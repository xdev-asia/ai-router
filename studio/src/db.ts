import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Mode = "image" | "video" | "mixed";
export type Step = "script" | "voice" | "assets" | "render" | "done";
export type Status = "queued" | "running" | "failed" | "done";

export interface Scene {
  narration: string;
  visual: string;
  kind: "image" | "video";
  /** Seconds, set by the voice step. */
  duration?: number;
  /** File names in the project's folder. */
  image?: string;
  video?: string;
  audio?: string;
  /** Why a video scene fell back to an image. */
  note?: string;
}

export interface Plan {
  title: string;
  description: string;
  hashtags: string[];
  scenes: Scene[];
}

export interface Project {
  id: string;
  topic: string;
  language: "vi" | "en";
  duration: number;
  mode: Mode;
  chat_model: string;
  image_model: string;
  video_model: string;
  tts_model: string;
  voice: string;
  image_size: string;
  step: Step;
  status: Status;
  error: string | null;
  plan: Plan | null;
  created_at: number;
  updated_at: number;
}

export interface Channel {
  id: string;
  kind: string;
  name: string;
  secret: string;
  config: Record<string, string>;
  created_at: number;
}

export type PubStatus = "pending" | "running" | "done" | "failed";

export interface Publication {
  id: string;
  project_id: string;
  channel_id: string;
  status: PubStatus;
  scheduled_at: number;
  external_id: string | null;
  url: string | null;
  error: string | null;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, language TEXT NOT NULL, duration INTEGER NOT NULL, mode TEXT NOT NULL,
  chat_model TEXT NOT NULL, image_model TEXT NOT NULL, video_model TEXT NOT NULL, tts_model TEXT NOT NULL,
  voice TEXT NOT NULL, image_size TEXT NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  plan TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, secret TEXT NOT NULL, config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS publication (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE, status TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL, external_id TEXT, url TEXT, error TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS publication_due ON publication (status, scheduled_at);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

const projectOf = (r: Row): Project => ({ ...(r as unknown as Project), plan: r.plan ? (JSON.parse(String(r.plan)) as Plan) : null });
const channelOf = (r: Row): Channel => ({ ...(r as unknown as Channel), config: JSON.parse(String(r.config)) as Record<string, string> });

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  setting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM setting WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** After a restart: a project step that was running starts again; a publication that was running is not sent twice. */
  recover(): void {
    const now = Date.now();
    this.db.prepare("UPDATE project SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now);
    this.db
      .prepare("UPDATE publication SET status = 'failed', error = 'interrupted by a restart: check the channel before retrying', updated_at = ? WHERE status = 'running'")
      .run(now);
  }

  insertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO project (id, topic, language, duration, mode, chat_model, image_model, video_model, tts_model, voice, image_size, step, status, error, plan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.topic, p.language, p.duration, p.mode, p.chat_model, p.image_model, p.video_model, p.tts_model, p.voice, p.image_size, p.step, p.status, p.error, p.plan ? JSON.stringify(p.plan) : null, p.created_at, p.updated_at);
  }

  project(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id) as Row | undefined;
    return r ? projectOf(r) : null;
  }

  projects(): Project[] {
    return (this.db.prepare("SELECT * FROM project ORDER BY created_at DESC LIMIT 200").all() as Row[]).map(projectOf);
  }

  updateProject(id: string, f: Partial<Pick<Project, "step" | "status" | "error" | "plan">>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(f)) {
      sets.push(`${k} = ?`);
      vals.push(k === "plan" ? (v ? JSON.stringify(v) : null) : (v as string | null));
    }
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    this.db.prepare(`UPDATE project SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
  }

  nextQueuedProject(): Project | null {
    const r = this.db.prepare("SELECT * FROM project WHERE status = 'queued' ORDER BY updated_at LIMIT 1").get() as Row | undefined;
    return r ? projectOf(r) : null;
  }

  insertChannel(c: Channel): void {
    this.db.prepare("INSERT INTO channel (id, kind, name, secret, config, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, c.kind, c.name, c.secret, JSON.stringify(c.config), c.created_at);
  }

  channel(id: string): Channel | null {
    const r = this.db.prepare("SELECT * FROM channel WHERE id = ?").get(id) as Row | undefined;
    return r ? channelOf(r) : null;
  }

  channels(): Channel[] {
    return (this.db.prepare("SELECT * FROM channel ORDER BY created_at").all() as Row[]).map(channelOf);
  }

  setChannelSecret(id: string, secret: string): void {
    this.db.prepare("UPDATE channel SET secret = ? WHERE id = ?").run(secret, id);
  }

  deleteChannel(id: string): void {
    this.db.prepare("DELETE FROM channel WHERE id = ?").run(id);
  }

  insertPublication(p: Publication): void {
    this.db
      .prepare("INSERT INTO publication (id, project_id, channel_id, status, scheduled_at, external_id, url, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.project_id, p.channel_id, p.status, p.scheduled_at, p.external_id, p.url, p.error, p.updated_at);
  }

  publication(id: string): Publication | null {
    return (this.db.prepare("SELECT * FROM publication WHERE id = ?").get(id) as Publication | undefined) ?? null;
  }

  publications(projectId: string): Publication[] {
    return this.db.prepare("SELECT * FROM publication WHERE project_id = ? ORDER BY scheduled_at").all(projectId) as unknown as Publication[];
  }

  updatePublication(id: string, f: Partial<Pick<Publication, "status" | "external_id" | "url" | "error" | "scheduled_at">>): void {
    const keys = Object.keys(f);
    this.db
      .prepare(`UPDATE publication SET ${[...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`)
      .run(...(Object.values(f) as (string | number | null)[]), Date.now(), id);
  }

  /** A pending publication whose time has come and whose project is rendered. */
  nextDuePublication(now: number): Publication | null {
    return (
      (this.db
        .prepare(
          "SELECT p.* FROM publication p JOIN project r ON r.id = p.project_id WHERE p.status = 'pending' AND p.scheduled_at <= ? AND r.step = 'done' ORDER BY p.scheduled_at LIMIT 1",
        )
        .get(now) as Publication | undefined) ?? null
    );
  }
}

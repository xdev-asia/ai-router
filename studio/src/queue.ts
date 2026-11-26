import { stat } from "node:fs/promises";
import { join } from "node:path";
import { open, seal } from "./crypto.ts";
import type { Store } from "./db.ts";
import { projectDir, runProject, type PipelineDeps } from "./pipeline.ts";
import { caption } from "./planner.ts";
import { publisherOf } from "./publishers/index.ts";
import type { PublishContext } from "./publishers/types.ts";

export interface QueueDeps extends PipelineDeps {
  channelsKey: Buffer | null;
  publicBaseUrl: string | null;
  publish?: Partial<PublishContext>;
}

/** Public paths of a rendered project: served without sign-in so Instagram and Zalo can fetch them. */
export const publicPath = (id: string, file: "final.mp4" | "cover.jpg") => `/files/${id}.${file === "final.mp4" ? "mp4" : "jpg"}`;

/**
 * One project and one publication at a time, in this process. The state is in the database, so after a restart
 * `Store.recover` puts the work back in line.
 */
export class Queue {
  private timer: NodeJS.Timeout | null = null;
  private projectBusy = false;
  private publishBusy = false;

  constructor(private readonly d: QueueDeps) {}

  /** Where the internet reaches /files, from the settings ai-router's console sends. */
  setPublicBaseUrl(url: string | null): void {
    this.d.publicBaseUrl = url;
  }

  start(everyMs = 2000): void {
    this.d.store.recover();
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Starts what is due; resolves when what it started has ended (tests await it). */
  async tick(): Promise<void> {
    await Promise.all([this.nextProject(), this.nextPublication()]);
  }

  private async nextProject(): Promise<void> {
    if (this.projectBusy) return;
    const p = this.d.store.nextQueuedProject();
    if (!p) return;
    this.projectBusy = true;
    this.d.store.updateProject(p.id, { status: "running", error: null });
    try {
      await runProject(this.d, p.id);
    } catch (e) {
      this.d.store.updateProject(p.id, { status: "failed", error: message(e) });
      this.d.log?.(`project ${p.id} failed: ${message(e)}`);
    } finally {
      this.projectBusy = false;
    }
  }

  private async nextPublication(): Promise<void> {
    if (this.publishBusy) return;
    const pub = this.d.store.nextDuePublication(Date.now());
    if (!pub) return;
    this.publishBusy = true;
    this.d.store.updatePublication(pub.id, { status: "running", error: null });
    const channel = this.d.store.channel(pub.channel_id);
    let secret: Record<string, string> | null = null;
    try {
      const project = this.d.store.project(pub.project_id);
      if (!project?.plan || !channel) throw new Error("the project or the channel is gone");
      const publisher = publisherOf(channel.kind);
      if (!publisher) throw new Error(`no publisher for ${channel.kind}`);
      if (!this.d.channelsKey) throw new Error("CHANNELS_KEY is not set");
      secret = open<Record<string, string>>(this.d.channelsKey, channel.secret);
      const file = join(projectDir(this.d.dataDir, project.id), "final.mp4");
      await stat(file);
      const base = this.d.publicBaseUrl;
      const links = this.d.store
        .publications(project.id)
        .flatMap((o) => (o.id !== pub.id && o.status === "done" && o.url ? [o.url] : []));
      const result = await publisher.publish(
        secret,
        channel.config,
        {
          file,
          videoUrl: base ? base + publicPath(project.id, "final.mp4") : null,
          coverUrl: base ? base + publicPath(project.id, "cover.jpg") : null,
          title: project.plan.title,
          caption: caption(project.plan),
          hashtags: project.plan.hashtags,
          links,
        },
        { fetch, pollMs: 5000, ...this.d.publish },
      );
      if (result.secret) this.d.store.setChannelSecret(channel.id, seal(this.d.channelsKey, result.secret));
      this.d.store.updatePublication(pub.id, { status: "done", external_id: result.externalId, url: result.url });
    } catch (e) {
      const rotated = (e as { secret?: Record<string, string> }).secret;
      if (rotated && channel && this.d.channelsKey) this.d.store.setChannelSecret(channel.id, seal(this.d.channelsKey, rotated));
      this.d.store.updatePublication(pub.id, { status: "failed", error: scrub(message(e), secret) });
    } finally {
      this.publishBusy = false;
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** A credential never shows in an error kept in the database. */
export function scrub(text: string, secret: Record<string, string> | null): string {
  let out = text;
  for (const v of Object.values(secret ?? {})) if (v && v.length >= 6) out = out.split(v).join("***");
  return out;
}

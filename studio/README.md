# Clip Studio

Makes short vertical clips (9:16, for YouTube Shorts, TikTok, Reels) from a topic and posts them to several
channels. Every model call goes through xDev AI Router with one gateway token, so providers, keys, fallbacks and
usage stay in the router.

```
topic ─▶ script (chat) ─▶ voice (speech) ─▶ assets (images / video) ─▶ render (ffmpeg) ─▶ publish (channels)
```

It is ai-router's studio sidecar, as `relay/` is its Codex relay: a Node service (Hono, SQLite through
`node:sqlite`, ffmpeg) in its own container, reached by the ai-router Worker, whose console has the page. This
service has no UI of its own: a JSON API under `/api` behind a shared secret, and the finished clips under `/files`.

## What it does

| Step | What happens |
|---|---|
| script | The chat model writes a JSON plan: title, description, hashtags, and about one scene per 5 seconds (narration, an English visual prompt, `image` or `video`) |
| voice | Each scene's narration through `/v1/audio/speech` (MP3). The scene lasts as long as its voice plus 0.35 s. No voice model: silence, about 15 characters a second |
| assets | `image` scenes: `/v1/images/generations` (`response_format: b64_json`). `video` scenes: `/v1/videos` (experimental, below); a video that fails falls back to an image and the scene's `note` says why |
| render | Each still becomes a slow zoom (Ken Burns, in and out by turns); each clip is cut or looped to its scene and cropped to fill 1080×1920. Segments and voices are joined, the narration is burned in as subtitles (SRT, timed by scene, lines of 30 characters at most), `final.mp4` is written with `+faststart`, and `cover.jpg` from the first scene |
| publish | The channels picked, now or at a set time. Each one is a publication with its status, the post's id and link |

Modes, per project: `image` (all stills), `video` (all clips), `mixed` (the script model picks the 1 to n scenes
that need motion most).

Each step is saved when it ends and skips files already on disk, so a restart goes on where it stopped. One project
and one publication run at a time. A publication that was running when the service stopped is marked failed, not
sent again: look at the channel, then retry it.

## ai-router

Make a system for the studio in ai-router's console (`#/systems`), put its token in `AI_ROUTER_TOKEN`, and allow it
the models it uses. `GET /api/models` lists them. Typical picks:

| Use | Example model |
|---|---|
| Script | `openai/gpt-5-mini`, a combo such as `combo/fast` |
| Images | `openai/gpt-image-1` (`1024x1536` is portrait), `fal/fal-ai/flux/dev`, `bfl/flux-pro-1.1` |
| Voice | `openai/gpt-4o-mini-tts` with voice `alloy`; ElevenLabs or another provider with its own voice id |
| Video | `openai/sora-2` |

**Video.** The client follows the OpenAI videos API: `POST /v1/videos` (`{model, prompt, seconds:
"4"|"8"|"12", size: "720x1280"}`), then `GET /v1/videos/{id}` until `status: completed`, then
`GET /v1/videos/{id}/content`. ai-router routes the two GETs to the account that made the job. A provider that
answers the video at once (`data[0].url`, `data[0].b64_json`, `url`, or the MP4 bytes) works too. A video scene
that fails becomes a still, with the reason in the scene's `note`.

## Channels

Credentials are sealed with AES-256-GCM (`CHANNELS_KEY`) in the database, never answered by the API and never
logged; a credential that shows up in a platform's error message is replaced by `***` before the error is stored.
When a platform hands back a new refresh token (TikTok, Zalo), the new one is stored, also when the post then fails.

| Channel (`kind`) | What is posted | What you need | Caveats |
|---|---|---|---|
| YouTube Shorts (`youtube`) | The MP4 by resumable upload (Data API v3), `#Shorts` added to the title | OAuth client (Google Cloud, YouTube Data API v3 on), a refresh token with scope `youtube.upload` (OAuth Playground with your own client works) | A project Google has not audited uploads private only. Default quota 10,000 units a day; an upload costs 1,600, so about 6 a day |
| TikTok (`tiktok`) | The MP4 by Content Posting API (Direct Post, `FILE_UPLOAD`, chunked), waits for `PUBLISH_COMPLETE` | A TikTok developer app with Content Posting API and `video.publish`, client key and secret, a user's refresh token | Until TikTok audits the app every post is `SELF_ONLY` and the account must be private. Set `privacy_level` to `PUBLIC_TO_EVERYONE` after the audit |
| Facebook Reels (`facebook`) | The MP4 to a Page (`video_reels` start, upload to rupload.facebook.com, finish as `PUBLISHED`) | Page id, a long-lived Page access token with `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` | Meta app review for Pages that are not yours. Reels of 3 to 90 seconds |
| Instagram Reels (`instagram`) | A `REELS` container from `PUBLIC_BASE_URL/files/<id>.mp4`, waits for `FINISHED`, then `media_publish` | An Instagram professional account linked to a Page, its IG user id, a token with `instagram_basic`, `instagram_content_publish` | Instagram fetches the video itself: `PUBLIC_BASE_URL` must reach `/files` (a Cloudflare Tunnel route). Meta app review. 50 API posts a day |
| Telegram (`telegram`) | The MP4 by the Bot API's `sendVideo` | A bot token from @BotFather, the bot an admin of the channel; `@channel` or a chat id | Bots send files of 50 MB at most |
| Zalo OA (`zalo`) | An article: cover (`/files/<id>.jpg`), description, and links to the clip (the project's other channels that are done, then `/files/<id>.mp4`) | App id, app secret key, an OA refresh token (Zalo for Developers, OA API permissions) | Not the video itself: OA article videos go through Zalo's own upload and review, not done here. Needs `PUBLIC_BASE_URL` for the cover. Publish to YouTube first so the article links there. Zalo refresh tokens work once; the stored one changes after each post |

None of the publishers has been run against the real platforms: each is tested against a fake server
(`test/publishers.test.ts`), so the first real post of each channel is its real test. The Graph API version is a
channel setting (`graph_version`, default `v23.0`).

Scheduled publications wait in the database and go out at their time if the service is running then.

## Settings

| Name | Value |
|---|---|
| `STUDIO_SECRET` | The shared secret: every `/api` call carries `Authorization: Bearer <secret>`. 16 characters or more |
| `STUDIO_SECRET_FILE` | Read when `STUDIO_SECRET` is unset (Docker: a file in the secrets volume, like `RELAY_SECRET_FILE`). One of the two is needed or the service does not start |
| `AI_ROUTER_URL` | ai-router's address (`http://ai-router:8787` inside ai-router's compose) |
| `AI_ROUTER_TOKEN` | The gateway token of the studio's system in ai-router |
| `CHANNELS_KEY` | 32 bytes, base64 (`openssl rand -base64 32`). Unset: channels cannot be added. Changing it makes stored channels unreadable |
| `PUBLIC_BASE_URL` | Where the internet reaches this service's `/files`. Needed by Instagram and Zalo |
| `STUDIO_DATA_DIR` | The database (`clip-studio.db`) and each project's folder (`projects/<id>/`). `data` by default, `/data` in the image |
| `SUBTITLE_FONT` | The subtitles' font family, `DejaVu Sans` by default (the image has it, with Vietnamese glyphs) |
| `SUBTITLE_FONTS_DIR` | Optional: a folder of font files for the subtitles, for a machine with no system fonts |
| `PORT` | `8791` |

In ai-router's compose, a service like the relay's:

```yaml
  studio:
    image: ghcr.io/xdev-asia/ai-router-studio:latest   # or build: studio
    environment:
      STUDIO_SECRET_FILE: /secrets/studio-secret
      AI_ROUTER_URL: http://ai-router:8787
    env_file:
      - path: .studio.env        # AI_ROUTER_TOKEN, CHANNELS_KEY, PUBLIC_BASE_URL
        required: false
    volumes:
      - secrets:/secrets:ro
      - studio:/data
```

The Dockerfile builds from this folder alone (`docker build studio/`): Node 24, ffmpeg with libass, DejaVu and
Noto fonts.

## API

Every `/api` call needs `Authorization: Bearer <STUDIO_SECRET>`; without it: `401 {"error": "unauthorized"}`.
Errors are `{"error": "<message>"}` with 400 (bad body), 404, 409 (state does not allow it) or 500.

### Without the secret

| Call | Answer |
|---|---|
| `GET /health` | `{"ok": true}` |
| `GET /files/<id>.mp4` | The finished clip (`video/mp4`, `Range` supported). 404 until rendered |
| `GET /files/<id>.jpg` | Its cover (`image/jpeg`) |

Project ids are random UUIDs; nothing else is served without the secret.

### Models

`GET /api/models` → `{"models": ["openai/gpt-5-mini", ...]}` (the ids ai-router's `/v1/models` gives the studio's
token). When ai-router cannot be asked: `{"models": [], "error": "..."}` with 200.

### Projects

A project:

```jsonc
{
  "id": "uuid",
  "topic": "5 mẹo dùng ChatGPT cho dân văn phòng",
  "language": "vi",              // "vi" | "en"
  "duration": 30,                // seconds asked for, 10 to 180
  "mode": "mixed",               // "image" | "video" | "mixed"
  "chat_model": "openai/gpt-5-mini",
  "image_model": "openai/gpt-image-1",
  "video_model": "openai/sora-2", // "" for mode image
  "tts_model": "openai/gpt-4o-mini-tts", // "": no voice
  "voice": "alloy",
  "image_size": "1024x1536",
  "step": "assets",              // "script" | "voice" | "assets" | "render" | "done": the step running or next
  "status": "running",           // "queued" | "running" | "failed" | "done"
  "error": null,                 // why it failed
  "plan": null | {
    "title": "...", "description": "...", "hashtags": ["ChatGPT", "AI"],   // hashtags without "#"
    "scenes": [{
      "narration": "...", "visual": "...", "kind": "image",  // "image" | "video"
      "duration": 3.84,          // seconds, after the voice step
      "audio": "voice-01.mp3", "image": "image-01.png", "video": "clip-02.mp4",  // file names, when made
      "note": "video failed, used an image: ..."  // optional
    }]
  },
  "created_at": 1764141234567, "updated_at": 1764141239876  // ms
}
```

| Call | Body | Answer |
|---|---|---|
| `GET /api/projects` | | `{"projects": [{id, topic, title, step, status, error, mode, created_at}]}`, newest first, 200 at most |
| `POST /api/projects` | `{topic, chat_model, image_model, language?, duration?, mode?, video_model?, tts_model?, voice?, image_size?}`. `video_model` is needed for `video` and `mixed` | 201 `{"project": {...}}`, queued |
| `GET /api/projects/:id` | | `{"project": {...}, "final": null \| {"video": "/files/<id>.mp4", "cover": "/files/<id>.jpg"}, "publications": [...]}` |
| `PUT /api/projects/:id/plan` | `{title?, description?, hashtags?: string[], scenes?: [{narration?, visual?}]}` (scenes by position) | `{"project": {...}, "rerun": null \| "voice" \| "assets"}`. A changed narration runs again from `voice`, a changed visual from `assets`. 409 while running |
| `POST /api/projects/:id/retry` | `{step?: "script" \| "voice" \| "assets" \| "render"}` (default: the step that failed; `render` for a done project) | `{"project": {...}}`. What that step and later ones made is thrown away and made again. 409 while running |
| `DELETE /api/projects/:id` | | 204; its files are deleted too. 409 while running |
| `GET /api/projects/:id/files/:file` | | A file of the project: `image-01.png`, `clip-02.mp4`, `voice-01.mp3`, `subs.srt`, `final.mp4`, `cover.jpg` (`Range` supported) |

While a project runs, poll `GET /api/projects/:id`: the plan fills in scene by scene.

### Publishing

A publication:

```jsonc
{ "id": "uuid", "project_id": "uuid", "channel_id": "uuid",
  "status": "pending",           // "pending" | "running" | "done" | "failed"
  "scheduled_at": 1764141234567, // ms
  "external_id": "abc123",       // the platform's id, when done
  "url": "https://www.youtube.com/shorts/abc123",  // when the platform gives one (TikTok and Zalo do not)
  "error": null, "updated_at": 1764141234567 }
```

| Call | Body | Answer |
|---|---|---|
| `POST /api/projects/:id/publish` | `{channels: ["<channel id>", ...], at?: <ms>}` (`at` in the future schedules it) | 201 `{"publications": [...]}` (all of the project's). 409 if not rendered |
| `POST /api/publications/:id/retry` | | `{"publication": {...}}`, pending again now. 409 unless failed |

### Channels

| Call | Body | Answer |
|---|---|---|
| `GET /api/channel-kinds` | | `{"kinds": [{kind, name, secretFields: [Field], configFields: [Field]}], "canStore": bool}`; a Field is `{key, label, help?, optional?}`. `canStore` false: `CHANNELS_KEY` is unset |
| `GET /api/channels` | | `{"channels": [{id, kind, name, config, created_at}]}`, never the secret |
| `POST /api/channels` | `{kind, name?, secret: {<secretFields>}, config: {<configFields>}}` | 201 `{"channel": {id, kind, name, config, created_at}}`. 400 `secret.<key> is needed` / `config.<key> is needed` |
| `DELETE /api/channels/:id` | | 204, with its publications |

Fields of each kind:

| kind | secret | config |
|---|---|---|
| `youtube` | `client_id`, `client_secret`, `refresh_token` | `privacy`? (`public`), `category_id`? (`22`) |
| `tiktok` | `client_key`, `client_secret`, `refresh_token` | `privacy_level`? (`SELF_ONLY`) |
| `facebook` | `page_access_token` | `page_id`, `graph_version`? |
| `instagram` | `access_token` | `ig_user_id`, `graph_version`? |
| `telegram` | `bot_token` | `chat_id` |
| `zalo` | `app_id`, `secret_key`, `refresh_token` | `author`? |

## Develop

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test
cp .env.example .env && corepack pnpm run dev   # http://localhost:8791, needs ffmpeg and ffprobe on PATH
```

The tests use fake servers for ai-router and every platform; no real key is in a test. When ffmpeg is on PATH,
`test/ffmpeg.test.ts` runs the whole pipeline (script, voices, two stills, a clip, render) against a fake
ai-router and checks the MP4 is 1080×1920 with sound and the right length (`SAMPLE_OUT=<path>` keeps it).

| Path | What |
|---|---|
| `src/ai-router.ts` | The ai-router client: chat, images, speech, videos, models |
| `src/planner.ts` | The script prompt and reading the plan out of the model's answer |
| `src/pipeline.ts` | The steps |
| `src/ffmpeg.ts` | The ffmpeg command lines |
| `src/srt.ts` | Subtitles |
| `src/queue.ts` | Runs projects and publications |
| `src/publishers/` | One file per channel behind one interface (`types.ts`) |
| `src/server.ts` | The API |
| `src/db.ts`, `src/crypto.ts`, `src/config.ts` | Storage, sealing, settings |

import { Hono } from "hono";
import type { AppEnv } from "./env";

/**
 * Skills (agent skills): Markdown files an agent can be pointed at to learn how to call this gateway.
 * Public and free of secrets: they carry this gateway's address and tell the agent to read its token from the
 * environment, never a token itself.
 */

interface Skill {
  name: string;
  description: string;
  body: (base: string) => string;
}

const SKILLS: Skill[] = [
  {
    name: "ai-router",
    description: "Chat with any model behind this gateway through the OpenAI or Anthropic API.",
    body: (base) => `---
name: ai-router
description: Chat with any model behind the ai-router gateway at ${base}, through the OpenAI or Anthropic API.
---

# ai-router

An LLM gateway. One token reaches every provider and combo the owner allows for your system.

- Base URL (OpenAI SDK): \`${base}\`
- Base URL (Anthropic SDK): \`${base.replace(/\/v1$/, "")}\`
- Token: read it from the environment (\`AI_ROUTER_TOKEN\`). Never write it into a file or a message.

## Models

\`GET ${base}/models\` lists what your token may call. A model is \`<provider>/<model>\` (\`groq/llama-3.3-70b-versatile\`),
\`combo/<name>\` (the gateway tries its targets in turn), or a Claude id.

## Chat

\`\`\`sh
curl ${base}/chat/completions \\
  -H "Authorization: Bearer $AI_ROUTER_TOKEN" -H "content-type: application/json" \\
  -d '{"model":"combo/default","messages":[{"role":"user","content":"Hello"}]}'
\`\`\`

## Errors

- 401: the token is wrong. 403: the model is not allowed for this system. 429 \`monthly_token_cap\`: stop, do not retry.
- 429 or 5xx from a provider: the gateway already tried the other accounts and targets.
`,
  },
  {
    name: "media",
    description: "Embeddings, images, video, speech and transcription through this gateway.",
    body: (base) => `---
name: ai-router-media
description: Embeddings, images, video, speech and transcription through the ai-router gateway at ${base}.
---

# ai-router media

Same token and base URL as chat (\`${base}\`, token in \`AI_ROUTER_TOKEN\`). \`model\` is \`<provider>/<model>\` of a provider that
speaks the OpenAI API; combos are for chat only.

| endpoint | body |
|---|---|
| \`POST ${base}/embeddings\` | \`{"model":"openai/text-embedding-3-small","input":"..."}\` |
| \`POST ${base}/images/generations\` | \`{"model":"openai/gpt-image-1","prompt":"..."}\` |
| \`POST ${base}/videos\` | \`{"model":"openai/sora-2","prompt":"..."}\` |
| \`POST ${base}/audio/speech\` | \`{"model":"openai/gpt-4o-mini-tts","input":"...","voice":"alloy"}\`, answers audio bytes |
| \`POST ${base}/audio/transcriptions\` | multipart: \`model\`, \`file\` (25 MB at most) |
`,
  },
  {
    name: "web",
    description: "Web search and page fetch through this gateway.",
    body: (base) => `---
name: ai-router-web
description: Search the web and read a page as text through the ai-router gateway at ${base}.
---

# ai-router web

Same token as chat (\`AI_ROUTER_TOKEN\`). The gateway picks the search or fetch provider and falls back on a failure.

\`\`\`sh
curl ${base}/search -H "Authorization: Bearer $AI_ROUTER_TOKEN" -H "content-type: application/json" \\
  -d '{"query":"cloudflare workers d1 limits","max_results":5}'
# {"query":"...","provider":"tavily","results":[{"title":"...","url":"...","snippet":"..."}]}

curl ${base}/fetch -H "Authorization: Bearer $AI_ROUTER_TOKEN" -H "content-type: application/json" \\
  -d '{"url":"https://developers.cloudflare.com/d1/platform/limits/"}'
# {"url":"...","provider":"jina","title":"...","content":"<markdown>"}
\`\`\`
`,
  },
];

export const SKILL_NAMES = SKILLS.map((s) => s.name);

export function skillRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(SKILLS.map((s) => ({ name: s.name, description: s.description, url: `${origin}/skills/${s.name}.md` })));
  });
  r.get("/:file", (c) => {
    const m = /^([a-z0-9-]+)\.md$/.exec(c.req.param("file"));
    const skill = m ? SKILLS.find((s) => s.name === m[1]) : undefined;
    if (!skill) return c.json({ error: "not_found" }, 404);
    return c.body(skill.body(`${new URL(c.req.url).origin}/v1`), 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
  });
  return r;
}

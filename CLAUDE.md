# ai-router

An LLM gateway (Cloudflare Worker, Hono, D1) with an owner console (`web/`, React, `@xdev-asia/ui`). README.md says what each part does; THIRD_PARTY_NOTICES.md lists the files and data taken from other projects, and a new one goes there with its license.

## Console (`web/`)

Follow the skills that ship with `@xdev-asia/ui` (`node_modules/@xdev-asia/ui/skills/`, or `../xdev-ui/skills/` in the workspace). Read the reference for the page you are building before writing it:

| building | read |
|---|---|
| any page | `xdev-ui-admin/SKILL.md`, `references/layout.md`, `references/states-feedback.md` |
| a grid of providers, tools or integrations | `xdev-ui-admin/references/visual-identity.md` |
| a list or table | `references/resource-list.md` |
| totals and charts | `references/dashboard.md` |
| a settings page | `references/settings.md` |
| a dialog or form | `references/dialogs.md`, `references/forms.md` |

- A component the console needs and the library lacks is added to `xdev-ui` (its `AGENTS.md` lists what a new component needs), never built here. This repo's `web/styles.css` only places parts.
- App classes never start with `x-` or `ws-`: those are the library's.
- Before calling a page done: `node ../xdev-ui/skills/xdev-ui-review/scripts/audit.mjs web --i18n web/strings`, then look at the page in dark and light.
- Every string is in `web/strings/en.ts` and `vi.ts`.

## Worker (`worker/`)

- Tests first (`worker/test/`, vitest in workerd with a fake upstream). No real key in a test or a fixture.
- A key or token never appears in an API answer, a log line or a usage row.
- Schema changes are a new file in `migrations/`; add the table to `reset()` in `worker/test/helpers.ts`.

## Commands

```sh
corepack pnpm run typecheck
corepack pnpm run test        # worker
corepack pnpm run test:web    # console
corepack pnpm run build
```

`@xdev-asia/ui` comes from npmjs.com; the install needs no token.

# Third-party notices

Most of this gateway is its own code. The files and data below come from other projects, under their licenses.

## 9router (MIT)

https://github.com/decolua/9router, MIT License, Copyright (c) 2024-2026 decolua and contributors. The full license
text is in [`worker/savers/vendor/LICENSE-9router`](worker/savers/vendor/LICENSE-9router).

| Here | Taken from 9router | How |
|---|---|---|
| `worker/savers/vendor/` | `open-sse/rtk/` at commit `1339107e` (`worker/savers/vendor/.upstream-commit`) | copied unchanged; called from `worker/savers/index.ts`, which is this gateway's own code |
| `worker/model-catalog.ts` | the provider registry (`open-sse/providers/registry`): model ids, display names, reasoning levels, context sizes | generated |
| `worker/pricing-defaults.ts` | the pricing table (`open-sse/providers/pricing.js`): per-1M-token prices | generated; numbers only, not checked against the providers' price lists |
| `worker/providers.ts` | names, colours, base URLs and key pages of the providers | data only |
| `worker/gemini.ts` (the chat ↔ Gemini translation) | the `openai-to-gemini` and `gemini-to-openai` translators | adapted |
| `worker/wire.ts`, `worker/oauth.ts`, `worker/cloudcode.ts`, `worker/provider-headers.ts` | the registry and executors at commit `54a88d04`: endpoints, header names and values, public client ids | values taken, code written anew |
| `worker/models.ts` | the model-name rules (`open-sse/services/model.js`, `open-sse/utils/modelMarkers.js`): the `(level)` suffix, the `[1m]` marker, the provider guess | rules followed, code written anew |
| `worker/vendor/codexInstructions.js` | `open-sse/config/codexInstructions.js` at commit `54a88d04` | copied unchanged (the text itself is the Codex CLI's, below) |
| `web/public/providers/`, `web/public/cli/` | the provider and tool logo files | copied |

The provider and tool logos are trademarks of their owners and are used only to name each provider or tool.

## Projects 9router's files port or adapt

- **RTK** (https://github.com/rtk-ai/rtk), Apache License 2.0: the tool-output filters in `worker/savers/vendor/`
  (`constants.js`, `autodetect.js`, `applyFilter.js`, `filters/*.js`) are 9router's JavaScript port of RTK's Rust
  filters. License text: https://www.apache.org/licenses/LICENSE-2.0
- **Caveman** (https://github.com/JuliusBrussee/caveman), Apache License 2.0: `cavemanPrompts.js` is adapted from
  the Caveman skill.
- **Ponytail** (https://github.com/DietrichGebert/ponytail), MIT License: `ponytailPrompt.js` is adapted from the
  Ponytail skill.
- **Codex CLI** (https://github.com/openai/codex), Apache License 2.0: the instructions text in
  `worker/vendor/codexInstructions.js` is the Codex CLI's system prompt.

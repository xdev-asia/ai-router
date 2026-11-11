# Third-party code in `worker/savers/vendor/`

The files in `vendor/` are copied unchanged from **9router** (https://github.com/decolua/9router,
`open-sse/rtk/`, commit in `vendor/.upstream-commit`), MIT License, Copyright (c) 2024-2026 decolua and
contributors. The full license text is in `vendor/LICENSE-9router`.

9router's files are themselves ports or adaptations of:

- **RTK** (https://github.com/rtk-ai/rtk), Apache License 2.0: the tool-output filters
  (`constants.js`, `autodetect.js`, `applyFilter.js`, `filters/*.js`) are 9router's JavaScript port of
  RTK's Rust filters. Apache-2.0 text: https://www.apache.org/licenses/LICENSE-2.0
- **Caveman** (https://github.com/JuliusBrussee/caveman), Apache License 2.0: `cavemanPrompts.js` is
  adapted from the Caveman skill.
- **Ponytail** (https://github.com/DietrichGebert/ponytail), MIT License: `ponytailPrompt.js` is
  adapted from the Ponytail skill.

Changes made here: none to the vendored files. This gateway calls them from `worker/savers/index.ts`,
which is its own code (which messages are compressed, where prompts are inserted, per-system switches).

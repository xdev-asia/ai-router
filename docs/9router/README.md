# 9router reference

Screenshots of the 9router dashboard (v0.5.116, the `decolua/9router:latest` image on 2026-11-12, empty install),
and what each page does, as the reference for building the same features and layout here. 9router is MIT; nothing
in this folder is its code.

- The pictures show a 1440 px wide window, saved at half size (720 px; four of them at 504 px).
- "Here" is the state of `ai-router` on the `feat/connections` branch.
- What a page does comes from the page itself and from 9router's source at commit `54a88d04`. Savings and other
  numbers on 9router's pages are its own claims, not measured here.

## Frame

Every page has the same frame (see any picture):

- **Sidebar**, 288 px: logo tile, name and version; then *Endpoint & Key, Providers, Combo & Vision Adapter, Usage,
  Quota Tracker, Token Saver, CLI Tools*; then a **System** group: *Media Providers* (opens a sub-list), *Proxy
  Pools, Skills, Console Log, Translator* (only when switched on in settings), *Settings*. The current page is
  tinted. Two more entries, *9Remote* and *9English*, are links to the author's other products.
- **Header**: the page's icon, title and one-line description on the left; on the right a search field (Providers
  only), a *Donate* link, a light/dark switch, a language flag and a menu.
- **Content**: one centred column, at most 1280 px wide, of rounded cards.

Here: the xdev-ui `AppShell` with one nav list (*Systems, Providers, Combos, Usage*, the same order as 9router's
first group) and a theme switch and language select in the top bar. No *System* group yet (none of its pages
exists), and the page title stays in the content, not in the top bar.

## Pages

| # | Page | What it has | Here |
|---|---|---|---|
| 01 | Endpoint & Key | The endpoint URL to copy; *Tunnel* and *Tailscale* switches to expose a local install; API keys: create, *Require API key*, show, copy, switch a key off, *Restrict access* per key, delete | **Partly.** *Systems* holds one gateway token per calling system (shown once), with a cap, an on/off switch and an allow-list. No tunnel: a Worker is already public |
| 02 | Providers | Search and a status filter; sections *Custom Providers (OpenAI/Anthropic Compatible)*, *OAuth Providers* (21), *Free Tier Providers* (17), *API Key Providers*; a 4-column grid of cards (icon, name, "No connections" / "N Connected" / "N Error"); *Test All* per section | **Partly.** Search, status filter, one section per kind, a grid of cards (initials for the mark, "N connected" / "N set aside" / "No connections", a switch for all of a provider's connections on hover). 6 API-key providers. No logos, *Test All*, or custom providers |
| 03 | Provider detail (API key) | Back link, icon, name, *Get API Key* link, connection count; **Connections** card with *Round Robin* switch and *Add Connection*; **Available Models**: a *Thinking* level select, *Disable All*, one chip per model (copy the name, test, hide), *Add Model* | **Partly.** Back link, mark, name, connection count; **Connections** card with *Add connection*: name, key ending, status, last error, on/off, drag to reorder, edit, delete. No *Get API Key* link, models card, or round robin |
| 04 | Provider detail (OAuth) | The same, plus a risk notice for subscription logins and a collapsible *Custom Headers* card | **Missing.** No subscription provider yet |
| 05 | Add API key dialog | *Single* / *Bulk Add* tabs; Name; API Key with a *Check* button; Priority; Proxy Pool; Save, Cancel | **Partly.** Name and API key. No check, bulk add, priority field or proxy pool |
| 06 | Combos | Four strategies explained (*Fallback, Round Robin, Smart Router, Fusion*); search; *Create Combo*; **Vision Adapter**: pools of models that take over image and audio input | **Partly.** Fallback combos only |
| 07 | Create combo dialog | Combo Name; a list of models built with *Add Model* | **Partly.** Name and a text box of models |
| 08 | Usage, Overview | Period switch (*Today, 24h, 7D, 30D, 60D, All*); five totals (requests, input, cached, output, estimated cost); a diagram of the router and its providers; recent requests; a chart by tokens, requests or cost; *By provider*; *Top models*; a table by model, account, API key or endpoint, in costs or tokens | **Partly.** One table per month by system, provider and model; no cost, charts or periods |
| 09 | Usage, Details | Filters (provider, start, end); one row per request: time, model, provider, input, cached, cache creation, output, latency, action | **Missing.** The rows exist in `usage`; no page shows them |
| 10 | Quota Tracker | Quota and reset time of each OAuth connection | **Missing** |
| 11 | Token Saver | Global switches: *Compress tool output (RTK)*, *Compress context (Headroom)*, *Compress LLM output (Caveman)*, *Lazy senior dev (Ponytail)*, *Custom system prompt* | **Partly.** RTK, Caveman and Ponytail per system, in a dialog. No Headroom, no custom system prompt, no page |
| 12 | CLI Tools | 26 coding tools as cards with *Not installed* or *Guide*; a *MITM Tools* group (Antigravity, Kiro) | **Missing** |
| 13 | CLI tool detail | Whether the tool is installed on this machine; *Manual Config*; *How to Install* | **Missing.** A Worker cannot look at the user's machine; only the manual config can be built |
| 14 | Media Providers, Embedding | Provider cards for embeddings, *Add Custom Embedding*; the same page exists for image, video, TTS, STT | **Missing** |
| 15 | Media Providers, Web | *Web Search* and *Web Fetch* provider cards, *Create Combo* for each | **Missing** |
| 16 | Proxy Pools | Outbound proxies to attach to connections: *Add Proxy Pool*, *Batch Import*, *Deploy Relay* | **Missing** |
| 17 | Skills | Links to skill files an agent can read to use the router (chat, images, speech, embeddings, search, fetch), each with *Copy link* | **Missing** |
| 18 | Console Log | The server's live log, with *Clear* | **Missing.** On Workers the log is in Cloudflare's observability |
| 19 | Settings | Theme; database location, backup and import; language; *Require login* and password; SSO (Okta, Entra ID, Keycloak, OIDC); routing strategy (*Round Robin*, *Combo Round Robin*); outbound proxy; observability; shutdown, logout | **Partly.** Sign-in with xDev ID or the admin token; language. The rest is missing or does not apply to a Worker (database file, shutdown) |

## Not shown

- The OAuth login dialogs. Opening one starts a real login at the provider, so they were left closed.
- *Translator* (off by default), the MITM page and the pricing settings page.
- Dark mode and phone widths.

## Not to be built here

The "web session" providers (`chatgpt-web`, `deepseek-web`, `grok-web`): 9router's code for them solves
proof-of-work challenges and imitates a browser to get past bot checks.

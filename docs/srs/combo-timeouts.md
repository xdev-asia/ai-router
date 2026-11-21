# SRS: Combo timeouts

Status: accepted for build, 2026-11-21. Architecture: [docs/add/combo-timeouts.md](../add/combo-timeouts.md). Builds on
[upstream timeouts](upstream-timeouts.md) (FR-TMO), which listed "a deadline per combo" as later work.

## 1. Purpose

The upstream timeouts are gateway-wide. One combo may hold fast models that should fail over after a few seconds of
silence, while another holds reasoning models that need minutes before the first byte. Today the owner must pick one
pair of limits for both.

This feature lets each combo set its own first-byte and idle limits. A limit the combo does not set follows the
gateway-wide setting.

## 2. Scope

In scope:

- A request whose `model` names a combo (`combo/<name>`, or its bare name, or an alias to it), on every route that
  reaches `runChat` (`worker/route.ts`): chat, messages, Gemini, Responses, basic chat and the model test.
- The combo's admin API (`GET/POST/PUT /admin/combos`), the MCP `save_combo` tool and the console's combo dialog.

Out of scope (later work):

- A deadline per provider or per model.
- A different limit for each member of one combo.

## 3. Terms

| term | meaning |
|---|---|
| gateway limit | The value in the `timeouts` setting (FR-TMO-08). |
| combo limit | A value saved on the combo. Unset means the gateway limit applies. |
| called combo | The combo the request names. A nested combo inside it is only a list of models. |

## 4. Functional requirements

| id | requirement |
|---|---|
| FR-CTO-01 | A combo may save `first_byte_s` and `idle_s`. Each is `0` (off), a whole number from 10 to 3600, or unset. |
| FR-CTO-02 | A request to a combo uses the combo limit for each limit the combo sets, and the gateway limit for each it does not. This applies to every provider request made for that combo request: each member, a Smart router model and each Fusion member. |
| FR-CTO-03 | Only the called combo's limits apply. A nested combo's own limits do not. |
| FR-CTO-04 | A request to a model that is not a combo uses the gateway limits, as before. |
| FR-CTO-05 | A combo limit acts exactly like a gateway limit: the same 504, header, log line, cooldown, fallback and stream error (FR-TMO-01..07, 12). The log line gives the limit that was used. |
| FR-CTO-06 | `GET /admin/combos` returns `timeouts` for each combo: `null` when none is set, otherwise an object with only the set fields. |
| FR-CTO-07 | `POST /admin/combos` and `PUT /admin/combos/:name` take `timeouts`. An object replaces the saved one; a field that is absent or `null` is unset. `null` unsets both. Absent on PUT keeps the saved value. A bad value returns 400 `{"error":"invalid_input","hint":...}` and saves nothing. |
| FR-CTO-08 | Changing the strategy never drops the combo's timeouts. |
| FR-CTO-09 | A saved change applies from the next request. |
| FR-CTO-10 | The MCP `save_combo` tool takes `timeouts` and passes it on. `list_combos` returns it. |
| FR-CTO-11 | The console's combo dialog has two optional number fields for the limits. An empty field means the gateway setting. A bad value shows an error under its field and sends nothing. |
| FR-CTO-12 | A backup carries each combo's timeouts, and an import restores them. An older backup without them still imports. |

## 5. Non-functional requirements

| id | requirement |
|---|---|
| NFR-CTO-01 | No extra D1 read: the limits come in the combo row `runChat` already reads. |
| NFR-CTO-02 | One migration adds one column. A row without a value behaves as before. |
| NFR-CTO-03 | The worker tests cover each FR-CTO with a fake provider, with no real wait over one second. |
| NFR-CTO-04 | Every console string is in `web/strings/en.ts` and `web/strings/vi.ts`. The dialog passes the xdev-ui audit. |

## 6. Acceptance criteria

1. Gateway first byte 0 (off), combo first byte 10, first member never answers: the client gets the second member's
   answer, and the first member's usage row has status 504.
2. Gateway first byte 10, combo first byte 0, a member answers after 40 ms (40 s at test speed): the client gets that
   answer.
3. Gateway idle 10, combo sets only first byte: a stalled stream still ends at the gateway idle limit.
4. A plain `provider/model` request in the same gateway ignores every combo's limits.
5. `PUT /admin/combos/x` with `{"timeouts":{"idle_s":5}}`, `{"timeouts":{"idle_s":"60"}}` or `{"timeouts":[]}`
   returns 400. `{"timeouts":{"idle_s":0}}` and `{"timeouts":null}` return 200.
6. A combo with timeouts, saved with `strategy: "fallback"`, keeps its timeouts.

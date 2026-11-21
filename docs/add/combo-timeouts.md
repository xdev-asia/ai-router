# ADD: Combo timeouts

Status: accepted for build, 2026-11-21. Requirements: [docs/srs/combo-timeouts.md](../srs/combo-timeouts.md).

## 1. Context

The gateway limits live in an `AsyncLocalStorage` store that `withTimeouts` fills once per request (`worker/timeouts.ts`,
[ADD upstream timeouts](upstream-timeouts.md) 2.3). `withDeadlines` reads the store when a provider request starts, and
keeps that value for the request's whole body.

Every combo request goes through `runChat` (`worker/route.ts`). It already reads the combo's row
(`SELECT strategy, config FROM combo WHERE name = ?`) after it resolves the model.

`combo.config` is not a place for limits: `strategyInput` (`worker/admin.ts`) sets it to null when the strategy is
`fallback` (FR-CMB-26), which would break FR-CTO-08.

## 2. Decision

### 2.1 Storage

`migrations/0028_combo_timeouts.sql`:

```sql
ALTER TABLE combo ADD COLUMN timeouts TEXT;
```

JSON with only the set fields, e.g. `{"first_byte_s":20}`. NULL when none is set. Backup reads and writes columns by
name (`worker/backup.ts`), so it carries the column with no change, and an old backup leaves it NULL (FR-CTO-12).

### 2.2 `worker/timeouts.ts`

```ts
export type TimeoutsPatch = Partial<Timeouts>;
export const COMBO_TIMEOUTS_HINT = "timeouts: null, or {first_byte_s, idle_s}, each 0 (off), 10 to 3600, or null (the gateway setting)";

/** The stored patch from an API body: null for none; "bad" when a field is wrong. */
export function timeoutsPatch(v: unknown): TimeoutsPatch | null | "bad";
/** The stored column as a patch; a damaged value reads as none. */
export function readTimeoutsPatch(raw: string | null): TimeoutsPatch | null;
/** Runs `fn` with the current limits, each field of `patch` replacing the gateway one. */
export function withTimeoutsPatch<T>(patch: TimeoutsPatch | null, fn: () => T): T;
```

`withTimeoutsPatch` reads the current store (or the defaults outside one), spreads the patch over it, and runs `fn` in
a new store that keeps `secondMs` and the client signal. With no patch it calls `fn` directly.

### 2.3 Routing

In `runChat`, the combo row read adds `timeouts`. Everything after the read runs inside
`withTimeoutsPatch(readTimeoutsPatch(row.timeouts), …)`: adapters, Headroom, the Smart router, Fusion and `runOrder`.
So each provider request for that combo request uses the combo limits (FR-CTO-02). `expandCombo` flattens nested
combos into targets and never reads their rows, so only the called combo's limits apply (FR-CTO-03). The target branch
returns before the read and is not touched (FR-CTO-04).

A stream body keeps the limits it started with, since `withDeadlines` reads the store once per call. No change to
`withDeadlines` or the log line: the log already gives the limit in use (FR-CTO-05).

### 2.4 Admin API

```http
GET /admin/combos
→ [{"name":"fast","targets":[...],"strategy":null,"config":null,"timeouts":{"first_byte_s":20},...}]

PUT /admin/combos/fast {"targets":[...],"timeouts":{"first_byte_s":20,"idle_s":null}}
→ 200 {...,"timeouts":{"first_byte_s":20}}

PUT /admin/combos/fast {"targets":[...],"timeouts":{"idle_s":5}}
→ 400 {"error":"invalid_input","hint":"timeouts: null, or {first_byte_s, idle_s}, ..."}
```

POST and PUT read `timeouts` the same way as `strategy`: absent keeps the stored value (POST: none), and a strategy
change does not touch it (FR-CTO-07, 08). The PUT that renames a combo copies the column with the row.

MCP `save_combo` adds `timeouts` to its properties and to `pick` (FR-CTO-10).

### 2.5 Console

The combo dialog (`web/pages/Combos.tsx`) gets a **Timeouts** group after the strategy:

```
Timeouts
Empty: the gateway setting (Settings). 0 turns a limit off; otherwise 10 to 3600 seconds.
Wait for first byte (s)   [      ]
Wait between chunks (s)   [      ]
```

- Two `Field`s with `inputMode="numeric"`, empty by default. The group hint is visible text, not a placeholder.
- `timeoutsDraft(combo)` and `timeoutsBody(draft)` (exported, like `strategyDraft`/`strategyBody`) turn the draft into
  `{first_byte_s, idle_s}` with `null` for empty, or report the bad field. Both empty sends `null`.
- A bad value shows `prefs.timeoutInvalid` under that field on submit and sends nothing (FR-CTO-11).
- The table row shows nothing new. [Inference: one more badge per row would crowd the table for a setting most combos
  leave empty.]

## 3. Alternatives

| option | why not |
|---|---|
| Keep the limits inside `combo.config` | `fallback` clears `config` (FR-CMB-26). Keeping it would change that rule for every strategy setting. |
| A second D1 read for the limits in `withTimeouts` | The combo is only known after the model is resolved, and `runChat` already reads its row (NFR-CTO-01). |
| Apply the innermost (nested) combo's limits | `expandCombo` flattens the tree, so a member does not know which combo it came from. The owner sets limits on the combo the client calls. |

## 4. Risks

- **A Fusion combo with a short first byte.** Each member gets the combo limit as well as Fusion's own `max_ms`. A short
  first byte ends slow members sooner. That is the intent, and the dialog hint says the limit applies to every model
  of the combo.
- **The model test (`models-admin.ts`)** races `runChat` with its own timer. The combo limits apply inside it, which
  matches what a client would see.

## 5. Tests (`worker/test/combo-timeouts.test.ts`, written first)

| test | proves |
|---|---|
| gateway first byte off, combo 10: the silent first member gives 504 and the second answers | FR-CTO-02, 05, criterion 1 |
| gateway 10, combo 0: a slow member's answer arrives | FR-CTO-02, criterion 2 |
| combo sets first byte only: a stalled stream ends at the gateway idle limit | FR-CTO-02, criterion 3 |
| a nested combo's limits do not apply | FR-CTO-03 |
| a `provider/model` request ignores combo limits | FR-CTO-04 |
| GET returns `timeouts`; POST/PUT save, unset with null, keep when absent; each bad value 400 | FR-CTO-06, 07, criterion 5 |
| saving `strategy: "fallback"` keeps the timeouts; a rename keeps them | FR-CTO-08 |
| a backup round trip keeps the column | FR-CTO-12 |
| MCP `save_combo` passes `timeouts` | FR-CTO-10 |

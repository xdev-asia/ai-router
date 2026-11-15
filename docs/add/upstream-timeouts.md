# ADD: Upstream timeouts

Status: accepted for build, 2026-11-15. Requirements: [docs/srs/upstream-timeouts.md](../srs/upstream-timeouts.md).

## 1. Context

Every provider request leaves the worker through one function type, `Upstream = (req: Request) => Promise<Response>`
(`worker/proxy.ts`). `makeApp` (`worker/app.ts`) gets it as `deps.upstream` (`fetch` in production, a fake in tests) and hands
it to the admin, Anthropic, OpenAI and Gemini routes and to `/auth/callback`. A Codex account behind an HTTP or SOCKS5 proxy
uses the pool's own fetch instead (`dest.fetch`, from `viaProxy` in `worker/proxy-pools.ts`; called in `route.ts` and
`quota.ts`).

What already happens after a provider answers:

| answer | `proxy.ts` (Anthropic passthrough) | `route.ts` (chat routing, combos) |
|---|---|---|
| status 429 or ≥ 500 | account failure: cool down, next account | the same, then the combo's next target (`retryable`) |
| `fetch` throws | (no catch) | 502 "could not reach X", account failure, retryable |
| non-streamed body fails while read | (body goes to the client) | inside the attempt's `try`: 502, next account or target |
| streamed body fails | client stream errors | client stream errors |

So a timeout that looks like a 5xx before the headers, and like a body error after them, needs no change in either router.

## 2. Decision

### 2.1 `withDeadlines` (new `worker/timeouts.ts`)

```ts
export function withDeadlines(fetcher: Upstream): Upstream
```

Wraps a fetcher. On each call it reads the current limits (2.3); with both off it calls `fetcher(req)` and returns.
Otherwise:

1. It makes an `AbortController`, links the caller's `req.signal` to it (an abort there aborts it; an already-aborted
   signal aborts it at once), and sends `new Request(req, { signal: ctl.signal })`. (FR-TMO-11)
2. **First byte.** It races the fetch against a timer of `first_byte` ms. When the timer wins it aborts the controller,
   logs, and returns a synthetic answer (FR-TMO-01, 03, 04, 12):
   ```http
   HTTP/1.1 504
   content-type: application/json
   x-gateway-timeout: first_byte

   {"type":"error","error":{"type":"api_error","message":"api.example.com did not answer within 300 s"}}
   ```
   The losing fetch gets a `.catch` and, if it still resolves, its body is cancelled. The message carries
   `new URL(req.url).host` only: never a path or query (a Gemini `?key=`) (NFR-TMO-01).
3. **Idle.** With an idle limit and a body, it returns `new Response(watched, res)`. `watched` is a `ReadableStream` that
   pulls from the provider's reader with a timer of `idle` ms per pull. When the timer wins it cancels the reader, aborts
   the controller, logs, and errors the stream with `UpstreamTimeout` (FR-TMO-02, 03, 12). `cancel` from the client
   clears the timer and cancels the reader. The timer only runs while a pull is waiting, so a slow client reader is not
   counted against the provider. (NFR-TMO-02)

`UpstreamTimeout extends Error` with `kind: "first_byte" | "idle"`, `host`, `seconds`.

The 504 is an ordinary 5xx to both routers, so it gives account cooldown, next account and combo fallback (FR-TMO-04)
with no change to `proxy.ts` or `route.ts`. A non-streamed body that stalls throws inside the attempt in `route.ts`, which
already gives 502, the next account and the next target (FR-TMO-05). A stall in a stream ends the client's stream
(FR-TMO-06).

Log line, one per timeout (FR-TMO-12):

```ts
console.warn(JSON.stringify({ level: "warn", event: "upstream_timeout", kind, host, seconds }));
```

### 2.2 Where it is applied

```ts
// app.ts
const upstream = withDeadlines(deps.upstream);
// … every place that used deps.upstream gets `upstream`

// proxy-pools.ts, codexDestinationFor
return { ok: true, url: CODEX_URL, secret: null, fetch: withDeadlines(viaProxy(t)) };
```

The console sign-in (`deps.idp`) is not a provider and stays as it is.

### 2.3 Where the limits come from

A middleware reads the setting row `timeouts` once per request and runs the rest of the request inside an
`AsyncLocalStorage` store, as `withCustomProviders` does for custom providers (`worker/providers.ts`):

```ts
export interface Timeouts { first_byte_s: number; idle_s: number }      // 0 = off
export const TIMEOUTS_DEFAULT: Timeouts = { first_byte_s: 300, idle_s: 300 };
interface Deadlines { firstByteMs: number; idleMs: number }

export const withTimeouts = (secondMs = 1000): MiddlewareHandler<AppEnv> => async (c, next) => {
  let t = TIMEOUTS_DEFAULT;
  try { t = await getTimeouts(c.env.DB); } catch { /* no setting table: defaults */ }
  await runWithDeadlines({ firstByteMs: t.first_byte_s * secondMs, idleMs: t.idle_s * secondMs }, next);
};
```

- Mounted on the same paths as `withCustomProviders`: `/v1`, `/v1/*`, `/v1beta/*`, `/openai/*`, `/anthropic/*`, `/admin/*`.
- Outside a store (`/auth/callback`) the defaults apply.
- `getTimeouts` reads D1 every time and keeps no cache, like `getComboSettings`, so a save applies from the next request
  (FR-TMO-10, NFR-TMO-03).
- `secondMs` is a test seam, like `deps.upstream`: `Deps.secondMs` (default 1000). The tests set it to 1, so a 10 s limit
  waits 10 ms (NFR-TMO-04).

### 2.4 Setting and admin API

Copies the combo settings in `worker/combo-strategy.ts`: the key-value table `setting` (migration 0008), key `timeouts`,
value JSON. No migration (NFR-TMO-03).

```ts
mergeTimeouts(current: Timeouts, patch: Record<string, unknown>): Timeouts | null   // 0, or an integer 10..3600
getTimeouts(db): Promise<Timeouts>
saveTimeouts(db, value): Promise<void>                                           // INSERT … ON CONFLICT DO UPDATE
```

```http
GET /admin/timeouts         → 200 {"first_byte_s":300,"idle_s":300}
PUT /admin/timeouts {"idle_s":60}
                            → 200 {"first_byte_s":300,"idle_s":60}
PUT /admin/timeouts {"idle_s":5}
                            → 400 {"error":"invalid_input","hint":"first_byte_s, idle_s: 0 (off) or 10 to 3600 seconds"}
```

### 2.5 Meters settle on a stream error (FR-TMO-07)

Two meters do not finish today when the body errors:

| meter | today | change |
|---|---|---|
| `usageOfStream` (`usage.ts`, Anthropic streams) | the read loop throws; `record()` turns the rejection into a zero row | catch the read error and return the usage read so far |
| `meterOpenAIStream` (`route.ts`, chat streams) | resolves only in `flush`; on an error or a cancel the promise never settles and no row is written | feed the transform from a wrapper stream that resolves the usage found so far on a read error or a cancel, then passes the error on |

```ts
// route.ts: the source the TransformStream reads
const reader = body.getReader();
const source = new ReadableStream<Uint8Array>({
  async pull(ctrl) {
    try {
      const r = await reader.read();
      if (r.done) ctrl.close(); else ctrl.enqueue(r.value);
    } catch (e) { resolve(found); ctrl.error(e); }
  },
  cancel(reason) { resolve(found); return reader.cancel(reason); },
});
```

Resolving twice is harmless (the first value wins). The Codex and Responses readers (`codex.ts`, `responses.ts`) already
end on a read error; they record zero tokens for a stream cut short. That stays a known limit.

## 3. Alternatives

| option | why not |
|---|---|
| `AbortSignal.timeout` on each `fetch` call site | about 10 modules call upstream; a missed site has no deadline. It also ends the body by total time, not idle time, so long streams would break. |
| Timeouts inside each router (`proxy.ts`, `route.ts`) | two copies, and admin, quota, models and token renewal would have none. |
| A module-level cache of the setting with a TTL | saves a D1 read, but a save would take up to the TTL to apply, and tests would need to clear it. The combo setting has no cache and is read on the same requests. |
| Read the limits in `withCustomProviders` | mixes two features in one middleware for one fewer `await`. |
| `vi.useFakeTimers()` in tests | the request path awaits real D1 I/O between timers, so advancing fake time races it. [Inference: not tried in workerd.] The `secondMs` seam is simpler. |

## 4. Risks

- **A long silent answer.** A non-streamed answer from a reasoning model can take minutes before its headers. The default
  300 s first byte allows that; an owner who sets 10 s will cut such answers. The console hint says what 0 does.
- **`new Request(req, { signal })` in workerd.** [Unverified] It is expected to keep the method, headers and body stream; a
  test with a POST body proves it.
- **Abort reaching the provider.** [Unverified] Aborting a `fetch` in workerd is expected to close the provider
  connection; the gateway does not rely on it, since it stops waiting either way.

## 5. Tests (`worker/test/timeouts.test.ts`, written first)

| test | proves |
|---|---|
| a fake provider that never answers, through `/anthropic/v1/messages`: 504, `x-gateway-timeout`, host only in the message | FR-TMO-01, NFR-TMO-01 |
| the same with two accounts: the second answers, the first is cooling down | FR-TMO-04 |
| a combo whose first target never answers: the second target's answer | FR-TMO-04 |
| a non-streamed chat body that stalls: the next target's answer | FR-TMO-05 |
| an Anthropic stream and a chat stream that send one chunk and stall: the client read fails, a usage row with the partial counts exists | FR-TMO-02, 06, 07 |
| the fake provider's request signal is aborted on each timeout | FR-TMO-03 |
| a fast answer: same status, headers and bytes; limits at 0: no deadline | NFR-TMO-02, criterion 4 |
| a caller's own `AbortSignal` still stops the request | FR-TMO-11 |
| GET/PUT `/admin/timeouts`: defaults, partial save, each bad value, sign-in required; a saved value applies on the next request | FR-TMO-08, 09, 10 |
| the log line has kind, host and seconds, and no key or path | FR-TMO-12, NFR-TMO-01 |

## 6. UI design (Settings page)

A new card **Upstream timeouts** in `web/pages/Settings.tsx`, after the Routing card. It loads on its own with
`useLoad("/timeouts")`, so a failed read shows the card's own Banner with Retry and leaves the other cards working.

```
┌ Upstream timeouts ──────────────────────────────────────────────────────┐
│ How long the gateway waits for a provider before it tries the next      │
│ account or combo model.                                                 │
│                                                                         │
│ Wait for first byte                         [   300 ]  [ Save ]         │
│ Seconds until the provider starts to answer.                            │
│ 0 turns it off; otherwise 10 to 3600.                                   │
│ ─────────────────────────────────────────────────────────────────────── │
│ Wait between chunks                         [   300 ]  [ Save ]         │
│ Seconds of silence allowed inside an answer.                            │
│ 0 turns it off; otherwise 10 to 3600.                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Rows.** `SettingRow` per limit. The control is the page's existing inline pattern (`prefs-inline`): a `Field` with the
  row title as its hidden label and `inputMode="numeric"`, then a Save `Button`. `Field` has no unit suffix, so the row
  text says "seconds". The xdev-ui settings reference
  says a text field gets Save, while a Switch or Select applies at once.
- **Validation.** Checked on Save, before the request, with the server's rule (0, or an integer 10 to 3600). A bad value
  shows the error under the field (`Field` `error`, joined to the input by `aria-describedby`) and sends nothing. Save is
  disabled while the field equals the saved value or a save is running. A 400 from the server shows the same error.
- **Feedback.** On success, `notify(t("prefs.saved"))`, the same toast as the other settings.
- **Loading.** A `Skeleton` the height of the two rows; then the fields hold the saved values.
- **Strings.** `prefs.timeouts`, `prefs.timeoutsHint`, `prefs.timeoutFirstByte`, `prefs.timeoutFirstByteHint`,
  `prefs.timeoutIdle`, `prefs.timeoutIdleHint`, `prefs.timeoutRange`, `prefs.timeoutInvalid`, in `en.ts` and `vi.ts`.
- **Accessibility.** Each input has a real label (the row title, hidden because the row shows it). The range rule is in visible text, not only
  in a placeholder. The numeric keypad comes up on phones. (Form rules from the xdev-ui settings reference and from
  ui-ux-pro-max: visible labels, `inputmode`, the error next to the field, feedback after submit.)
- **Phone (375 px).** `SettingRow` stacks the text above the control; the field and Save stay on one line.

# SRS: Upstream timeouts

Status: accepted for build, 2026-11-15. Architecture: [docs/add/upstream-timeouts.md](../add/upstream-timeouts.md).

## 1. Purpose

Today the gateway waits for a provider as long as the provider keeps the connection open. A provider that
accepts the request and never answers, or stops halfway through a stream, holds the caller until the caller
gives up. Account rotation and combo fallback never run, because they only run after an answer.

This feature puts two deadlines on every request the gateway sends to a provider, and lets the owner change
them in the console.

## 2. Scope

In scope:

- Every request sent through the `Upstream` function (`worker/proxy.ts`) and through a proxy exit's own
  fetch (`dest.fetch`, `worker/proxy-pools.ts`). That covers chat, messages, Gemini, Responses, Codex,
  media, embeddings, web tools, model lists, quota reads and token renewals.
- The settings row, the admin API and the console setting.

Out of scope (later work):

- A deadline per combo, per provider or per model.
- A cap on the total length of a stream.
- Stopping the provider request when the client disconnects.
- Retrying the same account after a timeout.

## 3. Terms

| term | meaning |
|---|---|
| first byte | The provider's response headers. `fetch` resolves when they arrive. |
| idle | Time between two body chunks, and between the headers and the first chunk. |
| account failure | A status that sets a provider account aside and moves to the next account (`accountFailure`, `worker/connections.ts`). |
| retryable | A status after which a combo moves to its next target (`retryable`, `worker/route.ts`). |

## 4. Functional requirements

| id | requirement |
|---|---|
| FR-TMO-01 | When a provider sends no response headers within the first-byte limit, the gateway stops waiting. It answers that attempt with status 504 and the JSON body `{"type":"error","error":{"type":"api_error","message":"<host> did not answer within <n> s"}}`. It also sets the header `x-gateway-timeout: first_byte`. |
| FR-TMO-02 | When the body sends no chunk within the idle limit, the gateway ends the body with an error. |
| FR-TMO-03 | On either timeout the gateway aborts its request to the provider. |
| FR-TMO-04 | A first-byte timeout is an account failure and is retryable. The account cools down, the next account is tried, and a combo moves to its next target. These are the same rules as for any 5xx. |
| FR-TMO-05 | When the body of a non-streamed chat answer goes idle before it is complete, the attempt fails as "could not reach <provider>" (502). It is an account failure and is retryable. |
| FR-TMO-06 | When a stream goes idle after bytes have reached the client, the client's stream ends with an error. No fallback runs. |
| FR-TMO-07 | A stream that the idle limit ends still writes its usage row. The row counts the tokens the meter read before the stall. Every meter settles, so no background task waits forever. |
| FR-TMO-08 | The limits are a gateway-wide setting with two values: `first_byte_s` and `idle_s`. Each is a whole number of seconds, either `0` (off) or from 10 to 3600. Both default to 300. |
| FR-TMO-09 | `GET /admin/timeouts` returns the current values, or the defaults when none are saved. `PUT /admin/timeouts` takes a partial object and returns the saved values. A bad value returns 400 `{"error":"invalid_input","hint":...}` and saves nothing. Both routes need the owner's sign-in, like the other admin routes. |
| FR-TMO-10 | A saved change applies from the next request. No redeploy is needed. |
| FR-TMO-11 | A request whose caller has already set its own abort signal still stops at that signal (for example, the 10 s proxy health test). |
| FR-TMO-12 | Each timeout writes one log line. It gives the kind (`first_byte` or `idle`), the provider host and the limit in seconds. |
| FR-TMO-13 | The console's Settings page shows the two limits in their own card. Each limit has a number field and a Save button, and a bad value shows an error under its field. |

## 5. Non-functional requirements

| id | requirement |
|---|---|
| NFR-TMO-01 | No key, token, query string or body text appears in a timeout answer, a log line or a usage row. The message names the host only. |
| NFR-TMO-02 | A request that finishes in time behaves as before: the same status, headers and bytes. The timers stop when the body ends or is cancelled. |
| NFR-TMO-03 | Reading the setting costs at most one D1 read per gateway or admin request. No new table and no migration. |
| NFR-TMO-04 | The worker tests cover each FR-TMO with a fake provider. No test waits in real time for longer than one second. |
| NFR-TMO-05 | Every console string is in `web/strings/en.ts` and `web/strings/vi.ts`. The card passes the xdev-ui audit and reads well in dark and light, at 375 px and 1440 px. |

## 6. Acceptance criteria

1. A fake provider that never answers, with `first_byte_s` set: the client gets the 504 from FR-TMO-01. When a second account or combo target exists, the client gets that target's answer instead, and the first one cools down.
2. A fake stream that sends one chunk and then stalls, with `idle_s` set: the client's read fails after about the limit. A usage row exists.
3. A fake provider that answers in time: the answer is unchanged.
4. Either limit at `0`: the gateway waits without a deadline.
5. `PUT /admin/timeouts` with `{"idle_s":5}`, `{"idle_s":3601}`, `{"idle_s":1.5}` or `{"idle_s":"300"}` returns 400. `{"idle_s":0}` and `{"idle_s":60}` return 200.
6. The console saves each limit and shows the field error for an out-of-range value, in both languages.

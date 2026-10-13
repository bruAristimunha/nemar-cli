# ADR 0099: Rate limit counters are fixed windows, and a block ends where the window does

**Status:** accepted
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0098 decision 7 recorded, and left alone, a property of the counter in `backend/src/middleware/rateLimit.ts`:
every allowed request rewrote the bucket's cache record with a fresh full window (`max-age=60`), so the window slid.
A client that never went quiet for a whole window was refused for about a minute after every `cap / rate` seconds, whatever the cap.
Measured with the real limiter, a steady 5 requests a second against a cap of 500 was refused 36.5 percent of the time and 8 a second 47.9 percent.
That is the 40 percent of `/discover` requests answered `429` in issue #1709, and it is also what a robot crawling steadily would have met.
This ADR settles what decision 7 and the last alternative of ADR 0098 left open.
It does not supersede ADR 0098, whose other decisions stand whether or not this one is taken.

## Decision

**Every counter is a fixed window.**

1. **The record carries the window's end.**
   A bucket's cache record is `{count, warned, windowEnd}`, with `windowEnd` in epoch milliseconds.
   The window starts with the first request that finds no live window and ends 60 seconds later.
   An allowed request writes the record back with the same `windowEnd` and, as the cache `max-age`, the time that remains, never a fresh minute.
   A refused request writes nothing.
   A new window starts only after the old one has ended, and a count never leaks across the boundary.
2. **A refusal says when the window ends.**
   `Retry-After` is the whole seconds left (at least 1, at most 60), `X-RateLimit-Reset` is the window's end in epoch seconds, and the JSON body's `retry_after` and message agree with both.
   Waiting exactly `Retry-After` seconds is always enough.
   Before this, `Retry-After` was a flat 60 and `Reset` was "now plus 60", neither of which was true after the first refusal.
3. **One code path.**
   `rateLimiter` and `consumeKeyedBudget` read, write and refuse through the same functions (`readRecordBody` and `interpretRecord`, `counterRecord`, `refusal`).
   That covers the anonymous, `site-ip`, `site-unattributed`, strict, data, token and Neurobagel buckets, the data plane's miss budget and the private-grant budget, and the observe-only path, where the one warning per window now resets at the boundary.
   Keys, caps, bucket names and the other headers are unchanged, and so are the admin bypass, the development bypass and `X-Test-Bypass`.
4. **Records from before, and damaged ones, cannot wedge a bucket.**
   A record with no `windowEnd` (written by the old code) keeps its count and is given a full window as the bound it reports; its cache entry still expires within a window of its last write, and a refusal never rewrites it.
   A record whose window has ended is a new window even if the cache has not dropped it yet; one that ended five seconds ago or more is also reported as `bad-end`, because an entry expires with its window.
   Only local workerd has been observed to drop it within a second of its end; how promptly Cloudflare's production cache drops an expired entry is not verified here, and nothing depends on it, since an ended window is a new window whether or not the entry is still held.
   A write abandoned at the 500 ms bound (ADR 0098) can still land afterward, so a record can outlive its `windowEnd` by the length of the stall,
   and a stall of five seconds or more can log a `bad-end` repair on top of the cache-fault line.
   The repair is right, since the window had ended; the extra line is what not waiting costs.
   An end more than one window away (a skewed clock, a damaged record) is cut to one window.
   A count that is not a finite number above zero is zero, and a body that is not JSON is replaced instead of failing the bucket open.
   A body that cannot be read at all, by contrast, says nothing about the record: it is a cache fault (fail open, logged), not a damaged record to reset.
   The repair is reported, not silent: a log line per bucket kind and kind of damage (`unparseable`, `bad-count`, `bad-end`), once per window and again at the milestones every limiter log has (ADR 0098), never the record.
   A few seconds of clock difference between isolates is cut to one window and is not called damage.

## Consequences

- **A fixed window can admit up to twice the cap across a boundary:** a full cap in the last moments of one window and another in the first moments of the next.
  That is accepted, for four reasons.
  The caps are floors against a runaway loop, not quotas, and a loop that is twice as large for one boundary is the same loop.
  The sustained ceiling is the same cap per 60 seconds it always claimed to be: a loop at hundreds of requests a second used to get its cap per minute and a few seconds, and now gets it per minute.
  Windows begin at each client's first request, not on the minute, so boundaries are not synchronized and nothing stampedes at a shared instant.
  And the buckets where doubling would matter keep their other bounds: the strict bucket's route handlers limit per email, and the miss budget is itself a tenth of the data plane's cap.
  The strict bucket does go from 10 to at most 20 across a boundary, and the per-email limits those routes enforce themselves stand.
- **Measured, 30 simulated minutes of a steady rate against the real limiter, share of requests refused:**

  | rate | sliding, cap 500 | fixed, cap 500 | sliding, cap 1000 | fixed, cap 1000 |
  |---|---|---|---|---|
  | 2 a second | 16.7 percent | 0 | 9.9 | 0 |
  | 5 a second | 36.5 | 0 | 22.2 | 0 |
  | 6 a second | 42 (model) | 0 | 25.9 | 0 |
  | 8 a second | 47.9 | 0 | 30.6 | 0 |
  | 10 a second | not measured | 16.7 | not measured | 0 |
  | 20 a second | not measured | 58.3 | not measured | 16.7 |

  With a fixed window the share refused is exactly `1 - cap / (60 * rate)` when that is positive and zero otherwise, which is what the tests assert.
  Cap 500 was a temporary edit for this table; the committed anonymous cap is 1000.
- The website's pool at its observed rate is no longer refused at all at either cap, and a crawler through `site-ip` is admitted up to 2000 requests a window and refused only beyond it.
- The window's start is per bucket, so a visitor who goes quiet and returns is in a new window as soon as the old one has ended, not a minute after their last request.
- `X-RateLimit-Reset` is now the truth, and `Retry-After` can be as small as 1.
- The counter is still a read then a write against the per-data-center Cache API, so concurrent requests can undercount a few, and a failed cache call still fails open.
  A Worker's clock moves at I/O, so the time is read after the cache lookup; isolates in one data center differ by milliseconds, and a larger skew is bounded by the cut to one window.
- A rate below the cap per window is never refused, so a cap now means what its comment always said.
  Choosing the website's caps is therefore a question about load rather than about how the counter behaves.

## Alternatives considered

- **Leave the window sliding.**
  Rejected: it is the larger part of #1709, and no cap number cures it (ADR 0098 decision 7).
- **A token or leaky bucket.**
  Avoids the doubling at a boundary, but needs a rate and a last-refill time, and changes what a cap means for every consumer of this file.
  A larger change than the defect justifies.
- **Windows aligned to the wall-clock minute.**
  A simpler key, but every client's block ends at the same instant, and a client arriving in the last second of a minute gets almost no allowance.
- **A weighted two-window estimate.**
  Smooths the boundary at the price of a second record per bucket and a count that is an estimate.
- **Only the buckets the website uses.**
  Rejected: one code path is the point, and the miss and private-grant budgets copied the same mechanics.

## Receipts

- Issue #1709; ADR 0098 decision 7 and its last alternative.
- `backend/src/middleware/rateLimit.ts` (`__CounterState`, `__readCounter`), `backend/test/rate-limit-fixed-window.test.ts`.
- The fixed-window tests fail when the window is refreshed on every allowed request again, when an ended window the cache still holds is trusted, and when `Retry-After` is a flat 60.
  Counts of failing tests are not recorded here: they change with every test added, and a number that is out of date is worse than none.
- The measurement: the real `rateLimiter` driven at a steady rate with a held clock, as ADR 0098 describes.

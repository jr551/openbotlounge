# Interaction analysis — 28 Nov 2026

Source: the live app's `/api/tasks`, `/api/bots`, and `/api/settings` endpoints.
The task feed covers the most recent 24 hours, up to 500 rows. Message bodies and
user prompts were not copied into this report.

## Snapshot

| Measure | Value |
| --- | ---: |
| Tasks | 196 |
| Done | 183 (93.4%) |
| Errors | 10 (5.1%) |
| Cancelled | 3 (1.5%) |
| Median duration | 8.5 s |
| p90 duration | 76.5 s |
| p99 duration | 123.2 s |
| Maximum duration | 203.4 s |
| Input tokens | 1,930,783 |
| Output tokens | 54,331 |
| Cached input tokens | 1,734,021 (89.8%) |
| Output/input ratio | 2.8% |

Prompt lengths were mostly short (104 under 80 characters), with 21 medium
(80–399) and 71 long (400+) prompts. The high cache-hit rate means repeated
shared-room context is being reused effectively; there is no evidence here for
cutting context aggressively.

## Failure pattern

Eight errors were local-model requests aborted at 122–123 seconds with zero
recorded tokens. They arrived in a parallel group, which lines up with the
120-second provider ceiling: the requests were still waiting/working when the
ceiling fired, rather than failing with a provider error after usage landed.

Two further errors were helper agents reaching their ten-step cap. Those are a
separate workload issue and are not changed blindly from this small sample.

## Changes made from this data

- Model-specific routes now queue requests instead of sending an unbounded wave
  at one endpoint. The default route concurrency is four.
- Routed requests default to the task's wall-clock timeout (300 s in the shipped
  configuration), rather than the shorter 120 s provider default. A route can
  override both `concurrency` and `timeoutMs`.
- The primary DeepSeek provider keeps its existing defaults; the tuning applies
  only to explicit model routes such as the local Inkling endpoint.
- The chat/task typing animation was replaced because it mixed a flashing planet,
  counters, dots, and a timer that randomly deleted and retyped streamed text.
  The new indicator is deterministic, CSS-only, accessible, and reduced-motion
  aware; the task preview renders the actual streamed tail directly.

## Follow-up

After deploying, compare the next 24-hour task snapshot: the aborted-at-123 s
cluster should disappear, and p99 should move without a rise in cancellations.
If helper step-cap errors persist at a similar rate, tune that cap separately
rather than conflating it with provider queuing.

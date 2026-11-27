# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-10: after the security read

| Promise | Test |
| --- | --- |
| A group with no active step never passes (unseeded or all switched off) | `what the security read found > never passes a group…` |
| The hash covers question, body, stop message, options, video, captions and a replaced file | `… > changes the hash with every part…` |
| A stop-message-only change fails old answers | `… > fails answers given before an editor changed only the stop message` |
| Per-language hashes; the record has the language and the question as read | `… > works out the hash per language…` |
| Duplicate option values, wrong video or captions types, a group used twice | three tests under `what the security read found` |
| No after Back withdraws a Yes | client `No after Back withdraws…` |

Gaps added: all of the above. Mutation check: 11 of 11 caught, after adding the stop-message test for the one that survived. Skipped: a real browser and screen reader (the owner's real-client batch).

## 2026-11-10: 0.1.0

| Promise | Test |
| --- | --- |
| Editors change steps; the public reads active steps only; members can't write | `steps > lets editors…` |
| A gate needs a stop message; a video needs captions | `steps > refuses a gate without…` |
| Flows list code slots and active steps in order | `flows > lists…` |
| Flows from other plugins; a duplicate stops start-up | `flows > takes flows…` |
| answersFor passes good answers and returns the record | `answers > passes…` |
| answersFor fails a No, a stopping choice, a wrong info value, missing, extra, repeated, stale, junk and unknown flows | `answers > fails closed…` |
| Answers to old wording fail once a step changes | `answers > fails answers given to the old wording…` |
| The Wizard component | `test/client/*` |

Mutation check on the server: 9 of 9 guards caught.

## 2026-11-26: 0.1.1 scope option

| Promise | Test (`test/scope.test.ts`) |
| --- | --- |
| Scope unset is 0.1.0: every step, no `req`, flow + key unique | `unset scope keeps 0.1.0 behavior` |
| Reads limited to the caller's site: Local, REST list and count, GraphQL, Local count, `flowSteps`, `answersFor` | `reads stay inside the caller's site` |
| No `req` with a scope refuses `flowSteps` and `answersFor` | `scope fails closed > refuses flowSteps and answersFor…` |
| A hook that throws, returns `{}`, `null` or an array refuses every read, write, `flowSteps` and `answersFor` | four tests under `scope fails closed` |
| Create, update, bulk update, delete and REST PATCH limited to the site; a create into or an update moving to another site is refused and leaves nothing changed | `writes stay inside the caller's site` |
| The empty-group refusal runs per site; the start-up check stays config-wide | `checks run per site` |
| `indexWith` lets two sites share a key and still refuses a repeat on one site | `indexWith`, plus the unscoped contrast in the first block |

Gaps skipped: a Postgres or SQLite adapter (the check is a plain count in the write's transaction, but only MongoDB was run), the media lookup (reads one file type, unscoped by decision), and versions (the collection has none). Failing-first: with the source change stashed, the new file's setup fails and none of its tests pass.

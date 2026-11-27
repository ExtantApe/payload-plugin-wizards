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

All of `test/scope.test.ts` runs four times: MongoDB replica set, MongoDB standalone, SQLite with default settings (no transactions) and SQLite with transactions on.

| Promise | Test |
| --- | --- |
| Scope unset is 0.1.0: every step, no `req`, flow + key unique | `unset scope keeps 0.1.0 behavior` |
| Reads limited to the caller's site: Local, REST list and count, GraphQL, Local count, `flowSteps`, `answersFor` | `reads stay inside the caller's site` |
| No `req` with a scope refuses `flowSteps` and `answersFor` | `scope fails closed > refuses flowSteps and answersFor…` |
| A hook that throws, or returns `{}`, `null`, an array, an empty or / and, an empty operator object, an empty or nested in an and, an undefined value, an empty `in`, an unknown operator, a bare value or a class instance, refuses every read, write, `flowSteps` and `answersFor` | one test per shape under `scope fails closed` |
| Create, update, bulk update, delete and REST PATCH limited to the site; a write into or moving to another site is refused before the save and leaves nothing | `writes stay inside the caller's site`, `refusals before the write, as 403` |
| A refused write is a 403 whether or not the key exists on the other site; an overrideAccess seed with no user and an overrideAccess delete are refused | `refusals before the write, as 403` |
| Access functions return the site filter or false (kills three mutants: update without the scope, create ignoring it, no plain-object check) | `the access functions themselves` |
| A video or captions from another site is refused on save and never shown | `media is looked up as the caller` |
| The empty-group refusal runs per site; the start-up check stays config-wide | `checks run per site` |
| `indexWith` lets two sites share a key and still refuses a repeat on one site; the start-up warning | `indexWith`, `start-up` |

Failing-first, as the review measured it: on main the new file's setup fails at the unique flow + key index, because two sites share a key. With that index dropped, 18 of the first 21 tests failed for the right reason and the 3 controls passed. The first build had a rollback-based write check that these tests passed on Mongo with transactions and missed on the other databases; running all four now covers that.

Gaps skipped: Postgres (the checks use no database-specific code, but only Mongo and SQLite were run) and versions (the collection has none).

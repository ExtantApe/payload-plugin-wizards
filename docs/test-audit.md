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

## 2026-11-26: scope limited to equals and in, and checked last

`test/scope.test.ts` still runs on four databases: MongoDB replica set, MongoDB standalone, SQLite with default settings and SQLite with transactions on. It now has 71 tests on each, 284 in all, and 316 with the other two files.

What changed: a scope may use only `equals` and `in` with non-empty string or number values, and the write check moved to the database adapter, where it sees the step exactly as it will be stored.

| Promise | Test |
| --- | --- |
| Each other operator is refused on every path (access functions, find, create, `flowSteps`): `not_equals`, `not_in`, `exists`, `like`, `contains`, the four comparisons, a second operator beside `equals`, an operator inside an or, and inside an and inside an or | `only equals and in…` (one test per case) |
| Empty string, null, NaN, Infinity, boolean, object and list operands to `equals`; `['']`, null, object and string operands to `in`; an empty string in an or | `only equals and in…` |
| `equals` and `in` still work alone, together, and inside and and or; a write to another site is refused with a 403 | `accepts equals and in…` |
| A stored site that is missing, null, a list or an object is refused even when its text would match (`'undefined'`, `'null'`, `'a'` for `['a']`, `{ id: 'a', toString: 'b' }`), on create and update | `refuses a stored site that is missing…` |
| `updateMany` and `upsert` on the adapter are refused while a scope is set | `refuses a bulk update or an upsert…` |
| A host field hook and a later host collection hook that set the site to another site cannot move a create or an update there, over Local; a header-driven field hook cannot, over REST (403, nothing stored, the step stays put) | `the scope is checked on the step as it will be stored…` |

Failing-first: run against the previous `src/`, 126 of the 284 scope tests failed (the new tests only; the old ones passed), and with the new `src/` all 316 pass. One older test calls `db.updateOne` with a partial step, which the adapter check now refuses, so it passes the site too.

Mutants the new tests are meant to kill: every operator outside `equals` and `in` accepted, empty or null operands accepted, the null and non-scalar guard on stored values removed, the check placed before field hooks, and the check placed before later collection hooks.

Gaps skipped: a plugin that replaces `db` after Wizards (the README says to set `db` first), Postgres, and versions (the collection has none). The repo has no lint script, so lint was not run.

## 2026-11-26: stored step, versions and drafts, plugin order

`test/scope.test.ts` now has 86 tests on each of four databases (MongoDB replica set, MongoDB standalone, SQLite default, SQLite with transactions) and 5 start-up tests that need no database, 349 in all, 381 with the other two files.

| Promise | Test |
| --- | --- |
| An update or delete checks the stored step: an `overrideAccess` update that sets the caller's site on another site's step, `db.updateOne` by id and by where, `db.deleteOne` and `db.deleteMany` that reach another site's step are refused with a 403 and change nothing; a `where` matching both sites is refused whole; own-site calls still work; no `req` is refused | `the stored step is checked too…` (6 tests) |
| With a scope set the site refuses to start if the steps have `versions: true`, drafts or drafts with autosave; with no scope they are allowed | `versions and drafts are refused…` |
| A draft or autosave write, a draft create and a REST `PATCH ?draft=true` can't move a step to another site; `findVersions` returns nothing of another site | same group (locks: they passed before, because the steps had no versions) |
| The site refuses to start when a later plugin restores the original `config.db` or wraps `create` outside the check | `plugin order…` |
| The start-up throws for a missing `db` and for an adapter without `find`, `create`, `updateOne`, `deleteOne` or `deleteMany`, and the 403 status | `guardDb refuses what it can't guard` |

Failing-first: against the previous `src/`, 38 of the 65 new tests failed (the stored-step, versions, plugin order and two adapter tests). The other 27 are locks that pass on both: the no-scope control, own-site calls, the draft and findVersions tests, and the start-up refusals that already existed. Those were checked by mutation instead: removing the missing-`db` throw, the missing-method throw, the stored-step check, the versions check or the guarded-function check, or changing 403 to 400, each makes tests fail.

Gaps skipped: Postgres, two writes at once (the stored-step check reads first and writes after), a plugin that wraps `db` before this one (it can't be detected, so the README says to list this plugin last), and the admin autosave UI.

## 2026-11-26: stored-step check by the adapter's own target

Covered, added: a `deleteOne` or `deleteMany` with an `id` next to a `where` on another site; `updateOne` with an empty or zero `id`; a `where` on a localized field in locale `es` (SQLite errored, Mongo let it through); `deleteMany` with `where: {}` inside a transaction (403, not a driver error); the scope hook called once per adapter call; the write handed a `where` that holds the scope and no `id`; a start-up refusal when a later plugin wraps `find`, `updateMany`, `upsert`, `updateOne`, `deleteOne` or `deleteMany` (dropping `updateMany` and `upsert` from the start-up check now fails two tests on each database). Skipped: concurrent writes, which need a real multi-site host.

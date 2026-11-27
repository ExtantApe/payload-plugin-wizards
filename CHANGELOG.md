# Changelog

## 0.1.1 (unreleased)

New optional `scope: { where, indexWith? }` for hosts that keep several sites in one database. `where({ req })` returns a Where that is ANDed into every read, update and delete of the steps, into `flowSteps` and `answersFor` (both take an optional `req` and refuse without one when a scope is set, `answersFor` with `noScope`), and checked after every write in the same transaction, so a step can't be created in or moved to a site the caller doesn't hold. A hook that throws, or returns anything but a non-empty plain object, refuses the call. `indexWith` adds the host's field names to the unique flow + key index. The group-with-no-active-step refusal runs per scope. With `scope` unset, behavior is exactly 0.1.0.

Tested: 21 new tests on in-memory MongoDB with two sites (53 in all, 14 + 21 server, 18 component), covering REST, GraphQL, count, Local, `flowSteps`, `answersFor`, create, update, move-out, bulk update, delete, a hook that throws or returns `{}`, `null` or an array, no `req`, the per-site empty group and a shared key with `indexWith`. Not tested: a real multi-site host, a Postgres or SQLite adapter, a real browser. Not published to npm.

## 0.1.0 (unreleased)

First version, from design 0001: guided steps edited in the admin with a content hash, flows registered by code (and by other plugins), `flowSteps`, the `<Wizard>` component (one question per screen, gates, choices, captioned video, code steps, in-memory state), and `answersFor`, which checks every answer on the server before the owner acts.

After the security read: a group of steps with no active step fails (`noSteps`); the hash is worked out per language at read time and covers the stop message, video and captions; the record carries the language and each question as read; duplicate option values, wrong file types and a group used twice are refused; No withdraws an earlier Yes.

Tested: 32 tests (14 server on in-memory MongoDB, 18 component in jsdom). Not tested: a real browser or screen reader, a real site.

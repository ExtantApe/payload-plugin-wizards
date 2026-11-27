# Changelog

## 0.1.1 (unreleased)

New optional `scope: { where, indexWith? }` for hosts that keep several sites in one database. `where({ req })` returns a filter that is ANDed into every read, update and delete access of the steps and into `flowSteps` and `answersFor` (both take an optional `req` and refuse without one when a scope is set, `answersFor` with `noScope`). Creates and updates are checked in `beforeChange` against the step as it would be saved, and deletes in `beforeDelete`, so a refused write never reaches the database, with or without transactions, and comes back as a 403. A hook that throws, or returns anything that could match everything by accident (empty `{}`, `and` or `or`, empty operator objects, undefined values, unknown operators, non-plain objects), refuses the call. Video and caption lookups run as the caller. `indexWith` adds the host's field names to the unique flow + key index, and a start-up warning appears when `scope` has no `indexWith`. The group-with-no-active-step refusal runs per scope. With `scope` unset, behavior is exactly 0.1.0.

Tested: 184 tests (14 + 18 existing, 152 for scope) on in-memory MongoDB with a replica set and standalone, and on SQLite with default settings and with transactions on, each with two sites: REST, GraphQL, count, Local, `flowSteps`, `answersFor`, create, update, move-out, bulk update, delete, every bad filter shape, no `req`, the access functions directly, media from another site, the per-site empty group, a shared key with `indexWith` and the start-up warning. Not tested: a real multi-site host, Postgres, a real browser. Not published to npm.

## 0.1.0 (unreleased)

First version, from design 0001: guided steps edited in the admin with a content hash, flows registered by code (and by other plugins), `flowSteps`, the `<Wizard>` component (one question per screen, gates, choices, captioned video, code steps, in-memory state), and `answersFor`, which checks every answer on the server before the owner acts.

After the security read: a group of steps with no active step fails (`noSteps`); the hash is worked out per language at read time and covers the stop message, video and captions; the record carries the language and each question as read; duplicate option values, wrong file types and a group used twice are refused; No withdraws an earlier Yes.

Tested: 32 tests (14 server on in-memory MongoDB, 18 component in jsdom). Not tested: a real browser or screen reader, a real site.

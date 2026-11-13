# Changelog

## 0.1.0 (unreleased)

First version, from design 0001: guided steps edited in the admin with a content hash, flows registered by code (and by other plugins), `flowSteps`, the `<Wizard>` component (one question per screen, gates, choices, captioned video, code steps, in-memory state), and `answersFor`, which checks every answer on the server before the owner acts.

After the security read: a group of steps with no active step fails (`noSteps`); the hash is worked out per language at read time and covers the stop message, video and captions; the record carries the language and each question as read; duplicate option values, wrong file types and a group used twice are refused; No withdraws an earlier Yes.

Tested: 32 tests (14 server on in-memory MongoDB, 18 component in jsdom). Not tested: a real browser or screen reader, a real site.

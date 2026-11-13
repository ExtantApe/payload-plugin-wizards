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

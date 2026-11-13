# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.

- 2026-11-10: name approved by the owner on 2026-11-10 (Wizards, collection `guided-steps`, from the platform team's answers for the kit packing station). MIT, public from its first push. Design in [architecture/0001-design.md](architecture/0001-design.md).
- 2026-11-10: answers are checked on the server against the current steps' content hashes before an owner acts, so a client can't skip a gate by posting directly, and the record says which wording was confirmed.
- 2026-11-10: component choices where the design was silent: focus moves to each new step's heading but not on first load; a chosen answer shows "(chosen)" and aria-pressed, not color alone; if `onFinish` fails, an alert says so and the buttons come back for a retry.
- 2026-11-10 (security read of 4898f71): a group of steps with no active step fails `answersFor` (`noSteps`), so an emptied or unseeded safety group never passes. The content hash is no longer stored: it's worked out per locale when a step is read and covers the stop message, video and captions (id and updatedAt). The record carries the locale and each question as read. Duplicate option values, a non-video video, non-WebVTT captions and a group used twice in a flow are refused. No withdraws an earlier Yes in the component. Test uploads go to a temp folder (`media/` is ignored).

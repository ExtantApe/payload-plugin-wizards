# 0001: Wizards design record

Status: **built** (2026-11-10), 0.1.0. The security read's changes are in `docs/decisions.md`; where this record differs, the decisions win.

## Context

The Captive Origins kit activation wizard needs:
- a gated flow: one question per screen, every step needing an answer before the next, and Back on each;
- safety steps where No stops the flow, says what to do, and keeps the step until Yes;
- a short video and a text version per step, edited in the admin;
- the confirmed answers recorded on the kit's event, so "one free retest, then it's on you" has a record of what was confirmed.

The kit packing-station plan put that in its own plugin under the owner's build-it-right rule (agnostic plugins, built right the first time), because care sheets, onboarding and event check-in have the same shape. The platform team named it, and the owner approved the name on 2026-11-10: **Wizards**, `@extantape/payload-plugin-wizards`, collection `guided-steps`.

MIT, public from its first push. Agnostic: no imports of Sample Kits or Scan.

## Decision

Wizards owns:
- the steps' content, in the admin;
- the flow on screen;
- the server-side check that every gate was answered Yes before an action runs.

What a flow does (activating a kit, marking it sampled) and where its answers go belong to whoever registers the flow.

## The steps' content: `guided-steps`

One record per step:
- `flow` (a key such as `kit-activation`), `key` (stable, such as `one-animal`), `order`;
- `question` (one line);
- `body` (plain text: the text version of the video);
- `video` (an upload, optional) with `captions` (a WebVTT upload, required when there's a video);
- `kind`: `gate` (Yes needed to go on), `info` (Next) or `choice` (options, each with a stop flag);
- `stopMessage`: what No (or a stopping choice) says, for example "Put the animal back first, then press Yes";
- `active`.

Translated like other content. Editors (`access.edit`, required) change steps; the public reads active ones.

Each step's **content hash** (question, body, kind, options, stop message, video and captions) is worked out per language when the step is read, so a recorded answer says exactly which wording was confirmed.

## Flows: registered by code

```ts
wizardsPlugin({
  flows: {
    'kit-activation': {
      // The order of slots. Content steps come from guided-steps; code steps are the site's components.
      slots: [
        { code: 'find-kit' },          // the site renders its own step (Scan's CameraScanButton, typing)
        { code: 'choose-subject' },
        { code: 'confirm' },
        { steps: 'safety' },           // every active guided-step in this flow with group 'safety', in order
        { code: 'sampled' },
      ],
    },
  },
  access: { edit },
})
```

Other plugins register flows at `config.custom.wizardFlows` with no import, as with Notifications' kinds.

## On screen: `<Wizard>` (`./client`)

- One step per screen, with focus moved to the question. "Back" on every step except the first.
- A `gate` step: Yes goes on, and No shows `stopMessage` in a polite live region and stays on the step. The answer isn't recorded as Yes until Yes is pressed.
- A video, when present, plays with captions; the text version is always on the page. Nothing autoplays with sound.
- Code steps are render props: `renderCode={{ 'find-kit': (ctx) => <FindKit {...ctx} /> }}`. `ctx.next(value)` and `ctx.back()` are provided.
- Every control is labeled, with 44px targets, a keyboard path, and screen-reader text for progress ("Step 4 of 9").
- The flow's state lives in memory only, never in web storage.

## On the server: the answers are checked, not trusted

- `answersFor(payload, { flow, answers })` checks every submitted gate against the current active steps:
  - every gate in the flow was answered Yes;
  - each answer names the content hash it saw;
  - no step is missing or extra.

  It returns `{ ok, record }` for the owner to store, or `{ ok: false, problem, key }`. It fails closed: a step changed since the screen loaded fails the check, and the person sees the new wording.
- The owner's action (`markSampled`) calls `answersFor` itself before acting, so a client can't skip a gate by posting directly.

## Adapters

- **Sample Kits:** registers `kit-activation`. Its code steps use Scan's components, and its action records the `record` on the kit's event.
- **Scan:** used inside code steps; no dependency.
- **Seed data:** `guided-steps` is a new collection. The tour needs the safety steps with text, without video until the owner's exists.

## Tests (planned)

- Steps: editors only; the public reads active steps; the content hash changes with the wording; captions are required with a video.
- `answersFor`: all gates Yes passes; a No, a missing step, an extra step or a stale hash fails; an unknown flow fails.
- Flows from other plugins; a duplicate flow key stops the site at start-up.
- `<Wizard>` (jsdom): one question per screen, focus, Back, No keeps the step and announces the stop message, code steps rendered with `ctx`, no web storage, "Step N of M".

## Rough time

These are guesses of session days, not promises: the collection and answersFor, 1; the client, 1.5; tests, the security read and docs, 1. About 3.5 in all.

# payload-plugin-wizards

Wizards for Payload: gated step-by-step flows, one question per screen with Yes needed to go on, a video and text per step edited in the admin, and the answers checked on the server and recorded.

**Status:** 0.1.0, not on npm yet. The server tests run on Payload 3.92 with an in-memory MongoDB, and the component tests in jsdom (32 tests: 14 server, 18 component). No site uses it yet, and nothing has run in a real browser.

## What it does

- **Steps in the admin** (`guided-steps`): each has a flow, a key, a group, an order and a kind:
  - **gate:** Yes needed to go on;
  - **info:** Next;
  - **choice:** options, any of which can stop the flow.

  Each step also has its question, a text version, an optional video with required captions, a stop message, and active or not.
  - Every gate and choice needs a stop message, which says what to do when the answer is No. A choice's options each need their own value.
  - A video has to be a video file, and its captions a WebVTT file.
  - Each step's content hash covers what a person confirms (question, text, kind, options, stop message, video and captions) in the language they read it. It's worked out each time a step is read, so it can't go stale.
  - Editors (`access.edit`, required) change steps. The public reads active ones only.
- **Flows are registered in code:** a list of slots, either your own code steps (finding a kit with the camera, choosing an animal) or a group of content steps. Other plugins register flows at `config.custom.wizardFlows` with no import, and a flow registered twice, or one that uses a group of steps twice, stops the site at start-up.
- **`flowSteps(payload, { flow, locale })`** gives the flow's slots, with active steps in order, for the page.
- **`<Wizard>`** (`./client`) shows one step per screen:
  - focus on the question, "Step N of M", and Back;
  - No shows the stop message and stays, and withdraws an earlier Yes on that step;
  - video with captions, never autoplaying, and the text version always shown;
  - your code steps rendered with `next` and `back`;
  - state in memory only.
- **The answers are checked on the server, not trusted.** Call `answersFor(payload, { flow, answers })` before acting. It refuses:
  - a No, or a stopping choice;
  - a missing, extra or repeated step;
  - a group of steps with no active step, so a safety group that was never seeded, is misspelled or was switched off never waves the flow through;
  - any step whose wording changed since the screen loaded;
  - a flow it doesn't know.

  Pass the `locale` the person read. It returns the record to keep with your action: the language, each step's hash and question as the person read them, the answers, and the time. The hash identifies the full wording; the plugin keeps no copy of older wording, so keep versions on `guided-steps` if you need to show a past version in full. A client can't skip a gate by posting straight to your action.

## On its own, and with others

**On its own:** Wizards needs only Payload, an `access.edit` rule, and an upload collection if your steps have videos (`media`, or `false` for none). Your site registers its flows in `flows` and renders its own code steps.

**Works with:**
- **Sample Kits:** with `adapters.wizards`, Sample Kits registers its `kit-activation` flow at `config.custom.wizardFlows` and checks the answers with `answersFor`.
- **Scan:** a code step can show Scan's `<CameraScanButton>`, for example to find a kit. Neither plugin imports the other.

**Family:** Wizards sits in the Fulfillment family, with Kitting, Restock, Sample Kits, Shipping, Scan, Labels, Custody and Sequences, though the families are a working draft and Fulfillment is due to be split into different groups.

## Install

```sh
npm install @extantape/payload-plugin-wizards
```

```ts
import { wizardsPlugin } from '@extantape/payload-plugin-wizards'

wizardsPlugin({
  flows: { 'kit-activation': { slots: [{ code: 'find-kit' }, { steps: 'safety' }, { code: 'sampled' }] } },
  access: { edit: ({ req }) => req.user?.role === 'editor' }, // required
  media: 'media', // your upload collection for videos and captions, or false
})

// In your action, before doing anything:
const check = await answersFor(payload, { flow: 'kit-activation', answers, locale })
if (!check.ok) return refuse(check.problem)
await markSampled(kit, { confirmed: check.record })
```

## Commands

```sh
npm test
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).

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
- **`flowSteps(payload, { flow, locale, req })`** gives the flow's slots, with active steps in order, for the page.
- **`<Wizard>`** (`./client`) shows one step per screen:
  - focus on the question, "Step N of M", and Back;
  - No shows the stop message and stays, and withdraws an earlier Yes on that step;
  - video with captions, never autoplaying, and the text version always shown;
  - your code steps rendered with `next` and `back`;
  - state in memory only.
- **The answers are checked on the server, not trusted.** Call `answersFor(payload, { flow, answers, req })` before acting. It refuses:
  - a No, or a stopping choice;
  - a missing, extra or repeated step;
  - a group of steps with no active step, so a safety group that was never seeded, is misspelled or was switched off never waves the flow through;
  - any step whose wording changed since the screen loaded;
  - a flow it doesn't know.

  Pass the `locale` the person read. It returns the record to keep with your action: the language, each step's hash and question as the person read them, the answers, and the time. The hash identifies the full wording; the plugin keeps no copy of older wording, so keep versions on `guided-steps` if you need to show a past version in full. A client can't skip a gate by posting straight to your action.

## Scope: one site's steps for one site

For a platform that runs several sites from one database. Unset, nothing changes: every caller sees every step, as in 0.1.0.

```ts
wizardsPlugin({
  flows,
  access: { edit },
  scope: {
    where: ({ req }) => {
      if (!req.user?.site) throw new Error('No site') // refuses plainly
      return { site: { equals: req.user.site } }
    },
    indexWith: ['site'],
  },
})
```

- **`where`** runs on every call with the request. If it throws, the call is refused. A scope may use only `equals` and `in`. `equals` takes one non-empty string or number. `in` takes a non-empty list of them. The plugin refuses everything else at every depth, so a filter can't match everything by accident or mean one thing in memory and another in a database: any other operator (`not_equals`, `not_in`, `exists`, `like`, `contains` and the comparisons), an empty string, `null` or `undefined`, a list with an empty or null entry, an empty `and` or `or`, an empty `{}`, and anything that isn't a plain object. `and` and `or` can nest. Build `or` lists so that a user with no sites throws instead of producing `{ or: [] }`. If a user's site can be an object (a populated relationship), return its id. A host that wants every site leaves `scope` unset.
- **Reads:** the scope is ANDed with what the access rules already allow, so the REST API, GraphQL, count and the Local API with `overrideAccess: false` only see the caller's steps. `flowSteps` and `answersFor` take `req` and apply the scope themselves. With a scope set and no `req` they refuse (`answersFor` answers `noScope`) and never fall back to all sites.
- **Writes:** update and delete access are limited to the caller's steps. A create or update is checked at the database adapter, on the step exactly as it will be stored, after every field hook and every collection hook, including any your own plugins add, whatever order the plugins run in. One that would leave the scope, including a move to another site, is refused with a 403 and nothing is written. That works the same with or without database transactions. The stored value of every field in the scope has to be a string or a number, so a missing, null, list or object value is refused. Put `db` in the config before this plugin runs, because the check wraps it. While a scope is set, `updateMany` and `upsert` on the adapter for the steps are refused. A delete is checked in `beforeDelete`. These checks run for `overrideAccess: true` calls too, so seeding code has to pass a `req` the hook accepts.
- **`indexWith`** adds your field names to the unique index on flow + key. Sites that share step keys need it, because without it the index is flow + key alone, so a second site can't reuse a key. Even then a duplicate key is answered with a 400 "must be unique" without `indexWith`, including for a key that only another site uses, so the answer tells a caller that the key exists elsewhere. Set `indexWith` if that matters to you. You add the field yourself, in a plugin or config that runs after Wizards (`{ name: 'site', type: 'text', required: true, index: true }`, for example); naming a field that doesn't exist stops the site at start-up. If `scope` is set without `indexWith`, a warning is logged at start-up.
- **Videos and captions:** the file-type check when a step is saved, and the files `flowSteps` returns, are looked up as the caller (`overrideAccess: false`), so a site can't attach or show another site's files. Give your media collection its own site-based read access. A file the caller can't read shows as no video.
- **Per-site checks:** the group-with-no-active-step refusal runs inside the caller's scope. A site that never seeded its safety group is refused even when another site has one. The start-up checks (a flow registered twice, a group used twice) stay across the whole config.
- **Limits:** the steps collection has no versions, so there is nothing to scope there. Tested on MongoDB (replica set and standalone) and SQLite (with and without transactions).

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

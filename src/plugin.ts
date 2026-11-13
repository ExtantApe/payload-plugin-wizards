import type { Access, Config, Plugin } from 'payload'

import { flowsOf, stepsCollection } from './steps.js'
import type { Resolved, WizardsOptions } from './types.js'

/** Wizards: gated step-by-step flows, steps edited in the admin, and answers checked on the server. */
export const wizardsPlugin =
  (options: WizardsOptions): Plugin =>
  (config: Config): Config => {
    const o: Resolved = { slug: options.slug ?? 'guided-steps', flows: options.flows ?? {}, edit: options?.access?.edit as Access, media: options.media === undefined ? 'media' : options.media, adminGroup: options.adminGroup ?? 'Wizards' }
    if (typeof o.edit !== 'function') throw new Error('Wizards: give `access.edit`, saying who may change the steps.')
    if (o.media && !(config.collections ?? []).some((c) => c.slug === o.media && c.upload)) throw new Error(`Wizards: "${o.media}" isn't an upload collection. Set \`media\`, or false for no videos.`)
    return {
      ...config,
      custom: { ...config.custom, wizards: o },
      collections: [...(config.collections ?? []), stepsCollection(o)],
      onInit: async (payload) => {
        flowsOf(payload)
        await config.onInit?.(payload)
      },
    }
  }

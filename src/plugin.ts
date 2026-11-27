import type { Access, Config, Plugin } from 'payload'

import { assertGuarded, flowsOf, guardDb, stepsCollection } from './steps.js'
import type { Resolved, WizardsOptions } from './types.js'

/** Wizards: gated step-by-step flows, steps edited in the admin, and answers checked on the server. */
export const wizardsPlugin =
  (options: WizardsOptions): Plugin =>
  (config: Config): Config => {
    const o: Resolved = { scope: options.scope, slug: options.slug ?? 'guided-steps', flows: options.flows ?? {}, edit: options?.access?.edit as Access, media: options.media === undefined ? 'media' : options.media, adminGroup: options.adminGroup ?? 'Wizards' }
    if (o.scope && typeof o.scope.where !== 'function') throw new Error('Wizards: `scope.where` must be a function.')
    if (o.scope?.indexWith && !(Array.isArray(o.scope.indexWith) && o.scope.indexWith.every((f) => typeof f === 'string' && f))) throw new Error('Wizards: `scope.indexWith` must be a list of field names.')
    if (typeof o.edit !== 'function') throw new Error('Wizards: give `access.edit`, saying who may change the steps.')
    if (o.media && !(config.collections ?? []).some((c) => c.slug === o.media && c.upload)) throw new Error(`Wizards: "${o.media}" isn't an upload collection. Set \`media\`, or false for no videos.`)
    return {
      ...config,
      db: guardDb(o, config.db),
      custom: { ...config.custom, wizards: o },
      collections: [...(config.collections ?? []), stepsCollection(o)],
      onInit: async (payload) => {
        flowsOf(payload)
        assertGuarded(o, payload)
        if (o.scope && !o.scope.indexWith?.length) payload.logger.warn('Wizards: scope is set without indexWith, so two sites can’t use the same step key. Add indexWith (and the field) if sites share keys.')
        await config.onInit?.(payload)
      },
    }
  }

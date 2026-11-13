import type { Access, Payload, PayloadRequest } from 'payload'

export type Req = Partial<PayloadRequest>

/** A slot in a flow: a code step the site renders, or every active guided step in a group, in order. */
export type Slot = { code: string } | { steps: string }
export type Flow = { slots: Slot[] }
export type FlowRegistration = { owner: string; flows: Record<string, Flow> }

/** A content step as the client gets it. */
export type Step = { key: string; group: string; kind: 'gate' | 'info' | 'choice'; question: string; body: string; video: { url: string; captionsUrl: string } | null; options: { value: string; label: string; stops: boolean }[]; stopMessage: string; hash: string }

/** What the client sends for each content step it showed: the step, the wording it saw, and the answer. */
export type Answer = { key: string; hash: string; value: string }

/** What to store with the owner's action: which wording, in which language, was confirmed, and when. */
export type WizardRecord = { flow: string; at: string; locale: string | null; answers: (Answer & { question: string })[] }

export type WizardsOptions = {
  flows?: Record<string, Flow>
  /** Who edits the steps. Required; only an answer of exactly true counts. */
  access: { edit: Access }
  /** The upload collection for videos and captions. Default 'media'; `false` for no videos. */
  media?: string | false
  slug?: string
  adminGroup?: string
}

export type Resolved = { slug: string; flows: Record<string, Flow>; edit: Access; media: string | false; adminGroup: string }
export type Ctx = { payload: Payload; req?: Req }

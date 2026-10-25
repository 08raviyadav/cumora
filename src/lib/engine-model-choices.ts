/**
 * Option list for the per-computer engine model pickers (Me page and AgentEditor).
 *
 * The catalog comes from the daemon on that computer (the only process that
 * knows which models its CLI login can actually reach), so the picker shows
 * real choices instead of asking the operator to type a vendor model id from
 * memory. A daemon that cannot enumerate (older build, custom endpoint) still
 * reports `supportsCustom`, and the picker keeps free-form entry for it.
 *
 * Only a catalog the daemon vouches for produces model rows. Two states do not:
 *
 * - `presets`: the engine never listed anything, so the ids are Cumora's
 *   compiled-in guesses about the account. Offering them means offering models
 *   the account may not run, each inheritable by every Agent — so they are not
 *   offered at all.
 * - `unverified`: a daemon that predates `trustedModels` reported a catalog
 *   after merging its presets into the provider's answer, while still labelling
 *   it `protocol`/`cli`. The tail is unvouched-for and indistinguishable from a
 *   real listing, so it is not offered either.
 *
 * Both fall back to "follow the default" plus custom entry, and the picker says
 * which of the two happened.
 *
 * Pure and React-free so the row rules can be pinned without rendering.
 */

/** Structural twin of the <Combobox> option, minus the component import. */
export interface ModelChoiceOption {
  value: string
  label: string
  hint?: string
}

export interface ModelChoiceCatalog {
  models: ReadonlyArray<{
    id: string
    label: string
    recommendedFor?: ReadonlyArray<'big' | 'small'>
  }>
  /** Absent or null both mean "the engine names no default". */
  defaultModel?: string | null
  defaultFastModel?: string | null
  /** How the daemon got this list. Absent on catalogs the app synthesises
   *  itself (a provider profile), which is why `catalogTrust` treats absent as
   *  reported rather than as a failure. */
  source?: 'protocol' | 'cli' | 'presets'
  /** Set by a daemon whose choices were explicitly configured or listed.
   *  Absent on daemons old enough to have merged their presets into a reported
   *  listing, which is the case `catalogTrust` calls `unverified`. */
  trustedModels?: boolean
  stale?: boolean
}

export type CatalogTrust = 'reported' | 'guessed' | 'unverified' | 'missing'

/**
 * How much the option list can be trusted, so the picker can say so.
 *
 * `presets` means the engine never actually listed anything — the daemon fell
 * back to ids compiled into Cumora. Those are guesses about the account, not
 * facts about it.
 *
 * `unverified` means the daemon claims a listing but does not vouch for it, so
 * it is one of the builds that appended its presets behind the provider's
 * answer. Both states offer no model rows: a model the account cannot run is a
 * runtime failure every Agent inherits, which is worse than an empty list.
 */
export function catalogTrust(catalog: ModelChoiceCatalog | undefined): CatalogTrust {
  if (!catalog) return 'missing'
  // No source at all: a profile catalog synthesised in the app, not a report.
  if (!catalog.source) return 'reported'
  // Vouched for beats how it was obtained — Claude's `opus`/`sonnet`/`haiku`
  // are aliases the CLI resolves, so the preset names models that exist even
  // when nothing was listed.
  if (catalog.trustedModels === true) return 'reported'
  return catalog.source === 'presets' ? 'guessed' : 'unverified'
}

/**
 * First row is the empty value — "no Cumora-side default" — hinted with the
 * model the engine would fall back to, so the operator can see what blank
 * actually means before choosing it.
 *
 * The hint is labelled as the *local* default on purpose: the catalog only
 * knows this computer's CLI settings, while the server may still apply a
 * deployment-level pin (`CUMORA_DEFAULT_*_MODEL`) that the app never sees.
 * Naming the model without naming where it came from would read as a promise
 * about which model actually runs.
 *
 * Nothing is quoted from a catalog we cannot vouch for — not the rows, and not
 * the default either: on an `unverified` catalog the fast default came from the
 * merged preset tail, so it names a model the account may not run.
 */
export function engineModelChoices(
  catalog: ModelChoiceCatalog | undefined,
  tier: 'big' | 'small',
  labels: {
    follow: string
    recommended: string
    localDefault: (model: string) => string
  },
): ModelChoiceOption[] {
  if (catalogTrust(catalog) !== 'reported') return [{ value: '', label: labels.follow }]
  const fallback = tier === 'big' ? catalog?.defaultModel : catalog?.defaultFastModel
  return [
    { value: '', label: labels.follow, hint: fallback ? labels.localDefault(fallback) : undefined },
    ...(catalog?.models ?? []).map((model) => ({
      value: model.id,
      label: model.label,
      hint: [
        model.label !== model.id ? model.id : null,
        model.recommendedFor?.includes(tier) ? labels.recommended : null,
      ].filter(Boolean).join(' · ') || undefined,
    })),
  ]
}

/**
 * Whether the Agent editor may offer Fast Mode for the model this Agent will
 * actually run.
 *
 * Split out of the component because the answer has two inputs that look alike
 * and are not: the model id (which the picker must resolve even when it offers
 * no rows) and the catalog's per-model `supportsFastMode` flags.
 *
 * The picker withholds rows from a catalog it cannot vouch for, but that is a
 * question about *offerability* — a model the account may not run must not be
 * suggested. Fast Mode is a question about a model already in play, and here
 * the two directions are not equally safe:
 *
 * - Ignoring a `supportsFastMode: false` because the catalog is old lets the
 *   editor enable Fast Mode on a model that refuses it, and the save persists
 *   that. Codex answers `true` for every model from the name alone, so nothing
 *   else catches it.
 * - Ignoring a `defaultModel` because the catalog is old silently resolves to
 *   "no model", which reads as "Fast Mode unsupported" — so an Agent that has
 *   Fast Mode on gets it switched off by the next unrelated edit, because the
 *   save writes the checkbox's computed value.
 *
 * So the flags and the default are honored from any catalog the daemon
 * reported. A preset tail contributes neither: presets carry no
 * `supportsFastMode` and no `defaultModel`.
 */
import { supportsNativeFastMode } from '../../shared/native-fast-mode'

export interface FastModeCatalog {
  models: ReadonlyArray<{ id: string; supportsFastMode?: boolean }>
  defaultModel?: string | null
}

export interface FastModeInput {
  engine: string
  /** The Agent's own pin. Blank means it follows the computer default. */
  model?: string | null
  /** The computer-level default configured on the Me page, if any. */
  engineDefault?: string | null
  /** What this computer's daemon reported, vouched for or not. */
  catalog?: FastModeCatalog
}

/** The model an unpinned Agent resolves to, as far as the app can know it. */
export function resolvedAgentModel({ model, engineDefault, catalog }: FastModeInput): string | undefined {
  return model?.trim() || engineDefault || catalog?.defaultModel || undefined
}

export function fastModeAvailable(input: FastModeInput): boolean {
  const resolved = resolvedAgentModel(input)
  return supportsNativeFastMode(input.engine, resolved)
    && input.catalog?.models.find((option) => option.id === resolved)?.supportsFastMode !== false
}

/** Claude can switch unsupported models to Opus when Fast Mode is enabled. */
export function supportsNativeFastMode(engine: string, model?: string | null): boolean {
  if (engine === 'codex') return true
  if (engine !== 'claude') return false
  // shortcut: Claude's catalog does not advertise Fast Mode; update when supported Opus models change.
  return /^(?:opus|claude-opus-(?:4-8|5(?:-5)?)(?:-\d{8})?)(?:\[1m\])?$/i.test(model?.trim() ?? '')
}

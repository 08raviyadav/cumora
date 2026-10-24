import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fastModeAvailable, resolvedAgentModel } from '../src/lib/agent-fast-mode.ts'
import { catalogTrust, engineModelChoices } from '../src/lib/engine-model-choices.ts'

// An old daemon: it reported a real listing but merged its presets behind it and
// does not vouch for the result, so the picker offers no rows. Fast Mode still
// has to read it — see the module doc.
const oldDaemon = {
  models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
  defaultModel: 'opus',
  defaultFastModel: null,
  source: 'cli' as const,
}

test('an old daemon still names the model an unpinned Agent runs', () => {
  // Repro from review: Claude with Fast Mode on, Agent following the computer
  // default, catalog from a daemon that predates `trustedModels`. Dropping the
  // default resolved to "no model", the editor judged Fast Mode unsupported,
  // and the next unrelated save — even just renaming — wrote
  // `nativeFastMode: false`.
  assert.equal(catalogTrust(oldDaemon), 'unverified')
  assert.equal(resolvedAgentModel({ model: '', catalog: oldDaemon }), 'opus')
  assert.equal(fastModeAvailable({ engine: 'claude', model: '', catalog: oldDaemon }), true)
})

test('an old daemon still reports a model that refuses Fast Mode', () => {
  // Repro from review: Codex pins a model its catalog marks
  // `supportsFastMode: false`. The name alone says yes for every codex model, so
  // dropping the flag let the editor offer a switch the model cannot honor.
  const codex = {
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', supportsFastMode: false },
    ],
    defaultModel: 'gpt-5.6-sol',
    defaultFastModel: null,
    source: 'protocol' as const,
  }
  assert.equal(catalogTrust(codex), 'unverified')
  assert.equal(fastModeAvailable({ engine: 'codex', model: 'gpt-5.4-mini', catalog: codex }), false)
  assert.equal(fastModeAvailable({ engine: 'codex', model: 'gpt-5.6-sol', catalog: codex }), true)
})

test('the picker withholds rows from the same catalog the Fast Mode check reads', () => {
  // The two decisions deliberately disagree: one asks "may I suggest this
  // model?", the other "is the model already in play allowed to run this way?".
  const labels = { follow: 'Follow engine default', recommended: 'Recommended', localDefault: (m: string) => `Local default: ${m}` }
  assert.deepEqual(engineModelChoices(oldDaemon, 'big', labels), [
    { value: '', label: 'Follow engine default' },
  ])
  assert.equal(fastModeAvailable({ engine: 'claude', model: '', catalog: oldDaemon }), true)
})

test('a vouched-for catalog is read the same way, and the name rule still applies', () => {
  const vouched = { ...oldDaemon, trustedModels: true }
  assert.equal(catalogTrust(vouched), 'reported')
  assert.equal(fastModeAvailable({ engine: 'claude', model: '', catalog: vouched }), true)
  // Claude's alias rule is independent of the catalog: `sonnet` is not an Opus
  // alias, so Fast Mode would switch it to Opus.
  assert.equal(fastModeAvailable({ engine: 'claude', model: 'sonnet', catalog: vouched }), false)
  // A computer-level default is the next fallback after the Agent's own pin.
  assert.equal(fastModeAvailable({ engine: 'claude', model: '', engineDefault: 'opus', catalog: undefined }), true)
  assert.equal(fastModeAvailable({ engine: 'claude', model: 'sonnet', engineDefault: 'opus' }), false)
  assert.equal(fastModeAvailable({ engine: 'cursor', model: 'opus' }), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogTrust, engineModelChoices } from '../src/lib/engine-model-choices.ts'

const labels = {
  follow: 'Follow engine default',
  recommended: 'Recommended',
  localDefault: (model: string) => `Local default: ${model}`,
}

const catalog = {
  models: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', recommendedFor: ['big' as const] },
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', recommendedFor: ['small' as const] },
  ],
  defaultModel: 'claude-sonnet-4-5',
  defaultFastModel: 'claude-haiku-4-5',
}

test('first row is the empty value, hinted with the tier default it falls back to', () => {
  const big = engineModelChoices(catalog, 'big', labels)
  const small = engineModelChoices(catalog, 'small', labels)
  assert.deepEqual(big[0], { value: '', label: 'Follow engine default', hint: 'Local default: claude-sonnet-4-5' })
  assert.deepEqual(small[0], { value: '', label: 'Follow engine default', hint: 'Local default: claude-haiku-4-5' })
})

test('the follow hint names its source, because a deployment pin can still win', () => {
  // Repro from review: this computer's CLI config says `local/main-model`, the
  // server also has CUMORA_DEFAULT_CLAUDE_MODEL=deploy/main-model, and no agent
  // or computer pin exists — so the daemon runs deploy/main-model. The catalog
  // cannot see the pin, so the hint must not read as "this is what runs".
  const local = { models: [], defaultModel: 'local/main-model', defaultFastModel: null }
  const [follow] = engineModelChoices(local, 'big', labels)
  assert.equal(follow.hint, 'Local default: local/main-model')
  assert.doesNotMatch(String(follow.hint), /^local\/main-model$/)
})

test('catalog models follow the follow row, with the id as hint only when the label differs', () => {
  const options = engineModelChoices(catalog, 'big', labels)
  assert.deepEqual(options.slice(1), [
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', hint: 'claude-sonnet-4-5 · Recommended' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', hint: undefined },
  ])
})

test('recommended marker follows the tier being configured', () => {
  const small = engineModelChoices(catalog, 'small', labels)
  assert.equal(small[2].hint, 'Recommended')
  assert.equal(small[1].hint, 'claude-sonnet-4-5')
})

test('no catalog still yields the follow row so the picker can offer custom ids', () => {
  assert.deepEqual(engineModelChoices(undefined, 'big', labels), [
    { value: '', label: 'Follow engine default' },
  ])
})

test('a preset catalog offers no rows and quotes no default', () => {
  // Gemini, qwen, zcode and maka are never probed at all: their catalog IS the
  // compiled-in preset. Those ids are guesses about the account, and one of them
  // saved as the computer default is a runtime failure every Agent inherits — so
  // the picker offers only "follow" plus the custom-entry row.
  const presets = {
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', recommendedFor: ['small' as const] },
    ],
    defaultModel: null,
    defaultFastModel: 'gemini-2.5-flash-lite',
    source: 'presets' as const,
  }
  assert.equal(catalogTrust(presets), 'guessed')
  for (const tier of ['big', 'small'] as const) {
    assert.deepEqual(engineModelChoices(presets, tier, labels), [
      { value: '', label: 'Follow engine default' },
    ])
  }
})

test('a listing from an old daemon is not offered, because its tail is preset', () => {
  // Repro from review: a daemon that predates `trustedModels` merged its presets
  // behind the provider's answer, so an account that listed only
  // `gateway/only-model` also reported `gpt-5.4-mini` — labelled `protocol`, with
  // nothing to tell the two apart. The flag is the only way to know.
  const merged = {
    models: [
      { id: 'gateway/only-model', label: 'Only Model', recommendedFor: ['big' as const] },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', recommendedFor: ['small' as const] },
    ],
    defaultModel: 'gateway/only-model',
    defaultFastModel: 'gpt-5.4-mini',
    source: 'protocol' as const,
  }
  assert.equal(catalogTrust(merged), 'unverified')
  assert.deepEqual(engineModelChoices(merged, 'big', labels), [
    { value: '', label: 'Follow engine default' },
  ])
  // The same listing from a daemon that vouches for it is offered in full.
  const vouched = { ...merged, trustedModels: true }
  assert.equal(catalogTrust(vouched), 'reported')
  assert.deepEqual(engineModelChoices(vouched, 'big', labels).map((option) => option.value), [
    '', 'gateway/only-model', 'gpt-5.4-mini',
  ])
})

test('trust distinguishes a vouched listing from a fallback and from nothing at all', () => {
  const base = { models: [], defaultModel: null, defaultFastModel: null }
  assert.equal(catalogTrust({ ...base, source: 'presets' }), 'guessed')
  assert.equal(catalogTrust({ ...base, source: 'protocol' }), 'unverified')
  assert.equal(catalogTrust({ ...base, source: 'cli' }), 'unverified')
  assert.equal(catalogTrust({ ...base, source: 'protocol', trustedModels: true }), 'reported')
  // A provider profile synthesises its own catalog in the app; there is no
  // daemon report to doubt, and it is not a preset either.
  assert.equal(catalogTrust(base), 'reported')
  assert.equal(catalogTrust(undefined), 'missing')
})

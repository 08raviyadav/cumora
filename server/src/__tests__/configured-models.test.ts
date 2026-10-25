import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverEngineModelCatalog, parseListedModels } from '../agents/computer/model-catalog.js'

test('Gemini reads JSONC model definitions, custom aliases and defaults without exporting settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-gemini-models-'))
  const file = join(root, '.gemini', 'settings.json')
  const env = { GEMINI_CLI_HOME: root }
  try {
    await mkdir(join(root, '.gemini'))
    await writeFile(file, `{
      // An engine-owned catalog, with a quoted URL and trailing commas.
      "model": {"name": "gateway/main"},
      "modelConfigs": {
        "modelDefinitions": {
          "gateway/main": {"displayName": "Main"},
          "hidden/model": {"isVisible": false},
        },
        "customAliases": {"custom/long": {"extends": "gateway/main"}},
      },
      "env": {"SECRET": "https://private.test/a//b"},
    }`)
    const catalog = await discoverEngineModelCatalog('gemini', 'fixture', true, env)
    assert.deepEqual(catalog.models.map(row => row.id), ['gateway/main', 'custom/long'])
    assert.equal(catalog.models[0].label, 'Main')
    assert.equal(catalog.prefersLocalDefault, true)
    assert.equal(catalog.defaultModel, 'gateway/main')
    assert.equal(catalog.defaultFastModel, null)
    assert.doesNotMatch(JSON.stringify(catalog), /SECRET|private\.test/)
    assert.equal((await discoverEngineModelCatalog('gemini', 'fixture', true,
      { ...env, GEMINI_MODEL: 'env/model' })).defaultModel, 'env/model')
    await writeFile(file, '{"modelConfigs":{"modelDefinitions":{}}}')
    assert.deepEqual((await discoverEngineModelCatalog('gemini', 'fixture', false, env)).models, [])
    await writeFile(file, '{partial')
    const broken = await discoverEngineModelCatalog('gemini', 'fixture', true, env)
    assert.equal(broken.stale, true)
    assert.deepEqual(broken.models, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Qwen includes unambiguous routes across endpoints within the active protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-qwen-models-'))
  const file = join(root, 'settings.json')
  const env = { QWEN_HOME: root }
  try {
    const settings = {
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'gateway/main' },
      providerProtocol: { company: 'openai' },
      modelProviders: {
        company: [
          { id: 'gateway/main', name: 'Main', baseUrl: 'https://gateway.test/v1', envKey: 'KEY' },
          { id: 'gateway/small[1m]', name: 'Small', baseUrl: 'https://gateway.test/v1', envKey: 'KEY' },
          { id: 'other-account', baseUrl: 'https://gateway.test/v1', envKey: 'OTHER_KEY' },
          { id: 'image', baseUrl: 'https://gateway.test/v1', envKey: 'KEY', imageOnly: true },
        ],
        anthropic: [{ id: 'other-protocol' }],
      },
    }
    await writeFile(file, JSON.stringify(settings))
    const catalog = await discoverEngineModelCatalog('qwen', 'fixture', true, env)
    assert.deepEqual(catalog.models.map(row => row.id), ['gateway/main', 'gateway/small[1m]', 'other-account'])
    assert.equal(catalog.models[0].label, 'Main')
    assert.equal(catalog.defaultModel, 'gateway/main')
    assert.equal(catalog.prefersLocalDefault, true)
    settings.modelProviders.company.push(
      { id: 'gateway/main', name: 'Ambiguous', baseUrl: 'https://other.test/v1', envKey: 'OTHER_KEY' },
    )
    await writeFile(file, JSON.stringify(settings))
    const ambiguous = await discoverEngineModelCatalog('qwen', 'fixture', false, env)
    assert.equal(ambiguous.models.some(row => row.id === 'gateway/main'), false)
    settings.model.name = 'image'
    await writeFile(file, JSON.stringify(settings))
    assert.equal((await discoverEngineModelCatalog('qwen', 'fixture', false, env)).models.some(row => row.id === 'image'), false)
    settings.model.name = 'gateway/main'
    settings.modelProviders.company = []
    await writeFile(file, JSON.stringify(settings))
    const changed = await discoverEngineModelCatalog('qwen', 'fixture', false, env)
    assert.deepEqual(changed.models.map(row => row.id), ['gateway/main'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ZCode preserves provider-qualified ACP selectors and desktop model deletions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-zcode-models-'))
  const env = { ZCODE_HOME: root }
  try {
    await mkdir(join(root, 'v2'))
    await writeFile(join(root, 'v2', 'config.json'), JSON.stringify({ provider: {
      company: { enabled: true, options: { apiKey: 'private-token' }, models: { deleted: {} } },
      local: { options: { baseURL: 'http://localhost:1234/v1' }, models: { 'auto/route': { name: 'Local' } } },
      unusable: { enabled: true, models: { hidden: {} } },
      'builtin:glm-coding-plan': { enabled: true, options: { apiKey: 'private-plan-key' }, models: { allowed: {}, disabled: {} } },
    } }))
    await writeFile(join(root, 'v2', 'provider_config.json'), JSON.stringify({ config: {
      modelConfigRules: { manualProviderModelRules: [
        { providerId: 'company', modelId: 'auto/route', config: { enabled: true } },
        { providerId: 'company', modelId: 'off', config: { enabled: false } },
        { providerId: 'account:glm-individual-coding-plan', modelId: 'disabled', config: { enabled: false } },
      ] },
    } }))
    const catalog = await discoverEngineModelCatalog('zcode', 'fixture', true, env)
    assert.deepEqual(catalog.models.map(row => row.id), ['company\\auto/route', 'local\\auto/route', 'builtin:glm-coding-plan\\allowed'])
    assert.doesNotMatch(JSON.stringify(catalog), /private-token|private-plan-key|localhost|deleted|unusable|disabled/)
    const pinned = await discoverEngineModelCatalog('zcode', 'fixture', false, { ...env, ZCODE_PROVIDER: 'local' })
    assert.deepEqual(pinned.models.map(row => row.id), ['local\\auto/route'])
    const defaulted = await discoverEngineModelCatalog('zcode', 'fixture', false,
      { ...env, ZCODE_PROVIDER: 'local', ZCODE_MODEL: 'auto/route' })
    assert.equal(defaulted.defaultModel, 'local\\auto/route')
    assert.deepEqual(defaulted.models.map(row => row.id), ['local\\auto/route'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native catalogs preserve context suffixes and do not parse prose into provider IDs', () => {
  for (const style of ['cursor', 'provider', 'pi', 'antigravity'] as const) {
    assert.deepEqual(parseListedModels('gateway/model[1m]', style).map(row => row.id), ['gateway/model[1m]'])
    assert.deepEqual(parseListedModels('Failed to load gateway/model', style), [])
  }
  assert.deepEqual(parseListedModels('ID  Name', 'cursor'), [])
})

test('all native listing adapters use the supplied environment, reject failed output and re-read the catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-native-models-'))
  const script = join(root, 'list.cjs')
  const bin = join(root, process.platform === 'win32' ? 'models.cmd' : 'models')
  try {
    await writeFile(script, `process.stdout.write(process.env.MODEL_LIST || ''); process.exit(Number(process.env.LIST_EXIT || 0))`)
    await writeFile(bin, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0list.cjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
    for (const engine of ['grok', 'cursor', 'opencode', 'pi', 'antigravity'] as const) {
      const env = { ...process.env, MODEL_LIST: 'gateway/model[1m]' }
      const listed = await discoverEngineModelCatalog(engine, bin, false, env)
      assert.deepEqual(listed.models.map(row => row.id), ['gateway/model[1m]'], engine)
      const changed = await discoverEngineModelCatalog(engine, bin, false, { ...env, MODEL_LIST: 'gateway/changed' })
      assert.deepEqual(changed.models.map(row => row.id), ['gateway/changed'], engine)
      const failed = await discoverEngineModelCatalog(engine, bin, true, { ...env, LIST_EXIT: '1' })
      assert.equal(failed.trustedModels, undefined, engine)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

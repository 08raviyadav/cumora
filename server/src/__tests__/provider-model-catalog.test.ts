import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { projectCodexProvider } from '../agents/computer/codex-provider.js'
import { clearModelCatalogCache, discoverEngineModelCatalog } from '../agents/computer/model-catalog.js'
import { fetchProviderModels, parseProviderModels } from '../agents/computer/provider-models.js'

afterEach(clearModelCatalogCache)

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

test('provider projection imports only the selected connection and model fields', () => {
  const result = projectCodexProvider({
    model_provider: 'gateway', model: 'auto/dfmodel',
    model_providers: {
      gateway: {
        name: 'Gateway', base_url: 'https://gateway.test/v1', wire_api: 'responses',
        env_key: 'GATEWAY_TOKEN', env_http_headers: { 'x-account': 'ACCOUNT' },
        query_params: { api_version: 'v1' }, command: 'must-not-run', auth: { command: 'must-not-run' },
      },
      inactive: { base_url: 'https://inactive.test', experimental_bearer_token: 'inactive-secret' },
    },
    hooks: { command: 'must-not-run' }, mcp_servers: { unsafe: {} }, permissions: { unsafe: true },
  }, { GATEWAY_TOKEN: 'local-secret', ACCOUNT: 'account' }, homedir())
  assert.equal(result.defaultModel, 'auto/dfmodel')
  assert.equal(result.connection?.url, 'https://gateway.test/v1/models')
  assert.equal(result.connection?.headers.Authorization, 'Bearer local-secret')
  assert.equal(result.connection?.headers['x-account'], 'account')
  assert.equal(result.prefersLocalDefault, true)
  assert.doesNotMatch(result.args.join('\n'), /must-not-run|inactive|hooks|mcp_servers|permissions/)
  assert.match(result.args.join('\n'), /model_provider="gateway"/)
  assert.match(result.args.join('\n'), /model_providers=\{/)
  assert.equal(projectCodexProvider({
    model_providers: { openai: { base_url: 'https://gateway.test', model_catalog_url: 'https://other.test/models' } },
  }, {}, homedir()).connection, null, 'never forward credentials to another catalog origin')
})

test('a Codex native backend override is projected but probed through its own protocol', () => {
  const result = projectCodexProvider({ openai_base_url: 'https://gateway.test/native', model: 'auto/main' }, {}, homedir())
  assert.equal(result.connection, null)
  assert.match(result.args.join('\n'), /openai_base_url="https:\/\/gateway.test\/native"/)
  assert.equal(result.prefersLocalDefault, true)
})

test('an explicit provider address wins over inherited OpenAI overrides without moving credentials', () => {
  const result = projectCodexProvider({
    model_provider: 'gateway',
    model_providers: { gateway: { name: 'Gateway', base_url: 'https://selected.test/v1',
      experimental_bearer_token: 'selected-token', wire_api: 'responses' } },
  }, { OPENAI_BASE_URL: 'https://other.test/v1' }, homedir())
  assert.equal(result.connection?.url, 'https://selected.test/v1/models')
  assert.equal(result.connection?.headers.Authorization, 'Bearer selected-token')
  assert.doesNotMatch(result.args.join('\n'), /other\.test/)
  assert.equal(result.ignoresOpenAIBaseEnv, true)
  const native = projectCodexProvider({ openai_base_url: 'https://runtime.test/native' },
    { OPENAI_BASE_URL: 'https://other.test' }, homedir())
  assert.match(native.args.join('\n'), /runtime\.test/)
  assert.doesNotMatch(native.args.join('\n'), /other\.test/)
})

test('protocol-only provider identities include resolved tenant and authentication environment', () => {
  const config = { model_provider: 'oauth', model_providers: { oauth: {
    name: 'OAuth', base_url: 'https://provider.test', requires_openai_auth: true,
    env_http_headers: { 'x-tenant': 'TENANT_ID' },
  } } }
  const first = projectCodexProvider(config, { TENANT_ID: 'a' }, homedir())
  const second = projectCodexProvider(config, { TENANT_ID: 'b' }, homedir())
  assert.equal(first.connection, null)
  assert.equal(second.connection, null)
  assert.notEqual(first.identity, second.identity)
})

test('HTTP catalog parsing preserves exact routes and ignores capability claims', () => {
  const result = parseProviderModels([
    { id: 'auto/dfmodel', display_name: 'Flash', supportsFastMode: true, serviceTiers: [{ id: 'fast' }] },
    { model: 'auto/dfmodel[1m]', label: 'Flash' },
    { id: 'provider/model+thinking' },
    { id: 'a/../secret' }, { id: 'model & calc' }, { id: 'model\ncontrol' }, { id: 'model@host' },
  ])
  assert.deepEqual(result.map(model => model.id), ['auto/dfmodel', 'auto/dfmodel[1m]', 'provider/model+thinking'])
  assert.ok(result.every(model => model.supportsFastMode === undefined))
})

test('HTTP discovery bounds pagination and keeps authentication on one endpoint', async () => {
  const calls: string[] = []
  const server = await serve((req, res) => {
    calls.push(req.url!)
    assert.equal(req.headers.authorization, 'Bearer fixture-token')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url!.includes('cursor=')
      ? { data: [{ id: 'auto/second' }] }
      : { data: [{ id: 'auto/first' }], next_cursor: 'page-two' }))
  })
  try {
    const models = await fetchProviderModels({ url: `${server.url}/v1/models`, headers: { Authorization: 'Bearer fixture-token' } })
    assert.deepEqual(models?.map(model => model.id), ['auto/first', 'auto/second'])
    assert.deepEqual(calls, ['/v1/models', '/v1/models?cursor=page-two'])
  } finally { await server.close() }
})

test('HTTP discovery rejects redirects, oversized responses, malformed data and repeating cursors', async () => {
  const server = await serve((req, res) => {
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { Location: '/redirect-target' })
      res.end()
    } else if (req.url?.startsWith('/large')) res.end(' '.repeat(2 * 1024 * 1024 + 1))
    else if (req.url?.startsWith('/loop')) res.end(JSON.stringify({ data: [], next_cursor: 'repeat' }))
    else res.end(JSON.stringify({ message: 'not a model catalog' }))
  })
  try {
    for (const path of ['redirect', 'large', 'loop', 'invalid']) {
      assert.equal(await fetchProviderModels({ url: `${server.url}/${path}`, headers: {} }), null)
    }
  } finally { await server.close() }
})

test('Claude without a picker supplements mappings from HTTP, retains failures and clears successful empties', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-provider-models-'))
  let mode: 'models' | 'failure' | 'empty' = 'models'
  const server = await serve((_req, res) => {
    if (mode === 'failure') { res.writeHead(503).end(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: mode === 'empty' ? [] : [
      { id: 'auto/dfmodel[1m]', display_name: 'Generic remote label' },
      { id: 'auto/dfmodel', display_name: 'Flash' },
      { id: 'remote-only', supportsFastMode: true },
    ] }))
  })
  const file = join(root, 'settings.json')
  const env = { CLAUDE_CONFIG_DIR: root }
  const write = (model = 'auto/dfmodel[1m]') => writeFile(file, JSON.stringify({
    model,
    env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_AUTH_TOKEN: 'private-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'auto/big', ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto/middle',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'auto/small' },
    hooks: { command: 'must-not-run' },
  }))
  try {
    await write()
    const catalog = await discoverEngineModelCatalog('claude', 'fixture-claude', true, env)
    assert.equal(catalog.defaultModel, 'auto/dfmodel[1m]')
    assert.equal(catalog.defaultFastModel, 'auto/small')
    assert.ok(catalog.models.some(model => model.id === 'auto/middle'))
    assert.ok(catalog.models.some(model => model.id === 'auto/big'))
    assert.ok(catalog.models.some(model => model.id === 'auto/dfmodel'))
    assert.ok(catalog.models.every(model => model.supportsFastMode === false))
    assert.doesNotMatch(JSON.stringify(catalog), /private-token|127\.0\.0\.1|must-not-run/)
    mode = 'failure'
    const failed = await discoverEngineModelCatalog('claude', 'fixture-claude', true, env)
    assert.equal(failed.stale, true)
    assert.ok(failed.models.some(model => model.id === 'remote-only'))
    mode = 'empty'
    const empty = await discoverEngineModelCatalog('claude', 'fixture-claude', true, env)
    assert.equal(empty.stale, undefined)
    assert.equal(empty.models.some(model => model.id === 'remote-only'), false)
    await write('auto/changed')
    assert.equal((await discoverEngineModelCatalog('claude', 'fixture-claude', false, env)).defaultModel, 'auto/changed')
    await writeFile(file, '{partial configuration')
    const partial = await discoverEngineModelCatalog('claude', 'fixture-claude', true, env)
    assert.equal(partial.stale, true)
    assert.deepEqual(partial.models, [], 'unknown connection identity cannot borrow an earlier directory')
    const switchedPartial = await discoverEngineModelCatalog('claude', 'fixture-claude', true,
      { ...env, ANTHROPIC_BASE_URL: 'https://other.example.test' })
    assert.deepEqual(switchedPartial.models, [])
    // A different connection never inherits the previous connection's cached choices.
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'settings.json'), JSON.stringify({ model: 'other/only' }))
    const switched = await discoverEngineModelCatalog('claude', 'fixture-claude', false, { CLAUDE_CONFIG_DIR: other })
    assert.equal(switched.models.some(model => model.id.startsWith('auto/')), false)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an explicit Claude picker is authoritative, including variants and a successful empty picker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-picker-'))
  let calls = 0
  const server = await serve((_req, res) => {
    calls++
    res.end(JSON.stringify({ data: [{ id: 'auto/route' }] }))
  })
  const file = join(root, 'settings.json')
  const env = { CLAUDE_CONFIG_DIR: root }
  const write = (options: unknown[]) => writeFile(file, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: server.url }, modelPicker: { options },
  }))
  try {
    await write([{ model: 'auto/route[1m]', label: 'Native route' }])
    const catalog = await discoverEngineModelCatalog('claude', 'fixture', true, env)
    assert.deepEqual(catalog.models.map(row => row.id), ['auto/route[1m]'])
    assert.equal(catalog.stale, undefined)
    await write([{ model: 'auto/route', label: 'Plain' }, { model: 'auto/route[1m]', label: 'Long' }])
    assert.equal((await discoverEngineModelCatalog('claude', 'fixture', false, env)).models.length, 2)
    await write([])
    assert.deepEqual((await discoverEngineModelCatalog('claude', 'fixture', false, env)).models, [])
    assert.equal(calls, 0, 'an engine picker must not be inflated by a generic namespace')
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

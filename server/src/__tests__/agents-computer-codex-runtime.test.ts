import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { codexAuthFingerprint, codexRuntimeEnv, codexRuntimeHome, CODEX_SESSION_SCOPE } from '../agents/computer/codex-runtime.js'
import { migrateCodexSession, migrateCodexSessions } from '../agents/computer/codex-session-migration.js'
import { getAdapter } from '../agents/computer/engine.js'
import { clearModelCatalogCache, discoverEngineModelCatalog } from '../agents/computer/model-catalog.js'
import { EngineSessionStore } from '../agents/computer/session-store.js'
import { runWithSessionRecovery } from '../agents/computer/session-recovery.js'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'
const original = { ...process.env }
let root: string
let bin: string
let capture: string
let source: string
let destination: string
let pointers: string
const id = '00000000-0000-4000-8000-000000000001'
const revision = '00000000-0000-4000-8000-000000000002'
const other = '00000000-0000-4000-8000-000000000003'
const sqliteModule = 'node:sqlite'
const sqlite = await import(sqliteModule).catch(() => null)

// Real child processes verify the environment at the process boundary, not
// just the output of an argv builder. No authentication or model calls.
const fakeCodex = `
const fs = require('node:fs')
const record = value => fs.appendFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(value) + '\\n')
let authAccount
try { authAccount = JSON.parse(fs.readFileSync(require('node:path').join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).tokens?.account_id } catch {}
record({ argv: process.argv.slice(2), home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME, authAccount })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
if (process.argv.includes('--version')) {
  const versionCalls = fs.readFileSync(process.env.CODEX_TEST_CAPTURE, 'utf8').trim().split('\\n')
    .map(line => JSON.parse(line)).filter(call => call.argv?.includes('--version')).length
  if (versionCalls <= Number(process.env.CODEX_TEST_VERSION_FAILURES || 0)) process.exit(1)
  process.stdout.write('codex-cli 0.160.0\\n')
} else if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line)
    record(m)
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'model/list') send({ id: m.id, result: { data: [{ id: 'fixture', model: 'fixture', isDefault: true }] } })
    if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId || 'fixture-thread' } } })
    if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1' } } })
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    }
  })
} else if (process.argv.includes('exec')) {
  process.stdin.resume()
  process.stdin.on('end', () => {
    if (!process.argv.includes('--json')) return process.stdout.write('ok\\n')
    if (process.argv.includes('resume') && process.env.CODEX_TEST_RESUME_FAILURE) {
      send({ type: 'turn.failed', error: { message: 'No session found with id: missing-thread' } })
      return
    }
    const resume = process.argv.indexOf('resume')
    send({ type: 'thread.started', thread_id: resume < 0 ? 'fixture-thread' : process.argv[resume + 1] })
    send({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 5, output_tokens: 3 } })
  })
}
`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cumora-codex-runtime-'))
  bin = join(root, 'bin')
  capture = join(root, 'calls.jsonl')
  await mkdir(bin)
  process.env.HOME = root
  process.env.USERPROFILE = root
  source = join(root, 'personal-codex')
  destination = codexRuntimeHome()
  pointers = join(root, '.cumora', 'sessions')
  process.env.PATH = `${bin}${delimiter}${original.PATH ?? original.Path ?? ''}`
  process.env.CODEX_HOME = source
  process.env.CODEX_SQLITE_HOME = join(root, 'personal-databases')
  process.env.CODEX_TEST_CAPTURE = capture
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '0'
  delete process.env.CUMORA_CODEX_ARGS
  delete process.env.CUMORA_TRIAGE_ARGS
  delete process.env.CUMORA_CODEX_NO_APP_SERVER
  const script = join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  await mkdir(join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
  await writeFile(script, fakeCodex)
  if (IS_WIN) {
    await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`)
  } else {
    await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec node "${script}" "$@"\n`)
    await chmod(join(bin, 'codex'), 0o755)
  }
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  clearModelCatalogCache()
  await rm(root, { recursive: true, force: true })
})

async function calls(): Promise<Array<Record<string, any>>> {
  return (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

function runComputer(flag: string, env = process.env) {
  return execFileAsync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../cli-bin.ts', import.meta.url)),
    'agent', 'computer', flag], { env, windowsHide: true, timeout: 15_000 })
}

async function writeAuth(home: string, account: string): Promise<string> {
  await mkdir(home, { recursive: true })
  const path = join(home, 'auth.json')
  await writeFile(path, JSON.stringify({ tokens: { account_id: account, access_token: `fixture-${account}` } }), { mode: 0o600 })
  return path
}

test('Codex environment overrides personal storage without mutating the parent or copying personal data', async () => {
  const env = { ...process.env }
  const child = codexRuntimeEnv(env)
  assert.equal(child.CODEX_HOME, join(root, '.cumora', 'codex-runtime'))
  assert.equal(child.CODEX_SQLITE_HOME, child.CODEX_HOME)
  assert.equal(env.CODEX_HOME, join(root, 'personal-codex'))
  assert.equal(process.env.CODEX_HOME, env.CODEX_HOME)
  assert.deepEqual(await readdir(child.CODEX_HOME!), [])
})

test('authentication stays shared in both directions without sharing personal config or history', async () => {
  const personal = await writeAuth(source, 'original-account')
  await writeFile(join(source, 'config.toml'), 'personal settings')
  await writeFile(join(source, 'history.jsonl'), 'personal history')
  codexRuntimeEnv()
  const runtime = join(destination, 'auth.json')
  codexRuntimeEnv({ ...process.env, CODEX_HOME: IS_WIN ? destination.toUpperCase() : destination })
  const alias = join(root, 'runtime-alias')
  await symlink(destination, alias, IS_WIN ? 'junction' : 'dir')
  codexRuntimeEnv({ ...process.env, CODEX_HOME: alias })
  assert.equal(JSON.parse(await readFile(join(destination, 'auth.shared.json'), 'utf8')).source, personal)
  assert.equal((await lstat(runtime)).ino, (await lstat(personal)).ino)
  assert.equal(await readFile(runtime, 'utf8'), await readFile(personal, 'utf8'))
  const before = codexAuthFingerprint()
  await writeAuth(destination, 'runtime-refreshed-token')
  assert.equal(await readFile(personal, 'utf8'), await readFile(runtime, 'utf8'))
  await writeAuth(source, 'personal-refreshed-token')
  assert.equal(await readFile(runtime, 'utf8'), await readFile(personal, 'utf8'))
  assert.notEqual(codexAuthFingerprint(), before)
  assert.deepEqual(await readdir(destination), ['auth.json', 'auth.shared.json'])
  assert.equal(await readFile(join(source, 'config.toml'), 'utf8'), 'personal settings')
  assert.equal(await readFile(join(source, 'history.jsonl'), 'utf8'), 'personal history')
})

test('hard-linked authentication follows atomic replacement, logout and login after restart', async () => {
  const personal = await writeAuth(source, 'original-account')
  codexRuntimeEnv()
  const runtime = join(destination, 'auth.json')
  const replacement = await writeAuth(join(root, 'replacement'), 'new-account')
  await rename(replacement, personal)
  codexRuntimeEnv()
  assert.equal(await readFile(runtime, 'utf8'), await readFile(personal, 'utf8'))
  await rm(personal)
  assert.equal(codexAuthFingerprint(), null)
  await assert.rejects(readFile(runtime), { code: 'ENOENT' })
  await writeAuth(source, 'signed-in-again')
  // A new process must reconstruct the binding from disk, not an in-memory cache.
  await runComputer('--codex-login')
  assert.equal(await readFile(runtime, 'utf8'), await readFile(personal, 'utf8'))
  assert.equal((await calls()).find(call => call.argv?.includes('login'))!.authAccount, 'signed-in-again')
})

test('an independent runtime login is preserved, including replacement of a previously shared file', async () => {
  const personal = await writeAuth(source, 'personal-account')
  const runtime = await writeAuth(destination, 'independent-account')
  const independent = await readFile(runtime, 'utf8')
  codexRuntimeEnv()
  assert.equal(await readFile(runtime, 'utf8'), independent)
  await assert.rejects(readFile(join(destination, 'auth.shared.json')), { code: 'ENOENT' })
  await rm(runtime)
  codexRuntimeEnv()
  const replacement = await writeAuth(join(root, 'independent'), 'replacement-account')
  await rename(replacement, runtime)
  codexRuntimeEnv()
  assert.equal(JSON.parse(await readFile(runtime, 'utf8')).tokens.account_id, 'replacement-account')
  assert.equal(JSON.parse(await readFile(personal, 'utf8')).tokens.account_id, 'personal-account')
  await assert.rejects(readFile(join(destination, 'auth.shared.json')), { code: 'ENOENT' })
})

test('unreadable shared-auth metadata fails closed without replacing either login', async () => {
  const personal = await writeAuth(source, 'personal-account')
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'auth.shared.json'), '{private-invalid-metadata')
  assert.throws(() => codexRuntimeEnv(), /Invalid Codex authentication link metadata/)
  assert.equal(JSON.parse(await readFile(personal, 'utf8')).tokens.account_id, 'personal-account')
  await assert.rejects(readFile(join(destination, 'auth.json')), { code: 'ENOENT' })
})

test('a changed personal home cannot resurrect authentication from the previous home', async () => {
  await writeAuth(source, 'old-account')
  codexRuntimeEnv()
  const nextHome = join(root, 'next-personal-home')
  const env = { ...process.env, CODEX_HOME: nextHome }
  codexRuntimeEnv(env)
  assert.equal(codexAuthFingerprint(), null)
  await writeAuth(nextHome, 'new-account')
  codexRuntimeEnv(env)
  assert.equal(JSON.parse(await readFile(join(destination, 'auth.json'), 'utf8')).tokens.account_id, 'new-account')
})

test('exec, triage, doctor and catalog share the isolated home in secure and compatibility modes', async () => {
  await writeAuth(source, 'shared-account')
  const adapter = getAdapter('codex')
  for (const mode of ['0', '1']) {
    process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = mode
    const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
    const signal = AbortSignal.timeout(10_000)
    const turn = await adapter.run({ home: root, env, prompt: 'hello', onLog() {}, signal })
    assert.equal(turn.exitCode, 0, turn.error)
    await adapter.classify({ cwd: root, env, prompt: 'triage', signal })
    await adapter.probe({ cwd: root, env, tier: 'small', signal })
    const catalog = await discoverEngineModelCatalog('codex', join(bin, IS_WIN ? 'codex.cmd' : 'codex'), true, env)
    assert.equal(catalog.defaultModel, 'fixture')
  }
  const spawns = (await calls()).filter(call => call.argv)
  assert.equal(spawns.length, 8)
  for (const call of spawns) {
    assert.equal(call.home, codexRuntimeHome())
    assert.equal(call.sqlite, codexRuntimeHome())
    assert.equal(call.authAccount, 'shared-account')
    assert.ok(call.argv.includes('memories.generate_memories=false'))
    assert.ok(call.argv.includes('memories.use_memories=false'))
  }
  const execs = spawns.filter(call => call.argv.includes('exec'))
  assert.deepEqual(execs.map(call => call.argv.includes('--ephemeral')), [false, true, true, false, true, true])
})

test('one-shot turns save and resume the same thread, including after a session store restart', async () => {
  const adapter = getAdapter('codex')
  const store = new EngineSessionStore(pointers, 'atlas', 'codex', CODEX_SESSION_SCOPE)
  const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
  for (const mode of ['0', '1']) {
    process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = mode
    for (let i = 0; i < 2; i++) {
      const reloaded = new EngineSessionStore(pointers, 'atlas', 'codex', CODEX_SESSION_SCOPE)
      const hops: unknown[] = []
      const result = await adapter.run({
        home: root, env, prompt: 'hello', model: 'fixture-model',
        resumeSessionId: await reloaded.load(), onLog() {}, onHopUsage: hop => hops.push(hop),
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(result.exitCode, 0, result.error)
      assert.equal(result.sessionId, 'fixture-thread')
      assert.deepEqual(result.usage, { input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 3 })
      assert.equal(hops.length, 1)
      await store.save(result.sessionId!)
    }
  }
  const execs = (await calls()).filter(call => call.argv?.includes('exec'))
  assert.deepEqual(execs.map(call => call.argv.includes('resume')), [false, true, true, true])
  for (const call of execs) {
    assert.ok(call.argv.includes('--json'))
    assert.equal(call.argv.at(-1), '-')
    assert.equal(call.argv.includes('--ephemeral'), false)
  }
})

test('one-shot resume failures use the existing fresh-session recovery instead of returning success', async () => {
  const adapter = getAdapter('codex')
  let resets = 0
  const result = await runWithSessionRecovery({
    resumeSessionId: 'missing-thread',
    reset: async () => { resets++ },
    run: resumeSessionId => adapter.run({
      home: root,
      env: { ...process.env, CODEX_TEST_RESUME_FAILURE: '1', CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') },
      prompt: 'hello', resumeSessionId, onLog() {}, signal: AbortSignal.timeout(10_000),
    }),
  })
  assert.equal(resets, 1)
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'fixture-thread')
})

test('custom Codex arguments cannot re-enable native memory', async () => {
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  process.env.CUMORA_TRIAGE_ARGS = '-c memories.generate_memories=true -c memories.use_memories=true'
  process.env.CUMORA_CODEX_ARGS = `--json ${process.env.CUMORA_TRIAGE_ARGS}`
  const adapter = getAdapter('codex')
  const env = { ...process.env }
  const signal = AbortSignal.timeout(10_000)
  await adapter.run({ home: root, env, prompt: 'hello', onLog() {}, signal })
  await adapter.classify({ cwd: root, env, prompt: 'triage', signal })
  await adapter.probe({ cwd: root, env, tier: 'big', signal })
  const records = await calls()
  assert.equal(records[0].argv.filter((arg: string) => arg === '--json').length, 1)
  assert.equal(records[2].argv.includes('--model'), false)
  assert.equal(records[2].argv.includes('memories.generate_memories=true'), false)
  for (const call of records.filter(call => call.argv)) {
    for (const key of ['generate_memories', 'use_memories']) {
      assert.ok(call.argv.lastIndexOf(`memories.${key}=false`) > call.argv.lastIndexOf(`memories.${key}=true`))
    }
  }
})

test('persistent sessions resume the same thread after restart; wake probes are ephemeral', { skip: IS_WIN }, async () => {
  const adapter = getAdapter('codex')
  const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
  let id: string | null = null
  for (let i = 0; i < 2; i++) {
    const session = adapter.startSession!({ home: root, env, resumeSessionId: id, onLog() {} })
    assert.ok(session)
    try {
      const result = await session.send('hello')
      assert.equal(result.exitCode, 0)
      assert.equal(session.sessionId, 'fixture-thread')
      id = session.sessionId
    } finally { await session.stop() }
  }
  assert.equal((await adapter.probeWake!({ cwd: root, env, signal: AbortSignal.timeout(10_000) })).ok, true)
  const records = await calls()
  assert.deepEqual(records.filter(call => call.method === 'thread/resume').map(call => call.params.threadId), ['fixture-thread'])
  assert.deepEqual(records.filter(call => call.method === 'thread/start').map(call => call.params.ephemeral ?? false), [false, true])
  for (const call of records.filter(call => call.argv)) {
    assert.equal(call.home, codexRuntimeHome())
    assert.ok(call.argv.includes('memories.generate_memories=false'))
    assert.ok(call.argv.includes('memories.use_memories=false'))
    assert.ok(call.argv.includes('default_permissions="cumora"'))
  }
})

test('persistent sessions finish active turns and then resume with a changed or removed login', { skip: IS_WIN }, async () => {
  const personal = await writeAuth(source, 'original-account')
  const adapter = getAdapter('codex')
  const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
  const logs: string[] = []
  const session = adapter.startSession!({ home: root, env, onLog: line => logs.push(line) })!
  try {
    assert.equal((await session.send('hello')).exitCode, 0)
    const auth = await readFile(personal, 'utf8')
    writeFileSync(personal, '{partial credential write')
    assert.equal(session.alive, true)
    writeFileSync(personal, auth)
    const turn = session.send('finish this turn')
    writeFileSync(personal, JSON.stringify({ tokens: { account_id: 'new-account' } }))
    assert.equal(session.alive, true)
    assert.equal((await turn).exitCode, 0)
    assert.equal(session.alive, false)
    assert.equal(session.sessionId, 'fixture-thread')
  } finally { await session.stop() }
  const resumed = adapter.startSession!({ home: root, env, resumeSessionId: session.sessionId, onLog: line => logs.push(line) })!
  try {
    assert.equal((await resumed.send('continue')).sessionId, 'fixture-thread')
    await rm(personal)
    assert.equal(resumed.alive, false)
  } finally { await resumed.stop() }
  assert.ok(logs.some(line => line.includes('login changed')))
  assert.equal((await calls()).filter(call => call.argv?.includes('app-server'))[1].authAccount, 'new-account')
})

test('the login command uses the dedicated home and exits without pairing or starting a daemon', async () => {
  if (IS_WIN) process.env.PATH = `${bin}${delimiter}${join(process.env.SystemRoot!, 'System32')}`
  await runComputer('--codex-login')
  const records = await calls()
  assert.ok(records.some(call => call.argv?.includes('--version')))
  const login = records.find(call => call.argv?.includes('login'))!
  assert.deepEqual(login.argv, ['login'])
  assert.equal(login.home, codexRuntimeHome())
  assert.equal(login.sqlite, codexRuntimeHome())
  assert.deepEqual(await readdir(join(root, '.cumora')), ['codex-runtime'])
})

test('login retries an inconclusive version probe without misreporting an installed CLI as missing', async () => {
  for (const failures of [2, 3]) {
    await rm(capture, { force: true })
    const result = runComputer('--codex-login', { ...process.env, CODEX_TEST_VERSION_FAILURES: String(failures) })
    if (failures === 2) await result
    else await assert.rejects(result, error => {
      const detail = error as Error & { code: number; stderr: string }
      assert.equal(detail.code, 2)
      assert.match(detail.stderr, /found on PATH.*version could not be verified/)
      assert.doesNotMatch(detail.stderr, /npm install|unavailable on PATH/)
      return true
    })
    const records = await calls()
    assert.equal(records.filter(call => call.argv?.includes('--version')).length, 3)
    assert.equal(records.some(call => call.argv?.includes('login')), failures === 2)
  }
})

test('login without Codex reports installation instructions without an uncaught stack', async () => {
  const emptyPath = join(root, 'empty-path')
  await mkdir(emptyPath)
  await assert.rejects(runComputer('--codex-login', { ...process.env, PATH: emptyPath }), error => {
    const result = error as Error & { code: number; stderr: string }
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Codex CLI is unavailable on PATH.*npm install -g @openai\/codex/)
    assert.doesNotMatch(result.stderr, /\n\s+at |UnhandledPromiseRejection/)
    return true
  })
})

test('migration copies only referenced rollouts, preserves IDs and personal data, and is repeatable', async () => {
  const name = join('2026', '10', '03', originalName)
  const path = await rollout(name, { id, cwd: join(root, '.cumora', 'agents', 'atlas') })
  const transcript = await readFile(path, 'utf8')
  await writeFile(join(source, 'auth.json'), 'private-auth')
  await writeFile(join(source, 'sessions', 'personal.jsonl'), 'private-chat')
  const legacy = await pointer()
  const store = new EngineSessionStore(pointers, 'atlas', 'codex', CODEX_SESSION_SCOPE)
  const result = await runComputer('--migrate-codex-sessions')
  assert.match(result.stdout, /Migrated 1 Codex session/)
  assert.equal(await readFile(join(destination, 'sessions', name), 'utf8'), transcript)
  assert.equal(await store.load(), id)
  assert.equal(await readFile(`${legacy}.migrated`, 'utf8'), id)
  assert.equal(await readFile(path, 'utf8'), transcript)
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), 'private-auth')
  assert.deepEqual(await readdir(codexRuntimeHome()), ['sessions'])
  assert.deepEqual(await migrateCodexSessions(), [])
  await store.save('newer-thread')
  // Retries preserve newer sessions; resets must not resurrect a legacy thread.
  await pointer()
  assert.deepEqual(await migrateCodexSessions(), [])
  assert.equal(await store.load(), 'newer-thread')
  await store.save(null)
  assert.deepEqual(await migrateCodexSessions(), [])
  assert.equal(await store.load(), null)
  await pointer('atlas', ' \n ')
  assert.deepEqual(await migrateCodexSessions(), [])
  assert.equal(await store.load(), null)
})

test('an unavailable legacy rollout fails migration without switching the session pointer', async () => {
  await pointer('atlas', 'missing-thread')
  await assert.rejects(migrateCodexSessions(), /old session pointer has been preserved/)
  assert.deepEqual(await readdir(join(pointers, 'atlas')), ['codex.session'])
})

test('daemon migrates automatically, isolates failures, deduplicates retries and recovers without restart', async () => {
  const agentThreads = [['blocked', revision], ['healthy', id]]
  const missingRollout = `rollout-2026-10-03T00-00-00-${revision}.jsonl`
  await rollout(originalName, { id })
  for (const [agent, thread] of agentThreads) await pointer(agent, thread)
  await writeFile(join(root, '.cumora', 'computer.json'), JSON.stringify({
    serverUrl: 'http://fixture.local', computerId: 'fixture-computer', deviceToken: 'fixture-token',
  }))

  const script = (recover: boolean) => `
    import assert from 'node:assert/strict'
    import { writeFile, access } from 'node:fs/promises'
    const { ENGINE_IDS, getAdapter } = await import(${JSON.stringify(new URL('../agents/computer/engine.ts', import.meta.url).href)})
    // Do not probe engines installed on the developer's machine.
    for (const id of ENGINE_IDS) if (id !== 'codex') getAdapter(id).bin = 'cumora-fixture-missing-' + id
    const { runComputerDaemon } = await import(${JSON.stringify(new URL('../agents/computer/daemon.ts', import.meta.url).href)})
    const errors = []
    const logError = console.error
    console.error = (...args) => { errors.push(args.join(' ')); logError(...args) }
    const connected = new Set()
    let scans = 0
    let notices = 0
    let noticeAttempts = 0
    let blockedTokens = 0
    let pendingConversation = 'fixture-conversation'
    const interval = globalThis.setInterval
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60_000 ? 40 : ms, ...args)
    const agents = ['blocked', 'healthy', 'new-user'].map(id => ({
      id, name: id, engine: 'codex', role: null, systemPrompt: null, model: null, fastModel: null,
    }))
    // Exercise real daemon reconciliation and runners without a backend,
    // credentials, messages or model calls. All fetches stay inside this fixture.
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname
      if (path === '/api/computers/me/agents') { scans++; return Response.json(agents) }
      if (path.endsWith('/runtime-token')) {
        if (path.split('/')[3] === 'blocked') blockedTokens++
        return Response.json({ token: path.split('/')[3], expiresInSeconds: 3600 })
      }
      if (path === '/runtime/inbox') return Response.json({ rows: [{ conversation_id: pendingConversation }] })
      if (path === '/runtime/notices') {
        if (++noticeAttempts === 1) return new Response('', { status: 503 })
        const body = JSON.parse(options.body)
        assert.match(body.text, /Codex session could not be migrated/)
        assert.match(body.text, /migrate-codex-sessions/)
        assert.match(body.dedupeKey, /codex_migration_failed:blocked:/)
        notices++
        return Response.json({ posted: true })
      }
      if (path.endsWith('wake-stream')) connected.add(options.headers.Authorization.slice(7))
      if (path.endsWith('stream')) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })
      if (path === '/api/computers/heartbeat' || path === '/api/computers/me/engines') return Response.json({})
      throw new Error('Unexpected fixture request: ' + path)
    }
    const waitFor = async (condition) => {
      const deadline = Date.now() + 8000
      while (!condition()) {
        assert.ok(Date.now() < deadline, 'daemon did not reach expected state: ' + [...connected] + '; scans=' + scans)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await runComputerDaemon([])
    await waitFor(() => scans >= 4 && connected.has('healthy') && connected.has('new-user'))
    if (${recover}) {
      assert.equal(connected.has('blocked'), false)
      assert.equal(errors.filter(line => line.includes('blocked paused:')).length, 1)
      assert.equal(notices, 1)
      assert.equal(noticeAttempts, 2)
      assert.equal(blockedTokens, 1)
      pendingConversation = 'new-conversation'
      await waitFor(() => notices === 2)
      assert.equal(noticeAttempts, 3)
      assert.equal(blockedTokens, 1)
      await assert.rejects(access(${JSON.stringify(join(root, '.cumora', '.runtime-cli-ipc', 'blocked'))}), { code: 'ENOENT' })
      await writeFile(${JSON.stringify(join(source, 'sessions', missingRollout))}, ${JSON.stringify(`${JSON.stringify({ type: 'session_meta', payload: { id: revision } })}\n`)})
      await waitFor(() => connected.has('blocked'))
      assert.equal(errors.filter(line => line.includes('blocked paused:')).length, 1)
      assert.equal(notices, 2)
    } else {
      await waitFor(() => connected.has('blocked'))
      assert.deepEqual(errors, [])
    }
    assert.equal(process.exitCode, undefined)
    process.exit(0)
  `
  for (const recover of [true, false]) {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script(recover)], {
      env: process.env, windowsHide: true, timeout: 15_000,
    })
    assert.match(result.stdout, /healthy restored codex session/)
    assert.match(result.stdout, /blocked restored codex session/)
    assert.doesNotMatch(result.stderr, /new-user paused:/)
    for (const [agent, thread] of agentThreads) {
      assert.equal(await new EngineSessionStore(pointers, agent, 'codex', CODEX_SESSION_SCOPE).load(), thread)
      assert.equal(await readFile(join(pointers, agent, 'codex.session.migrated'), 'utf8'), thread)
    }
    for (const name of [originalName, missingRollout]) {
      assert.equal(await readFile(join(destination, 'sessions', name), 'utf8'), await readFile(join(source, 'sessions', name), 'utf8'))
    }
  }
})

async function pointer(agent = 'atlas', thread = id): Promise<string> {
  const path = join(pointers, agent, 'codex.session')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, thread)
  return path
}

async function rollout(name: string, metadata: Record<string, unknown>, directory = 'sessions', prefix = ''): Promise<string> {
  const path = join(source, directory, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, prefix + JSON.stringify({ type: 'session_meta', payload: metadata }) + '\n')
  return path
}

const originalName = `rollout-2026-10-03T00-00-00-${id}.jsonl`
const revisedName = `rollout-2026-10-06T00-00-00-${id}_${revision}.jsonl`
// A Zstandard-compressed metadata record, generated once with Node's encoder.
const compressedMetadata = Buffer.from('KLUv/SBQPQIAlAN7InR5cGUiOiJzZXNzaW9uX21ldGEiLCJwYXlsb2FkIjp7ImlkIjoiMC0tNDAwMC04MDAwMSJ9fQoEADsJoISphJsMlAE=', 'base64')

test('migration selects the revised rollout and leaves unrelated history behind', async () => {
  await pointer()
  await rollout(originalName, { id, version: 'obsolete' })
  const latest = await rollout(revisedName, { id, version: 'current' })
  await rollout(`rollout-2026-10-06T00-00-00-${other}.jsonl`, { id: other })
  assert.equal(await migrateCodexSession('atlas'), true)
  assert.deepEqual(await readdir(join(destination, 'sessions')), [revisedName])
  assert.equal(await readFile(join(destination, 'sessions', revisedName), 'utf8'), await readFile(latest, 'utf8'))
  assert.equal(await readFile(join(pointers, 'atlas', 'codex.runtime.session'), 'utf8'), id + '\n')
})

test('a legacy backup rename failure preserves both pointers and does not block runtime resume on retry', async () => {
  const legacy = await pointer()
  await rollout(originalName, { id })
  await mkdir(`${legacy}.migrated`)
  // A nonempty directory blocks rename on both POSIX and Windows.
  await writeFile(join(`${legacy}.migrated`, 'keep'), 'existing backup')
  await assert.rejects(migrateCodexSession('atlas'), /old session pointer has been preserved/)
  assert.equal(await readFile(legacy, 'utf8'), id)
  assert.equal(await migrateCodexSession('atlas'), false)
  await assert.rejects(readFile(legacy), { code: 'ENOENT' })
  await mkdir(legacy)
  assert.equal(await migrateCodexSession('atlas'), false)
  assert.deepEqual(await readdir(legacy), [])
  assert.equal(await readFile(join(pointers, 'atlas', 'codex.runtime.session'), 'utf8'), id + '\n')
  assert.equal(await readFile(join(`${legacy}.migrated`, 'keep'), 'utf8'), 'existing backup')
})

test('SQLite selection wins over filename timestamps, including uncheckpointed WAL rows', { skip: !sqlite }, async () => {
  await pointer()
  const selected = await rollout(originalName, { id, version: 'selected' })
  await rollout(revisedName, { id, version: 'unselected' })
  const sqliteHome = join(root, 'separate-sqlite-home')
  await mkdir(sqliteHome)
  process.env.CODEX_SQLITE_HOME = sqliteHome
  const databasePath = join(sqliteHome, 'state_5.sqlite')
  const database = new sqlite!.DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
    database.prepare('INSERT INTO threads VALUES (?, ?)').run(id, selected)
    const before = await readFile(databasePath)
    assert.equal(await migrateCodexSession('atlas'), true)
    assert.deepEqual(await readdir(join(destination, 'sessions')), [originalName])
    assert.deepEqual(await readFile(databasePath), before)
    assert.deepEqual(await readdir(destination), ['sessions'])
  } finally { database.close() }
})

test('a missing database-selected rollout cannot silently fall back to old history', { skip: !sqlite }, async () => {
  process.env.CODEX_SQLITE_HOME = source
  const legacy = await pointer()
  await rollout(originalName, { id })
  const database = new sqlite!.DatabaseSync(join(source, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
  database.prepare('INSERT INTO threads VALUES (?, ?)').run(id, join(source, 'sessions', revisedName))
  database.close()
  await assert.rejects(migrateCodexSession('atlas'), /selected by Codex's database is unavailable/)
  assert.equal(await readFile(legacy, 'utf8'), id)
})

test('older Node.js reports how to read database selection without guessing or moving the pointer', { skip: !!sqlite }, async () => {
  process.env.CODEX_SQLITE_HOME = source
  const legacy = await pointer()
  await rollout(originalName, { id })
  await writeFile(join(source, 'state_5.sqlite'), '')
  await assert.rejects(migrateCodexSession('atlas'), /requires Node\.js 22\.13 or newer/)
  assert.equal(await readFile(legacy, 'utf8'), id)
  await assert.rejects(readdir(destination), { code: 'ENOENT' })
})

test('compressed rollouts migrate with identity validation on older Node.js versions too', async () => {
  await pointer()
  await mkdir(join(source, 'sessions'), { recursive: true })
  await writeFile(join(source, 'sessions', originalName + '.zst'), compressedMetadata)
  assert.equal(await migrateCodexSession('atlas'), true)
  assert.deepEqual(await readFile(join(destination, 'sessions', originalName + '.zst')), compressedMetadata)
})

test('migration follows archived history_base, excluding unrelated threads and later personal messages', async () => {
  await pointer('atlas', other)
  const ancestor = await rollout(originalName, { id, history_mode: 'paginated' }, 'archived_sessions')
  const prefix = await readFile(ancestor)
  await writeFile(ancestor, Buffer.concat([prefix, Buffer.from('{"type":"response_item","payload":{"text":"private later message"}}\n')]))
  const currentName = `rollout-2026-10-06T00-00-00-${other}_${revision}.jsonl`
  const current = await rollout(currentName, {
    id: other, session_id: id, history_mode: 'paginated',
    history_base: { thread_id: id, end_ordinal_exclusive: 1, end_byte_offset: prefix.length },
  })
  await rollout(`rollout-2026-10-06T00-00-00-${revision}.jsonl`, { id: revision })
  assert.equal(await migrateCodexSession('atlas'), true)
  assert.deepEqual(await readFile(join(destination, 'archived_sessions', originalName)), prefix)
  assert.match(await readFile(ancestor, 'utf8'), /private later message/)
  assert.equal(await readFile(join(destination, 'sessions', currentName), 'utf8'), await readFile(current, 'utf8'))
  assert.deepEqual(await readdir(join(destination, 'sessions')), [currentName])
})

test('a compressed ancestor is published as the exact uncompressed prefix', async () => {
  await pointer('atlas', other)
  await mkdir(join(source, 'archived_sessions'), { recursive: true })
  await writeFile(join(source, 'archived_sessions', originalName + '.zst'), compressedMetadata)
  const prefix = Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n')
  await rollout(`rollout-2026-10-06T00-00-00-${other}_${revision}.jsonl`, {
    id: other, history_mode: 'paginated',
    history_base: { thread_id: id, end_ordinal_exclusive: 1, end_byte_offset: prefix.length },
  })
  assert.equal(await migrateCodexSession('atlas'), true)
  assert.deepEqual(await readFile(join(destination, 'archived_sessions', originalName)), prefix)
  assert.deepEqual(await readdir(join(destination, 'archived_sessions')), [originalName])
})

for (const [offset, reason] of [
  [-1, /does not end at a complete record/],
  [1, /history_base extends beyond source rollout/],
] as const) {
  test(`history prefix with length offset ${offset} fails before copying any state`, async () => {
    const legacy = await pointer()
    const ancestor = await rollout(originalName, { id, history_mode: 'paginated' })
    await rollout(revisedName, {
      id, history_mode: 'paginated',
      history_base: { thread_id: id, end_ordinal_exclusive: 1, end_byte_offset: (await readFile(ancestor)).length + offset },
    })
    await assert.rejects(migrateCodexSession('atlas'), reason)
    assert.equal(await readFile(legacy, 'utf8'), id)
    await assert.rejects(readdir(destination), { code: 'ENOENT' })
  })
}

test('migration never overwrites a rollout already used by the isolated runtime', async () => {
  await pointer()
  const path = await rollout(originalName, { id })
  const runtimePath = join(destination, 'sessions', originalName)
  await mkdir(dirname(runtimePath), { recursive: true })
  const newer = (await readFile(path, 'utf8')) + '{"type":"response_item","payload":{"text":"new runtime turn"}}\n'
  await writeFile(runtimePath, newer)
  assert.equal(await migrateCodexSession('atlas'), true)
  assert.equal(await readFile(runtimePath, 'utf8'), newer)
})

test('automatic and manual migration can race without replacing the winning pointer', async () => {
  await pointer()
  await rollout(originalName, { id })
  const results = await Promise.all([
    migrateCodexSession('atlas'),
    migrateCodexSession('atlas'),
  ])
  assert.deepEqual(results.sort(), [false, true])
  const store = new EngineSessionStore(pointers, 'atlas', 'codex', CODEX_SESSION_SCOPE)
  assert.equal(await store.load(), id)
  await store.save('new-runtime-thread')
  assert.equal(await migrateCodexSession('atlas'), false)
  assert.equal(await store.load(), 'new-runtime-thread')
  assert.deepEqual(await readdir(join(pointers, 'atlas')), ['codex.runtime.session', 'codex.session.migrated'])
})

test('an incomplete existing rollout is preserved and temporary copies are cleaned up', async () => {
  const legacy = await pointer()
  const path = await rollout(originalName, { id })
  await writeFile(path, (await readFile(path, 'utf8')) + '{"type":"response_item","payload":{"text":"original turn"}}\n')
  const runtimePath = join(destination, 'sessions', originalName)
  await mkdir(dirname(runtimePath), { recursive: true })
  const incomplete = JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n'
  await writeFile(runtimePath, incomplete)
  await assert.rejects(migrateCodexSession('atlas'), /history_base extends beyond source rollout/)
  assert.equal(await readFile(runtimePath, 'utf8'), incomplete)
  assert.equal(await readFile(legacy, 'utf8'), id)
  assert.deepEqual(await readdir(dirname(runtimePath)), [originalName])
})

test('an unreadable runtime pointer pauses migration before copying or replacing state', async () => {
  const legacy = await pointer()
  await rollout(originalName, { id })
  await mkdir(join(pointers, 'atlas', 'codex.runtime.session'))
  await assert.rejects(migrateCodexSession('atlas'), /old session pointer has been preserved/)
  assert.equal(await readFile(legacy, 'utf8'), id)
  await assert.rejects(readdir(destination), { code: 'ENOENT' })
})

test('incomplete or cyclic pagination preserves the pointer before copying any history', async () => {
  const legacy = await pointer()
  for (const sourceId of [other, revision]) {
    await rollout(revisedName, {
      id, history_mode: 'paginated',
      history_base: { thread_id: sourceId, end_ordinal_exclusive: 5, end_byte_offset: 100 },
    })
    await assert.rejects(migrateCodexSession('atlas'), /missing source rollout|cyclic history_base/)
    assert.equal(await readFile(legacy, 'utf8'), id)
    await assert.rejects(readdir(destination), { code: 'ENOENT' })
  }
})

test('metadata parsing skips blank and malformed records but rejects unreadable or mismatched histories', async () => {
  const legacy = await pointer()
  const path = await rollout(originalName, { id }, 'sessions', '\n{broken json\n{"type":"event_msg","payload":{}}\n')
  assert.equal(await migrateCodexSession('atlas'), true)
  await rm(join(pointers, 'atlas', 'codex.runtime.session'))
  for (const text of ['', '{broken json\n', JSON.stringify({ type: 'session_meta', payload: { id: other } })]) {
    await writeFile(legacy, id)
    await writeFile(path, text)
    await assert.rejects(migrateCodexSession('atlas'), {
      name: 'Error', message: /no readable session metadata|belongs to another thread/,
    })
    assert.equal(await readFile(legacy, 'utf8'), id)
  }
})

test('an archived current thread reports unarchive instructions and preserves its pointer', async () => {
  const legacy = await pointer()
  await rollout(originalName, { id }, 'archived_sessions')
  await assert.rejects(migrateCodexSession('atlas'), /thread is archived.*codex unarchive/)
  assert.equal(await readFile(legacy, 'utf8'), id)
})

test('bulk migration continues after failures and reports partial success', async () => {
  const legacy = await pointer('broken', other)
  await pointer('healthy')
  await rollout(originalName, { id })
  await assert.rejects(migrateCodexSessions(), err => {
    assert.ok(err instanceof AggregateError)
    assert.ok(err.message.includes(`Migrated 1 Codex session(s) (healthy) to ${destination}`))
    assert.match(err.message, /Personal Codex data was left in place; failed 1/)
    return true
  })
  assert.equal(await readFile(legacy, 'utf8'), other)
  assert.equal(await readFile(join(pointers, 'healthy', 'codex.runtime.session'), 'utf8'), id + '\n')
})

test('using the runtime itself as the source produces an actionable error without moving the pointer', async () => {
  const legacy = await pointer()
  await assert.rejects(migrateCodexSession('atlas', source, pointers, source), /source and destination Codex homes are the same/)
  assert.equal(await readFile(legacy, 'utf8'), id)
})

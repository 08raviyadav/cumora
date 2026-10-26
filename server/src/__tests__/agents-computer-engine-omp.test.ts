/**
 * Contract tests for the BYOA omp (`omp acp`) ACP adapter.
 *
 * The fake implements the wire surface the adapter actually speaks —
 * initialize / session/load|new / session/set_config_option / session/prompt /
 * _session/steering over newline-delimited JSON-RPC — and is injected through
 * CUMORA_OMP_BIN, the same escape hatch operators use, so the spawn resolution
 * and its argv stay under test. No case needs a real omp install.
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { getAdapter, resolveOmpBin, type EngineHopReport, type EngineSessionArgs } from '../agents/computer/engine.js'

const tempDirs: string[] = []
const liveSessions: Array<{ stop(): void | Promise<void> }> = []

const FAKE_OMP_ACP_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.env.FAKE_OMP_LOG
const mode = process.env.FAKE_OMP_MODE || 'ok'
const argv = process.argv.slice(2)
const allowed = [['acp'], ['acp', '--no-tools', '--no-session']]
if (!allowed.some((shape) => shape.length === argv.length && shape.every((v, i) => v === argv[i]))) {
  process.stderr.write('unexpected omp argv: ' + JSON.stringify(argv) + '\n')
  process.exit(2)
}

let prompts = 0
let steers = 0
let pendingPrompt = null
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const record = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n')
}
const finishPrompt = (id, sid) => {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read README.md' } },
  })
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong #' + prompts } },
    },
  })
  send({
    jsonrpc: '2.0',
    id,
    result: mode === 'with-usage'
      ? { stopReason: 'end_turn', usage: { inputTokens: 110, cachedReadTokens: 30, cachedWriteTokens: 10, outputTokens: 15 } }
      : { stopReason: 'end_turn' },
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  record({ argv, ...msg })
  if (msg.id !== undefined && !msg.method) {
    if (pendingPrompt) {
      const { id, sid } = pendingPrompt
      pendingPrompt = null
      finishPrompt(id, sid)
    }
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'omp', title: 'omp', version: '18.12.6' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
        _meta: { steering: { supported: true } },
      },
    })
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'omp-sess-fresh',
        configOptions: [
          { id: 'mode', currentValue: 'default' },
          { id: 'model', currentValue: 'magpie/auto/dfmodel' },
          { id: 'thinking', currentValue: 'high' },
        ],
      },
    })
  } else if (msg.method === 'session/load' || msg.method === 'session/resume') {
    if (mode === 'fail-load') {
      // omp's real shape: a generic message with the cause in data.details.
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'Internal error', data: { details: 'ACP session not found: ' + msg.params.sessionId } },
      })
    } else {
      if (mode === 'replay-on-load') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_REPLAY_TEXT ' } },
          },
        })
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: [] } })
    }
  } else if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId !== 'model') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: unknown config option' } })
    } else if (mode === 'reject-pin') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown ACP model: ' + msg.params.value } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ id: 'model', currentValue: msg.params.value }] } })
    }
  } else if (msg.method === '_session/steering') {
    steers += 1
    if (mode === 'reject-steer') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: _session/steering' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'injected', queue: 'steering' } })
    }
    // A held turn is released by the steering traffic itself, so the test waits
    // on the wire rather than on a clock. reject-steer keeps it open for both
    // steers, or the second would arrive after the turn had already ended.
    if (pendingPrompt && (mode !== 'reject-steer' || steers >= 2)) {
      const { id, sid } = pendingPrompt
      pendingPrompt = null
      finishPrompt(id, sid)
    }
  } else if (msg.method === 'session/prompt') {
    prompts += 1
    const text = msg.params.prompt[0].text
    if (mode === 'die-mid-turn') process.exit(17)
    if (mode === 'session-gone' || (mode === 'session-gone-after-first' && prompts >= 2)) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'Internal error', data: { details: 'ACP session not found: ' + msg.params.sessionId } },
      })
      return
    }
    if (mode === 'session-unsupported') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'Internal error', data: { details: 'Unsupported ACP session: ' + msg.params.sessionId } },
      })
      return
    }
    if (mode === 'cancelled') {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } })
      return
    }
    if (mode === 'ask-permission' || mode === 'ask-permission-once' || mode === 'ask-permission-reject-only') {
      pendingPrompt = { id: msg.id, sid: msg.params.sessionId }
      const options = mode === 'ask-permission'
        ? [
            { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
          ]
        : mode === 'ask-permission-once'
          ? [{ optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' }]
          : [{ optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }]
      // Reuse the pending prompt's id on purpose: a server->client request must be
      // routed by method, never by id, or it would be taken as the prompt's answer.
      send({
        jsonrpc: '2.0',
        id: msg.id,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc-perm', title: 'npm test', kind: 'execute' },
          options,
        },
      })
      return
    }
    const sid = msg.params.sessionId
    if ((mode === 'hold' || mode === 'reject-steer') && text === 'held turn') {
      // Announce receipt through the turn's own chunk stream, then block until
      // the steer arrives — the test waits on the log line, not on a clock.
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PROMPT_HELD' } },
        },
      })
      pendingPrompt = { id: msg.id, sid }
      return
    }
    if (mode === 'split-utf8') {
      const frame = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好世界' } },
          },
        }) + '\n',
        'utf8',
      )
      // '你' is 0xe4 0xbd 0xa0 — split right after the first byte.
      const cut = frame.indexOf(0xe4) + 1
      process.stdout.write(frame.subarray(0, cut))
      setTimeout(() => {
        process.stdout.write(frame.subarray(cut))
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, 15)
      return
    }
    finishPrompt(msg.id, sid)
  }
})
`

interface Fixture {
  home: string
  env: NodeJS.ProcessEnv
  /** Pass as onLog so waitForLog() sees the adapter's own output. */
  log: (line: string) => void
  lines: string[]
  /** Resolves once the adapter has logged a line containing `needle`. */
  waitForLog: (needle: string) => Promise<void>
  readCalls: () => Promise<Array<{ argv?: string[]; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }>>
}

async function makeFixture(mode = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-omp-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const bridge = join(root, 'fake-omp.mjs')
  const logFile = join(root, 'calls.jsonl')
  await writeFile(bridge, FAKE_OMP_ACP_SOURCE, 'utf8')
  const lines: string[] = []
  const waiting = new Set<() => void>()
  const log = (line: string) => {
    lines.push(line)
    for (const check of waiting) check()
  }
  return {
    home,
    log,
    lines,
    waitForLog: (needle) => new Promise<void>((resolve) => {
      const check = () => {
        if (!lines.some((line) => line.includes(needle))) return
        waiting.delete(check)
        resolve()
      }
      waiting.add(check)
      check()
    }),
    env: {
      ...process.env,
      CUMORA_OMP_BIN: bridge,
      FAKE_OMP_LOG: logFile,
      FAKE_OMP_MODE: mode,
    },
    readCalls: async () => {
      const raw = await readFile(logFile, 'utf8').catch(() => '')
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
  }
}

function startOmpSession(f: Fixture, overrides: Partial<Omit<EngineSessionArgs, 'home' | 'env'>> = {}) {
  const session = getAdapter('omp').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: null,
    onLog: () => {},
    ...overrides,
  })
  assert.ok(session)
  liveSessions.push(session)
  return session
}

afterEach(async () => {
  for (const s of liveSessions.splice(0)) {
    try { await s.stop() } catch { /* already gone */ }
  }
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

test('omp wake spawns `omp acp` and triage spawns `omp acp --no-tools --no-session`', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('omp')
  const signal = AbortSignal.timeout(10_000)

  const session = startOmpSession(f)
  await session.send('wake turn')
  await session.stop()

  const classified = await adapter.classify({ cwd: f.home, env: f.env, prompt: 'Actionable?', signal })
  assert.equal(classified.error, undefined)
  assert.equal(classified.text, 'pong #1')

  const calls = await f.readCalls()
  assert.deepEqual(calls[0]?.argv, ['acp'], 'a wake runs omp with FULL tools')
  assert.deepEqual(calls[calls.length - 1]?.argv, ['acp', '--no-tools', '--no-session'], 'triage is the no-tool surface')
})

test('omp orders initialize → session/new → pin → prompt and pins once across wakes', async () => {
  const f = await makeFixture()
  const logs: string[] = []
  const hops: EngineHopReport[] = []
  const session = startOmpSession(f, {
    model: 'magpie/auto/dfmodel',
    standingPrompt: 'ignored by omp over ACP',
    onLog: (l) => logs.push(l),
    onHopUsage: (h) => hops.push(h),
  })
  assert.equal(session.carriesStandingPrompt, false, 'omp does not deliver --append-system-prompt over ACP')

  const r1 = await session.send('first wake')
  const r2 = await session.send('second wake')

  assert.equal(r1.exitCode, 0)
  assert.equal(r2.exitCode, 0)
  assert.equal(r1.sessionId, 'omp-sess-fresh')
  assert.equal(r2.sessionId, 'omp-sess-fresh')
  assert.equal(r1.model, 'magpie/auto/dfmodel')
  assert.equal(hops.length, 2)
  assert.equal(hops[0]?.model, 'magpie/auto/dfmodel')
  assert.ok(logs.some((l) => l.includes('[omp] tool Read README.md')))
  assert.ok(logs.some((l) => l.includes('pong #1')))
  assert.ok(logs.some((l) => l.includes('pong #2')))

  const calls = await f.readCalls()
  assert.deepEqual(
    calls.map((c) => c.method),
    ['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/prompt'],
  )
  assert.deepEqual(calls[2]?.params, {
    sessionId: 'omp-sess-fresh',
    configId: 'model',
    value: 'magpie/auto/dfmodel',
  })
  assert.equal(
    calls.some((c) => c.method === 'session/set_config_option' && c.params?.configId !== 'model'),
    false,
    'omp exposes no permission_mode option — nothing else may be pinned',
  )
})

test('omp keeps the turn alive when the model pin is rejected and never retries it', async () => {
  const f = await makeFixture('reject-pin')
  const logs: string[] = []
  const session = startOmpSession(f, {
    model: 'unknown/selector',
    onLog: (l) => logs.push(l),
  })

  const r1 = await session.send('first wake')
  const r2 = await session.send('second wake')

  assert.equal(r1.exitCode, 0, 'an unknown pin is a preference loss, not a turn failure')
  assert.equal(r1.model, '<omp-default>', 'a rejected pin must not be reported as the active model')
  assert.equal(r2.exitCode, 0)
  assert.ok(logs.some((l) => l.includes('[omp] model pin (unknown/selector) rejected') && l.includes('engine default')))
  const pins = (await f.readCalls()).filter((c) => c.method === 'session/set_config_option')
  assert.equal(pins.length, 1, 'ONE pin attempt per session process')
})

test('omp attaches with session/load so the transcript replays, and replay stays out of the turn', async () => {
  const f = await makeFixture('replay-on-load')
  const logs: string[] = []
  const session = startOmpSession(f, {
    model: 'deepseek/deepseek-v4-pro',
    resumeSessionId: 'omp-sess-existing',
    onLog: (l) => logs.push(l),
  })

  const r = await session.send('wake after load')
  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'omp-sess-existing')
  assert.ok(!logs.some((l) => l.includes('STALE_REPLAY_TEXT')), 'replayed history must not be reported as this turn')
  assert.ok(logs.some((l) => l.includes('pong #1')))

  const calls = await f.readCalls()
  assert.deepEqual(
    calls.map((c) => c.method),
    ['initialize', 'session/load', 'session/set_config_option', 'session/prompt'],
    'the pin lands after the attach and before the turn',
  )
})

test('omp classifies both missing-session wordings as resume-not-found, ungated on wasResume', async () => {
  // `ACP session not found` — the attach wording, surfaced from data.details.
  const gone = await makeFixture('session-gone')
  const onGone = startOmpSession(gone, {
    resumeSessionId: 'omp-sess-stale',
  })
  const rGone = await onGone.send('turn on a dead session')
  assert.equal(rGone.exitCode, 1)
  assert.equal(rGone.failure?.kind, 'resume-not-found')
  assert.match(rGone.error ?? '', /ACP session not found/i, 'the cause must survive rpc() rejection, not just "Internal error"')

  // `Unsupported ACP session` — the live-call wording.
  const unsupported = await makeFixture('session-unsupported')
  const onUnsupported = startOmpSession(unsupported, {
    resumeSessionId: 'omp-sess-stale',
  })
  const rUnsupported = await onUnsupported.send('turn on an unsupported session')
  assert.equal(rUnsupported.failure?.kind, 'resume-not-found')

  // A session that disappears AFTER a successful turn still recovers.
  const afterFirst = await makeFixture('session-gone-after-first')
  const onAfterFirst = startOmpSession(afterFirst, {
    resumeSessionId: 'omp-sess-existing',
  })
  assert.equal((await onAfterFirst.send('first turn')).exitCode, 0)
  assert.equal((await onAfterFirst.send('second turn')).failure?.kind, 'resume-not-found')
})

test('omp self-heals a stale session/load at handshake time via session/new', async () => {
  const f = await makeFixture('fail-load')
  const logs: string[] = []
  const session = startOmpSession(f, {
    resumeSessionId: 'omp-sess-stale',
    onLog: (l) => logs.push(l),
  })

  const r = await session.send('after stale load')
  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'omp-sess-fresh')
  assert.ok(logs.some((l) => l.includes('session/load failed') && l.includes('fresh session')))

  const calls = await f.readCalls()
  assert.deepEqual(calls.slice(0, 3).map((c) => c.method), ['initialize', 'session/load', 'session/new'])
})

test('omp auto-answers session/request_permission preferring allow_always, then allow_once, then cancels', async () => {
  const cases: Array<[string, unknown]> = [
    ['ask-permission', { outcome: { outcome: 'selected', optionId: 'opt-allow-always' } }],
    ['ask-permission-once', { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } }],
    ['ask-permission-reject-only', { outcome: { outcome: 'cancelled' } }],
  ]
  for (const [mode, expected] of cases) {
    const f = await makeFixture(mode)
    const session = startOmpSession(f)

    const r = await session.send('do something requiring permission')
    assert.equal(r.exitCode, 0, mode)

    const calls = await f.readCalls()
    const promptCall = calls.find((c) => c.method === 'session/prompt')
    const reply = calls.find((c) => c.id === promptCall?.id && !c.method)
    assert.equal(reply?.id, promptCall?.id, mode)
    assert.deepEqual(reply?.result, expected, mode)
    await session.stop()
  }
})

test('omp treats stopReason=cancelled as a failed turn instead of success', async () => {
  const f = await makeFixture('cancelled')
  const hops: EngineHopReport[] = []
  const session = startOmpSession(f, {
    onHopUsage: (h) => hops.push(h),
  })

  const r = await session.send('fail with cancelled stopReason')
  assert.equal(r.exitCode, 1)
  assert.match(r.error ?? '', /cancelled/i)
  assert.equal(hops.length, 0)
})

test('omp steer injects mid-turn via _session/steering and no-ops while idle', async () => {
  const f = await makeFixture('hold')
  const session = startOmpSession(f, {
    onLog: f.log,
  })

  // Before any turn: nothing to inject into, and no RPC may be attempted.
  session.steer('too early')
  assert.equal((await f.readCalls()).filter((c) => c.method === '_session/steering').length, 0, 'an idle steer is a no-op')

  const turn = session.send('held turn')
  await f.waitForLog('PROMPT_HELD')
  session.steer('answer the ping first')
  const result = await turn
  assert.equal(result.exitCode, 0, 'a steer must not cancel the in-flight turn')

  const steerCall = (await f.readCalls()).find((c) => c.method === '_session/steering')
  assert.deepEqual(steerCall?.params, {
    sessionId: 'omp-sess-fresh',
    prompt: [{ type: 'text', text: 'answer the ping first' }],
    _meta: { steering: { queue: 'steering' } },
  })
})

test('omp swallows a rejected steer and logs it once', async () => {
  const f = await makeFixture('reject-steer')
  const session = startOmpSession(f, {
    onLog: f.log,
  })

  const held = session.send('held turn')
  await f.waitForLog('PROMPT_HELD')
  session.steer('first rejected steer')
  await f.waitForLog('[omp] steer rejected')
  session.steer('second rejected steer')

  const result = await held
  assert.equal(result.exitCode, 0, 'a rejected steer never fails the turn')
  assert.equal(f.lines.filter((l) => l.includes('[omp] steer rejected')).length, 1, 'warn once per session')
})

test('omp process dying MID-TURN resolves the turn as a failure, never rejects', async () => {
  const f = await makeFixture('die-mid-turn')
  const session = startOmpSession(f)

  const r = await session.send('crash now')
  assert.equal(r.exitCode, 17)
  assert.match(r.error ?? '', /exited with code 17/)
  assert.equal(session.alive, false)
})

test('omp seedHome writes the AGENTS.md and .agents/skills that omp actually loads', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('omp')
  await adapter.seedHome(f.home, {
    id: 'agent-omp',
    name: 'omp Engineer',
    role: 'engineer',
    systemPrompt: 'Follow first principles.',
  })
  const agentsMd = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /omp Engineer/)
  assert.match(agentsMd, /\.agents\/skills\//)
  assert.equal((await stat(join(f.home, '.agents', 'skills'))).isDirectory(), true)
})

test('omp probeWake exercises the acp handshake and one-shot run forwards resumeSessionId', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('omp')
  const controller = new AbortController()

  const wake = await adapter.probeWake({ cwd: f.home, env: f.env, signal: controller.signal })
  assert.equal(wake.ok, true, 'the wake path IS omp acp on every platform, so it is never skipped')

  const oneShot = await adapter.run({
    home: f.home,
    env: f.env,
    prompt: 'say pong',
    resumeSessionId: 'omp-sess-resumed-run',
    signal: controller.signal,
    onLog: () => {},
  })
  assert.equal(oneShot.exitCode, 0)
  assert.equal(oneShot.sessionId, 'omp-sess-resumed-run')

  const calls = await f.readCalls()
  assert.ok(
    calls.some((c) => c.method === 'session/load' && c.params?.sessionId === 'omp-sess-resumed-run'),
    'OmpAdapter.run must forward resumeSessionId to session/load',
  )

  const probed = await adapter.probe({ cwd: f.home, env: f.env, tier: 'big', signal: controller.signal })
  assert.equal(probed.text, 'pong #1')
  assert.deepEqual((await f.readCalls()).at(-1)?.argv, ['acp', '--no-tools', '--no-session'])
})

test('omp resolves no bin when only another engine is on PATH and reports a failed handshake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-omp-path-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const other = join(binDir, process.platform === 'win32' ? 'maka.cmd' : 'maka')
  await writeFile(other, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(other, 0o755)

  assert.equal(resolveOmpBin({ PATH: binDir }), null)

  // A pinned-but-broken entry is the deterministic failure: probing PATH would
  // find whatever omp the DEVELOPER has installed, which is not this test's subject.
  const controller = new AbortController()
  const wake = await getAdapter('omp').probeWake({
    cwd: root,
    env: { ...process.env, CUMORA_OMP_BIN: join(root, 'missing-omp.mjs') },
    signal: controller.signal,
  })
  assert.equal(wake.ok, false)
  assert.match(wake.detail ?? '', /omp acp handshake failed/)
})

test('omp extracts the ACP camelCase usage fields', async () => {
  const f = await makeFixture('with-usage')
  const hops: EngineHopReport[] = []
  const session = startOmpSession(f, {
    onHopUsage: (h) => hops.push(h),
  })

  const r = await session.send('turn with usage')
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.usage, {
    input_tokens: 110,
    output_tokens: 15,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
  })
  assert.equal(hops.length, 1)
  assert.deepEqual(hops[0]?.usage, r.usage)
})

test('omp decodes multi-byte UTF-8 split across stdout chunks without replacement characters', async () => {
  const f = await makeFixture('split-utf8')
  const controller = new AbortController()
  const classified = await getAdapter('omp').classify({
    cwd: f.home,
    env: f.env,
    prompt: 'say hello in Chinese',
    signal: controller.signal,
  })
  assert.equal(classified.error, undefined)
  assert.equal(classified.text, '你好世界')
  assert.ok(!classified.text.includes('\uFFFD'))
})

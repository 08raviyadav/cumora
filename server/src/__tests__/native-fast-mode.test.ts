import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { supportsNativeFastMode } from '../../../shared/native-fast-mode.js'
import { AgentRunner } from '../agents/computer/daemon.js'
import { getAdapter } from '../agents/computer/engine.js'

test('native Fast Mode only allows Claude models that will not be switched to Opus', () => {
  for (const model of ['opus', 'opus[1m]', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5-20261001']) {
    assert.equal(supportsNativeFastMode('claude', model), true, model)
  }
  for (const model of [null, '', 'sonnet', 'haiku', 'opusplan', 'claude-opus-4-7', 'provider/opus']) {
    assert.equal(supportsNativeFastMode('claude', model), false, String(model))
  }
  assert.equal(supportsNativeFastMode('codex', 'custom-model'), true)
  assert.equal(supportsNativeFastMode('managed', 'opus'), false)
  assert.equal(supportsNativeFastMode('cursor', 'opus'), false)
})

test('Claude refuses Fast Mode before spawning when its model or alias is unsupported', async () => {
  const adapter = getAdapter('claude')
  const env = { CLAUDE_CONFIG_DIR: join(tmpdir(), 'cumora-no-fast-mode-settings') }
  for (const pin of [
    { model: 'sonnet', env },
    { model: 'claude-opus-4-7', env },
    { model: 'opus', env: { ...env, ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider/other-model' } },
    { model: 'opus', env: { ...env, CLAUDE_CODE_DISABLE_FAST_MODE: '1' } },
  ]) {
    const args = { home: tmpdir(), ...pin, nativeFastMode: true, onLog: () => {} }
    assert.equal(adapter.startSession?.(args), null)
    const result = await adapter.run({ ...args, prompt: 'unused', signal: new AbortController().signal })
    assert.equal(result.exitCode, 1)
    assert.match(result.error ?? '', /Fast mode/)
  }
})

test('changing Fast Mode replaces the runner while omitted and false settings match', () => {
  const agent = { id: 'fast-mode-fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'codex' as const, model: 'main', fastModel: 'auxiliary' }
  const cfg = { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' }
  const standard = new AgentRunner(cfg, agent, 'codex')
  const fast = new AgentRunner(cfg, { ...agent, nativeFastMode: true }, 'codex')
  assert.equal(standard.configMatches({ ...agent, nativeFastMode: false }, 'codex'), true)
  assert.equal(standard.configMatches({ ...agent, nativeFastMode: true }, 'codex'), false)
  assert.equal(fast.configMatches({ ...agent, nativeFastMode: true }, 'codex'), true)
  assert.equal(fast.configMatches({ ...agent, nativeFastMode: false }, 'codex'), false)
})

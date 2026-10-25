import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { assertCodexProviderTransport, codexCommandInvocation, readCodexRpc } from '../agents/computer/codex-rpc.js'

test('an RPC timeout remains bounded when process cleanup never produces close', async () => {
  const originalSpawn = childProcess.spawn
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), pid: undefined, unref() {},
  })
  const guard = setTimeout(() => {}, 4000)
  try {
    childProcess.spawn = (() => child) as unknown as typeof childProcess.spawn
    syncBuiltinESMExports()
    const started = Date.now()
    assert.equal(await readCodexRpc('unavailable-codex', [], { PATH: '', CODEX_HOME: tmpdir() },
      'config/read', {}, { timeoutMs: 5 }), null)
    assert.ok(Date.now() - started < 3000)
  } finally {
    clearTimeout(guard)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
})

test('a successful RPC response survives cleanup without a close event', async () => {
  const originalSpawn = childProcess.spawn
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), pid: undefined, unref() {},
  })
  const guard = setTimeout(() => {}, 4000)
  try {
    childProcess.spawn = (() => child) as unknown as typeof childProcess.spawn
    syncBuiltinESMExports()
    const response = { config: { model: 'gateway/model' } }
    const started = Date.now()
    const pending = readCodexRpc('fixture-codex', [], { PATH: '', CODEX_HOME: tmpdir() }, 'config/read', {})
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: response })}\n`)
    assert.deepEqual(await pending, response)
    assert.ok(Date.now() - started < 3000)
    assert.equal(child.stdin.destroyed, true)
    assert.equal(child.stdout.destroyed, true)
  } finally {
    clearTimeout(guard)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
})

test('Windows resolves pnpm-style entry points and preserves literal percent values', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-pnpm-'))
  const bin = join(root, 'node_modules', '.bin')
  const packageDir = join(root, 'node_modules', '@openai', 'codex')
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(join(packageDir, 'bin'), { recursive: true })])
  const shim = join(bin, 'codex.cmd')
  const script = join(packageDir, 'bin', 'codex.js')
  await writeFile(shim, '@echo off\r\nexit /b 1\r\n')
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0' }))
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
  const value = 'model_providers={gateway={http_headers={token="literal-%COMSPEC%"}}}'
  try {
    const invocation = codexCommandInvocation(shim, ['-c', value], process.env)
    assert.equal(basename(invocation.command).toLowerCase(), 'node.exe')
    assert.equal(invocation.windowsVerbatimArguments, undefined)
    const output = childProcess.execFileSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true })
    assert.deepEqual(JSON.parse(output), ['-c', value])
    assert.throws(() => assertCodexProviderTransport([value], true), /cannot preserve/)
    await rm(join(root, 'node_modules', '@openai'), { recursive: true })
    const fallback = codexCommandInvocation(shim, ['-c', value], { PATH: '' })
    assert.equal(fallback.windowsVerbatimArguments, true)
    assert.equal(await readCodexRpc(shim, ['-c', value], { PATH: '', CODEX_HOME: root }, 'model/list', {}), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

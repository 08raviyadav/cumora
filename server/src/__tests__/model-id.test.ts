import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InvalidModelIdError, modelIdOrNull, parseModelId } from '../agents/computer/model-id.js'
import { shellSafeSpawnPlan } from '../agents/computer/engine.js'
import { resolveEngineFastModel, resolveEngineModel } from '../agents/computer/daemon.js'

test('a model id is one token vendors actually use', () => {
  assert.equal(parseModelId('claude-sonnet-4-5'), 'claude-sonnet-4-5')
  assert.equal(parseModelId(' my-provider/some-model '), 'my-provider/some-model')
  assert.equal(parseModelId('gpt-5.4-mini'), 'gpt-5.4-mini')
  assert.equal(parseModelId('auto/dfmodel[1m]'), 'auto/dfmodel[1m]')
  assert.equal(parseModelId('provider/model+thinking'), 'provider/model+thinking')
  assert.equal(parseModelId('builtin:zai-coding-plan\\glm-model'), 'builtin:zai-coding-plan\\glm-model')
  assert.equal(parseModelId(''), null)
  assert.equal(parseModelId('   '), null)
  assert.equal(parseModelId(null), null)
  assert.equal(parseModelId(undefined), undefined)
  assert.equal(parseModelId(1), undefined)
})

test('a model id cannot carry a shell metacharacter', () => {
  for (const value of ['sonnet & calc.exe', 'sonnet|calc', 'sonnet;calc', 'a"b', 'a%PATH%', 'a b', '../x',
    'a/../x', 'a/./x', 'a[1m', 'a[1m][2m]', 'a\nb', 'a@host', 'provider\\..\\secret', 'provider\\../secret', 'p\\a\\b']) {
    assert.throws(() => parseModelId(value), InvalidModelIdError)
    assert.equal(modelIdOrNull(value), null)
  }
})

test('resolveEngineModel drops an id that must not reach the shell', () => {
  assert.equal(resolveEngineModel('sonnet & calc.exe', undefined), null)
  assert.equal(resolveEngineModel('claude-opus-4-7', 'sonnet & calc.exe'), null)
  assert.equal(resolveEngineFastModel('sonnet & calc.exe', undefined), null)
  assert.equal(resolveEngineModel('claude-opus-4-7', 'my-provider/some-model'), 'my-provider/some-model')
})

test('a Windows shell spawn quotes the model instead of using shell:true', () => {
  const plan = shellSafeSpawnPlan('C:\\Tools\\claude.cmd', ['--model', 'sonnet & calc.exe'], { shell: true, cwd: 'C:\\agent' }, 'win32')
  assert.equal(plan.options.shell, false)
  assert.equal(plan.options.windowsVerbatimArguments, true)
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.match(plan.args[3], /"sonnet & calc\.exe"/)
  assert.equal(plan.options.windowsHide, true)
})

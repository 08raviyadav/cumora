/**
 * Per-engine version reporting for BYOA computers.
 *
 * The Computers card shows what is installed on the *paired* machine, so the
 * numbers have to come from that machine's daemon. These cover the parsing and
 * update-command inference the daemon does locally, plus the server-side
 * validation that stands between a daemon's claim and what the app renders.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-version.test.ts
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const {
  parseCliVersion, isCliOutdated, isCliVersionAtLeast, inferUpdateCommand, updateArgv,
  parseCursorAbout, parseGrokCheck, ENGINE_VERSION_SPECS, versionCommandInvocation,
  probeLocalEngineVersionWithRetry, runEngineUpdate, npmPackageVersion, probeEngineVersion,
} = await import('../agents/computer/cli-version.js')
const { sanitizeDetectedEngines } = await import('../agents/computer/registry.js')

test('parseCliVersion reads the shapes real CLIs print', () => {
  assert.equal(parseCliVersion('1.2.3'), '1.2.3')
  assert.equal(parseCliVersion('claude 1.0.88 (Claude Code)'), '1.0.88')
  assert.equal(parseCliVersion('v2.10.0'), '2.10.0')
  assert.equal(parseCliVersion('codex-cli 0.5.1-alpha.2'), '0.5.1-alpha.2')
  // Some vendors ship CalVer rather than semver.
  assert.equal(parseCliVersion('2026.08.30'), '2026.08.30')
  assert.equal(parseCliVersion('no version here'), null)
  assert.equal(parseCliVersion(''), null)
  assert.equal(parseCliVersion(null), null)
})

test('Windows version probe replaces an extensionless npm shim with its runnable .cmd sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-version-'))
  try {
    const shim = join(root, 'codex')
    await writeFile(shim, '#!/bin/sh\n')
    await writeFile(`${shim}.cmd`, '@echo off\r\necho codex-cli 0.15.1\r\n')
    const comspec = String.raw`C:\Windows\System32\cmd.exe`
    assert.deepEqual(versionCommandInvocation(shim, ['--version'], 'win32', comspec), {
      command: comspec,
      args: ['/d', '/s', '/c', `""${shim}.cmd" --version"`],
      windowsVerbatimArguments: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an inconclusive local version probe retries and stops on the first concrete version', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-version-retry-'))
  try {
    const counter = join(root, 'counter')
    const cli = join(root, 'claude')
    await writeFile(cli, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `const counter = ${JSON.stringify(counter)}`,
      "const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0') + 1",
      "fs.writeFileSync(counter, String(n))",
      "if (n >= 3) process.stdout.write('claude 2.1.248\\n')",
    ].join('\n'))
    await chmod(cli, 0o755)

    assert.equal(await probeLocalEngineVersionWithRetry('claude', cli, [0, 1, 1]), '2.1.248')
    assert.equal(await readFile(counter, 'utf8'), '3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion reads the package that owns a binary inside node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-npm-version-'))
  try {
    const pkgDir = join(root, 'lib', 'node_modules', '@openai', 'codex')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.164.0' }))
    const bin = join(pkgDir, 'bin', 'codex.js')
    await writeFile(bin, '#!/usr/bin/env node\n')
    assert.equal(npmPackageVersion(bin), '0.164.0')
    // npm links a global install through a symlink; the real path decides.
    // Windows refuses symlinks without developer mode, which is fine — the
    // path shape above already covers the walk-up.
    const link = join(root, 'codex')
    try {
      await symlink(bin, link)
      assert.equal(npmPackageVersion(link), '0.164.0')
    } catch { /* symlinks unavailable on this host */ }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion reads the package an npm Windows shim points at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-npm-shim-'))
  try {
    const pkgDir = join(root, 'node_modules', 'opencode-ai')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.19.4' }))
    // The shape npm writes: a shim *beside* node_modules, naming its own path.
    const shim = join(root, 'opencode')
    await writeFile(shim, [
      '@ECHO off',
      'SETLOCAL',
      'SET "dp0=%~dp0"',
      'IF EXIST "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" (',
      '  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
      ')',
    ].join('\r\n'))
    assert.equal(npmPackageVersion(shim), '1.19.4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion follows the symlink a POSIX npm global install uses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-npm-posix-'))
  try {
    // What `npm i -g opencode-ai` leaves on macOS and Linux: <prefix>/bin/<bin>
    // is a symlink into <prefix>/lib/node_modules, never a file of its own.
    const prefix = join(root, 'usr', 'local')
    const pkgDir = join(prefix, 'lib', 'node_modules', 'opencode-ai')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.19.4' }))
    const target = join(pkgDir, 'bin', 'opencode.exe')
    await writeFile(target, '#!/bin/sh\necho "postinstall was not run" >&2\nexit 1\n')
    await mkdir(join(prefix, 'bin'), { recursive: true })
    const link = join(prefix, 'bin', 'opencode')
    try {
      await symlink(join('..', 'lib', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), link)
    } catch {
      return // symlinks unavailable on this host; the shape is covered above
    }
    assert.equal(npmPackageVersion(link), '1.19.4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a CLI that cannot report a version is answered by its package instead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-broken-cli-'))
  try {
    const pkgDir = join(root, 'node_modules', 'opencode-ai')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.19.4' }))
    // Exactly what opencode-ai ships before its postinstall: exits 1 and says
    // nothing about a version. This is the bug, reproduced.
    const bin = join(pkgDir, 'bin', 'opencode')
    await writeFile(bin, '#!/bin/sh\necho "Error: postinstall was not run." >&2\nexit 1\n')
    await chmod(bin, 0o755)
    if (process.platform === 'win32') {
      await writeFile(`${bin}.cmd`, '@echo off\r\necho Error: postinstall was not run. 1>&2\r\nexit /b 1\r\n')
    }

    // No registry in a unit test: probeLatest() must fail quietly, not hang.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
    try {
      const info = await probeEngineVersion('opencode', bin)
      assert.equal(info.version, '1.19.4', 'the package says what the CLI cannot')
      assert.equal(info.latest, null)
      assert.equal(info.outdated, false, 'no upstream means no nagging')
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion reads the package a pnpm global shim points at', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-pnpm-shim-'))
  try {
    // What `pnpm add -g` leaves (9.15.0, verified against a real install): the
    // shim sits in the global bin dir, but the package lives in the store one
    // level over — <global-dir>/<major>/node_modules/<pkg>, not beside the shim.
    const binDir = join(root, 'pnpm')
    const pkgDir = join(root, 'pnpm-global', '5', 'node_modules', 'opencode-ai')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.19.4' }))
    await mkdir(binDir, { recursive: true })
    // Verbatim shape, minus the absolute NODE_PATH lines: %~dp0\.. is the store.
    const cmd = join(binDir, 'opencode.CMD')
    await writeFile(cmd, [
      '@SETLOCAL',
      `@IF EXIST "%~dp0\\..\\pnpm-global\\5\\node_modules\\opencode-ai\\bin\\opencode.exe" (`,
      '  "%~dp0\\..\\pnpm-global\\5\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
      ')',
    ].join('\r\n'))
    assert.equal(npmPackageVersion(cmd), '1.19.4')
    // The POSIX twin names the same store through $basedir.
    const sh = join(binDir, 'opencode')
    await writeFile(sh, [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'exec "$basedir/../pnpm-global/5/node_modules/opencode-ai/bin/opencode.exe" "$@"',
    ].join('\n'))
    assert.equal(npmPackageVersion(sh), '1.19.4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion reads a pnpm shim whose global directory holds a space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-pnpm-space-'))
  try {
    // `pnpm add -g --global-dir "…/global packages"` (9.15.0, real install).
    // Every path stays quoted; splitting on whitespace truncates it.
    const binDir = join(root, 'pnpm')
    const pkgDir = join(root, 'global packages', '5', 'node_modules', 'opencode-ai')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.19.4' }))
    await mkdir(binDir, { recursive: true })
    const cmd = join(binDir, 'opencode.CMD')
    await writeFile(cmd, [
      '@SETLOCAL',
      '  "%~dp0\\/bin/sh.exe"  "%~dp0\\..\\global packages\\5\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
    ].join('\r\n'))
    assert.equal(npmPackageVersion(cmd), '1.19.4')
    const sh = join(binDir, 'opencode')
    await writeFile(sh, [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      '  exec "$basedir//bin/sh"  "$basedir/../global packages/5/node_modules/opencode-ai/bin/opencode.exe" "$@"',
    ].join('\n'))
    assert.equal(npmPackageVersion(sh), '1.19.4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npmPackageVersion stays null for anything it cannot attribute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-npm-none-'))
  try {
    // A real binary outside any package: never guess.
    const standalone = join(root, 'opencode.exe')
    await writeFile(standalone, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
    assert.equal(npmPackageVersion(standalone), null)
    // A shim whose package is not installed beside it.
    const shim = join(root, 'codex')
    await writeFile(shim, 'IF EXIST "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" (\r\n)\r\n')
    assert.equal(npmPackageVersion(shim), null)
    // A package.json without a version is not a version.
    const pkgDir = join(root, 'node_modules', 'broken')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), '{"name":"broken"}')
    assert.equal(npmPackageVersion(join(pkgDir, 'index.js')), null)
    assert.equal(npmPackageVersion(null), null)
    assert.equal(npmPackageVersion(join(root, 'missing')), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isCliOutdated only fires when upstream is strictly newer', () => {
  assert.equal(isCliOutdated('1.2.3', '1.2.4'), true)
  assert.equal(isCliOutdated('1.2.3', '1.3.0'), true)
  assert.equal(isCliOutdated('1.9.0', '1.10.0'), true, 'compares numerically, not lexically')
  assert.equal(isCliOutdated('1.2.3', '1.2.3'), false)
  assert.equal(isCliOutdated('1.2.4', '1.2.3'), false, 'ahead of the registry is not outdated')
  // Unknown on either side must stay silent rather than nag.
  assert.equal(isCliOutdated(null, '1.2.3'), false)
  assert.equal(isCliOutdated('1.2.3', null), false)
})

test('isCliVersionAtLeast enforces a local security floor', () => {
  assert.equal(isCliVersionAtLeast('2.1.248', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.251', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.247', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('2.1.248-beta.1', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('0.138.0', '0.138.0'), true)
  assert.equal(isCliVersionAtLeast(null, '0.138.0'), false)
})

test('inferUpdateCommand prefers the vendor updater, then brew, then npm', () => {
  // claude has a self-updater, so brew/npm never win even from a brew path.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.claude, '/opt/homebrew/bin/claude'),
    'claude update',
  )
  // gemini has no self-updater: brew only when it actually came from brew.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.gemini, '/opt/homebrew/Cellar/gemini-cli/1.0.0/bin/gemini'),
    'brew upgrade gemini-cli',
  )
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.gemini, '/usr/local/bin/gemini'),
    'npm install -g @google/gemini-cli@latest',
  )
  // A regular npm Codex install keeps using npm.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.codex, '/usr/local/bin/codex'),
    'npm install -g @openai/codex@latest',
  )
  // pi needs the vendor's documented flag when it falls through to npm.
  assert.equal(inferUpdateCommand({ versionArgs: ['--version'], npm: '@earendil-works/pi-coding-agent', npmFlags: '--ignore-scripts' }, '/usr/local/bin/pi'),
    'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest')
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.antigravity, '/Users/test/.local/bin/agy'),
    'agy update',
  )
})

test('updateArgv runs the CLI\'s own updater through its resolved path', () => {
  // Windows: a bare `claude` is a .cmd shim only cmd.exe can start.
  assert.deepEqual(updateArgv('claude update', 'C:\\bin\\claude.cmd'), ['C:\\bin\\claude.cmd', 'update'])
  // Package managers are already runnable by name.
  assert.deepEqual(
    updateArgv('npm install -g @openai/codex@latest', '/usr/local/bin/codex'),
    ['npm', 'install', '-g', '@openai/codex@latest'],
  )
  assert.deepEqual(updateArgv('brew upgrade gemini-cli', '/opt/homebrew/bin/gemini'), ['brew', 'upgrade', 'gemini-cli'])
})

test('Codex updates the installation that supplies its binary', () => {
  const spec = ENGINE_VERSION_SPECS.codex
  assert.equal(inferUpdateCommand(spec, '/opt/homebrew/Caskroom/codex/0.162.1/codex'), 'brew upgrade codex')
  assert.equal(inferUpdateCommand(spec, '/usr/local/Caskroom/codex/0.160.0/codex'), 'brew upgrade codex')
  assert.equal(inferUpdateCommand(spec, '/home/test/.codex/packages/standalone/current/bin/codex'), 'codex update')
  assert.equal(inferUpdateCommand(spec, 'C:\\Users\\test\\.codex\\packages\\standalone\\current\\bin\\codex.exe'), 'codex update')
  assert.equal(inferUpdateCommand(spec, '/usr/local/bin/codex'), 'npm install -g @openai/codex@latest')
})

test('Homebrew-installed Node does not make an npm Codex install belong to brew', () => {
  const spec = ENGINE_VERSION_SPECS.codex
  for (const path of [
    '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
    '/opt/homebrew/Cellar/node@22/22.0.0/lib/node_modules/@openai/codex/bin/codex.js',
    '/home/linuxbrew/.linuxbrew/lib/node_modules/@openai/codex/bin/codex.js',
  ]) {
    assert.equal(inferUpdateCommand(spec, path), 'npm install -g @openai/codex@latest')
  }
})

test('an upgrade refuses an engine removed since the last scan', async () => {
  assert.deepEqual(await runEngineUpdate('codex', null), {
    ok: false, command: null, error: 'codex is no longer installed',
  })
})

test('parseCursorAbout / parseGrokCheck read their vendor formats', () => {
  assert.equal(parseCursorAbout('Version 1.0.0\nLatest  1.2.0\n'), '1.2.0')
  assert.equal(parseCursorAbout('Version 1.0.0\n'), null)
  assert.equal(parseGrokCheck('{"latestVersion":"0.4.2"}'), '0.4.2')
  // Not JSON — fall back to scraping a version out of the text.
  assert.equal(parseGrokCheck('grok 0.4.2 available'), '0.4.2')
})

test('sanitizeDetectedEngines carries version fields through', () => {
  const rows = sanitizeDetectedEngines([
    {
      id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
      version: '0.5.0', latest: '0.6.0', outdated: true,
      updateCommand: 'npm install -g @openai/codex@latest',
    },
  ], ['codex'])
  assert.deepEqual(rows, [{
    id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
    version: '0.5.0', latest: '0.6.0', outdated: true,
    updateCommand: 'npm install -g @openai/codex@latest',
    blockedReason: null,
  }])
})

test('sanitizeDetectedEngines does not trust a stale outdated flag', () => {
  // A daemon claiming "outdated" while both versions read the same would nag
  // forever; the server can check that itself, so it does.
  const [row] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: '1.0.0', latest: '1.0.0', outdated: true }],
    ['codex'],
  )
  assert.equal(row?.outdated, false)

  // Same when one side is missing entirely.
  const [noLatest] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: '1.0.0', outdated: true }],
    ['codex'],
  )
  assert.equal(noLatest?.outdated, false)
  assert.equal(noLatest?.latest, null)
})

test('sanitizeDetectedEngines strips control characters and bounds length', () => {
  const [row] = sanitizeDetectedEngines([{
    id: 'codex', bin: 'codex', path: '/x/codex',
    version: '1.0.0', latest: '2.0.0',
    outdated: true,
    // A newline here would turn a copyable one-liner into a two-command script.
    updateCommand: 'npm i -g @openai/codex\nrm -rf /',
  }], ['codex'])
  assert.ok(!row?.updateCommand?.includes('\n'))
  assert.equal(row?.updateCommand, 'npm i -g @openai/codex rm -rf /')

  const [long] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: 'v'.repeat(500) }],
    ['codex'],
  )
  assert.equal(long?.version?.length, 64)
})

test('sanitizeDetectedEngines tolerates a daemon too old to report versions', () => {
  // Pre-probe daemons send {id,bin,path}. Rendering the path alone is correct;
  // inventing a version would be worse than showing none.
  const [row] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/usr/local/bin/codex' }],
    ['codex'],
  )
  assert.equal(row?.version, null)
  assert.equal(row?.latest, null)
  assert.equal(row?.outdated, false)
  assert.equal(row?.updateCommand, null)
})

test('sanitizeDetectedEngines bounds and cleans account-specific model catalogs', () => {
  const [row] = sanitizeDetectedEngines([{
    id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
    modelCatalog: {
      source: 'protocol', supportsCustom: true, fastModelScope: 'agent',
      defaultModel: 'gpt-5.6-sol', defaultFastModel: 'gpt-5.4-mini',
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol\nspoof', recommendedFor: ['big', 'bogus'] },
        { id: 'gpt-5.6-sol', label: 'duplicate' },
        { id: '', label: 'empty' },
      ],
    },
  }], ['codex'])
  assert.deepEqual(row?.modelCatalog, {
    source: 'protocol', supportsCustom: true, fastModelScope: 'agent',
    defaultModel: 'gpt-5.6-sol', defaultFastModel: 'gpt-5.4-mini',
    models: [{
      id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol spoof', description: null, recommendedFor: ['big'],
    }],
  })
})

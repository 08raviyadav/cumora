import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import { versionCommandInvocation } from './cli-version.js'

/** Resolve npm/pnpm entry points so structured TOML never passes through cmd.exe. */
export function codexCommandInvocation(command: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof versionCommandInvocation> {
  let invocation = versionCommandInvocation(command, args)
  if (process.platform !== 'win32') return invocation
  const paths = (env.PATH ?? process.env.PATH ?? '').split(delimiter)
  const shim = [command, ...paths.map(dir => join(dir, command))]
    .flatMap(path => [path, `${path}.cmd`]).find(path => existsSync(path) && /\.cmd$/i.test(path))
  if (!shim) return invocation
  invocation = versionCommandInvocation(shim, args)
  let script = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (!existsSync(script)) {
    try { script = createRequire(join(dirname(shim), 'cumora-resolver.cjs')).resolve('@openai/codex/bin/codex.js') }
    catch { return invocation }
  }
  if (!existsSync(script)) return invocation
  const node = [join(dirname(shim), 'node.exe'), ...paths.map(dir => join(dir, 'node.exe'))]
    .find(path => existsSync(path))
    ?? (/^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : null)
  return node ? { command: node, args: [script, ...args] } : invocation
}

export function assertCodexProviderTransport(args: string[], usesShell: boolean): void {
  if (process.platform === 'win32' && usesShell && args.length) {
    throw new Error('Codex provider settings require a native executable or a resolvable npm/pnpm installation on Windows; this batch wrapper cannot preserve them safely')
  }
}

/** Metadata only. Callers must project config/read before storing or reporting it. */
export function readCodexRpc(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  method: string,
  params: Record<string, unknown>,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const invocation = codexCommandInvocation(command, [...args, 'app-server', '--listen', 'stdio://'], env)
    const hasProvider = args.some(arg => /^(?:model(?:_provider|_providers|_catalog_json)?|openai_base_url)=/.test(arg))
    if (hasProvider && invocation.windowsVerbatimArguments) { resolve(null); return }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        env, cwd: env.CODEX_HOME, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
    } catch { resolve(null); return }
    let done = false
    let closed = false
    let buffer = ''
    let bytes = 0
    const decoder = new StringDecoder('utf8')
    const finish = (value: Record<string, unknown> | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (closed) { resolve(value); return }
      const cleanupDeadline = setTimeout(() => {
        resolve(value)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.unref()
      }, 1500)
      cleanupDeadline.unref()
      child.once('close', () => { clearTimeout(kill); clearTimeout(cleanupDeadline); resolve(value) })
      child.stdin?.end()
      const kill = setTimeout(() => {
        if (!child.pid) return
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {})
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
        }
      }, 250)
      kill.unref()
    }
    const send = (message: object) => {
      if (!done) child.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    const timer = setTimeout(() => finish(null), limits.timeoutMs ?? 10_000)
    timer.unref()
    child.stdin?.on('error', () => finish(null))
    child.once('error', () => finish(null))
    child.once('close', () => { closed = true; finish(null) })
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (limits.maxBytes ?? 2 * 1024 * 1024)) { finish(null); return }
      buffer += decoder.write(chunk)
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0 || done) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { id?: number; result?: Record<string, unknown>; error?: unknown }
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1) {
          if (message.error) { finish(null); return }
          send({ method: 'initialized', params: {} })
          send({ id: 2, method, params })
        } else if (message.id === 2) finish(message.result ?? null)
      }
    })
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'cumora-catalog', version: '1.0.0' }, capabilities: { experimentalApi: true },
    } })
  })
}

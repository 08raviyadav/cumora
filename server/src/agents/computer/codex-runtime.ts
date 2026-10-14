import { createHash, randomUUID } from 'node:crypto'
import { type BigIntStats, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Keep pointers to the isolated runtime separate from pre-upgrade threads.
export const CODEX_SESSION_SCOPE = 'runtime'
export const CODEX_LOGIN_COMMAND = 'cumora agent computer --codex-login'
export const CODEX_MIGRATE_COMMAND = 'cumora agent computer --migrate-codex-sessions'
export const CODEX_RUNTIME_CONFIG_ARGS = [
  '-c', 'memories.generate_memories=false',
  '-c', 'memories.use_memories=false',
]

export function codexRuntimeHome(): string {
  return join(homedir(), '.cumora', 'codex-runtime')
}

interface SharedAuth { source: string; fileId: string }
let sharingFailureNoted = false

function fileId(info: BigIntStats): string { return `${info.dev}:${info.ino}` }

function authFileText(path: string): string | null {
  try { return readFileSync(path, 'utf8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Share auth.json in place, retaining ownership information across daemon restarts. */
function syncSharedAuth(home: string, sourceHome?: string): void {
  const target = join(home, 'auth.json')
  const marker = join(home, 'auth.shared.json')
  const text = authFileText(marker)
  let shared: SharedAuth | null = null
  if (text !== null) {
    try { shared = JSON.parse(text) }
    catch { throw new Error(`Invalid Codex authentication link metadata: ${marker}`) }
    if (!shared || typeof shared.source !== 'string' || !isAbsolute(shared.source)
      || typeof shared.fileId !== 'string' || !/^\d+:\d+$/.test(shared.fileId)) {
      throw new Error(`Invalid Codex authentication link metadata: ${marker}`)
    }
  }
  const current = lstatSync(target, { bigint: true, throwIfNoEntry: false })
  if (current && (!shared || fileId(current) !== shared.fileId)) {
    // An independently configured runtime login always takes precedence.
    if (shared) rmSync(marker, { force: true })
    return
  }
  const source = sourceHome && relative(sourceHome, home) !== ''
    ? join(resolve(sourceHome), 'auth.json') : shared?.source
  if (!source) return
  const original = statSync(source, { bigint: true, throwIfNoEntry: false })
  if (original && !original.isFile()) throw new Error(`Codex authentication source is not a file: ${source}`)
  if (current && original && fileId(current) === fileId(original)
    && (shared?.source === source || relative(realpathSync(source), realpathSync(target)) === '')) return
  if (current) rmSync(target)
  let linkedId = shared?.fileId
  if (original) {
    try { linkSync(realpathSync(source), target) }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
      // shortcut: hard links require one volume; use separate login on other filesystems.
      if (!sharingFailureNoted) {
        sharingFailureNoted = true
        console.warn(`[codex] cannot share the personal login (${(err as NodeJS.ErrnoException).code ?? 'filesystem error'}); run ${CODEX_LOGIN_COMMAND} to sign in separately.`)
      }
      return
    }
    linkedId = fileId(lstatSync(target, { bigint: true }))
  }
  if (!linkedId || (shared?.source === source && shared.fileId === linkedId)) return
  const temporary = `${marker}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ source, fileId: linkedId }), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, marker)
  } catch (err) {
    const linked = lstatSync(target, { bigint: true, throwIfNoEntry: false })
    if (linked && fileId(linked) === linkedId) rmSync(target)
    throw err
  } finally { rmSync(temporary, { force: true }) }
}

/** Idle app-server processes must reload after login, logout or token rotation. */
export function codexAuthFingerprint(home = codexRuntimeHome()): string | null | undefined {
  syncSharedAuth(home)
  const text = authFileText(join(home, 'auth.json'))
  if (text === null) return null
  // Codex writes credentials in place; a partial write is not an account change.
  try { JSON.parse(text) } catch { return undefined }
  return createHash('sha256').update(text).digest('hex')
}

/** Only Codex children get this environment; other engines keep their homes. */
export function codexRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = codexRuntimeHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  syncSharedAuth(home, env.CODEX_HOME || join(homedir(), '.codex'))
  return { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: home }
}

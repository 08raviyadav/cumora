import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decompress } from 'fzstd'
import { CODEX_SESSION_SCOPE, codexRuntimeHome } from './codex-runtime.js'
import { EngineSessionStore } from './session-store.js'

function missingAsNull(err: NodeJS.ErrnoException): null {
  if (err.code !== 'ENOENT') throw err
  return null
}

async function entries(path: string, recursive = true): Promise<string[]> {
  return await readdir(path, { recursive }).catch(missingAsNull) ?? []
}

interface Rollout {
  path: string
  timestamp: string
  threadId: string
  rolloutId: string
  endByteOffset?: number
}

interface SessionMetadata {
  id: string
  history_mode?: 'legacy' | 'paginated'
  history_base?: { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number } | null
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const rolloutName = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${uuid})(?:_(${uuid}))?\\.jsonl(?:\\.zst)?$`, 'i')

async function rolloutsIn(home: string): Promise<Rollout[]> {
  const rollouts = new Map<string, Rollout>()
  for (const directory of ['sessions', 'archived_sessions']) {
    for (const entry of await entries(join(home, directory))) {
      const match = rolloutName.exec(basename(entry))
      if (!match) continue
      const path = join(directory, entry)
      const key = path.replace(/\.zst$/, '')
      // Codex prefers the plain representation while compression publishes its replacement.
      if (!rollouts.has(key) || !path.endsWith('.zst')) {
        rollouts.set(key, { path, timestamp: match[1], threadId: match[2], rolloutId: match[3] ?? match[2] })
      }
    }
  }
  return [...rollouts.values()]
}

async function rolloutMetadata(path: string, minimumBytes = 0): Promise<SessionMetadata> {
  const bytes = path.endsWith('.zst') ? decompress(await readFile(path)) : null
  if (minimumBytes > 0 && minimumBytes > (bytes?.byteLength ?? (await stat(path)).size)) {
    throw new Error(`history_base extends beyond source rollout ${path}`)
  }
  if (minimumBytes > 0) {
    let lastByte = bytes?.[minimumBytes - 1]
    if (!bytes) {
      const file = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(1)
        await file.read(buffer, 0, 1, minimumBytes - 1)
        lastByte = buffer[0]
      } finally { await file.close() }
    }
    if (lastByte !== 10) throw new Error(`history_base does not end at a complete record in ${path}`)
  }
  const input = bytes ? Readable.from([bytes]) : createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let metadata
      try { metadata = JSON.parse(line) } catch { continue }
      if (metadata?.type === 'session_meta' && typeof metadata.payload?.id === 'string') {
        if (metadata.payload.history_mode && !['legacy', 'paginated'].includes(metadata.payload.history_mode)) {
          throw new Error(`unsupported history mode in ${path}`)
        }
        return metadata.payload
      }
      if (metadata?.type === 'response_item') break
    }
    throw new Error(`rollout has no readable session metadata: ${path}`)
  } finally {
    lines.close()
    input.destroy()
  }
}

async function selectedRollout(id: string, home: string, rollouts: Rollout[]): Promise<Rollout> {
  const candidates = rollouts.filter(rollout => rollout.threadId === id)
  if (!candidates.length) throw new Error(`its rollout is unavailable in ${home}`)
  const sqliteHome = process.env.CODEX_SQLITE_HOME || home
  const databases = (await entries(sqliteHome, false)).filter(path => /^state_\d+\.sqlite$/.test(path))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
  let selected: Rollout | undefined
  if (databases.length) {
    // Read only the selected path; never migrate personal database rows.
    const sqliteModule = 'node:sqlite'
    let sqlite
    try { sqlite = await import(sqliteModule) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err
      throw new Error('reading Codex\'s selected rollout from SQLite requires Node.js 22.13 or newer; retry this one-time migration with a newer Node.js')
    }
    const database = new sqlite.DatabaseSync(join(sqliteHome, databases[0]), { readOnly: true })
    try {
      const row = database.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id)
      if (row) {
        const path = relative(resolve(home), resolve(String(row.rollout_path))).replace(/\.zst$/, '')
        selected = candidates.find(rollout => rollout.path.replace(/\.zst$/, '') === path)
        if (!selected) throw new Error(`the rollout selected by Codex's database is unavailable: ${row.rollout_path}`)
      }
    } finally { database.close() }
  }
  // Match Codex's filesystem fallback, including its same-second rollout-ID tie-breaker.
  selected ??= candidates.filter(rollout => rollout.path.startsWith(`sessions${sep}`))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.rolloutId.localeCompare(a.rolloutId))[0]
  if (!selected || selected.path.startsWith('archived_sessions')) {
    throw new Error(`thread is archived in ${home}; run \`codex unarchive ${id}\` with CODEX_HOME set to that home, then retry migration`)
  }
  return selected
}

async function rolloutHistory(current: Rollout, home: string, rollouts: Rollout[]): Promise<Rollout[]> {
  const history: Rollout[] = []
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(current.rolloutId)) throw new Error(`cyclic history_base at ${current.path}`)
    seen.add(current.rolloutId)
    const metadata = await rolloutMetadata(join(home, current.path), current.endByteOffset)
    if (metadata.id !== current.threadId) throw new Error(`rollout belongs to another thread: ${current.path}`)
    history.push(current)
    const base = metadata.history_base
    if (!base) return history.reverse()
    if (metadata.history_mode !== 'paginated'
      || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 1
      || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 1) {
      throw new Error(`invalid history_base in ${current.path}`)
    }
    const sources = rollouts.filter(rollout => rollout.rolloutId === base.thread_id)
    if (sources.length !== 1) {
      throw new Error(`${sources.length ? 'ambiguous' : 'missing'} source rollout ${base.thread_id} referenced by ${current.path}`)
    }
    current = { ...sources[0], endByteOffset: base.end_byte_offset }
  }
}

/** Publish complete files without truncating a rollout another agent already uses. */
async function copyRollout(rollout: Rollout, sourceHome: string, destinationHome: string): Promise<void> {
  const source = join(sourceHome, rollout.path)
  const destination = join(destinationHome, rollout.endByteOffset ? rollout.path.replace(/\.zst$/, '') : rollout.path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp${destination.endsWith('.zst') ? '.zst' : ''}`
  try {
    const input = source.endsWith('.zst') && rollout.endByteOffset
      ? Readable.from([decompress(await readFile(source)).subarray(0, rollout.endByteOffset)])
      : createReadStream(source, { end: rollout.endByteOffset ? rollout.endByteOffset - 1 : undefined })
    await pipeline(input, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    const metadata = await rolloutMetadata(temporary, rollout.endByteOffset)
    if (metadata.id !== rollout.threadId) throw new Error(`copied rollout belongs to another thread: ${source}`)
    try { await link(temporary, destination) }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const requiredBytes = rollout.endByteOffset ?? (temporary.endsWith('.zst')
        ? decompress(await readFile(temporary)).byteLength
        : (await stat(temporary)).size)
      const existing = await rolloutMetadata(destination, requiredBytes)
      if (existing.id !== rollout.threadId) throw new Error(`destination rollout belongs to another thread: ${destination}`)
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Copy an agent's referenced rollout before switching its session pointer.
 * No legacy pointer means there is nothing to migrate (including new users). */
export async function migrateCodexSession(
  agentId: string,
  sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  sessionsDir = join(homedir(), '.cumora', 'sessions'),
  destinationHome = codexRuntimeHome(),
): Promise<boolean> {
  const legacy = join(sessionsDir, agentId, 'codex.session')
  const store = new EngineSessionStore(sessionsDir, agentId, 'codex', CODEX_SESSION_SCOPE)
  let id = ''
  try {
    if (!await stat(legacy).catch(missingAsNull)) return false
    // A read error is not an absent pointer: never overwrite unreadable state.
    const runtime = await readFile(store.sessionFile, 'utf8').catch(missingAsNull)
    if (runtime?.trim()) {
      await rename(legacy, `${legacy}.migrated`).catch(async () => {
        await rm(legacy, { force: true }).catch(() => {})
      })
      return false
    }
    id = (await readFile(legacy, 'utf8')).trim()
    if (id) {
      if (resolve(sourceHome) === resolve(destinationHome)) throw new Error('source and destination Codex homes are the same')
      const rollouts = await rolloutsIn(sourceHome)
      const current = await selectedRollout(id, sourceHome, rollouts)
      const history = await rolloutHistory(current, sourceHome, rollouts)
      for (const rollout of history) await copyRollout(rollout, sourceHome, destinationHome)
      // Migration must report pointer-write failures instead of starting fresh.
      const temporary = `${store.sessionFile}.${randomUUID()}.migrating`
      try {
        await writeFile(temporary, `${id}\n`, { mode: 0o600, flag: 'wx' })
        try { await link(temporary, store.sessionFile) }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          if (!(await readFile(store.sessionFile, 'utf8')).trim()) throw err
          return false
        }
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
    }
    await rename(legacy, `${legacy}.migrated`).catch(missingAsNull)
    return !!id
  } catch (err) {
    throw new Error(`Cannot migrate Codex ${id ? `thread ${id}` : 'session'} for ${agentId}: ${err instanceof Error ? err.message : String(err)}. The old session pointer has been preserved.`, { cause: err })
  }
}

/** Manual retry for all saved agents. Daemon startup migrates them individually
 * so one unavailable rollout cannot stop other agents from being hosted. */
export async function migrateCodexSessions(
  sourceHome?: string,
  sessionsDir = join(homedir(), '.cumora', 'sessions'),
  destinationHome?: string,
): Promise<string[]> {
  const pointers = (await entries(sessionsDir))
    .filter(path => basename(path) === 'codex.session')
  const migrated: string[] = []
  const failures: Error[] = []
  for (const pointer of pointers) {
    const agentId = basename(dirname(pointer))
    try {
      if (await migrateCodexSession(agentId, sourceHome, sessionsDir, destinationHome)) migrated.push(agentId)
    } catch (err) { failures.push(err instanceof Error ? err : new Error(String(err))) }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Migrated ${migrated.length} Codex session(s)${migrated.length ? ` (${migrated.join(', ')})` : ''} to ${destinationHome ?? codexRuntimeHome()}. Personal Codex data was left in place; failed ${failures.length}:\n${failures.map(err => err.message).join('\n')}`)
  }
  return migrated
}

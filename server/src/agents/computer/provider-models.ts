import { readFileSync, statSync } from 'node:fs'
import type { EngineModelOption } from './model-catalog.js'
import { modelIdOrNull } from './model-id.js'

export const MAX_CATALOG_MODELS = 1024
const MAX_BYTES = 2 * 1024 * 1024

export interface ProviderCatalogConnection {
  url: string
  headers: Record<string, string>
  query?: Record<string, string>
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || undefined
}

/** Deliberately ignore generic capability claims (especially native Fast Mode). */
export function parseProviderModels(rows: unknown): EngineModelOption[] {
  if (!Array.isArray(rows)) return []
  return rows.slice(0, MAX_CATALOG_MODELS).flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const id = modelIdOrNull(typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : typeof row.slug === 'string' ? row.slug : null)
    if (!id) return []
    return [{
      id,
      label: text(row.label ?? row.display_name ?? row.displayName ?? row.name, 160) ?? id,
      description: text(row.description, 320),
    }]
  })
}

export function readProviderCatalogFile(file: string | null): EngineModelOption[] {
  if (!file) return []
  try {
    if (statSync(file).size > MAX_BYTES) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parseProviderModels(parsed.models ?? parsed.data ?? parsed)
  } catch { return [] }
}

/** A null result is a failed refresh; [] is a successful, explicitly empty catalog. */
export async function fetchProviderModels(connection: ProviderCatalogConnection): Promise<EngineModelOption[] | null> {
  const models: EngineModelOption[] = []
  const url = new URL(connection.url)
  for (const [key, value] of Object.entries(connection.query ?? {})) url.searchParams.set(key, value)
  const cursors = new Set<string>()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3500)
  timeout.unref()
  let total = 0
  try {
    for (let page = 0; page < 8; page++) {
      const response = await fetch(url, {
        headers: connection.headers, redirect: 'error', signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.length
          if (total > MAX_BYTES) { await reader.cancel(); return null }
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const rows = body.data ?? body.models
      if (!Array.isArray(rows)) return null
      models.push(...parseProviderModels(rows))
      if (models.length >= MAX_CATALOG_MODELS) return models.slice(0, MAX_CATALOG_MODELS)
      const cursor = body.next_cursor ?? body.nextCursor ?? (body.has_more === true ? body.last_id : null)
      if (typeof cursor !== 'string' || !cursor) return body.has_more === true ? null : models
      if (cursors.has(cursor)) return null
      cursors.add(cursor)
      // Only a cursor may be returned by the server, never a URL to fetch.
      url.searchParams.set(body.has_more === true ? 'after_id' : 'cursor', cursor)
    }
    return null
  } catch { return null }
  finally { clearTimeout(timeout); controller.abort() }
}

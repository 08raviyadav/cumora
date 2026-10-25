import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { CODEX_RUNTIME_CONFIG_ARGS, codexRuntimeEnv, codexRuntimeHome } from './codex-runtime.js'
import { readCodexRpc } from './codex-rpc.js'
import { modelIdOrNull } from './model-id.js'
import type { ProviderCatalogConnection } from './provider-models.js'

export interface CodexProvider {
  args: string[]
  defaultModel: string | null
  prefersLocalDefault: boolean
  connection: ProviderCatalogConnection | null
  catalogFile: string | null
  fingerprint: string
  identity: string
  ignoresOpenAIBaseEnv: boolean
}

const cache = new Map<string, Promise<CodexProvider>>()
const ready = new Map<string, CodexProvider>()
const agentRuntimeEnv = new Set(['CUMORA_AGENT_ID', 'CUMORA_AGENT_IPC_DIR', 'CUMORA_AGENT_MCP_SHIM'])
const configReads = new Map<string, Promise<Record<string, unknown> | null>>()

function sourceHome(env: NodeJS.ProcessEnv): string {
  if (existsSync(join(codexRuntimeHome(), 'config.toml'))) return codexRuntimeHome()
  const home = env.CODEX_HOME || join(homedir(), '.codex')
  if (!isAbsolute(home)) throw new Error('Codex configuration home must be absolute')
  return home
}

function configText(home: string): string {
  const file = join(home, 'config.toml')
  if (!existsSync(file)) return ''
  if (statSync(file).size > 1024 * 1024) throw new Error('Codex provider configuration is too large')
  return readFileSync(file, 'utf8')
}

/** Local hash only: changing credentials/config invalidates caches without publishing them. */
export function codexProviderFingerprint(env: NodeJS.ProcessEnv): string {
  const home = sourceHome(env)
  return createHash('sha256').update(home).update(configText(home))
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].length <= 4096 && !/[\r\n\0]/.test(entry[1])).slice(0, 64))
}

function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  return `{${Object.entries(record(value)).map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`).join(',')}}`
}

/** Only connection fields, never commands, hooks, MCP, permissions, profiles or tool settings. */
export function projectCodexProvider(config: Record<string, unknown>, env: NodeJS.ProcessEnv, home: string, fingerprint = ''): CodexProvider {
  const args: string[] = []
  const add = (key: string, value: unknown) => { args.push('-c', `${key}=${toml(value)}`) }
  const providerId = typeof config.model_provider === 'string' ? config.model_provider : 'openai'
  const raw = record(record(config.model_providers)[providerId])
  const provider: Record<string, unknown> = {}
  for (const key of ['name', 'base_url', 'model_catalog_url', 'env_key', 'experimental_bearer_token', 'wire_api']) {
    const value = raw[key]
    if (typeof value === 'string' && value.length <= 4096) provider[key] = value
  }
  for (const key of ['requires_openai_auth', 'supports_websockets']) {
    if (typeof raw[key] === 'boolean') provider[key] = raw[key]
  }
  for (const key of ['http_headers', 'env_http_headers', 'query_params']) {
    const entries = strings(raw[key])
    if (Object.keys(entries).length) provider[key] = entries
  }
  const usesOpenAIEnv = providerId === 'openai' && !raw.base_url && typeof config.openai_base_url !== 'string' && !!env.OPENAI_BASE_URL
  const openaiBase = providerId !== 'openai' ? null
    : typeof config.openai_base_url === 'string' ? config.openai_base_url : env.OPENAI_BASE_URL
  const baseUrl = (typeof raw.base_url === 'string' ? raw.base_url : null) || openaiBase
  if (typeof config.model_provider === 'string') {
    add('model_provider', providerId)
  }
  if (Object.keys(provider).length) {
    add('model_providers', { [providerId]: provider })
  }
  if (openaiBase && providerId === 'openai') add('openai_base_url', openaiBase)
  const defaultModel = modelIdOrNull(typeof config.model === 'string' ? config.model : null)
  if (defaultModel) add('model', defaultModel)
  let catalogFile: string | null = null
  if (typeof config.model_catalog_json === 'string') {
    catalogFile = resolve(home, config.model_catalog_json)
    add('model_catalog_json', catalogFile)
  }
  let connection: ProviderCatalogConnection | null = null
  const headers = strings(provider.http_headers)
  for (const [key, name] of Object.entries(strings(provider.env_http_headers))) {
    if (env[name]) headers[key] = env[name]!
  }
  const token = typeof provider.env_key === 'string' ? env[provider.env_key]
    : typeof provider.experimental_bearer_token === 'string' ? provider.experimental_bearer_token : env.OPENAI_API_KEY
  if (token && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${token}`
  if (baseUrl) {
    try {
      const base = new URL(baseUrl)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error()
      const explicit = typeof provider.model_catalog_url === 'string' ? new URL(provider.model_catalog_url, base) : null
      // Catalog credentials may never cross to another origin.
      if (explicit && explicit.origin !== base.origin) throw new Error()
      const standard = new URL(base)
      standard.pathname = `${standard.pathname.replace(/\/+$/, '')}/models`
      standard.hash = ''
      const url = explicit ?? standard
      // OAuth-only connections use the engine protocol; do not repurpose login tokens.
      const compatibleApi = !!raw.base_url || usesOpenAIEnv || !!explicit
      if (compatibleApi && (provider.requires_openai_auth !== true || token)) {
        connection = { url: url.href, headers, query: strings(provider.query_params) }
      }
    } catch { /* Invalid/unsupported endpoint: protocol and configured choices remain available. */ }
  }
  const prefersLocalDefault = !!baseUrl || providerId !== 'openai'
  const identity = createHash('sha256').update(JSON.stringify([
    providerId, provider, baseUrl, headers, token,
  ])).digest('hex')
  return { args, defaultModel, prefersLocalDefault, connection, catalogFile, fingerprint, identity,
    ignoresOpenAIBaseEnv: !!raw.base_url || typeof config.openai_base_url === 'string' || providerId !== 'openai' }
}

async function readEffectiveCodexConfig(command: string, env: NodeJS.ProcessEnv, home: string): Promise<Record<string, unknown>> {
  const keyEnv = Object.entries(env).filter(([key]) => !agentRuntimeEnv.has(key)).sort(([a], [b]) => a.localeCompare(b))
  const key = createHash('sha256').update(command).update(home).update(configText(home)).update(JSON.stringify(keyEnv)).digest('hex')
  let pending = configReads.get(key)
  if (!pending) {
    // Share only the effective-config read; provider projection still uses each agent's environment.
    pending = readCodexRpc(command, [
      ...CODEX_RUNTIME_CONFIG_ARGS,
      '-c', 'features.hooks=false', '-c', 'features.apps=false',
      '-c', 'features.remote_plugin=false', '-c', 'mcp_servers={}',
    ], { ...env, CODEX_HOME: home }, 'config/read', { includeLayers: false })
    configReads.set(key, pending)
    void pending.then(() => {
      if (configReads.get(key) === pending) configReads.delete(key)
    }, () => {
      if (configReads.get(key) === pending) configReads.delete(key)
    })
  }
  const result = await pending
  if (!result || !result.config || typeof result.config !== 'object') {
    throw new Error('Cannot read effective Codex provider configuration; refresh the engine after correcting its configuration')
  }
  return record(result.config)
}

export function cachedCodexProvider(env: NodeJS.ProcessEnv): CodexProvider | undefined {
  const fingerprint = codexProviderFingerprint(env)
  const cached = ready.get(fingerprint)
  if (cached) return cached
  const home = sourceHome(env)
  return configText(home) ? undefined : projectCodexProvider({}, env, home, fingerprint)
}

export async function prepareCodexProvider(command: string, env: NodeJS.ProcessEnv): Promise<CodexProvider> {
  const fingerprint = codexProviderFingerprint(env)
  const key = `${command}\0${fingerprint}`
  const existing = cache.get(key)
  if (existing) return existing
  const pending = (async () => {
    const home = sourceHome(env)
    let config: Record<string, unknown> = {}
    if (configText(home)) {
      // Resolve TOML/profiles using the installed engine, with startup integrations disabled.
      config = await readEffectiveCodexConfig(command, env, home)
    }
    const projected = projectCodexProvider(config, env, home, fingerprint)
    ready.set(fingerprint, projected)
    if (ready.size > 64) ready.delete(ready.keys().next().value!)
    return projected
  })()
  cache.set(key, pending)
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  try { return await pending } catch (error) { cache.delete(key); throw error }
}

export async function codexProviderRuntime(command: string, env: NodeJS.ProcessEnv) {
  const provider = await prepareCodexProvider(command, env)
  return { provider, env: codexProviderEnv(provider, env) }
}

export function codexProviderEnv(provider: CodexProvider, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = codexRuntimeEnv(env)
  if (provider.ignoresOpenAIBaseEnv) delete runtime.OPENAI_BASE_URL
  return runtime
}

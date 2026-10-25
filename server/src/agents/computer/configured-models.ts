import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { EngineModelOption } from './model-catalog.js'
import { modelIdOrNull } from './model-id.js'
import { parseProviderModels } from './provider-models.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function read(file: string): Record<string, unknown> {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) throw new Error('Model settings exceed the size limit')
    // JSONC comments/trailing commas are allowed; quoted URLs and strings stay intact.
    const text = readFileSync(file, 'utf8')
      .replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : '')
      .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : '')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid model settings')
    return parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function home(override: string | undefined, directory: string): string {
  if (override && !isAbsolute(override)) throw new Error('Engine configuration home must be absolute')
  return override || join(homedir(), directory)
}

/** Read model declarations only. The engine still owns credentials and execution. */
export function configuredEngineModels(id: 'gemini' | 'qwen' | 'zcode', env: NodeJS.ProcessEnv): {
  models: EngineModelOption[]; defaultModel: string | null
} | null {
  let rows: unknown[] = []
  let defaultId: unknown
  let declared = false
  let includeDefault = true
  if (id === 'gemini' || id === 'qwen') {
    const dir = id === 'gemini' ? join(home(env.GEMINI_CLI_HOME, ''), '.gemini') : home(env.QWEN_HOME, '.qwen')
    const settings = read(join(dir, 'settings.json'))
    defaultId = object(settings.model).name
    if (id === 'gemini') {
      defaultId = env.GEMINI_MODEL || defaultId
      const configs = object(settings.modelConfigs)
      const definitions = object(configs.modelDefinitions)
      const aliases = { ...object(configs.aliases), ...object(configs.customAliases) }
      includeDefault = typeof defaultId !== 'string' || object(definitions[defaultId]).isVisible !== false
      declared = ['modelDefinitions', 'aliases', 'customAliases'].some(key => key in configs)
      rows = [
        ...Object.entries(definitions).filter(([, value]) => object(value).isVisible !== false)
          .map(([id, value]) => ({ id, displayName: object(value).displayName })),
        ...Object.keys(aliases).filter(id => !(id in definitions)).map(id => ({ id })),
      ]
    } else {
      // --model selects within the active auth protocol. Advertising a model
      // from another protocol would require changing execution credentials.
      const auth = object(object(settings.security).auth)
      const inferred = env.QWEN_OAUTH ? 'qwen-oauth'
        : env.OPENAI_API_KEY && env.OPENAI_BASE_URL && (env.OPENAI_MODEL || env.QWEN_MODEL) ? 'openai'
        : env.GEMINI_API_KEY && env.GEMINI_MODEL ? 'gemini'
        : (env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_PROJECT) && env.GOOGLE_MODEL ? 'vertex-ai'
        : env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL && env.ANTHROPIC_BASE_URL ? 'anthropic' : 'qwen-oauth'
      const protocol = typeof auth.selectedType === 'string' ? auth.selectedType : inferred
      const protocols = object(settings.providerProtocol)
      const vars: Record<string, string | undefined> = {
        openai: env.OPENAI_MODEL || env.QWEN_MODEL, anthropic: env.ANTHROPIC_MODEL,
        gemini: env.GEMINI_MODEL, 'vertex-ai': env.GOOGLE_MODEL,
      }
      defaultId ||= vars[protocol]
      const providers = object(settings.modelProviders)
      declared = 'modelProviders' in settings
      const declarations = Object.entries(providers).filter(([key]) => (protocols[key] ?? key) === protocol)
        .flatMap(([, value]) => Array.isArray(value) ? value : [])
      const chat = (value: unknown) => object(value).imageOnly !== true && object(value).realtimeOnly !== true
      rows = declarations.filter(chat)
      const connection = (value: unknown) => {
        const row = object(value)
        return JSON.stringify([row.baseUrl, row.envKey, row.wireApi, row.api, object(row.generationConfig).customHeaders])
      }
      const routes = new Map<unknown, Set<string>>()
      for (const row of rows) {
        const key = object(row).id
        if (!routes.has(key)) routes.set(key, new Set())
        routes.get(key)!.add(connection(row))
      }
      // --model carries no route discriminator. Hide ambiguous IDs instead of
      // silently selecting the first credential/endpoint registered for them.
      includeDefault = (routes.get(defaultId)?.size ?? 0) <= 1
        && !declarations.some(value => object(value).id === defaultId && !chat(value))
      rows = rows.filter(value => routes.get(object(value).id)!.size === 1)
    }
  } else {
    const root = home(env.ZCODE_HOME, '.zcode')
    const providers = object(read(join(root, 'v2', 'config.json')).provider)
    const personal = object(read(join(root, 'v2', 'provider_config.json')).config)
    const modelRules = object(personal.modelConfigRules)
    const normalize = (id: string) => id.replace(/^account:([a-z0-9]+)-(?:individual-|team-)?coding-plan$/, 'builtin:$1-coding-plan')
      .replace(/^account:([a-z0-9]+)-start-plan$/, 'builtin:$1-start-plan')
    const personalModels = new Map<string, string[]>()
    const disabled = new Set<string>()
    for (const value of [modelRules.providerModelRules, modelRules.manualProviderModelRules]) {
      for (const rule of Array.isArray(value) ? value : []) {
        const row = object(rule)
        if (typeof row.providerId !== 'string' || typeof row.modelId !== 'string') continue
        const key = normalize(row.providerId)
        if (!personalModels.has(key)) personalModels.set(key, [])
        if (object(row.config).enabled === false) disabled.add(`${key}\\${row.modelId}`)
        else personalModels.get(key)!.push(row.modelId)
      }
    }
    const rules = object(personal.providerConfigRules).providerRules
    for (const rule of Array.isArray(rules) ? rules : []) {
      const row = object(rule)
      if (typeof row.providerId !== 'string') continue
      const key = normalize(row.providerId)
      if (key in providers) continue
      const config = object(row.config)
      providers[key] = { name: row.providerName, enabled: row.enabled,
        options: { apiKey: object(config.access).apiKey, baseURL: object(config.api).baseUrl } }
    }
    declared = Object.keys(providers).length > 0
    let firstProvider: string | undefined
    for (const [providerId, value] of Object.entries(providers)) {
      if (env.ZCODE_PROVIDER && normalize(env.ZCODE_PROVIDER) !== providerId) continue
      const provider = object(value)
      const options = object(provider.options)
      let local = false
      try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(String(options.baseURL)).hostname) } catch { /* no local endpoint */ }
      const usable = providerId.startsWith('builtin:')
        ? provider.enabled === true && !!options.apiKey
        : provider.enabled !== false && (!!options.apiKey || options.apiKeyRequired === false || local)
      if (!usable) continue
      firstProvider ??= providerId
      const configured = object(provider.models)
      const personalIds = personalModels.get(providerId)
      const ids = personalIds && !providerId.startsWith('builtin:') ? personalIds : [...Object.keys(configured), ...(personalIds ?? [])]
      rows.push(...ids.filter(id => !disabled.has(`${providerId}\\${id}`))
        .map(id => ({ id: `${providerId}\\${id}`, label: object(configured[id]).name ?? id })))
    }
    if (env.ZCODE_MODEL && firstProvider) {
      defaultId = env.ZCODE_MODEL.includes('\\') ? env.ZCODE_MODEL : `${firstProvider}\\${env.ZCODE_MODEL}`
    }
    includeDefault = typeof defaultId !== 'string' || !disabled.has(defaultId)
  }
  const defaultModel = typeof defaultId === 'string' ? modelIdOrNull(defaultId) : null
  if (defaultModel && includeDefault) rows.push({ id: defaultModel })
  if (!declared && !defaultModel) return null
  return { models: parseProviderModels(rows).map(model => ({ ...model, supportsFastMode: false })), defaultModel }
}

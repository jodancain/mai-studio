import { isClaudeOpus55Model } from '@shared/utils/model'

import { isCustomProviderNamespace } from '../../../utils/options'

const CUSTOM_PARAMS_FETCH_CACHE_SIZE = 10
const customParamsFetchCache = new WeakMap<typeof globalThis.fetch, Map<string, typeof globalThis.fetch>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Runs inside custom-body wrappers so their overrides cannot restore rejected fields. */
export function createClaudeOpus55Fetch(
  innerFetch: typeof globalThis.fetch,
  maxOutputTokens?: number,
  allowContextEdits = false
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return innerFetch(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (!url.split(/[?#]/)[0].endsWith('/messages')) return innerFetch(input, init)
    let body: unknown
    try {
      body = JSON.parse(init.body)
    } catch {
      return innerFetch(input, init)
    }
    if (!isRecord(body) || typeof body.model !== 'string' || !isClaudeOpus55Model({ id: body.model })) {
      return innerFetch(input, init)
    }

    const normalized = { ...body }
    delete normalized.temperature
    delete normalized.top_p
    delete normalized.top_k
    if (maxOutputTokens !== undefined && typeof body.max_tokens === 'number') {
      normalized.max_tokens = Math.min(body.max_tokens, maxOutputTokens)
    }
    const thinking = isRecord(body.thinking) ? body.thinking : undefined
    const blockBinding = isRecord(thinking?.block_binding)
      ? thinking.block_binding
      : allowContextEdits
        ? { prefix_mismatch_behavior: 'drop_block' }
        : undefined
    normalized.thinking = {
      type: 'adaptive',
      ...(typeof thinking?.display === 'string' && { display: thinking.display }),
      ...(blockBinding && { block_binding: blockBinding })
    }
    const outputConfig = isRecord(body.output_config) ? body.output_config : {}
    normalized.output_config = {
      ...outputConfig,
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(outputConfig.effort))
        ? outputConfig.effort
        : 'medium'
    }
    if (isRecord(body.tool_choice) && (body.tool_choice.type === 'any' || body.tool_choice.type === 'tool')) {
      normalized.tool_choice = { type: 'auto' }
    }
    const headers = new Headers(init.headers)
    if (allowContextEdits) {
      const betas = new Set(
        (headers.get('anthropic-beta') ?? '')
          .split(',')
          .map((beta) => beta.trim())
          .filter(Boolean)
      )
      betas.add('thinking-binding-controls-2026-08-01')
      headers.set('anthropic-beta', [...betas].join(','))
    }
    return innerFetch(input, {
      ...init,
      headers: allowContextEdits ? headers : init.headers,
      body: JSON.stringify(normalized)
    })
  }
}

/**
 * Keep flat custom parameters for HTTP-body passthrough while excluding
 * provider-scoped option bags that only belong inside `providerOptions`.
 */
export function selectCustomBodyParameters(
  providerParams: Record<string, unknown>,
  providerOptions: Record<string, Record<string, unknown>>,
  rawProviderId: string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(providerParams).filter(([key]) => !isCustomProviderNamespace(key, providerOptions, rawProviderId))
  )
}

/**
 * Re-inject raw custom parameters after an AI SDK provider has serialized its
 * schema-filtered request body. SDK-produced fields keep higher precedence.
 */
export function createCustomParamsFetch(
  innerFetch: typeof globalThis.fetch,
  customParams: Record<string, unknown>
): typeof globalThis.fetch {
  if (Object.keys(customParams).length === 0) return innerFetch

  const serializedCustomParams = JSON.stringify(customParams) ?? '{}'
  let cachedByParams = customParamsFetchCache.get(innerFetch)
  if (!cachedByParams) {
    cachedByParams = new Map()
    customParamsFetchCache.set(innerFetch, cachedByParams)
  }

  const cachedFetch = cachedByParams.get(serializedCustomParams)
  if (cachedFetch) {
    cachedByParams.delete(serializedCustomParams)
    cachedByParams.set(serializedCustomParams, cachedFetch)
    return cachedFetch
  }

  const customParamsSnapshot = JSON.parse(serializedCustomParams) as Record<string, unknown>
  const wrappedFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string') {
      let body: unknown
      try {
        body = JSON.parse(init.body)
      } catch {
        return innerFetch(input, init)
      }

      if (isRecord(body)) {
        return innerFetch(input, {
          ...init,
          body: JSON.stringify({ ...customParamsSnapshot, ...body })
        })
      }
    }

    return innerFetch(input, init)
  }

  if (cachedByParams.size >= CUSTOM_PARAMS_FETCH_CACHE_SIZE) {
    const oldestKey = cachedByParams.keys().next().value
    if (oldestKey !== undefined) cachedByParams.delete(oldestKey)
  }
  cachedByParams.set(serializedCustomParams, wrappedFetch)
  return wrappedFetch
}

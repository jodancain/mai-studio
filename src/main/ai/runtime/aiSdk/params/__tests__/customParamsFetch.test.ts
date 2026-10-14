import { describe, expect, it, vi } from 'vitest'

import { createClaudeOpus55Fetch, createCustomParamsFetch, selectCustomBodyParameters } from '../customParamsFetch'

function createInnerFetch() {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
}

describe('Opus 5.5 wire contract', () => {
  it.each(['disabled', 'enabled', 'adaptive'])(
    'normalizes %s thinking after flat custom-body injection',
    async (type) => {
      let outgoing: Record<string, any> = {}
      const innerFetch: typeof fetch = async (_input, init) => {
        outgoing = JSON.parse(init!.body as string)
        return new Response(null, { status: 204 })
      }
      const fetchWithCustomParams = createCustomParamsFetch(createClaudeOpus55Fetch(innerFetch, 64), {
        temperature: 0.2,
        top_p: 0.8,
        top_k: 4,
        thinking: { type, budget_tokens: 1024, display: 'summarized' },
        output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
        tool_choice: { type: 'tool', name: 'echo' }
      })
      await fetchWithCustomParams('https://provider.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1088, messages: [] })
      })
      expect(outgoing).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 64,
        messages: [],
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
        tool_choice: { type: 'auto' }
      })
    }
  )

  it.each([undefined, 'none', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'keeps a legal effort for requested %s without expanding the token cap',
    async (effort) => {
      let outgoing: Record<string, any> = {}
      const innerFetch: typeof fetch = async (_input, init) => {
        outgoing = JSON.parse(init!.body as string)
        return new Response(null, { status: 204 })
      }
      await createClaudeOpus55Fetch(innerFetch, 64)('https://provider.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 32,
          output_config: { effort },
          tool_choice: { type: 'none' }
        })
      })
      expect(outgoing.max_tokens).toBe(32)
      expect(outgoing.output_config.effort).toBe(effort === undefined || effort === 'none' ? 'medium' : effort)
      expect(outgoing.thinking).toEqual({ type: 'adaptive' })
      expect(outgoing.tool_choice).toEqual({ type: 'none' })
    }
  )

  it('leaves an older Claude request untouched', async () => {
    let outgoing: string | undefined
    const innerFetch: typeof fetch = async (_input, init) => {
      outgoing = init?.body as string
      return new Response(null, { status: 204 })
    }
    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tool_choice: { type: 'any' },
      temperature: 0.2
    })
    await createClaudeOpus55Fetch(innerFetch, 64)('https://provider.test/v1/messages', { method: 'POST', body })
    expect(outgoing).toBe(body)
  })

  it.each(['error', 'drop_block'])(
    'preserves explicit %s prefix binding and the caller beta header',
    async (behavior) => {
      let outgoing: Record<string, any> = {}
      let headers: HeadersInit | undefined
      const innerFetch: typeof fetch = async (_input, init) => {
        outgoing = JSON.parse(init!.body as string)
        headers = init?.headers
        return new Response(null, { status: 204 })
      }
      await createClaudeOpus55Fetch(innerFetch)('https://provider.test/v1/messages', {
        method: 'POST',
        headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01,other-beta' },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: behavior } },
          messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'signed' }] }]
        })
      })
      expect(outgoing.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: behavior } })
      expect(outgoing.messages[0].content).toEqual([{ type: 'thinking', thinking: '', signature: 'signed' }])
      expect(headers).toEqual({ 'anthropic-beta': 'thinking-binding-controls-2026-08-01,other-beta' })
    }
  )

  it.each([undefined, 'error'])(
    'allows managed context edits while preserving explicit binding %s',
    async (behavior) => {
      let outgoing: Record<string, any> = {}
      let headers = new Headers()
      const innerFetch: typeof fetch = async (_input, init) => {
        outgoing = JSON.parse(init!.body as string)
        headers = new Headers(init?.headers)
        return new Response(null, { status: 204 })
      }
      const messages = [
        { role: 'user', content: 'Client summary replacing older turns' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'signed-before-compaction' }] }
      ]
      await createClaudeOpus55Fetch(
        innerFetch,
        64,
        true
      )('https://provider.test/v1/messages', {
        method: 'POST',
        headers: { 'anthropic-beta': 'other-beta,thinking-binding-controls-2026-08-01', 'x-caller': 'kept' },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 1088,
          thinking: behavior ? { type: 'adaptive', block_binding: { prefix_mismatch_behavior: behavior } } : undefined,
          messages
        })
      })
      expect(outgoing.thinking).toEqual({
        type: 'adaptive',
        block_binding: { prefix_mismatch_behavior: behavior ?? 'drop_block' }
      })
      expect(outgoing.messages).toEqual(messages)
      expect(outgoing.max_tokens).toBe(64)
      expect(headers.get('anthropic-beta')).toBe('other-beta,thinking-binding-controls-2026-08-01')
      expect(headers.get('x-caller')).toBe('kept')
    }
  )

  it('does not inject generation settings into token-counting requests', async () => {
    let outgoing: string | undefined
    const innerFetch: typeof fetch = async (_input, init) => {
      outgoing = init?.body as string
      return new Response(null, { status: 204 })
    }
    const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [] })
    await createClaudeOpus55Fetch(innerFetch)('https://provider.test/v1/messages/count_tokens', {
      method: 'POST',
      body
    })
    expect(outgoing).toBe(body)
  })
})

describe('selectCustomBodyParameters', () => {
  it('keeps flat parameters and excludes SDK and raw-provider namespaces regardless of value shape', () => {
    expect(
      selectCustomBodyParameters(
        {
          openai: 'invalid-namespace-value',
          cherryin: false,
          enable_search: true,
          custom_snake_case: { nested: 'value' }
        },
        { openai: {} },
        'cherryin'
      )
    ).toEqual({
      enable_search: true,
      custom_snake_case: { nested: 'value' }
    })
  })
})

describe('createCustomParamsFetch', () => {
  it('returns the inner fetch unchanged when there are no custom parameters', () => {
    const innerFetch = createInnerFetch()

    expect(createCustomParamsFetch(innerFetch, {})).toBe(innerFetch)
  })

  it('passes non-POST requests through unchanged', async () => {
    const innerFetch = createInnerFetch()
    const init: RequestInit = { method: 'GET' }

    await createCustomParamsFetch(innerFetch, { enable_search: true })('https://example.com', init)

    expect(innerFetch).toHaveBeenCalledWith('https://example.com', init)
  })

  it('passes non-string request bodies through unchanged', async () => {
    const innerFetch = createInnerFetch()
    const body = new FormData()
    const init: RequestInit = { method: 'POST', body }

    await createCustomParamsFetch(innerFetch, { enable_search: true })('https://example.com', init)

    expect(innerFetch).toHaveBeenCalledWith('https://example.com', init)
  })

  it('passes invalid JSON request bodies through unchanged', async () => {
    const innerFetch = createInnerFetch()
    const init: RequestInit = { method: 'POST', body: 'not-json{{{' }

    await createCustomParamsFetch(innerFetch, { enable_search: true })('https://example.com', init)

    expect(innerFetch).toHaveBeenCalledWith('https://example.com', init)
  })

  it.each(['null', '[]', 'true'])('passes non-object JSON body %s through unchanged', async (body) => {
    const innerFetch = createInnerFetch()
    const init: RequestInit = { method: 'POST', body }

    await createCustomParamsFetch(innerFetch, { enable_search: true })('https://example.com', init)

    expect(innerFetch).toHaveBeenCalledWith('https://example.com', init)
  })

  it('injects custom parameters at lower precedence than SDK-produced fields', async () => {
    const innerFetch = createInnerFetch()
    const wrappedFetch = createCustomParamsFetch(innerFetch, {
      model: 'custom-model',
      store: false,
      enable_search: true
    })

    await wrappedFetch('https://example.com', {
      method: 'POST',
      body: JSON.stringify({ model: 'sdk-model', store: true, messages: [] })
    })

    const forwardedInit = innerFetch.mock.calls[0][1] as RequestInit
    expect(JSON.parse(forwardedInit.body as string)).toEqual({
      model: 'sdk-model',
      store: true,
      enable_search: true,
      messages: []
    })
  })

  it('reuses wrappers for the same inner fetch and serialized custom parameters', () => {
    const innerFetch = createInnerFetch()
    const first = createCustomParamsFetch(innerFetch, { enable_search: true })
    const second = createCustomParamsFetch(innerFetch, { enable_search: true })

    expect(second).toBe(first)
    expect(createCustomParamsFetch(innerFetch, { enable_search: false })).not.toBe(first)
    expect(createCustomParamsFetch(createInnerFetch(), { enable_search: true })).not.toBe(first)
  })
})

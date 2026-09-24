import { defineProvider } from './types'
import { openaiResponsesSummaryWire } from './wires'

/**
 * ezr.sh gateway. Serves the vendors' native protocols side by side, so each model is pinned to the
 * endpoints the gateway actually answers for it (probed 2026-09-23):
 *
 * - claude-*: `/v1/messages` and `/v1/chat/completions` both 200; `/v1/responses` 500.
 * - *-codex: `/v1/responses` ONLY — chat/completions and messages both 400
 *   `{"error":{"message":"The requested operation is unsupported."}}`.
 * - the rest of the gpt-5/6 line: chat/completions and responses both 200.
 *
 * `resolveEffectiveEndpoint` takes `endpointTypes[0]`, so the order below is the default each model
 * gets in the endpoint picker.
 */

/** Claude serves native thinking blocks over `/v1/messages`, so the Anthropic protocol leads. */
const CLAUDE_ENDPOINTS = ['anthropic-messages', 'openai-chat-completions'] as const

/** Codex SKUs are Responses-only on this gateway. */
const CODEX_ONLY_ENDPOINTS = ['openai-responses'] as const

const GPT_ENDPOINTS = ['openai-responses', 'openai-chat-completions'] as const

export default defineProvider({
  id: 'mai',
  name: 'mai studio',
  availableInEditions: ['global', 'cn'],
  defaultChatEndpoint: 'anthropic-messages',
  modelListSource: 'registry',
  endpointConfigs: {
    'anthropic-messages': { adapterFamily: 'anthropic', baseUrl: 'https://ezr.sh' },
    'openai-chat-completions': { adapterFamily: 'openai-compatible', baseUrl: 'https://ezr.sh' },
    'openai-responses': {
      adapterFamily: 'openai',
      baseUrl: 'https://ezr.sh',
      reasoningFormat: { type: 'openai-responses', wire: openaiResponsesSummaryWire }
    }
  },
  metadata: {
    website: {
      official: 'https://ezr.sh',
      models: 'https://ezr.sh'
    }
  },
  overrides: [
    // ── Claude ────────────────────────────────────────────────────────────────
    { modelId: 'claude-fable-5', apiModelId: 'claude-fable-5', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-fable-5-1', apiModelId: 'claude-fable-5-1', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-opus-5', apiModelId: 'claude-opus-5', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-opus-4-8', apiModelId: 'claude-opus-4-8', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-opus-4-7', apiModelId: 'claude-opus-4-7', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-opus-4-6', apiModelId: 'claude-opus-4-6', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-opus-4-5', apiModelId: 'claude-opus-4-5', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-sonnet-4-6', apiModelId: 'claude-sonnet-4-6', endpointTypes: [...CLAUDE_ENDPOINTS] },
    { modelId: 'claude-haiku-4-5', apiModelId: 'claude-haiku-4-5', endpointTypes: [...CLAUDE_ENDPOINTS] },
    // The gateway lists sonnet-4-5 only under its date-pinned id.
    {
      modelId: 'claude-sonnet-4-5',
      apiModelId: 'claude-sonnet-4-5@20250929',
      endpointTypes: [...CLAUDE_ENDPOINTS]
    },

    // ── Codex (Responses-only) ────────────────────────────────────────────────
    { modelId: 'gpt-5-3-codex', apiModelId: 'gpt-5.3-codex', endpointTypes: [...CODEX_ONLY_ENDPOINTS] },
    { modelId: 'gpt-5-2-codex', apiModelId: 'gpt-5.2-codex', endpointTypes: [...CODEX_ONLY_ENDPOINTS] },
    { modelId: 'gpt-5-1-codex-max', apiModelId: 'gpt-5.1-codex-max', endpointTypes: [...CODEX_ONLY_ENDPOINTS] },
    { modelId: 'gpt-5-1-codex', apiModelId: 'gpt-5.1-codex', endpointTypes: [...CODEX_ONLY_ENDPOINTS] },
    { modelId: 'gpt-5-1-codex-mini', apiModelId: 'gpt-5.1-codex-mini', endpointTypes: [...CODEX_ONLY_ENDPOINTS] },

    // ── Remaining GPT-5/6 text line ───────────────────────────────────────────
    { modelId: 'gpt-6-astra', apiModelId: 'gpt-6-astra', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-6-sol', apiModelId: 'gpt-5.6-sol', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-6-terra', apiModelId: 'gpt-5.6-terra', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-6-luna', apiModelId: 'gpt-5.6-luna', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-5', apiModelId: 'gpt-5.5', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-4', apiModelId: 'gpt-5.4', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-4-mini', apiModelId: 'gpt-5.4-mini', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-4-nano', apiModelId: 'gpt-5.4-nano', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-2', apiModelId: 'gpt-5.2', endpointTypes: [...GPT_ENDPOINTS] },
    { modelId: 'gpt-5-1', apiModelId: 'gpt-5.1', endpointTypes: [...GPT_ENDPOINTS] },
    // `/v1/messages` 400s for this one, unlike the rest of the GPT line.
    { modelId: 'gpt-chat-latest', apiModelId: 'gpt-chat-latest', endpointTypes: [...GPT_ENDPOINTS] }
  ]
})

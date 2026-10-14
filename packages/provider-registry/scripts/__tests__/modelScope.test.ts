import { describe, expect, it } from 'vitest'

import anthropic from '../../src/creators/anthropic'
import type { ModelConfig } from '../../src/schemas/model'
import { ModelConfigSchema } from '../../src/schemas/model'
import type { ProviderModelOverride } from '../../src/schemas/provider-models'
import { ProviderModelOverrideSchema } from '../../src/schemas/provider-models'
import { applyModelScope, applyServerToolModelScope } from '../modelScope'

const originalModel: ModelConfig = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  ownedBy: 'anthropic',
  metadata: {},
  contextWindow: 1_000_000
}
const originalOverride: ProviderModelOverride = {
  providerId: 'mai',
  modelId: 'claude-opus-5',
  apiModelId: 'claude-opus-5',
  endpointTypes: ['anthropic-messages', 'openai-chat-completions']
}
const currentModel = {
  ...anthropic.models?.find(({ id }) => id === 'claude-opus-5-5'),
  ownedBy: 'anthropic',
  metadata: {}
} as ModelConfig
const currentOverride: ProviderModelOverride = {
  providerId: 'mai',
  modelId: 'claude-opus-5-5',
  apiModelId: 'claude-opus-5-5',
  endpointTypes: ['anthropic-messages', 'openai-chat-completions']
}

describe('scoped catalog generation', () => {
  // Catches an upstream refresh changing another model while adding the requested SKU.
  it('preserves every non-scoped baseline row and ignores other newly discovered models', () => {
    const baseline = { models: [originalModel], overrides: [originalOverride] }
    const result = applyModelScope(
      baseline,
      {
        models: [{ ...originalModel, contextWindow: 200_000 }, currentModel, { ...originalModel, id: 'new-model' }],
        overrides: [{ ...originalOverride, apiModelId: 'changed-id' }, currentOverride]
      },
      new Set(['claude-opus-5-5'])
    )

    expect(JSON.stringify(result.models.find(({ id }) => id === 'claude-opus-5'))).toBe(JSON.stringify(originalModel))
    expect(JSON.stringify(result.overrides.find(({ modelId }) => modelId === 'claude-opus-5'))).toBe(
      JSON.stringify(originalOverride)
    )
    expect(result.models.map(({ id }) => id)).toEqual(['claude-opus-5', 'claude-opus-5-5'])
    expect(result.models.every((model) => ModelConfigSchema.safeParse(model).success)).toBe(true)
    expect(result.overrides.every((row) => ProviderModelOverrideSchema.safeParse(row).success)).toBe(true)
  })

  // Catches a stale row/alias surviving regeneration instead of the current fixed model ID.
  it('replaces scoped model metadata and all provider rows from current generation', () => {
    const result = applyModelScope(
      {
        models: [{ ...currentModel, contextWindow: 200_000 }],
        overrides: [{ ...currentOverride, apiModelId: 'claude-opus-5-5@20260922' }]
      },
      { models: [currentModel], overrides: [currentOverride] },
      new Set(['claude-opus-5-5'])
    )

    expect(result.models).toHaveLength(1)
    expect(result.models[0].contextWindow).toBe(1_000_000)
    expect(result.models[0].maxOutputTokens).toBe(128_000)
    expect(result.overrides.map(({ apiModelId }) => apiModelId)).toEqual(['claude-opus-5-5'])
  })

  // Catches a misspelled scope silently deleting existing baseline models and provider rows.
  it('rejects a scope absent from the generated models', () => {
    expect(() =>
      applyModelScope(
        { models: [originalModel], overrides: [originalOverride] },
        { models: [currentModel], overrides: [currentOverride] },
        new Set(['claude-opus-5'])
      )
    ).toThrow('Scoped model not generated: claude-opus-5')
  })

  // Catches unrelated alias removals or tool additions during a focused catalog refresh.
  it('changes only the selected model in provider tool eligibility', () => {
    const result = applyServerToolModelScope(
      {
        anthropic: { 'web-search': ['claude-opus-5'] },
        deepseek: { 'web-search': ['deepseek-flash', 'deepseek-flash-latest'] },
        xai: { 'web-search': ['grok-4-6'] },
        mai: { 'web-search': ['claude-opus-5-5'] }
      },
      {
        anthropic: { 'web-search': ['claude-opus-5', 'claude-opus-5-5'] },
        deepseek: { 'web-search': ['deepseek-flash'] },
        xai: { 'web-search': ['grok-4-6', 'grok-4-7'] }
      },
      new Set(['claude-opus-5-5'])
    )

    expect(result).toEqual({
      anthropic: { 'web-search': ['claude-opus-5', 'claude-opus-5-5'] },
      deepseek: { 'web-search': ['deepseek-flash', 'deepseek-flash-latest'] },
      xai: { 'web-search': ['grok-4-6'] }
    })
  })
})

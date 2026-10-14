import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { inferReasoningControls } from '../patterns/reasoning-heuristics'
import { isServerToolModelEligible } from '../patterns/serverToolModelEligibility'
import type { ModelConfig } from '../schemas/model'
import type { ProviderModelOverride } from '../schemas/provider-models'

const models: ModelConfig[] = JSON.parse(readFileSync(join(__dirname, '../../data/models.json'), 'utf8')).models
const overrides: ProviderModelOverride[] = JSON.parse(
  readFileSync(join(__dirname, '../../data/provider-models.json'), 'utf8')
).overrides

describe('Claude Opus 5.5 API contract', () => {
  // Catches a stale upstream toggle/manual-budget declaration reaching the shipped model.
  it('ships only the five effort levels with medium as the default', () => {
    const model = models.find(({ id }) => id === 'claude-opus-5-5')

    expect(model).toMatchObject({
      name: 'Claude Opus 5.5',
      ownedBy: 'anthropic',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      reasoning: {
        controls: [{ kind: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' }],
        defaultEffort: 'medium',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        wireDialect: 'effort'
      }
    })
    expect(model?.capabilities).toEqual(
      expect.arrayContaining(['function-call', 'reasoning', 'image-recognition', 'structured-output'])
    )
    expect(model?.reasoning?.thinkingTokenLimits).toBeUndefined()
  })

  // Catches the older 5.x rule exposing "none" or losing xhigh on a discovered/custom model.
  it.each(['claude-opus-5-5', 'claude-opus-5.5', 'anthropic/claude-opus-5-5', 'anthropic.claude-opus-5-5'])(
    'keeps %s always thinking when the model is discovered',
    (modelId) => {
      expect(inferReasoningControls(modelId)).toEqual([
        { kind: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      ])
    }
  )

  // Catches a minor-version matcher disabling thinking on the older Opus 5 contract.
  it('does not apply the 5.5 always-on exception to Opus 5', () => {
    expect(inferReasoningControls('claude-opus-5')).toContainEqual({ kind: 'toggle' })
  })

  // Catches canonical-ID/date substitution or Responses routing, both invalid for the native API.
  it.each(['anthropic', 'mai'])('pins %s to the fixed wire ID and native Messages route', (providerId) => {
    const row = overrides.find(
      ({ providerId: provider, modelId }) => provider === providerId && modelId === 'claude-opus-5-5'
    )

    expect(row?.apiModelId).toBe('claude-opus-5-5')
    expect(row?.endpointTypes?.[0]).toBe('anthropic-messages')
    expect(row?.endpointTypes).not.toContain('openai-responses')
    expect(row?.parameterSupport).toMatchObject({
      temperature: { supported: false },
      topP: { supported: false },
      topK: { supported: false }
    })
  })

  // Catches the previous 4.x-only whitelist hiding tools supported by the native 5.5 API.
  it.each(['web-search', 'url-context'] as const)('enables native %s for Opus 5.5', (tool) => {
    expect(isServerToolModelEligible('claude-opus-5-5', 'anthropic', tool)).toBe(true)
    expect(isServerToolModelEligible('claude-opus-5-5', 'mai', tool)).toBe(false)
  })
})

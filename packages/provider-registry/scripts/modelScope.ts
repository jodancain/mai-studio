import type { ServerTool } from '../src/schemas/enums'
import type { ModelConfig } from '../src/schemas/model'
import type { ProviderModelOverride } from '../src/schemas/provider-models'

export type ServerToolModels = Record<string, Partial<Record<ServerTool, string[]>>>

export function applyModelScope(
  baseline: { models: ModelConfig[]; overrides: ProviderModelOverride[] },
  generated: { models: ModelConfig[]; overrides: ProviderModelOverride[] },
  modelIds: ReadonlySet<string>
): { models: ModelConfig[]; overrides: ProviderModelOverride[] } {
  for (const id of modelIds) {
    if (!generated.models.some((model) => model.id === id)) throw new Error(`Scoped model not generated: ${id}`)
  }
  return {
    models: [
      ...baseline.models.filter((model) => !modelIds.has(model.id)),
      ...generated.models.filter((model) => modelIds.has(model.id))
    ],
    overrides: [
      ...baseline.overrides.filter((row) => !modelIds.has(row.modelId)),
      ...generated.overrides.filter((row) => modelIds.has(row.modelId))
    ].sort((a, b) => `${a.providerId} ${a.modelId}`.localeCompare(`${b.providerId} ${b.modelId}`))
  }
}

export function applyServerToolModelScope(
  baseline: ServerToolModels,
  generated: ServerToolModels,
  modelIds: ReadonlySet<string>
): ServerToolModels {
  const result: ServerToolModels = {}
  for (const providerId of new Set([...Object.keys(baseline), ...Object.keys(generated)])) {
    for (const rawTool of Object.keys({ ...baseline[providerId], ...generated[providerId] })) {
      const tool = rawTool as ServerTool
      const ids = [
        ...(baseline[providerId]?.[tool] ?? []).filter((id) => !modelIds.has(id)),
        ...(generated[providerId]?.[tool] ?? []).filter((id) => modelIds.has(id))
      ]
      if (ids.length) (result[providerId] ??= {})[tool] = ids.sort()
    }
  }
  return result
}

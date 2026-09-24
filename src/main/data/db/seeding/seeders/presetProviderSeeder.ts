import { randomUUID } from 'node:crypto'

import type { ProtoProviderConfig } from '@cherrystudio/provider-registry'
import { RegistryLoader } from '@cherrystudio/provider-registry/node'
import { providerService } from '@data/services/ProviderService'
import { resolveRegistryPaths } from '@data/services/utils/registryDataPaths'
import type { ApiKeyEntry, AuthConfig } from '@shared/data/types/provider'

import type { DbType, ISeeder } from '../../types'

/**
 * Seed rows are DELTA rows: registry-owned connection config
 * (endpointConfigs, defaultChatEndpoint) is NOT persisted —
 * it resolves from the registry at read time (#17096), so registry updates
 * reach existing installs without reconciliation. Only user-editable
 * scaffolding is seeded: identity, display name, and the auth shell below.
 *
 * Per the v2 invariant in `ProviderSettings/utils/provider.ts` ("Azure/Vertex/Bedrock
 * reuse other vendors' endpoint protocols, so authType is the only reliable
 * discriminator"), vendor URL routing for those providers is driven by
 * `authType` (`iam-azure` → AI SDK `createAzure`, `iam-gcp` → Vertex SDK).
 */
function getSeedAuthConfig(providerId: string): AuthConfig | null {
  if (providerId === 'vertexai') {
    return { type: 'iam-gcp', project: '', location: '' }
  }

  if (providerId === 'azure-openai') {
    return { type: 'iam-azure', apiVersion: '' }
  }

  if (providerId === 'aws-bedrock') {
    return { type: 'iam-aws', region: '' }
  }

  return null
}

/**
 * mai studio is this fork's bundled gateway, so it ships pre-credentialed from the build env
 * instead of waiting on UI setup. `batchUpsertTx` inserts only absent providers, so a key the
 * user later edits in Settings is never re-seeded over.
 */
const MAI_PROVIDER_ID = 'mai'

function getSeedApiKeys(providerId: string): ApiKeyEntry[] | undefined {
  if (providerId !== MAI_PROVIDER_ID) return undefined
  const key = import.meta.env.MAIN_VITE_MAI_API_KEY?.trim()
  return key ? [{ id: randomUUID(), key, isEnabled: true }] : undefined
}

function toDbRow(p: ProtoProviderConfig) {
  const apiKeys = getSeedApiKeys(p.id)
  return {
    providerId: p.id,
    presetProviderId: p.presetProviderId ?? p.id,
    name: p.name,
    authConfig: getSeedAuthConfig(p.id),
    ...(apiKeys && { apiKeys, isEnabled: true })
  }
}

export class PresetProviderSeeder implements ISeeder {
  readonly name = 'presetProvider'
  readonly description = 'Insert preset provider configurations'

  private _loader?: RegistryLoader

  private getLoader(): RegistryLoader {
    if (!this._loader) {
      this._loader = new RegistryLoader(resolveRegistryPaths())
    }
    return this._loader
  }

  get version(): string {
    return this.getLoader().getProvidersVersion()
  }

  run(db: DbType): void {
    let rawProviders: ProtoProviderConfig[]
    try {
      rawProviders = this.getLoader().loadProviders()
    } catch (error) {
      throw new Error('PresetProviderSeeder: failed to load registry providers', { cause: error })
    }

    if (rawProviders.length === 0) return

    const rows = rawProviders.map(toDbRow)

    db.transaction((tx) => providerService.batchUpsertTx(tx, rows))
  }
}

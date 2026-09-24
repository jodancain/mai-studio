import { isDeepStrictEqual } from 'node:util'

import { and, eq, isNull } from 'drizzle-orm'

import { RegistryLoader } from '@cherrystudio/provider-registry/node'
import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import { preferenceTable } from '@data/db/schemas/preference'
import type { InsertUserModelRow } from '@data/db/schemas/userModel'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { insertManyWithOrderKey } from '@data/services/utils/orderKey'
import { resolveRegistryPaths } from '@data/services/utils/registryDataPaths'
import { loggerService } from '@logger'
import { isProtectedBuiltinAgentRole } from '@shared/ai/builtinAgent'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/cherryai'
import { DEFAULT_ASSISTANT_SEED } from '@shared/data/presets/defaultAssistant'
import { MAI_DEFAULT_UNIQUE_MODEL_ID, MAI_PROVIDER_ID } from '@shared/data/presets/mai'
import { createUniqueModelId } from '@shared/data/types/model'

import type { DbType, ISeeder, SeedRunContext } from '../../types'
import { hashObject } from '../hashObject'
import { DEFAULT_MODEL_PREFERENCE_KEYS } from './cherryaiDefaultModelSeeder'

const logger = loggerService.withContext('MaiDefaultModelSeeder')

const PREFERENCE_SCOPE = 'default' as const

type MaiModelRow = Omit<InsertUserModelRow, 'orderKey'>

/**
 * A preset-backed row with every config column null: the runtime resolves those from the
 * registry on read, so this is byte-for-byte what the settings UI's pull flow stores for a
 * catalog model the user has not overridden. Built by hand rather than through `modelService`
 * because that re-acquires `DbService`, which is still inside its own `onInit` while seeders run.
 */
function createPresetDeltaRow(modelId: string, presetModelId: string): MaiModelRow {
  return {
    id: createUniqueModelId(MAI_PROVIDER_ID, modelId),
    providerId: MAI_PROVIDER_ID,
    modelId,
    presetModelId,
    name: null,
    description: null,
    group: null,
    capabilities: null,
    inputModalities: null,
    inputModalitiesExplicit: false,
    outputModalities: null,
    endpointTypes: null,
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    supportsStreaming: null,
    reasoning: null,
    parameters: null,
    pricing: null,
    isEnabled: true,
    isHidden: false
  }
}

/**
 * Makes the bundled gateway usable on a fresh install: materializes mai's catalog models and
 * repoints the default-model preferences at one of them. Must run AFTER PresetProviderSeeder
 * (user_model.providerId is an FK) and AFTER CherryAiDefaultModelSeeder (whose preferences this
 * overrides).
 */
export class MaiDefaultModelSeeder implements ISeeder {
  readonly name = 'maiDefaultModel'
  readonly description = 'Seed the mai gateway model list and default-model preferences'

  private _loader?: RegistryLoader

  /**
   * Rechecks defaults when the catalog changes without restoring models the user removed.
   */
  get version(): string {
    return hashObject({
      revision: 2,
      providerId: MAI_PROVIDER_ID,
      defaultModel: MAI_DEFAULT_UNIQUE_MODEL_ID,
      preferenceKeys: DEFAULT_MODEL_PREFERENCE_KEYS,
      catalog: this.getLoader().getProviderModelsVersion()
    })
  }

  private getLoader(): RegistryLoader {
    this._loader ??= new RegistryLoader(resolveRegistryPaths())
    return this._loader
  }

  run(db: DbType, context?: SeedRunContext): void {
    db.transaction((tx) => {
      if (!context?.hasPreviouslyRun) this.materializeModels(tx)
      if (!this.isReady(tx)) return
      this.repointDefaultModelPreferences(tx)
      this.repointSeededResources(tx)
      this.skipProviderSetupOnboarding(tx)
    })
  }

  private isReady(tx: Pick<DbType, 'select'>): boolean {
    const provider = tx.select().from(userProviderTable).where(eq(userProviderTable.providerId, MAI_PROVIDER_ID)).get()
    const model = tx.select().from(userModelTable).where(eq(userModelTable.id, MAI_DEFAULT_UNIQUE_MODEL_ID)).get()
    return !!(
      provider?.isEnabled &&
      provider.apiKeys?.some((entry) => entry.isEnabled && entry.key.trim()) &&
      model?.isEnabled
    )
  }

  private repointSeededResources(tx: Pick<DbType, 'select' | 'update'>): void {
    const assistants = tx.select().from(assistantTable).where(isNull(assistantTable.deletedAt)).all()
    const assistant = assistants.length === 1 ? assistants[0] : undefined
    if (
      assistant?.modelId === CHERRYAI_DEFAULT_UNIQUE_MODEL_ID &&
      ['Cherry Assistant', 'Cherry 助手'].includes(assistant.name) &&
      assistant.prompt === DEFAULT_ASSISTANT_SEED.prompt &&
      assistant.description === DEFAULT_ASSISTANT_SEED.description &&
      assistant.emoji === DEFAULT_ASSISTANT_SEED.emoji &&
      isDeepStrictEqual(assistant.settings, DEFAULT_ASSISTANT_SEED.settings)
    ) {
      tx.update(assistantTable)
        .set({ modelId: MAI_DEFAULT_UNIQUE_MODEL_ID })
        .where(eq(assistantTable.id, assistant.id))
        .run()
    }

    for (const agent of tx.select().from(agentTable).where(isNull(agentTable.deletedAt)).all()) {
      if (
        isProtectedBuiltinAgentRole(agent.configuration.builtin_role) &&
        (agent.model === null || agent.model === CHERRYAI_DEFAULT_UNIQUE_MODEL_ID)
      ) {
        tx.update(agentTable).set({ model: MAI_DEFAULT_UNIQUE_MODEL_ID }).where(eq(agentTable.id, agent.id)).run()
      }
    }
  }

  /**
   * The gateway ships pre-credentialed with models and defaults already in place, so the
   * upstream first-run provider-setup wizard (whose primary CTA is a CherryIN sign-in) has
   * nothing left to collect. Privacy consent is not skipped: with the setup status no longer
   * 'pending', `PrivacyPolicyUpdateGate` owns the first window instead.
   */
  private skipProviderSetupOnboarding(tx: Pick<DbType, 'select' | 'update'>): void {
    const key = 'app.onboarding.provider_setup.status'
    const where = and(eq(preferenceTable.scope, PREFERENCE_SCOPE), eq(preferenceTable.key, key))
    const [existing] = tx.select({ value: preferenceTable.value }).from(preferenceTable).where(where).limit(1).all()

    if (existing?.value !== 'pending') return

    tx.update(preferenceTable).set({ value: 'completed' }).where(where).run()
    logger.info('Skipped provider-setup onboarding', { reason: 'gateway pre-configured' })
  }

  /**
   * A registry-backed provider keeps no `user_model` rows until something pulls them, so without
   * this a fresh install shows an enabled, credentialed `mai` provider with an empty model list.
   */
  private materializeModels(tx: Pick<DbType, 'select' | 'insert'>): void {
    const loader = this.getLoader()
    const overrides = loader.getOverridesForProvider(MAI_PROVIDER_ID)
    if (overrides.length === 0) {
      logger.warn('Catalog serves no models for the bundled gateway', { providerId: MAI_PROVIDER_ID })
      return
    }

    // Re-runs (catalog grew) must not collide with rows a previous pass — or the user — created.
    const present = new Set(
      tx
        .select({ id: userModelTable.id })
        .from(userModelTable)
        .where(eq(userModelTable.providerId, MAI_PROVIDER_ID))
        .all()
        .map((row) => row.id)
    )

    const rows: MaiModelRow[] = []
    for (const override of overrides) {
      // The canonical id must exist in models.json, else the row would resolve with no
      // capabilities at read time.
      if (!loader.findModel(override.modelId)) {
        logger.warn('Skipping gateway model with no catalog entry', { modelId: override.modelId })
        continue
      }
      const row = createPresetDeltaRow(override.apiModelId ?? override.modelId, override.modelId)
      if (!present.has(row.id)) rows.push(row)
    }
    if (rows.length === 0) return

    insertManyWithOrderKey(tx, userModelTable, rows, {
      pkColumn: userModelTable.id,
      scope: eq(userModelTable.providerId, MAI_PROVIDER_ID)
    })
    logger.info('Seeded gateway models', { providerId: MAI_PROVIDER_ID, count: rows.length })
  }

  /**
   * CherryAiDefaultModelSeeder points every default at Cherry's own cloud model, which needs a
   * Cherry account. Only repoint the keys still holding that seeded value — a user who has since
   * picked their own model keeps it.
   */
  private repointDefaultModelPreferences(tx: Pick<DbType, 'select' | 'update'>): void {
    for (const key of DEFAULT_MODEL_PREFERENCE_KEYS) {
      const where = and(eq(preferenceTable.scope, PREFERENCE_SCOPE), eq(preferenceTable.key, key))
      const [existing] = tx.select({ value: preferenceTable.value }).from(preferenceTable).where(where).limit(1).all()

      if (existing?.value !== CHERRYAI_DEFAULT_UNIQUE_MODEL_ID) continue

      tx.update(preferenceTable).set({ value: MAI_DEFAULT_UNIQUE_MODEL_ID }).where(where).run()
      logger.info('Repointed default model preference', { key, value: MAI_DEFAULT_UNIQUE_MODEL_ID })
    }
  }
}

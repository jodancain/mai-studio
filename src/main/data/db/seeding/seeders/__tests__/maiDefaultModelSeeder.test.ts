import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import { preferenceTable } from '@data/db/schemas/preference'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/cherryai'
import { MAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/mai'

import { CherryAiDefaultModelSeeder } from '../cherryaiDefaultModelSeeder'
import { DefaultAssistantSeeder } from '../defaultAssistantSeeder'
import { MaiDefaultModelSeeder } from '../maiDefaultModelSeeder'

const catalog = vi.hoisted(() => ({ version: 'test' }))

vi.mock('@cherrystudio/provider-registry/node', () => ({
  RegistryLoader: class {
    getProviderModelsVersion() {
      return catalog.version
    }
    getOverridesForProvider() {
      return [{ modelId: 'claude-sonnet-5' }]
    }
    findModel() {
      return { id: 'claude-sonnet-5' }
    }
  }
}))

describe('Mai default initialization', () => {
  const dbh = setupTestDatabase()
  beforeEach(() => {
    catalog.version = 'test'
    new CherryAiDefaultModelSeeder().run(dbh.db)
    new DefaultAssistantSeeder().run(dbh.db)
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: 'mai',
        name: 'mai',
        orderKey: 'a1',
        isEnabled: true,
        apiKeys: [{ id: 'test-key', key: 'synthetic-test-credential', isEnabled: true }]
      })
      .run()
    dbh.db
      .insert(preferenceTable)
      .values({ scope: 'default', key: 'app.onboarding.provider_setup.status', value: 'pending' })
      .onConflictDoNothing()
      .run()
    dbh.db
      .insert(agentTable)
      .values({
        id: 'builtin',
        name: 'Assistant',
        type: 'claude-code',
        instructions: '',
        orderKey: 'a0',
        configuration: { builtin_role: 'assistant' }
      })
      .run()
  })

  it('makes the initial chat and builtin agent use the same configured gateway', () => {
    new MaiDefaultModelSeeder().run(dbh.db)
    expect(dbh.db.select().from(assistantTable).get()?.modelId).toBe(MAI_DEFAULT_UNIQUE_MODEL_ID)
    expect(dbh.db.select().from(agentTable).get()?.model).toBe(MAI_DEFAULT_UNIQUE_MODEL_ID)
    expect(
      dbh.db.select().from(preferenceTable).where(eq(preferenceTable.key, 'app.onboarding.provider_setup.status')).get()
        ?.value
    ).toBe('completed')
  })

  it('keeps setup pending and existing defaults intact without an enabled credential', () => {
    dbh.db.update(userProviderTable).set({ apiKeys: [] }).where(eq(userProviderTable.providerId, 'mai')).run()
    new MaiDefaultModelSeeder().run(dbh.db)
    expect(
      dbh.db.select().from(preferenceTable).where(eq(preferenceTable.key, 'app.onboarding.provider_setup.status')).get()
        ?.value
    ).toBe('pending')
    expect(dbh.db.select().from(assistantTable).get()?.modelId).toBe(CHERRYAI_DEFAULT_UNIQUE_MODEL_ID)
    expect(dbh.db.select().from(agentTable).get()?.model).toBeNull()
  })

  it('does not recreate a model deleted after a previous seeding pass', () => {
    const seed = new MaiDefaultModelSeeder()
    const runner = new SeedRunner(dbh.db)
    runner.runAll([seed])
    dbh.db.delete(userModelTable).where(eq(userModelTable.id, MAI_DEFAULT_UNIQUE_MODEL_ID)).run()
    catalog.version = 'updated'
    runner.runAll([seed])
    expect(
      dbh.db.select().from(userModelTable).where(eq(userModelTable.id, MAI_DEFAULT_UNIQUE_MODEL_ID)).get()
    ).toBeUndefined()
  })

  it('preserves a chosen model for both an assistant and a builtin agent', () => {
    dbh.db.insert(userProviderTable).values({ providerId: 'custom', name: 'Custom', orderKey: 'a2' }).run()
    dbh.db
      .insert(userModelTable)
      .values({
        id: 'custom::chosen',
        providerId: 'custom',
        modelId: 'chosen',
        name: 'Chosen',
        capabilities: [],
        supportsStreaming: true,
        orderKey: 'a0'
      })
      .run()
    dbh.db.update(assistantTable).set({ modelId: 'custom::chosen' }).run()
    dbh.db.update(agentTable).set({ model: 'custom::chosen' }).run()
    new MaiDefaultModelSeeder().run(dbh.db)
    expect(dbh.db.select().from(assistantTable).get()?.modelId).toBe('custom::chosen')
    expect(dbh.db.select().from(agentTable).get()?.model).toBe('custom::chosen')
  })

  it('preserves customized assistants and never revives deleted agents on replay', () => {
    dbh.db.update(assistantTable).set({ name: 'My assistant', prompt: 'Keep my behavior' }).run()
    dbh.db.update(agentTable).set({ deletedAt: Date.now() }).run()
    const seed = new MaiDefaultModelSeeder()
    seed.run(dbh.db)
    seed.run(dbh.db)
    expect(dbh.db.select().from(assistantTable).get()).toMatchObject({
      name: 'My assistant',
      prompt: 'Keep my behavior',
      modelId: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID
    })
    expect(dbh.db.select().from(agentTable).all()).toHaveLength(1)
    expect(dbh.db.select().from(agentTable).get()?.model).toBeNull()
  })
})

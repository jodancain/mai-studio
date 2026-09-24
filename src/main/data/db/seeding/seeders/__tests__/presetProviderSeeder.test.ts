/**
 * Regression tests for PresetProviderSeeder.run — insert-only behavior.
 *
 * Regression: An earlier implementation called db.insert() unconditionally and
 * used onConflictDoUpdate, overwriting user customizations (renamed providers,
 * custom API keys, etc.) on every app start. The fix filters out already-present
 * provider IDs and only inserts genuinely new rows.
 */

import { setupTestDatabase } from '@test-helpers/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { userProviderTable } from '@data/db/schemas/userProvider'
import { PresetProviderSeeder } from '@data/db/seeding/seeders/presetProviderSeeder'
import { generateOrderKeyBetween, generateOrderKeySequence } from '@data/services/utils/orderKey'

// Fake registry providers — two preset providers: 'openai' and 'anthropic'.
vi.mock('@cherrystudio/provider-registry/node', () => {
  class RegistryLoader {
    loadProviders() {
      return [
        { id: 'openai', name: 'OpenAI', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'anthropic', name: 'Anthropic', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'azure-openai', name: 'Azure OpenAI', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'vertexai', name: 'Vertex AI', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'aws-bedrock', name: 'AWS Bedrock', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'mai', name: 'mai studio', endpointConfigs: {}, defaultChatEndpoint: null }
      ]
    }
    getProvidersVersion() {
      return 'test-version'
    }
    loadModels() {
      return []
    }
    loadProviderModels() {
      return []
    }
  }
  return { RegistryLoader }
})

describe('PresetProviderSeeder.run — insert-only behavior', () => {
  const dbh = setupTestDatabase()

  it('should insert all preset providers when DB is empty', async () => {
    const seed = new PresetProviderSeeder()
    seed.run(dbh.db)

    const rows = await dbh.db.select().from(userProviderTable)
    const ids = rows.map((r) => r.providerId)
    expect(ids).toContain('openai')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('azure-openai')
    expect(ids).toContain('vertexai')
    expect(ids).toContain('aws-bedrock')
    expect(ids).not.toContain('cherryai')
  })

  it('seeds only user-editable auth scaffolding; connection config stays registry-resolved', async () => {
    const seed = new PresetProviderSeeder()
    seed.run(dbh.db)

    const rows = await dbh.db.select().from(userProviderTable)
    const azure = rows.find((r) => r.providerId === 'azure-openai')
    const vertex = rows.find((r) => r.providerId === 'vertexai')
    const bedrock = rows.find((r) => r.providerId === 'aws-bedrock')

    // Delta rows: defaultChatEndpoint/endpointConfigs are NOT seeded — they
    // resolve from the registry at read time (#17096). Only the
    // user-editable auth shell is materialized.
    expect(azure?.defaultChatEndpoint).toBeNull()
    expect(azure?.endpointConfigs).toBeNull()
    expect(azure?.authConfig).toEqual({ type: 'iam-azure', apiVersion: '' })
    expect(vertex?.defaultChatEndpoint).toBeNull()
    expect(vertex?.authConfig).toEqual({ type: 'iam-gcp', project: '', location: '' })
    expect(bedrock?.defaultChatEndpoint).toBeNull()
    expect(bedrock?.authConfig).toEqual({ type: 'iam-aws', region: '' })
  })

  it('should NOT re-insert openai when it already exists in DB', async () => {
    await dbh.db
      .insert(userProviderTable)
      .values({ providerId: 'openai', name: 'User-renamed OpenAI', orderKey: generateOrderKeyBetween(null, null) })

    const seed = new PresetProviderSeeder()
    seed.run(dbh.db)

    const rows = await dbh.db.select().from(userProviderTable)
    const openai = rows.find((r) => r.providerId === 'openai')
    // User customization must be preserved
    expect(openai?.name).toBe('User-renamed OpenAI')

    const ids = rows.map((r) => r.providerId)
    expect(ids).toContain('anthropic')
    expect(ids).not.toContain('cherryai')
  })

  it('never seeds endpointConfigs — registry connection config resolves at read time', async () => {
    const seed = new PresetProviderSeeder()
    seed.run(dbh.db)

    const rows = await dbh.db.select().from(userProviderTable)
    // No row freezes a registry connection snapshot (#17096).
    expect(rows.every((r) => r.endpointConfigs === null)).toBe(true)
  })

  it('should not insert anything when all registry providers already exist', async () => {
    const [openaiKey, anthropicKey, azureKey, vertexKey, bedrockKey, maiKey] = generateOrderKeySequence(6)
    await dbh.db.insert(userProviderTable).values([
      { providerId: 'openai', name: 'OpenAI', orderKey: openaiKey },
      { providerId: 'anthropic', name: 'Anthropic', orderKey: anthropicKey },
      { providerId: 'azure-openai', name: 'Azure OpenAI', orderKey: azureKey },
      { providerId: 'vertexai', name: 'Vertex AI', orderKey: vertexKey },
      { providerId: 'aws-bedrock', name: 'AWS Bedrock', orderKey: bedrockKey },
      { providerId: 'mai', name: 'mai studio', orderKey: maiKey }
    ])
    const before = await dbh.db.select().from(userProviderTable)

    const seed = new PresetProviderSeeder()
    seed.run(dbh.db)

    const after = await dbh.db.select().from(userProviderTable)
    expect(after).toHaveLength(before.length)
  })
})

describe('PresetProviderSeeder.run — mai studio bundled credential', () => {
  const dbh = setupTestDatabase()

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const seedMai = async () => {
    new PresetProviderSeeder().run(dbh.db)
    const rows = await dbh.db.select().from(userProviderTable)
    return rows.find((r) => r.providerId === 'mai')
  }

  it('seeds the build-env key as an enabled credential and enables the provider', async () => {
    vi.stubEnv('MAIN_VITE_MAI_API_KEY', '  gateway-key  ')

    const mai = await seedMai()

    // Trimmed, because ApiKeyEntrySchema rejects blank keys and a stray newline from .env
    // would otherwise be sent verbatim in the Authorization header.
    expect(mai?.apiKeys).toMatchObject([{ key: 'gateway-key', isEnabled: true }])
    expect(mai?.apiKeys?.[0].id).toBeTruthy()
    expect(mai?.isEnabled).toBe(true)
  })

  it('leaves the provider uncredentialed and disabled when the build env carries no key', async () => {
    vi.stubEnv('MAIN_VITE_MAI_API_KEY', '   ')
    await dbh.db.delete(userProviderTable)

    const mai = await seedMai()

    expect(mai).toBeDefined()
    expect(mai?.apiKeys ?? []).toEqual([])
    expect(mai?.isEnabled).toBe(false)
  })

  it('never attaches the mai key to another provider', async () => {
    vi.stubEnv('MAIN_VITE_MAI_API_KEY', 'gateway-key')
    await dbh.db.delete(userProviderTable)

    new PresetProviderSeeder().run(dbh.db)
    const rows = await dbh.db.select().from(userProviderTable)

    expect(rows.filter((r) => r.providerId !== 'mai').every((r) => (r.apiKeys ?? []).length === 0)).toBe(true)
  })
})

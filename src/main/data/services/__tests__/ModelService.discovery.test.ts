import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { application } from '@application'
import { agentTable } from '@main/data/db/schemas/agent'
import { agentSessionTable } from '@main/data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@main/data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@main/data/db/schemas/agentWorkspace'
import { assistantTable } from '@main/data/db/schemas/assistant'
import { knowledgeBaseTable } from '@main/data/db/schemas/knowledge'
import { messageTable } from '@main/data/db/schemas/message'
import { pinTable } from '@main/data/db/schemas/pin'
import { topicTable } from '@main/data/db/schemas/topic'
import { userModelTable } from '@main/data/db/schemas/userModel'
import { userProviderTable } from '@main/data/db/schemas/userProvider'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { createUniqueModelId, type Model } from '@shared/data/types/model'

import { modelService } from '../ModelService'
import { generateOrderKeyBetween } from '../utils/orderKey'

const discovered = (apiModelId: string): Model => ({
  id: createUniqueModelId('custom', apiModelId),
  providerId: 'custom',
  apiModelId,
  name: apiModelId,
  capabilities: [],
  supportsStreaming: false,
  isEnabled: false,
  isHidden: false
})

describe('ModelService safe discovered model batches', () => {
  const dbh = setupTestDatabase()
  beforeEach(() => {
    dbh.db
      .insert(userProviderTable)
      .values({ providerId: 'custom', name: 'Custom', orderKey: generateOrderKeyBetween(null, null) })
      .run()
  })

  it('preserves the wire ID and keeps an unverified model disabled', () => {
    modelService.applyDiscoveredModels([
      { model: discovered('Publisher/Exact.Case'), change: 'new', expected: null, verified: false },
      { model: discovered('verified'), change: 'new', expected: null, verified: true }
    ])
    const rows = dbh.db.select().from(userModelTable).all()
    expect(rows.find((row) => row.modelId === 'Publisher/Exact.Case')).toMatchObject({
      id: 'custom::Publisher/Exact.Case',
      discoverySource: 'provider-api',
      capabilities: null,
      supportsStreaming: false,
      isEnabled: false
    })
    expect(modelService.getByKey('custom', 'Publisher/Exact.Case')).toMatchObject({
      apiModelId: 'Publisher/Exact.Case',
      capabilities: [],
      supportsStreaming: false
    })
    expect(rows.find((row) => row.modelId === 'verified')?.isEnabled).toBe(true)
  })

  it('rolls back the entire batch if a later candidate became stale', () => {
    const [receipt] = modelService.applyDiscoveredModels([
      { model: discovered('existing'), change: 'new', expected: null, verified: true }
    ])
    dbh.db.update(userModelTable).set({ name: 'User edit' }).run()
    expect(() =>
      modelService.applyDiscoveredModels([
        { model: discovered('first'), change: 'new', expected: null, verified: true },
        { model: discovered('existing'), change: 'missing', expected: receipt.after, verified: false }
      ])
    ).toThrow('scan again')
    expect(
      dbh.db
        .select()
        .from(userModelTable)
        .all()
        .map((row) => row.modelId)
    ).toEqual(['existing'])
  })

  it('only changes deprecation, and undo preserves later edits to other fields', () => {
    const [created] = modelService.applyDiscoveredModels([
      { model: discovered('existing'), change: 'new', expected: null, verified: true }
    ])
    const receipts = modelService.applyDiscoveredModels([
      { model: discovered('existing'), change: 'missing', expected: created.after, verified: false }
    ])
    dbh.db.update(userModelTable).set({ name: 'User override', notes: 'Keep this note' }).run()
    expect(modelService.undoDiscoveredModels(receipts)).toEqual([])
    expect(dbh.db.select().from(userModelTable).get()).toMatchObject({
      name: 'User override',
      notes: 'Keep this note',
      isDeprecated: false,
      isEnabled: true
    })
  })

  it('refuses to remove a new model that was edited, pinned, or made a default', async () => {
    const receipts = modelService.applyDiscoveredModels(
      ['edited', 'pinned', 'default'].map((id) => ({
        model: discovered(id),
        change: 'new' as const,
        expected: null,
        verified: true
      }))
    )
    dbh.db.update(userModelTable).set({ notes: 'User changed it' }).where(eq(userModelTable.modelId, 'edited')).run()
    dbh.db
      .insert(pinTable)
      .values({ entityType: 'model', entityId: 'custom::pinned', orderKey: generateOrderKeyBetween(null, null) })
      .run()
    await application.get('PreferenceService').set('chat.default_model_id', 'custom::default')
    expect(modelService.undoDiscoveredModels(receipts)).toEqual(['custom::edited', 'custom::pinned', 'custom::default'])
    expect(dbh.db.select().from(userModelTable).all()).toHaveLength(3)
    await application.get('PreferenceService').set('chat.default_model_id', '')
  })

  it('preserves every model reference and reports conflicts while undoing unused models in the same batch', () => {
    const used = ['assistant', 'agent', 'plan', 'small', 'message', 'session-message', 'embedding', 'rerank']
    const receipts = modelService.applyDiscoveredModels(
      ['unused', ...used].map((id) => ({
        model: discovered(id),
        change: 'new' as const,
        expected: null,
        verified: true
      }))
    )
    dbh.db
      .insert(assistantTable)
      .values({
        id: 'assistant',
        name: 'Assistant',
        emoji: '🌟',
        settings: DEFAULT_ASSISTANT_SETTINGS,
        modelId: 'custom::assistant',
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentTable)
      .values({
        id: 'agent',
        type: 'custom',
        name: 'Agent',
        instructions: '',
        orderKey: 'a0',
        model: 'custom::agent',
        planModel: 'custom::plan',
        smallModel: 'custom::small'
      })
      .run()
    dbh.db.insert(topicTable).values({ id: 'topic', orderKey: 'a0' }).run()
    dbh.db
      .insert(messageTable)
      .values([
        { id: 'root', topicId: 'topic', role: 'root', data: { parts: [] }, status: 'success' },
        {
          id: 'message',
          parentId: 'root',
          topicId: 'topic',
          role: 'assistant',
          data: { parts: [] },
          status: 'success',
          modelId: 'custom::message'
        }
      ])
      .run()
    dbh.db
      .insert(agentWorkspaceTable)
      .values({
        id: 'workspace',
        name: 'Workspace',
        path: '/tmp/undo-model-references',
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({
        id: 'session',
        name: 'Session',
        workspaceId: 'workspace',
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(agentSessionMessageTable)
      .values({
        id: 'session-message',
        sessionId: 'session',
        role: 'assistant',
        data: { parts: [] },
        status: 'success',
        modelId: 'custom::session-message'
      })
      .run()
    dbh.db
      .insert(knowledgeBaseTable)
      .values({
        id: 'knowledge',
        name: 'Knowledge',
        status: 'completed',
        dimensions: 128,
        embeddingModelId: 'custom::embedding',
        rerankModelId: 'custom::rerank',
        chunkSize: 512,
        chunkOverlap: 0
      })
      .run()

    expect(modelService.undoDiscoveredModels(receipts)).toEqual(used.map((id) => `custom::${id}`))
    expect(
      dbh.db
        .select()
        .from(userModelTable)
        .all()
        .map((row) => row.modelId)
        .sort()
    ).toEqual([...used].sort())
    expect(dbh.db.select().from(assistantTable).get()?.modelId).toBe('custom::assistant')
    expect(dbh.db.select().from(agentTable).get()).toMatchObject({
      model: 'custom::agent',
      planModel: 'custom::plan',
      smallModel: 'custom::small'
    })
    expect(dbh.db.select().from(messageTable).where(eq(messageTable.id, 'message')).get()?.modelId).toBe(
      'custom::message'
    )
    expect(dbh.db.select().from(agentSessionMessageTable).get()?.modelId).toBe('custom::session-message')
    expect(dbh.db.select().from(knowledgeBaseTable).get()).toMatchObject({
      embeddingModelId: 'custom::embedding',
      rerankModelId: 'custom::rerank'
    })
  })
})

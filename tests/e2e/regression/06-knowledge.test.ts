import { join } from 'node:path'

import { caseDefinition } from '../../../scripts/e2e/regression/cases'
import { AbsoluteFilePathSchema } from '../../../src/shared/types/file'
import { customAssistantName, ensureCustomAssistant } from './assistants'
import { expect, test } from './fixture'
import { EMBEDDING_PROVIDER, ensureEmbeddingProvider, ensureKnowledgeBase, knowledgeName } from './knowledge'
import {
  findLocalKnowledgeBase,
  queryLocalKnowledgeWithMai,
  requestKnowledgeRuntime,
  verifyKnowledgeSource
} from './localKnowledge'
import { dismissOnboarding, selectSidebarApp } from './navigation'
import { closeSettings } from './settings'

test(...caseDefinition('K-01'), async ({ app, mainWindow }) => {
  let page = mainWindow
  await test.step('Create and index a knowledge base, then verify recall', async () => {
    await ensureEmbeddingProvider(app, page)
    await expect(page.getByRole('heading', { name: EMBEDDING_PROVIDER, exact: true, level: 1 })).toBeVisible()
    await expect(page.getByText(app.config.customEmbeddingProvider.model, { exact: true })).toBeVisible()
    await closeSettings(page)
    await ensureKnowledgeBase(app, page)

    await page.getByRole('button', { name: 'Recall Test', exact: true }).click()
    await page.getByRole('textbox').last().fill('What is the regression knowledge answer?')
    await page
      .getByRole('button', { name: /Search|Test|Send/ })
      .last()
      .click()
    await expect(page.getByRole('dialog').last()).toContainText('CHERRY_KNOWLEDGE_58597', { timeout: 2 * 60_000 })
  })

  await test.step('Restart and verify the knowledge base persists', async () => {
    page = await app.restart('authenticated')
    await dismissOnboarding(page)
    await selectSidebarApp(page, 'Knowledge Base')
    await expect(
      page.locator('[data-ui="knowledge.navigation"]').getByText(knowledgeName(app), { exact: true })
    ).toBeVisible()
  })

  await test.step('Query the persisted knowledge base and verify the answer and citations', async () => {
    await ensureCustomAssistant(app, page)
    await page.getByRole('button', { name: `Edit Assistant: ${customAssistantName(app)}`, exact: true }).click()
    await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
    if (
      !(await page
        .getByText(knowledgeName(app), { exact: true })
        .isVisible()
        .catch(() => false))
    ) {
      await page.getByRole('button', { name: 'Add knowledge base', exact: true }).click()
      await page.getByText(knowledgeName(app), { exact: true }).click()
    }
    const assistantDialog = page.getByRole('dialog').last()
    await expect(assistantDialog.getByText(knowledgeName(app), { exact: true })).toBeVisible()
    await assistantDialog.getByRole('button', { name: 'Close', exact: true }).click()

    const sendQuestion = async () => {
      const composer = page.locator('[data-ui="chat.composer"] [contenteditable="true"]').first()
      await composer.fill('What is the regression knowledge answer? Include the exact marker and cite the source file.')
      await page.getByRole('button', { name: 'Input Quick Panel', exact: true }).click()
      const quickPanel = page.getByTestId('quick-panel')
      await quickPanel.getByText('Knowledge Base', { exact: true }).click()
      await quickPanel.getByText(knowledgeName(app), { exact: true }).click()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
    }
    const marker = page.getByText('CHERRY_KNOWLEDGE_58597', { exact: false }).last()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sendQuestion()
      const visible = await marker
        .waitFor({ state: 'visible', timeout: 2 * 60_000 })
        .then(() => true)
        .catch(() => false)
      if (visible) break
    }
    await expect(marker).toBeVisible()
    await expect(page.locator('body')).toContainText('ground-truth.txt')
    await expect(page.getByText(/\d+ citations?/i)).toBeVisible()
  })
})

test(...caseDefinition('MAI-K01'), async ({ app, mainWindow }) => {
  test.setTimeout(20 * 60_000)
  let page = mainWindow
  await test.step('Download the real local Qwen3 model and verify readiness', async () => {
    const status = await requestKnowledgeRuntime(page, 'local_model.get_status', { id: 'qwen3-embedding-0.6b' })
    test.skip(status.status === 'unsupported', 'Local Qwen3 inference is unsupported on this platform')
    const download = await requestKnowledgeRuntime(page, 'local_model.download', { id: 'qwen3-embedding-0.6b' })
    expect(download.result).toBe('ready')
    expect(await requestKnowledgeRuntime(page, 'local_model.get_status', { id: 'qwen3-embedding-0.6b' })).toEqual({
      status: 'ready'
    })
  })

  const keywordBase = await test.step('Import a real source into a keyword-only base', async () => {
    const base = await requestKnowledgeRuntime(page, 'knowledge.create_base', {
      base: { name: app.resourceName('Mai Keyword Knowledge') }
    })
    expect(base.embeddingModelId).toBeNull()
    expect(base.dimensions).toBeNull()
    const source = AbsoluteFilePathSchema.parse(join(app.paths.fixtures, 'knowledge', 'ground-truth.txt'))
    expect(
      await requestKnowledgeRuntime(page, 'knowledge.add_items', {
        baseId: base.id,
        items: [{ type: 'file', data: { path: source, source } }]
      })
    ).toEqual({ status: 'added' })
    return base
  })
  const keyword = await verifyKnowledgeSource(app, page, keywordBase.id)

  await test.step('Create the local vector base and import fixtures through the UI', async () => {
    await ensureKnowledgeBase(app, page, { model: 'qwen3-embedding-0.6b', providerId: 'local-embedding' })
  })
  const vectorBase = await findLocalKnowledgeBase(app, page)
  const vector = await verifyKnowledgeSource(app, page, vectorBase.id)

  await test.step('Restart and verify both persisted indexes and source references', async () => {
    page = await app.restart('authenticated')
    await dismissOnboarding(page)
    await selectSidebarApp(page, 'Knowledge Base')
    await expect(
      page.locator('[data-ui="knowledge.navigation"]').getByText(knowledgeName(app), { exact: true })
    ).toBeVisible()
    expect((await findLocalKnowledgeBase(app, page)).id).toBe(vectorBase.id)
    expect(await verifyKnowledgeSource(app, page, keywordBase.id)).toEqual(keyword)
    expect(await verifyKnowledgeSource(app, page, vectorBase.id)).toEqual(vector)
  })

  const messageId = await test.step('Ask Mai about the persisted source and verify its citation', () =>
    queryLocalKnowledgeWithMai(app, page))
  await test.info().attach('local-knowledge-evidence.json', {
    body: JSON.stringify({ keyword, vector, messageId, modelId: 'mai::claude-sonnet-5' }, null, 2),
    contentType: 'application/json'
  })
})

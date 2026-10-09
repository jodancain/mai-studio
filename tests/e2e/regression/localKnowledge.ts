import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type Page } from '@playwright/test'

import type {
  KnowledgeBaseListResponse,
  KnowledgeItemListResponse
} from '../../../src/shared/data/api/schemas/knowledges'
import type { IpcResult } from '../../../src/shared/ipc/errors/IpcError'
import type { IpcRoute } from '../../../src/shared/ipc/schemas/ipcSchemas'
import type { InputFor, OutputFor } from '../../../src/shared/ipc/types'
import { customAssistantName, ensureCustomAssistant } from './assistants'
import { knowledgeName } from './knowledge'
import type { RegressionApp } from './RegressionApp'

export async function requestKnowledgeRuntime<R extends IpcRoute>(
  page: Page,
  route: R,
  input: InputFor<R>
): Promise<OutputFor<R>> {
  const payload: { route: string; input: unknown } = { route, input }
  const result = (await page.evaluate(
    ({ route, input }) => window.api.ipcApi.request(route, input),
    payload
  )) as IpcResult<OutputFor<R>>
  if (!result.ok) throw new Error(`${route}: ${result.error.message}`)
  return result.data
}

export async function findLocalKnowledgeBase(app: RegressionApp, page: Page) {
  const bases = await page.evaluate(async (name) => {
    const response = await window.api.dataApi.request({
      id: 'mai-local-knowledge-base',
      method: 'GET',
      path: '/knowledge-bases',
      params: { search: name }
    })
    if (response.error) throw new Error('Could not read knowledge bases')
    return (response.data as KnowledgeBaseListResponse).items
  }, knowledgeName(app))
  const base = bases.find(({ name }) => name === knowledgeName(app))
  expect(base).toBeDefined()
  expect(base!.embeddingModelId).toBe('local-embedding::qwen3-embedding-0.6b')
  expect(base!.dimensions).toBe(1024)
  return base!
}

export async function verifyKnowledgeSource(app: RegressionApp, page: Page, baseId: string) {
  await expect
    .poll(
      async () => {
        const items = await page.evaluate(async (id) => {
          const response = await window.api.dataApi.request({
            id: 'mai-local-knowledge-items',
            method: 'GET',
            path: `/knowledge-bases/${id}/items`,
            params: { type: 'file' }
          })
          if (response.error) throw new Error('Could not read knowledge indexing status')
          return (response.data as KnowledgeItemListResponse).items
        }, baseId)
        if (items.some(({ status }) => status === 'failed')) throw new Error('Knowledge indexing failed')
        return items.length > 0 && items.every(({ status }) => status === 'completed')
      },
      { timeout: 3 * 60_000 }
    )
    .toBe(true)

  const hits = await requestKnowledgeRuntime(page, 'knowledge.search', {
    baseId,
    query: 'regression knowledge answer'
  })
  const hit = hits.find(({ pageContent }) => pageContent.includes('CHERRY_KNOWLEDGE_58597'))
  expect(hit).toBeDefined()
  expect(hit!.itemId).toBeTruthy()
  expect(hit!.chunkId).toBeTruthy()
  const itemId = hit!.itemId!
  const source = await requestKnowledgeRuntime(page, 'knowledge.get_file_path', { itemId })
  expect(readFileSync(source, 'utf8')).toBe(
    readFileSync(join(app.paths.fixtures, 'knowledge', 'ground-truth.txt'), 'utf8')
  )
  const chunks = await requestKnowledgeRuntime(page, 'knowledge.list_item_chunks', { baseId, itemId })
  expect(chunks.find(({ id }) => id === hit!.chunkId)?.content).toContain('CHERRY_KNOWLEDGE_58597')
  return { baseId, itemId, chunkId: hit!.chunkId, scoreKind: hit!.scoreKind, sourceCopyVerified: true }
}

export async function queryLocalKnowledgeWithMai(app: RegressionApp, page: Page): Promise<string> {
  await ensureCustomAssistant(app, page, { id: 'claude-sonnet-5', providerId: 'mai' })
  await page.getByRole('button', { name: `Edit Assistant: ${customAssistantName(app)}`, exact: true }).click()
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  const assistantDialog = page.getByRole('dialog').last()
  if (
    !(await assistantDialog
      .getByText(knowledgeName(app), { exact: true })
      .isVisible()
      .catch(() => false))
  ) {
    await assistantDialog.getByRole('button', { name: 'Add knowledge base', exact: true }).click()
    await page.getByRole('dialog').last().getByText(knowledgeName(app), { exact: true }).click()
  }
  const dialog = page.getByRole('dialog').last()
  await expect(dialog.getByText(knowledgeName(app), { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  const chat = page.locator('[data-ui="chat.view"]:visible')
  const composer = chat.locator('[data-ui~="chat.composer"]')
  await composer.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(chat.locator('[data-ui~="chat.message"]')).toHaveCount(0)
  await composer
    .locator('[contenteditable="true"]')
    .first()
    .fill('What is the regression knowledge answer? Include the exact marker and cite the source file.')
  await composer.getByRole('button', { name: 'Input Quick Panel', exact: true }).click()
  const panel = page.getByTestId('quick-panel')
  await panel.getByText('Knowledge Base', { exact: true }).click()
  await panel.getByText(knowledgeName(app), { exact: true }).click()
  await page.keyboard.press('Escape')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  const response = chat
    .locator('[data-ui~="chat.message"][data-message-id]')
    .filter({ has: page.locator('.message-assistant') })
    .last()
  await expect(
    response
      .getByText('CHERRY_KNOWLEDGE_58597', { exact: false })
      .and(response.locator(':not([data-ui~="part:message-reasoning"] *)'))
      .last()
  ).toBeVisible({ timeout: 2 * 60_000 })
  const citations = response.getByRole('button', { name: /\d+ citations?/i })
  await expect(citations).toBeVisible()
  const messageId = await response.getAttribute('data-message-id')
  expect(messageId).toBeTruthy()
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const result = await window.api.dataApi.request({
            id: 'mai-knowledge-answer',
            method: 'GET',
            path: `/messages/${id}`
          })
          if (result.error) throw new Error('Could not read knowledge answer')
          const message = result.data as { status: string; modelId: string }
          return { status: message.status, modelId: message.modelId }
        }, messageId),
      { timeout: 2 * 60_000 }
    )
    .toEqual({ status: 'success', modelId: 'mai::claude-sonnet-5' })
  await citations.click()
  await expect(
    page
      .locator('[data-slot="page-side-panel"][role="dialog"]:visible')
      .getByText('ground-truth.txt', { exact: true })
      .first()
  ).toBeVisible()
  return messageId!
}

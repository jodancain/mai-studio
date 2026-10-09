import { caseDefinition } from '../../../scripts/e2e/regression/cases'
import { customAssistantName, ensureCustomAssistant } from './assistants'
import { selectChatModel, sendChatMarker } from './chat'
import { expect, test } from './fixture'
import { CUSTOM_CHAT_PROVIDER, ensureCustomChatProvider } from './models'
import { dismissOnboarding, selectSidebarApp } from './navigation'
import { closeSettings, openProviderSettings } from './settings'

test(...caseDefinition('M-02'), async ({ app, mainWindow }) => {
  let page = mainWindow
  await ensureCustomChatProvider(app, page)
  await expect(page.getByText(CUSTOM_CHAT_PROVIDER, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(app.config.customProvider.chatModel, { exact: true }).last()).toBeVisible()

  await closeSettings(page)
  await selectChatModel(page, app.config.customProvider.chatModel)
  await sendChatMarker(
    page,
    'Reply with exactly CUSTOM_PROVIDER_CHAT_PASS and nothing else.',
    'CUSTOM_PROVIDER_CHAT_PASS'
  )

  page = await app.restart('authenticated')
  await dismissOnboarding(page)
  await openProviderSettings(page)
  await expect(page.getByText(CUSTOM_CHAT_PROVIDER, { exact: true }).first()).toBeVisible()
})

test(...caseDefinition('C-01'), async ({ app, mainWindow: page }) => {
  await ensureCustomAssistant(app, page)
  await sendChatMarker(page, 'In one sentence, what is two plus two?', 'ASSISTANT_PROMPT_PASS', false)

  const restarted = await app.restart('authenticated')
  await dismissOnboarding(restarted)
  await selectSidebarApp(restarted, 'Chat')
  const assistantList = restarted.locator('[data-ui="chat.view"]:visible').getByRole('listbox').first()
  await expect(assistantList).toBeVisible()
  await assistantList.getByText(customAssistantName(app), { exact: true }).first().click({ noWaitAfter: true })
  await expect(restarted.getByText('ASSISTANT_PROMPT_PASS').last()).toBeVisible()
})

test.describe('Mai default assistant on a clean profile', () => {
  test.use({ profile: 'clean' })

  test(...caseDefinition('MAI-01'), async ({ app, mainWindow: page }) => {
    await selectSidebarApp(page, 'Chat')
    const readDefaults = () =>
      page.evaluate(async () => {
        const [chatModel, assistants, agents] = await Promise.all([
          window.api.preference.get('chat.default_model_id'),
          window.api.dataApi.request({ id: 'mai-default-assistant', method: 'GET', path: '/assistants' }),
          window.api.dataApi.request({ id: 'mai-default-agent', method: 'GET', path: '/agents' })
        ])
        if (assistants.error || agents.error) throw new Error('Could not load the initial Mai defaults')
        const assistant = (
          assistants.data as { items: { id: string; name: string; prompt: string; modelId: string }[] }
        ).items
          .filter(({ name, prompt }) => ['Cherry Assistant', 'Cherry 助手'].includes(name) && prompt === '')
          .map(({ id, name, modelId }) => ({ id, name, modelId }))
        const agent = (
          agents.data as {
            items: { id: string; type: string; model: string | null; configuration: { builtin_role?: string } }[]
          }
        ).items
          .filter(({ configuration }) => configuration.builtin_role === 'assistant')
          .map(({ id, type, model }) => ({ id, type, model }))
        return { chatModel, assistant, agent }
      })
    const defaults = await readDefaults()
    expect(defaults.chatModel).toBe('mai::claude-sonnet-5')
    expect(defaults.assistant).toHaveLength(1)
    expect(defaults.assistant[0].modelId).toBe('mai::claude-sonnet-5')
    expect(defaults.agent).toHaveLength(1)
    expect(defaults.agent[0]).toMatchObject({ type: 'claude-code', model: 'mai::claude-sonnet-5' })
    const defaultAssistant = defaults.assistant[0]
    const chatView = page.locator('[data-ui="chat.view"]:visible')
    const assistant = chatView
      .getByRole('listbox')
      .first()
      .getByRole('button', { name: defaultAssistant.name, exact: true })
    await assistant.click({ noWaitAfter: true })
    await chatView.locator('[data-ui~="chat.composer"]').getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect(page.locator('[data-ui~="chat.message"]:visible')).toHaveCount(0)

    const responseId = await sendChatMarker(
      page,
      'Reply with exactly MAI_DEFAULT_CHAT_PASS and nothing else.',
      'MAI_DEFAULT_CHAT_PASS'
    )
    const responseModel = await page.evaluate(async (id) => {
      const response = await window.api.dataApi.request({
        id: 'mai-response-model',
        method: 'GET',
        path: `/messages/${id}`
      })
      return (response.data as { modelId?: string }).modelId
    }, responseId)
    expect(responseModel).toBe('mai::claude-sonnet-5')

    const previousIds = await page
      .locator('[data-ui~="chat.message"][data-message-id]:visible')
      .evaluateAll((messages) => messages.map((message) => message.getAttribute('data-message-id')))
    const composer = page.locator('[data-ui~="chat.composer"] [contenteditable="true"]').first()
    await composer.fill('Write a detailed 3000-word essay about the history of computing.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const stop = page.getByRole('button', { name: 'Pause', exact: true })
    await expect(stop).toBeVisible({ timeout: 30_000 })
    const excludePrevious = previousIds.map((id) => `:not([data-message-id="${id}"])`).join('')
    const pendingResponse = page
      .locator(`[data-ui~="chat.message"][data-message-id]${excludePrevious}:visible`)
      .filter({ has: page.locator('.message-assistant') })
      .last()
    await expect(pendingResponse).toBeVisible()
    const stoppedId = await pendingResponse.getAttribute('data-message-id')
    expect(stoppedId).toBeTruthy()
    await stop.click()
    await expect(stop).toHaveCount(0, { timeout: 1000 })
    await expect
      .poll(
        () =>
          page.evaluate(async (id) => {
            const response = await window.api.dataApi.request({
              id: 'mai-stopped-message',
              method: 'GET',
              path: `/messages/${id}`
            })
            const message = response.data as { status?: string; modelId?: string }
            return { status: message.status, modelId: message.modelId }
          }, stoppedId),
        { timeout: 30_000 }
      )
      .toEqual({ status: 'paused', modelId: 'mai::claude-sonnet-5' })

    page = await app.restart('clean')
    await dismissOnboarding(page)
    expect(await readDefaults()).toEqual(defaults)
    const persistedResponses = await page.evaluate(
      async (ids) => {
        return Promise.all(
          ids.map(async (id) => {
            const response = await window.api.dataApi.request({
              id: 'mai-restarted-response',
              method: 'GET',
              path: `/messages/${id}`
            })
            if (response.error) throw new Error('Could not read the persisted Mai response')
            const message = response.data as { status: string; modelId: string }
            return { status: message.status, modelId: message.modelId }
          })
        )
      },
      [responseId, stoppedId]
    )
    expect(persistedResponses).toEqual([
      { status: 'success', modelId: 'mai::claude-sonnet-5' },
      { status: 'paused', modelId: 'mai::claude-sonnet-5' }
    ])
  })
})

import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle/BaseService'

const { tray, buildFromTemplate } = vi.hoisted(() => ({
  tray: {
    on: vi.fn(),
    setImage: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    popUpContextMenu: vi.fn(),
    destroy: vi.fn()
  },
  buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => template)
}))

vi.mock('electron', () => ({
  Tray: vi.fn(function () {
    return tray
  }),
  Menu: { buildFromTemplate },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: {
    createFromPath: () => ({ resize: () => ({ setTemplateImage: vi.fn() }) })
  }
}))
vi.mock('@main/i18n', () => ({ t: (key: string) => key }))

import { TrayService } from '../TrayService'

describe('TrayService core release', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    MockMainPreferenceServiceUtils.setPreferenceValue('app.tray.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.quick_assistant.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.quick_assistant.click_tray_to_show', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.selection.enabled', true)
  })

  afterEach(() => BaseService.resetInstances())

  it('opens the main window on click and omits unavailable actions without changing saved preferences', async () => {
    const service = new TrayService()
    await service._doInit()
    const click = tray.on.mock.calls.find(([event]) => event === 'click')?.[1] as () => void
    expect(click).toBeTypeOf('function')
    click()

    expect(application.get('MainWindowService').showMainWindow).toHaveBeenCalledOnce()
    expect(buildFromTemplate.mock.lastCall?.[0].map((item) => item.label ?? item.type)).toEqual([
      'tray.show_window',
      'separator',
      'tray.quit'
    ])
    expect(MockMainPreferenceServiceUtils.getPreferenceValue('feature.quick_assistant.enabled')).toBe(true)
    expect(MockMainPreferenceServiceUtils.getPreferenceValue('feature.quick_assistant.click_tray_to_show')).toBe(true)
    expect(MockMainPreferenceServiceUtils.getPreferenceValue('feature.selection.enabled')).toBe(true)
    expect(application.get('PreferenceService').set).not.toHaveBeenCalled()
    await service._doDeactivate()
  })
})

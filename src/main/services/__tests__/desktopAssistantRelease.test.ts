import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle/BaseService'
import { WindowType } from '@main/core/window/types'

import { QuickAssistantService } from '../QuickAssistantService'
import { SelectionService } from '../selection/SelectionService'

describe('core release desktop assistant entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.quick_assistant.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.selection.enabled', true)
  })

  afterEach(() => BaseService.resetInstances())

  it('keeps enabled saved features dormant through boot, direct commands, and explicit activation', async () => {
    const quick = new QuickAssistantService()
    const selection = new SelectionService()
    await quick._doInit()
    await selection._doInit()
    await selection._doAllReady()
    await new Promise((resolve) => setImmediate(resolve))

    quick.showQuickAssistant()
    quick.toggleQuickAssistant()
    selection.toggleEnabled(false)
    selection.processSelectTextByShortcut()
    selection.processAction({ id: 'translate', name: 'Translate', enabled: true, isBuiltIn: true })

    for (const service of [quick, selection]) {
      await expect(service._doActivate()).rejects.toThrow('unavailable in this release')
      expect(service.isActivated).toBe(false)
    }
    expect(selection.isInitialized()).toBe(false)
    expect(application.get('WindowManager').open).not.toHaveBeenCalled()
    expect(application.get('WindowManager').suspendPool).toHaveBeenCalledWith(WindowType.SelectionAction)
    expect(application.get('WindowManager').resumePool).not.toHaveBeenCalled()
    expect(MockMainPreferenceServiceUtils.getPreferenceValue('feature.quick_assistant.enabled')).toBe(true)
    expect(MockMainPreferenceServiceUtils.getPreferenceValue('feature.selection.enabled')).toBe(true)
    expect(application.get('PreferenceService').set).not.toHaveBeenCalled()
  })
})

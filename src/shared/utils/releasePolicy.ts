export const DESKTOP_ASSISTANTS_ENABLED = false

export const isCoreReleaseCommandEnabled = (command: string): boolean =>
  DESKTOP_ASSISTANTS_ENABLED ||
  !['quick_assistant.toggle', 'selection.toggle', 'selection.capture_text'].includes(command)

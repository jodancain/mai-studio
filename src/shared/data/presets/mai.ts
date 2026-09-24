import { createUniqueModelId } from '@shared/data/types/model'

/**
 * The bundled ezr.sh gateway. Unlike every other registry provider, mai studio ships this one
 * pre-credentialed and pre-populated: it is the fork's own default backend, so a fresh install
 * must be able to chat before the user opens a single settings page.
 */
export const MAI_PROVIDER_ID = 'mai' as const
export const MAI_DEFAULT_MODEL_ID = 'claude-sonnet-5' as const
export const MAI_DEFAULT_UNIQUE_MODEL_ID = createUniqueModelId(MAI_PROVIDER_ID, MAI_DEFAULT_MODEL_ID)

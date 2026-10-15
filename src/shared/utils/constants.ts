export const KB = 1024
export const MB = 1024 * KB
export const GB = 1024 * MB

export const APP_NAME = 'mai studio'
export const LATEST_PRIVACY_POLICY_VERSION = '20260820'

/**
 * Gates the three unconditional calls home to Cherry Studio's backend: crash reporting (Sentry),
 * the app auto-updater, and the remote provider-catalog refresh. This fork has no equivalent
 * endpoints and upstream's are actively wrong for it — crashes would be misattributed to Cherry
 * Studio, an applied update would replace this build with an upstream one, and a remote catalog
 * snapshot replaces `provider-models.json` wholesale, dropping the fork-only `mai` rows.
 *
 * Usage analytics is not gated here: it already sits behind the privacy-consent predicate, and
 * this fork ships `app.privacy.data_collection.enabled` defaulting to false.
 */
export const UPSTREAM_SERVICES_ENABLED = false

/**
 * Gates the in-app updater against this fork's OWN release feed (a Tailscale-served
 * static directory on the internal network — see `publish.url` in electron-builder.yml).
 * Split from {@link UPSTREAM_SERVICES_ENABLED}: that flag keeps upstream Cherry Studio
 * endpoints (Sentry, remote catalog) disabled, while this one re-enables update checks
 * now that the packaged feed URL points at the fork's internal release service.
 * The feed is reachable only inside the tailnet; off-network checks fail soft and retry.
 */
export const SELF_UPDATE_FEED_ENABLED = true

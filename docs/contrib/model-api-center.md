---
description: Model and API center behavior, production boundaries, and validation contracts
sources:
  - src/main/ai/AiService.ts
  - src/main/services/diagnostics/doctor/README.md
  - src/main/data/services/ModelService.ts
  - src/main/services/ProviderRegistryUpdaterService.ts
  - src/renderer/pages/settings/ProviderSettings
---

# Model and API Center

The model-provider settings page keeps the existing provider configuration entry and adds a central view for API checks, model updates, and verified adaptation. Existing provider IDs, imports, Agent filters, and settings-search focus links continue to open the configuration surface.

## API checks

Checks run in Main against the configured provider and model. The initial report is unverified. Basic connectivity and model-list checks do not imply that inference, streaming, or tools work. Each provider tests at most one selected model per batch.

Text, streaming, and tool probes require explicit confirmation because they can incur provider usage fees. Each probe has a 15-second deadline, a small output-token limit, no automatic retry or key fallback, and no conversation history. The tool probe returns a test call without executing a real tool. Unsupported external CLI and non-chat targets are skipped with a reason.

Cancellation stops the underlying requests and invalidates pending confirmations. A changed provider, key, model, new run, or expired report invalidates the captured target. Completed results remain distinct from canceled and unstarted checks. Cross-window state is transported through SharedCache.

Exported reports contain only approved identifiers, observed statuses, timing, and summary codes. They omit keys, authorization headers, raw response bodies, credential-bearing URLs, and pending confirmation IDs.

## Model updates

Provider API discovery and the model registry are independent sources. API discovery preserves the exact wire model ID. Failed, unsupported, or partial listings cannot mark existing models missing. Applying selected changes never deletes existing model records or changes an assistant's selected model.

The discovery command explicitly queries the configured provider API, including providers whose ordinary model picker uses the registry. It does not fall back to registry rows after an API failure. Undo preserves newly added models that have since been edited, pinned, selected as a default, or referenced by an assistant, Agent, message, or knowledge base; these rows are reported as conflicts.

Registry updates merge model metadata incrementally. Bundled MAI routing pins and fork-only definitions survive an upstream catalog update. Provider routing and credential destinations remain bundled; database user overrides keep priority over catalog metadata. Malformed entries, content-version mismatches, incompatible app/schema versions, and mixed revisions are rejected.

A complete previous snapshot is retained before activating a new catalog. The active manifest switches only after all new files are complete. Failed writes retain the previous valid catalog. Rollback restores the previous metadata snapshot and refreshes affected projections.

## Adaptation and automatic policy

Adaptation uses only protocol adapters already supported by the application. Exact registry metadata supplies declarations; actual probes supply verification. Unknown protocol mappings require a manual choice, and new adapters require an application update. Text verification does not establish tool, vision, reasoning, streaming, or context-window support.

Discovery, paid automatic verification, and automatic application are separate opt-in settings. Enabling paid verification requires confirmation. Each automatic cycle has a bounded candidate count and at most one request per candidate; failure does not trigger a sequence of alternate paid probes. Only verified, still-current candidates can be enabled automatically. Existing user overrides, defaults, and pins remain unchanged.

## Production validation

Contract tests cover zero-fee defaults, single-use confirmation, cancellation, stale targets, bounded concurrency, redacted export, exact IDs, partial listings, selected application, atomic writes, user-override preservation, and rollback. Database mutations use the production migration chain in a real file-backed test database.

The release gate additionally checks lint, types, all relevant unit suites, documentation and migrations, real-window accessibility and deep links, deterministic core regression, bounded real-provider probes, clean installation, populated-profile upgrade and recovery, and native modules in the final Windows x64 and macOS ARM64 packages. Both packages must map to the same source commit. Build success alone does not establish code signing, notarization, or operating-system trust acceptance.

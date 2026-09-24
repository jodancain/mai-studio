# Critical-path desktop regression

These scenarios run against one controller-owned Electron instance per platform. The [controller](../../../scripts/e2e/regression/README.md) installs and launches either the requested development checkout or release installer.
The separate [Playwright config](../../../playwright.regression.config.ts) uses CDP rather than the per-test launch fixture used by the older E2E smoke suite.

## File organization

- Numbered `*.test.ts` files are the ten CI phases, ordered from startup to runtime tasks.
- `fixture.ts` validates required capabilities and owns each test's CDP connection and failure evidence.
- `RegressionApp.ts` locates windows and delegates process operations. Connecting or locating a window does not change application preferences.
- `setup.ts` explicitly establishes English locale, onboarding/telemetry settings, and disabled desktop assistants before each non-startup scenario.
- Domain helpers such as `models.ts`, `knowledge.ts`, and `agents.ts` express reusable user workflows.
- `navigation.ts` and `settings.ts` own shared navigation; `chat.ts` owns chat interactions and response assertions.
- The controller owns `RegressionReporter.ts` and its unit tests.
- Helpers import Playwright assertions directly; only scenarios import the extended `test` from `fixture.ts`.

## State ownership

The application process and configured service providers are shared within a run. Provider configuration comes from the same run environment and is not changed between scenarios.
Custom assistants and knowledge bases are named with their case ID. Agent work directories are case-scoped; file tasks remove their own previous output before asserting newly produced content.
Each non-startup scenario begins on Chat with quick/selection assistants disabled. Persistence assertions restart the application inside the same scenario without repeating setup, so initialization cannot hide lost persisted state.
The built-in assistant's tests start new tasks and clear skill tokens where required. A scenario that mutates a shared resource must restore its intended state explicitly before relying on it.

A failed scenario must not supply the expected result for another scenario. Assert a new assistant response, a newly written file, or a real native event; do not inject success markers through IPC.

The `knowledge` task is one end-to-end case (`K-01`): create and index a knowledge
base, verify recall, restart the application, then query the persisted base and
verify the answer and citations. It imports the fixtures only once. The former
`knowledge-import` and `knowledge-qa` task IDs are replaced by `knowledge`.

`mai-local-knowledge` (`MAI-K01`) covers the Mai core knowledge scope without
external embedding credentials. It downloads Qwen3 through `local_model.download`
and verifies readiness, creates a `local-embedding::qwen3-embedding-0.6b` base
through the UI, imports the fixture folder, and verifies indexing and hybrid retrieval.
A separate keyword-only base imports the real source through Knowledge IPC.
Both paths verify the stored source bytes and cited chunk before and after a
restart; a case-owned assistant using `mai::claude-sonnet-5` then answers from
the persisted vector base with a visible citation. Runtime evidence is attached
to the report. Public Knowledge search uses hybrid ranking for embedding bases;
this case does not independently assert pure-vector ranking. The external `K-01`
still blocks when its provider credentials are absent; it remains selected by
`all` and `knowledge`.

## Adding or selecting a case

1. Add the case to `scripts/e2e/regression/cases.ts`, including its phase, task, and required capabilities.
2. Register it with `test(...caseDefinition('CASE-ID'), async ({ app, mainWindow }) => { ... })`.
3. Establish its preconditions in the scenario or domain helper. Keep selectors scoped to the relevant product surface.
4. Run manifest tests, typechecking, and Playwright enumeration. Add a workflow step only when introducing a new phase.

Use the task IDs from the manifest in the workflow's `task` input (`all` selects every case). Within an initialized run, execute a phase through the same controller as CI:

For the Mai internal macOS ARM64 candidate, `mai-core` selects the supported
core cases; `mai-default-chat` exercises the bundled default assistant and
Stop. The default-model case uses the clean profile, separate from custom-model
and custom-assistant scenarios on the authenticated profile. It asserts the
initial chat-default preference, Chat assistant, and builtin Agent model without
changing them, explicitly selects the Chat assistant, and verifies the model
recorded on its actual answer and paused response. After restarting the same
clean profile, all three default bindings and both message states must persist.
Use a new run directory for a first-install baseline: switching to `clean` in an
existing run reuses that profile rather than deleting it.

In `mai-core`, `A-01` and `A-02` select the exact `mai::claude-sonnet-5`
model through the bundled Anthropic path. Other tasks retain their custom
provider selection. The optional custom Agent OpenAI bridge returned HTTP 400
and remains outside this release's accepted scope; ordinary custom-provider
chat is still covered by `M-02` and `C-01`.

```sh
pnpm exec tsx scripts/e2e/regression/cli.ts run-phase \
  --run-dir /absolute/run-directory --phase 02-basic-features
```

The run's task selection controls which cases execute. To run only Notes, initialize with `--task notes`; do not narrow an all-task run manually and then treat it as a full pass.

## Configuration and evidence

The repository variables/secrets are listed in `scripts/e2e/regression/config.ts`; the image model variable is `CHERRY_TEST_CHERRYIN_IMAGE_MODEL`.

Custom chat provider creation fills two required endpoint URLs:

- OpenAI: `CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL` (for example, `https://api.siliconflow.cn/v1`).
- Anthropic: `CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL` (for example, `https://api.siliconflow.cn`).

Both endpoints use `CHERRY_TEST_CUSTOM_PROVIDER_API_KEY`. The embedding provider remains separately configured.

Never attach credentials or enable credential-bearing Playwright traces. HTML reports and failure screenshots are produced by Playwright and the fixture; sanitized Electron logs are copied during finalization.

Use the [frontend testing guidelines](../../../docs/references/testing/frontend-testing.md). Keep local changes separate from hosted runtime validation; successful enumeration and unit tests do not prove desktop permissions or external model availability.

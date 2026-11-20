# Verification

This file describes what the automated checks cover for the current dependency set and what to check when Codex or Paseo releases a new version. The commit history records when things changed and why.

## Supported versions

| Component                   | Verified                                                   | Accepted                                                                                                                                                                  | Rejected                                        |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Codex CLI and shared daemon | 0.164.0 – 0.170.x (the contract test runs on 0.170.0)      | Newer releases and pre-releases above 0.164.0, with a one-time warning per component and version                                                                          | Below 0.164.0, and 0.164.0 pre-releases         |
| Paseo host                  | 0.16.2 (locked helper and host version), 0.15.4 and 0.14.0 | Any version matching `>=0.14.0`, including pre-releases, because Paseo also checks the stable core version; versions above 0.16.x and pre-releases log a one-time warning | Below 0.14.0 (Paseo refuses to load the plugin) |

`src/protocol.ts` holds the version policy (`CODEX_MIN_VERSION`, `CODEX_TESTED_VERSION`, `PASEO_MIN_VERSION`, `PASEO_TESTED_VERSION`). `paseo-plugin.json` holds the Paseo requirement that Paseo enforces itself. `tests/version.test.ts` checks that these constants match the manifest and the pinned packages. The `@getpaseo/*` runtime helpers and the `@openai/codex` devDependency are pinned in `package.json` and the lockfile.

### Codex 0.170.x compared with the minimum

Between 0.164.0 and 0.170.x, the app-server methods the bridge calls (`initialize`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/resume`, `thread/items/list`, `thread/turns/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/unsubscribe`) only gained optional fields:
- `thread/list` accepts `attachedToThreadId`, `includeAttachedThreads` and `currentAccountOnly` filters. The defaults keep ordinary listings unchanged.
- `Thread` carries `attachedToThreadId`.
- `thread/items/list` accepts an opt-in `deferOutput`, and entries may carry `outputDeferred`. The bridge does not request deferral, so outputs stay inline.
- `agentMessage` items carry an optional `moderation.display` hint for how Codex Chat presents a recovered answer; 0.170 reshaped it into versioned `show`, `hide` and `block` variants. The bridge does not read it and shows the item text.

The control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`), `codex app-server proxy --sock`, thread and turn status values, and the async-question reply envelope are unchanged.

### Paseo 0.16.2 compared with 0.14.0

The provider, hook, reverse-RPC and host-client interfaces the plugin uses behave the same. The released-host test passes with the locked 0.16.2 helpers against 0.16.2, 0.15.4 and 0.14.0 hosts. Only the test's own server-internal storage call differs: 0.16 renamed `agentStorage.list()` to `listAll()`, and the test accepts either.

## Checking a new release

For a new **Codex** release:
1. Bump `@openai/codex` in `package.json` and run `pnpm install`.
2. Compare the generated bindings, for example `codex app-server generate-ts --experimental --out <dir>` for the old and new versions, then `diff -r`. Look at the methods listed above, `Thread`, `Turn`, `ThreadStatus`, `ThreadItem`, `ThreadItemEntry`, the server request types in `permissions.ts`, and `InitializeResponse`.
3. Check that the control socket path and `app-server proxy --sock` are unchanged (`codex app-server proxy --help`).
4. Raise `CODEX_TESTED_VERSION` to the pinned release and run `pnpm verify`. `tests/codex-contract.test.ts` starts the pinned daemon and asserts that it reports `CODEX_TESTED_VERSION`.
5. If something fails, keep the previous `CODEX_TESTED_VERSION` and pin until fixed. Users on the new release get the tentative-version warning, but the bridge keeps working.

What tends to break, and how it shows:
- **Required fields removed or retyped** in thread, turn or item payloads: schema-validation errors on attach or refresh. The attachment shows a synchronization notice and reconnects. Nothing is replayed.
- **New thread status types**: tolerated. Only `active` is interpreted.
- **New item types**: shown as labelled "Codex native record" cards.
- **New or reshaped server requests**: shown as a "complete this in the Codex terminal" notice instead of a Paseo card.
- **Socket or proxy changes**: the provider reports the proxy's own stderr, for example a missing socket path.

For a new **Paseo** release:
1. Bump the four `@getpaseo/*` dependencies together and run `pnpm install`.
2. Run `pnpm verify`. The host test starts the locked server version, so the plugin requirement check, provider registration, `agent.session_open` hook, reverse RPC, import, restart, disable/enable and reload are all exercised.
3. If everything passes, raise `PASEO_TESTED_VERSION`. Until then, discovery logs the tentative-version warning for that host.
4. `src/paseo-client.ts` imports three server modules by path (home, pid lock, local credential), because Paseo's `daemon-control` export does not survive the CommonJS plugin bundler. Check those paths still exist after a bump.

## What the tests cover

| Requirement             | Implementation                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic attachment    | `activation.ts`, `provider.ts`, `discovery.ts`, `paseo-client.ts` | The released-host test installs the plugin without warming Paseo's provider snapshot, waits for import without a separate worker, then discovers a later thread; each thread lands in its own titled workspace, apart from an existing folder workspace. Provider and discovery tests cover eligibility (persisted, loaded, root, terminal, direct-input), opaque handles, lost import responses, archives, cancellation and isolated failures. |
| Shared control          | `thread.ts`, `timeline.ts`                                        | Provider tests cover stale snapshots, steering against the host's admitted turn, fast completion and idle continuation. The host test steers native turns through the public reverse RPC.                                                                                                                                                                                                                                                       |
| Approvals and questions | `permissions.ts`, `questions.ts`, `thread.ts`                     | Projection tests cover offered decisions and response validation. Host and provider tests cover pending approvals, terminal-side resolution, async questions across turns and reloads, answers from other clients, and persistent **Hide**.                                                                                                                                                                                                     |
| Lifetime                | `activation.ts`, `provider.ts`, `thread.ts`, `rpc.ts`             | The host test restarts Paseo and disables, re-enables and reloads the plugin, keeping agent IDs. The real-Codex test verifies the daemon survives proxy close. Provider tests cover reconnects, including a reconnect where one thread can no longer be resumed while healthy attachments recover.                                                                                                                                              |
| Native authority        | `thread.ts`, `protocol.ts`                                        | Native and host scenarios assert identity-only resume and retained native settings, with no `thread/start` and no Paseo configuration overrides.                                                                                                                                                                                                                                                                                                |
| Failure integrity       | `rpc.ts`, `provider.ts`, `discovery.ts`                           | Transport tests cover malformed and oversized frames, bounded queues, timeouts, a missing executable, a failed proxy handshake, proxy exit with stderr, and unknown outcomes. Provider tests cover malformed or unaddressed native messages and failed unsubscribe. Snapshot recovery never replays a mutation.                                                                                                                                 |
| Packaging               | `package.json`, `index.server.ts`, `scripts/package-smoke.mjs`    | Build and pack, inspect archive contents, install production dependencies inside the extracted package, run the CLI help, then rerun the host scenario against the extracted plugin.                                                                                                                                                                                                                                                            |

The real-Codex test runs a test-owned daemon in a disposable home against a loopback Responses fixture. The released-host test runs Paseo itself and the official Codex proxy against a deterministic native WebSocket fixture. Neither uses live credentials, contacts a model, updates global CLIs or edits live Paseo configuration.

## Design constraints the tests protect

- **Transport:** the official proxy forwards bytes to a WebSocket endpoint, so the bridge speaks WebSocket framing over the proxy's stdio.
- **Eligibility:** a thread qualifies only when it is both loaded and persisted. An empty start screen has no resumable record.
- **Discovery isolation:** Codex can reject `thread/read` with `-32600` after a thread disappears between listing and reading. Other readable terminals still import; the rejected thread is retried next pass. Its diagnostic is logged once until it changes or the thread recovers. Transport errors, invalid protocol responses and scans with no readable candidates still fail visibly.
- **Activation:** Paseo's manager only receives turn events after registration, so discovery activates each attachment explicitly after import or restore.
- **Revision guards:** native notification revisions keep a stale snapshot from overwriting newer turn state. The last published turn is kept until its native outcome is known; no completion is invented.
- **Recovery:** a snapshot failure closes the proxy and rehydrates every attachment without repeating mutations. A per-thread failure stays isolated.
- **Admission:** steering and answers check the host's admitted turn and the native active turn before sending anything.
- **Deduplication:** exact fingerprints, not an evicting cache, prevent duplicate timeline records, because Paseo drops identity for some imported item types.
- **Bounded resources:** history streams in pages, and every scan, queue and metadata set has an explicit limit that reports an error instead of truncating.

## Not covered

Interactive Codex TUI with Paseo phone or browser acceptance, and macOS or Windows operation, are not verified. The bridge needs Codex's Unix control socket. No claim extends to `--no-daemon` sessions, other users' homes or remote app servers. Paseo's external-permission history lacks the native decision, and concurrent archive and import have no atomic host guard. The [README](../README.md#limits-and-recovery) describes how to handle both.

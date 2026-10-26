# Verification record

## Baseline and scope

Checked 2026-10-25 against released Paseo **0.13.0** and Codex **0.164.0** on Linux. Runtime dependencies are pinned in the package and lockfile. Paseo source reference: [d34d17a9072149320ace35ec2a2e5c7dcd992cb3](https://github.com/getpaseo/paseo/tree/d34d17a9072149320ace35ec2a2e5c7dcd992cb3). Native protocol evidence uses the released executable and [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.164.0).

The automated tests do not update global CLIs, edit live Paseo configuration, or use user sessions and credentials. Git publication and installation into the local Paseo daemon are separate, explicitly authorized operations, not part of the test suite.

## Owning proofs

| Requirement               | Implementation                                                    | Evidence                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 — Automatic attachment | `activation.ts`, `provider.ts`, `discovery.ts`, `paseo-client.ts` | Released-host test installs the plugin and awaits import without a separate worker, then discovers a later thread. Provider/discovery tests cover eligibility, opaque handles, uncertain imports, archives, cancellation and independent failures.                 |
| R2 — Shared control       | `thread.ts`, `timeline.ts`, `activation.ts`                       | Provider tests cover stale snapshots, active steering, stale host admission, fast completion and idle continuation. Released host imports live output and steers native turn IDs through the public reverse-RPC guard.                                             |
| R3 — Approvals            | `permissions.ts`, `thread.ts`                                     | Projection tests cover offered decisions and response validation. Host test verifies pending native approval and terminal-side resolution.                                                                                                                         |
| R4 — Lifetime             | `activation.ts`, `provider.ts`, `thread.ts`, `rpc.ts`             | Released-host test restarts Paseo, disables/re-enables the plugin and reloads it, preserving agent IDs and restoring activation automatically. Disabled discovery sends no native requests or imports. Real Codex test verifies daemon survival after proxy close. |
| R5 — Native authority     | `thread.ts`, `protocol.ts`                                        | Native and host scenarios assert identity-only resume and retained settings, without `thread/start` or Paseo configuration overrides.                                                                                                                              |
| R6 — Failure integrity    | `rpc.ts`, `provider.ts`, `discovery.ts`                           | Transport tests cover malformed/oversized messages, bounded queues, timeouts, proxy shutdown and unknown outcomes. Snapshot recovery never replays the failed mutation. Discovery isolates an invalid attachment without swallowing errors.                        |
| R7 — Packaging            | `package.json`, `index.server.ts`, `scripts/package-smoke.mjs`    | Build and pack, inspect archive contents, run extracted CLI help, then reuse the host scenario with the extracted plugin directory.                                                                                                                                |

The real-Codex test runs a test-owned daemon in disposable homes and sends one request to a loopback Responses fixture. The released-host test runs Paseo itself and the official Codex proxy against a deterministic native WebSocket fixture. Neither test operates the interactive Codex TUI or a Paseo phone UI. Together they exercise the component boundaries, not a manual end-to-end UI session.

The package check copies tracked working-tree inputs into a fresh directory, runs the manifest's preparation commands, and packs that output. It installs production dependencies inside the extracted artifact from the same lockfile and build policy, offline from the populated store. This matches Git installation's plugin-root dependency layout; no dependency-directory symlink points to another checkout. It proves clean-source installation, generated output, archive layout and runtime loading on the test platform, not arbitrary npm-hoisted consumer layouts.

## Findings that changed implementation

- **F1 — Transport.** JSONL initialization timed out against real Codex. The official proxy forwards bytes to a WebSocket endpoint. Replaced the single transport with WebSocket framing; retained no alternate path.
- **F2 — Persistence.** A loaded thread without a first prompt had no resumable stored record. Discovery now requires both loaded and persisted identity and recognizes the actual TUI originator.
- **F3 — Loader.** Released Paseo rejected imports outside runtime-owned directories. Compile to `server/` and verify the actual package entry.
- **F4 — Registration.** Pre-ready turn events were not delivered to Paseo's manager after import. Activate explicitly after manager registration; timeline fetch restores the same agent ID after restart.
- **F5 — Hydration.** A newer completion could be overwritten by a stale current-turn snapshot. Guard snapshots with native notification revisions and clear disconnected state before rehydration. Both initial and reconnect races have regressions.
- **F6 — Recovery.** A snapshot failure originally disconnected only the attachment, leaving no reconnect trigger. Close the owned proxy and recover through the connection owner without repeating mutations.
- **F7 — Discovery isolation.** A deleted attachment could prevent new imports. Collect identified failures, continue independent attachments, then report the aggregate.
- **F8 — Admission.** The plugin contract omitted the host's expected steering turn. Read the manager's barrier-held ID through its public API and reject mismatches before native mutation.
- **F9 — Git installation.** `--path plugin` selected a nonexistent subdirectory; the manifest is at the repository root. Fresh Git sources also lacked generated `server/` output and declared no preparation. The strengthened package check reproduced the missing `server/activation.js` before adding manifest preparation. GitHub setup now uses the root source and declares dependency installation plus build.
- **F10 — Discovery startup.** Plugin registration never started the discovery loop. Removing manual import from the released-host scenario reproduced zero agents after startup. Registration now starts one loop without awaiting host readiness; async cleanup aborts and awaits it. CLI `watch` was removed; `once` remains for diagnostics.
- **F11 — Plugin bundling.** Importing the exported Paseo `daemon-control` helper failed with `createRequire` receiving undefined: its transitive executable resolver depends on `import.meta.url`, which Paseo's CommonJS plugin compiler removes. The approved workaround imports three pinned owning modules directly for home, daemon-state and credential operations. Paths are relative to the installed package, not this host. The same released-host proof exercises the packed artifact in an unrelated temporary directory.

Behavioral failures were observed before the corresponding fixes. One transport API extension, the `initialized` notification sender, did not have a separate symbol-level RED test; the real handshake failure and subsequent native contract proof cover its end outcome.

## Turn-state reconciliation — 2026-10-26

The released-host scenario now persists native completion without broadcasting either completion or thread-status notifications. Before the fix, Paseo remained `running` with the old turn after the ten-second assertion deadline. The same scenario requires automatic transition to idle under the original agent ID and one completion across subsequent discovery passes. The packed-plugin scenario reuses this proof.

Provider regressions cover idle and closed lifecycle notices, native cancellation, a newer turn arriving during an older read, and missing history through repeated reconnection. Missing history first reproduced absent user-visible diagnostics, then loss of the unresolved Paseo turn after unsuccessful rehydration. The bridge retains the last published turn ID until its native outcome is known; it does not fabricate a terminal result. Existing bootstrap, prompt-admission, archive-exclusion and mutation-replay proofs remain in place.

Review exposed two additional regressions: activation during reconnect could publish completion twice, and a missing turn could close a proxy shared with healthy attachments. Focused failures preceded the corrections. Activation and prompts now remain blocked through the complete reattach operation; per-thread reconciliation errors remain isolated and retryable. Snapshot failures retain their existing proxy-restart recovery.

Periodic reconciliation reads thread and turn metadata. Older turn metadata is paged only when the remembered turn is not the latest one, under the existing history bounds. Lifecycle-triggered checks share the existing snapshot scheduler and failure recovery. Native notification revisions and RPC identity prevent stale current-state reads from overwriting newer activity.

## Async questions — 2026-10-28

The released-host scenario first failed because a native `agentMessage` with `delivery: "async"` produced no pending question. It now checks selectable and free-text fields, sends the reply through Paseo's public permission API, and verifies the exact native question-ID envelope. The existing restart scenario verifies that answered questions do not reopen. Package smoke reuses this host proof.

The late-answer regression then reproduced question loss after native turn completion. The host scenario now keeps that question pending through completion and plugin reload, submits an answer while idle, and verifies one native `turn/start` with the original question identity in a different turn's history. A further reload must not restore the answered form. This extends the existing host owner rather than adding a separate mock-only lifecycle test.

Provider regressions cover partial answers from another native client, an externally answered question whose notification was missed, and a turn switch during answer admission. The turn-switch test failed before the guard pinned the answer to its original native turn. Review then reproduced an older history read reopening an answered question, including when the newer pending set was unchanged. Every accepted question reconciliation now advances the history revision. The same guarded steering path serves ordinary prompts and async answers.

The native format and input semantics were checked against the installed 0.164.0 generated protocol and the pinned [reply parser](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/async_question_reply.rs), [question identity](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/bottom_pane/async_questions/state.rs), and [start-or-steer contract](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/turn_start.rs#L654). The native TUI's transient card lifetime is not used as the remote answer-validity rule. Interactive Android acceptance remains separate from these host and native-boundary checks.

## Project gate

Run `pnpm format` followed by `pnpm verify` for formatting, lint, strict types, build, behavioral tests, and the extracted-package host scenario. The package scenario reuses the owning integration proof. All test-owned proxies and daemons exit through explicit cleanup.

**Tests:** Pruned one redundant CLI-help absence assertion from package smoke; the current one-shot usage contract remains checked. The existing host scenario owns lifecycle behavior, without new duplicate test cases. The long provider test file shares one native fixture and covers one attachment lifecycle; it was not split merely for line count.

**Simplify:** The original implementation pass removed redundant status validation. The lifecycle change received its own post-verification pass: no-op; startup, cancellation and client ownership remain explicit, with no extra wrapper or process to remove.

The reconciliation cleanup pass was also a no-op: snapshot reading is shared by initial hydration and reconnect, one scheduler owns pending refreshes, and the published turn ID is an intentional host-state snapshot needed across unsuccessful recovery. Further restructuring would change lifecycle or error-ordering behavior rather than remove redundant code.

The async-question cleanup pass named the shared native question-tool identifier and narrowed idle-turn parameters to their using branch. No duplicate-outcome tests were added; the stale-read variant extends the external-answer owner.

The late-answer cleanup pass was a no-op: normal prompts and question replies already share native delivery, and the refresh adds no second question-history cache. The new completion/reload scenario extends the existing host owner; no redundant test was added.

**Diagram:** `dot -Tdot docs/architecture.dot -o /dev/null` and Graphviz SVG generation completed without diagnostics. The render pipeline adds `role="img" aria-label="Plugin-owned discovery and shared Codex execution"` to the SVG root. The plugin-process group contains the provider and discovery loop. `rsvg-convert -w 1800 docs/architecture.svg -o /tmp/pbc-lifecycle-architecture.png` rendered the saved SVG for visual inspection: no clipped nodes, overlapping labels, or edges through unrelated nodes. SVG point-coordinate DPI is explicit in the DOT source; the installed Graphviz renderer clipped the higher-DPI output.

## Remaining acceptance boundaries

Interactive Codex TUI plus Paseo phone/browser acceptance and macOS/Windows operation are unverified. The package uses a Unix control socket. No claim extends to embedded `--no-daemon` sessions, other users' homes, arbitrary remote app servers, or unsupported versions.

Paseo's external-permission history lacks the actual native decision, and concurrent archive/import has no atomic host guard. The [README](../README.md#limits-and-recovery) describes these boundaries and operational handling.

# paseo-bridge-codex

Attach terminal-started Codex threads to unmodified Paseo. The terminal and Paseo control the same native thread; closing the terminal does not close the Paseo attachment.

The package supplies a **Codex Terminal** provider (`codex-terminal`) and one plugin-owned discovery worker per Paseo host. Paseo's built-in Codex provider stays unchanged. No shell wrapper or replacement execution engine is involved.

## Setup

The tested release pair is **Paseo 0.13.0 + Codex 0.164.0**, checked on 2026-10-25. Other versions are rejected, not adapted. Node.js 22.22 or newer is required. Runtime tests ran on Linux; Windows and macOS have not been verified. The bridge requires Codex's Unix control socket.

### Install from GitHub

With the supported CLIs and pnpm available on the Paseo daemon host, install from the repository root:

```sh
paseo plugin install github:Konfekt/paseo-bridge-codex
paseo plugin ls
```

Do not add `--path plugin`: there is no `plugin/` subdirectory. The manifest runs `pnpm install --frozen-lockfile` and `pnpm build` in the staged checkout before activation. Paseo records preparation output in `$PASEO_HOME/daemon.log`.

The pinned Paseo helpers resolve from this plugin's own dependency directory, created by that preparation step. No machine-specific paths are embedded. Git/local root installs are supported; embedding the package in an arbitrary npm-hoisted dependency layout is not supported.

The root `pluginsEnabled` setting must be `true` for installed plugins to run. Installation does not enable this global setting. A running plugin starts discovery automatically; no dedicated terminal or separate service is required.

Codex must use its shared daemon. Set `daemon_auto_start = true` in the existing `[features]` section of Codex's `config.toml`, preserving other settings. This starts Codex's daemon, not the discovery worker. Check both `codex --version` and `codex app-server daemon version`: an already-running daemon may still use an older release. If needed, run `codex app-server daemon update --from-cli` once active work is idle; updating can interrupt running work. Both must match the supported Codex release.

### Install a local checkout

1. Install the supported official CLIs separately and authenticate Codex. Start the Paseo daemon. Use the same OS account and Codex home for the terminal and Paseo provider.
2. In this checkout, install dependencies and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   ```

3. Set the root `pluginsEnabled` field to `true` in the existing `$PASEO_HOME/config.json` (default `~/.paseo/config.json`), preserving other configuration. Plugins execute trusted code with the daemon account's access. Reload and register the built checkout:

   ```sh
   paseo reload
   paseo plugin install "$PWD"
   paseo plugin ls
   ```

   Keep the default plugin ID `paseo-bridge-codex`; the worker uses it for activation. These commands follow the [released Paseo plugin setup](https://github.com/getpaseo/paseo/blob/d34d17a9072149320ace35ec2a2e5c7dcd992cb3/docs/plugins.md).

4. Run ordinary daemon-backed `codex` in a workspace and send its first prompt. Once Codex persists the thread, it appears in Paseo as **Codex Terminal**. An empty start screen is not yet resumable and is not imported.

Discovery starts with the plugin, checks every two seconds after successful passes, and stops when the plugin unloads. Failed passes retry with a delay capped at 30 seconds. It imports threads but does not relay conversation traffic; the provider and shared Codex daemon handle that. Plugin reload and Paseo restart resume discovery automatically. Stop any separately running worker from an older checkout before loading this version; the CLI no longer offers continuous `watch` mode. No service registration or global configuration changes occur during the build or tests.

Each pass also reconciles attached threads' native turn state, repairing missed start or completion events without replaying the full transcript. Native thread-status changes and closure trigger the same check through the existing refresh scheduler. Closing a terminal retains the session; **running** means a native turn is active, not that the terminal remains open. Archive finished sessions in Paseo to remove them from the active list and exclude them from discovery.

If Paseo uses a different environment, merge an explicit `agents.providers.codex-terminal` override into its configuration:

```json
{
  "agents": {
    "providers": {
      "codex-terminal": {
        "command": ["/absolute/path/to/codex"],
        "env": { "CODEX_HOME": "/absolute/path/to/codex-home" }
      }
    }
  }
}
```

Use the actual binary and home paths. Reload Paseo after changing the configuration. The plugin uses the Paseo launcher's explicit `PASEO_HOME`; a custom launcher must supply it. The diagnostic CLI's `--paseo-home` selects Paseo, not Codex; the provider environment selects Codex.

## Operation

| Command or action                                     | Result                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Enable the plugin                                     | Start the host's discovery worker automatically.                                                |
| `node server/cli.js once`                             | Run one diagnostic discovery pass; exit nonzero if an attachment fails.                         |
| `node server/cli.js once --paseo-home /absolute/path` | Run that pass against the selected local Paseo home using its existing credentials.             |
| `node server/cli.js --help`                           | Print CLI usage.                                                                                |
| Send text in Paseo                                    | Start a native turn when idle, or steer the admitted active turn.                               |
| Close the terminal                                    | Retain the thread in Paseo.                                                                     |
| Archive the Paseo entry                               | Exclude it from subsequent discovery passes; release its attachment.                            |
| Disable the plugin                                    | Stop discovery and release bridge connections; leave Codex execution and saved pointers intact. |
| Restart Paseo with the plugin enabled                 | Restart discovery and activate saved attachments under their original Paseo agent IDs.          |

After installing the package as a CLI, `paseo-bridge-codex` replaces `node server/cli.js`; its default is one pass. For checkout updates, rebuild and run `paseo plugin reload paseo-bridge-codex`.

## Limits and recovery

- **Discovery:** Only persisted, loaded, directly controllable root terminal threads qualify. Stored history alone, editor sessions, child threads, and `codex --no-daemon` sessions do not. No process or screen inspection is used.
- **Controls:** Text prompts, interrupts, supported approvals, structured questions, and basic string-field MCP forms are projected. Secret/client-bound or unsupported requests remain terminal-only with a notice. Settings and model selection remain native; no Paseo defaults overwrite them.
- **Native records:** Items without a dedicated projection appear as labelled JSON activity cards, preserving their native type and fields. These are record snapshots, not invented tool invocations. Unlike startup notifications, these cards are not inserted twice by Paseo's import path.
- **Async questions:** Unanswered questions remain available after native turns finish and after plugin reload. Matching native replies remove answered fields, including replies sent in later turns. Answers use Codex's structured reply envelope and question IDs, starting a turn when idle or steering the admitted active turn. Codex's local Skip action has no shared record, so remote dismissal is rejected. No answer state is stored in Paseo persistence.
- **Failures:** A dropped connection or timed-out mutation has an unknown outcome. Check the reconciled native history before submitting again. The bridge reconnects and rehydrates, but never automatically repeats prompts or approval responses. Missing or contradictory native turn history reports a warning instead of inventing completion. Paseo 0.13.0 has no separate reversible unavailable status: a disconnected session can retain its last running indicator alongside the warning until native state is recovered.
- **Permissions:** Terminal resolution clears the Paseo request. Paseo 0.13.0 records external resolution as a generic denial-shaped history entry; the native notification does not include the actual decision.
- **Archiving:** Entries already archived at reconciliation are skipped. Paseo 0.13.0 has no atomic “import only if not archived” operation, so an archive simultaneous with another client's import can race. Stop discovery while resolving that conflict.
- **Long histories:** Native history streams in pages of at most 100 items, without a lifetime item/page cutoff or retained full-payload cache in the bridge. Initial import, restart and reconnect preserve complete history. Live updates read dirty turns; question reconciliation and answer admission scan native questions and replies pagewise. Paseo itself retains its timeline in memory; this does not provide lazy mobile history or constant-memory Paseo.
- **Resources:** Each provider connection allows 128 attachments. Each native history scan has a 60-second deadline, checks attachment cancellation between pages and rejects non-advancing pagination. Exact snapshot deduplication retains IDs and SHA-256 fingerprints, not historical payloads, with a 64 MiB encoded-metadata budget. Fingerprints cannot be evicted safely because Paseo does not preserve identity for every timeline type. Question-scan metadata and updates awaiting manager activation each have an 8 MiB budget. RPC messages and queued writes are bounded at 8 MiB, with 128 pending requests and a 15-second response deadline. Discovery metadata lists remain bounded at 10,000 entries or 200 pages. Resource exhaustion reports an error instead of silently truncating history.

For a missing socket, start normal daemon-backed Codex under the provider's configured `CODEX_HOME`; the bridge never starts a separate execution server. For a version error, align Paseo, the Codex CLI, and the running Codex daemon with the supported release pair. Already-open embedded terminals do not switch to the daemon automatically; finish active work, close them, then resume those conversations through daemon-backed Codex. For a stale or deleted thread, archive its Paseo entry; other discoveries continue despite that attachment's error. Discovery failures appear in Paseo's plugin logs; `once` also reports them directly.

## Development and evidence

```sh
pnpm format
pnpm verify
```

The gate checks formatting, lint, strict types, behavioral tests, and the packed plugin. The package check copies tracked files into an isolated directory, executes manifest preparation, and loads the resulting package with those freshly installed dependencies. It cannot reuse ignored build output or workspace dependencies. Dependency downloads can use pnpm's existing store. Tests use disposable homes, an isolated real Codex daemon with a loopback model fixture, and the released Paseo host. They do not use live user credentials or contact an external model. Interactive phone/TUI acceptance remains unverified.

# paseo-bridge-codex

Share Codex threads between the Codex terminal and unmodified Paseo, including its Android app. A thread started in the terminal appears in Paseo, and a **Codex Terminal** agent created in Paseo is a thread on the same shared daemon that `codex resume <thread-id>` continues in a terminal. Both sides control the same native thread at the same time; neither has to close for the other to continue.

```
 Codex TUI ----\                         /---- Paseo (desktop, Android)
 codex resume   +-- shared Codex daemon --+     Codex Terminal agent
 <thread-id> --/   (one native thread)     \--- via app-server proxy
```

The package supplies a **Codex Terminal** provider (`codex-terminal`) and one plugin-owned discovery worker per Paseo host. Paseo's built-in Codex provider stays unchanged. No shell wrapper or replacement execution engine is involved.

## Setup

Supported releases:
- **Paseo 0.14.0 or newer** (manifest requirement `>=0.14.0`). The plugin's own Paseo helpers are locked to **0.17.1**; the released-host test passes on Paseo 0.17.1 and 0.16.2. Newer Paseo releases, including betas, are allowed tentatively: discovery logs a warning once per host version (`Paseo host ... is newer than the tested range ...; continuing tentatively`).
- **Codex 0.164.0 or newer.** **0.164.0 through 0.171.x** is verified. Newer releases and pre-releases are accepted **tentatively**: the bridge logs a warning once per version (`... is newer than the tested range ...` or `... is a pre-release ...`, then `continuing tentatively`) and keeps working instead of refusing. Releases older than 0.164.0, and pre-releases of 0.164.0 itself, are rejected because they lack the app-server methods the bridge uses. See [docs/verification.md](docs/verification.md#checking-a-new-release) for promoting a newer release to verified.

Node.js 22.22 or newer is required. Runtime tests ran on Linux; Windows and macOS have not been verified. The bridge requires Codex's Unix control socket.

### Install from GitHub

With the supported CLIs and pnpm available on the Paseo daemon host, install from the repository root:

```sh
paseo plugin install github:Konfekt/paseo-bridge-codex
paseo plugin ls
```

Do not add `--path plugin`: there is no `plugin/` subdirectory. The manifest runs `pnpm install --frozen-lockfile` and `pnpm build` in the staged checkout before activation. Paseo records preparation output in `$PASEO_HOME/daemon.log`.

The pinned Paseo helpers resolve from this plugin's own dependency directory, created by that preparation step. No machine-specific paths are embedded. Git/local root installs are supported; embedding the package in an arbitrary npm-hoisted dependency layout is not supported.

The root `pluginsEnabled` setting must be `true` for installed plugins to run. Installation does not enable this global setting. A running plugin starts discovery automatically; no dedicated terminal or separate service is required.

Codex must use its shared daemon. Set `daemon_auto_start = true` in the existing `[features]` section of Codex's `config.toml`, preserving other settings. This starts Codex's daemon, not the discovery worker. Check both `codex --version` and `codex app-server daemon version`: an already-running daemon may still use an older release. If needed, run `codex app-server daemon update --from-cli` once active work is idle; updating can interrupt running work. Both must be 0.164.0 or newer; ideally they are the same release.

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

Each imported thread gets its own Paseo workspace in the thread's directory, titled after the thread name or first prompt, so it has its own sidebar entry instead of joining the folder's existing workspace. The workspace ID derives from the thread, so retries and restarts reuse it. Hosts that cannot create the workspace, and threads whose workspace was archived, fall back to the folder workspace. Threads imported before this behavior stay where they are.

Discovery starts with the plugin, requests Paseo's provider snapshot before each pass (Paseo lists a plugin provider's sessions only after its runtime has connected), reports an unavailable or failed **Codex Terminal** provider with its diagnostic, checks every two seconds after successful passes, and stops when the plugin unloads. If Codex rejects the read of a thread that disappeared after listing, discovery logs its identity and continues importing the other readable threads; the next pass retries that thread. A broken connection, invalid protocol response, or scan in which every thread read is rejected still fails visibly. Failed passes retry with a delay capped at 30 seconds. It imports threads but does not relay conversation traffic; the provider and shared Codex daemon handle that. Plugin reload and Paseo restart resume discovery automatically. No service registration or global configuration changes occur during the build or tests.

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

### Remote hosts

Discovery runs inside the Paseo daemon and finds it through `$PASEO_HOME/paseo.pid`, on any listen address or port, TCP or Unix socket. A password-protected daemon admits it with `$PASEO_HOME/local-credential`, so no password is configured. `PASEO_HOST` is not used. Codex threads are read from the provider's `CODEX_HOME` and attached through that home's Codex daemon socket. Codex, its home and the daemon therefore have to be on the same machine. For Codex on another machine, install Paseo and this plugin there and add that daemon as a host in the Paseo app, for example with `paseo host add` or by pairing the app with it. Its threads then appear under that host.

## Operation

| Command or action                                     | Result                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Enable the plugin                                     | Start the host's discovery worker automatically.                                                |
| `node server/cli.js once`                             | Run one diagnostic discovery pass; exit nonzero if an attachment fails.                         |
| `node server/cli.js once --paseo-home /absolute/path` | Run that pass against the selected local Paseo home using its existing credentials.             |
| `node server/cli.js --help`                           | Print CLI usage.                                                                                |
| New agent in Paseo, provider **Codex Terminal**       | Start a thread on the shared daemon; continue it in a terminal with `codex resume <thread-id>`. |
| Send text in Paseo                                    | Start a native turn when idle, or steer the admitted active turn.                               |
| Type a `/command` in Paseo                            | Run a Codex command through the app-server; see [Slash commands](#slash-commands).              |
| Hide an async question                                | Remove its Paseo card permanently for this attachment, without sending a native answer.         |
| Close the terminal                                    | Retain the thread in Paseo.                                                                     |
| Archive the Paseo entry                               | Exclude it from subsequent discovery passes; release its attachment.                            |
| Disable the plugin                                    | Stop discovery and release bridge connections; leave Codex execution and saved pointers intact. |
| Restart Paseo with the plugin enabled                 | Restart discovery and activate saved attachments under their original Paseo agent IDs.          |

After installing the package as a CLI, `paseo-bridge-codex` replaces `node server/cli.js`; its default is one pass. For checkout updates, rebuild and run `paseo plugin reload paseo-bridge-codex`.

## Slash commands

Codex's slash commands belong to its terminal UI; the app-server only offers the operations behind them. The bridge lists the commands below in Paseo's command menu and runs each through the matching app-server method. None of them reaches the model as text.

| Command                                                     | Effect                                                                                                                                   | App-server method                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/btw <question>`, `/side <question>`                       | Answer a quick question from the thread's context. The question and answer are not added to the thread.                                  | `thread/sample`                                                       |
| `/compact`                                                  | Compact the conversation; Paseo shows the native compaction turn.                                                                        | `thread/compact/start`                                                |
| `/review [base <branch> \| commit <sha> \| <instructions>]` | Review uncommitted changes, a branch diff, a commit, or custom instructions, as a native turn.                                           | `review/start`                                                        |
| `/init`                                                     | Ask Codex to write `AGENTS.md`, with Codex's own prompt. Does nothing if the file exists.                                                | `turn/start`                                                          |
| `/plan [off \| <prompt>]`                                   | Switch to Codex's Plan mode, optionally starting a turn with the prompt; `/plan off` returns to the default mode.                        | `thread/settings/update`                                              |
| `/model [<model> [<effort>]]`                               | List Codex's models, or switch the thread's model and reasoning effort for its next turns; a unique fragment of the model name suffices. | `model/list`, `thread/settings/update`                                |
| `/rename <name>`                                            | Rename the thread.                                                                                                                       | `thread/name/set`                                                     |
| `/goal [<objective> \| pause \| resume \| done \| clear]`   | Show, set or change the thread's goal. An active goal makes Codex continue on its own, as in the terminal.                               | `thread/goal/*`                                                       |
| `/status`                                                   | Show the thread, directory, model, reasoning effort, goal and last token usage.                                                          | `thread/goal/get`                                                     |
| `/usage`                                                    | Show account rate limits. Needs a signed-in Codex account.                                                                               | `account/rateLimits/read`                                             |
| `/permissions [<profile>]`                                  | List permission profiles, or choose one for the next turns (`workspace` matches `:workspace`).                                           | `permissionProfile/list`, `thread/settings/update`                    |
| `/memories on\|off`                                         | Turn memory use on or off for the thread.                                                                                                | `thread/memoryMode/set`                                               |
| `/mcp`, `/skills`, `/hooks`, `/plugins`                     | List MCP servers and tools, skills, lifecycle hooks, or plugins.                                                                         | `mcpServerStatus/list`, `skills/list`, `hooks/list`, `plugin/list`    |
| `/ps`, `/stop` (`/clean`)                                   | List or stop the thread's background terminals.                                                                                          | `thread/backgroundTerminals/list`, `thread/backgroundTerminals/clean` |

How answers appear:
- When the thread is idle, an answer is a short turn of its own in Paseo. A failure, such as `/usage` without a signed-in account, shows as an error and starts nothing.
- During a running turn, Paseo sends a typed command as steering. The bridge answers it inside the running turn and neither steers nor interrupts it. Commands that start a native turn (`/compact`, `/review`, `/init`, `/plan <prompt>`) ask you to wait for the turn to end or stop it.
- If Paseo is set to interrupt the running turn for new messages, Paseo stops the turn before the command arrives. That is Paseo's choice, not the bridge's.
- Command answers live only in Paseo's timeline. Codex does not store them, so they disappear when Paseo reloads the thread's history.
- `/btw` runs one model request without tools, using the thread's model. Asking during a running turn needs Codex 0.171 or newer; older releases answer with an error until the turn ends. Paseo's stop button cancels a side question asked while the thread is idle.

Other Codex terminal commands, such as `/diff`, `/new`, `/resume`, `/fork`, `/copy` and `/quit`, are rejected with a message that names the Paseo alternative (for example "Use Paseo's diff view."). `/new`, `/clear`, `/resume` and `/fork` would move a Paseo agent to another thread; create a new Codex Terminal agent in Paseo instead, or start or fork the session in the terminal and let Paseo import it.

The thread ID of a Paseo-created agent is shown by `/status`. Codex writes a thread's rollout with its first turn, so send a first message before resuming the thread in a terminal or restarting Paseo; an empty thread cannot be resumed. Names Codex does not define, such as a path like `/tmp/log`, still reach the model as text.

## Limits and recovery

- **Discovery:** Only persisted, loaded, directly controllable root terminal threads qualify. Stored history alone, editor sessions, child threads, and `codex --no-daemon` sessions do not. No process or screen inspection is used.
- **Stop:** Paseo refuses to stop or replace an agent unless the provider answers Stop within two seconds. The bridge sends Stop to Codex at once (`turn/interrupt`), even while it is still delivering another message or approval; Codex answers it immediately.
- **Controls:** Text prompts, interrupts, supported approvals, structured questions, and basic string-field MCP forms are projected. Secret/client-bound or unsupported requests remain terminal-only with a notice. The model picker lists Codex's own models (`model/list`) with their reasoning efforts. A choice applies to the shared thread through Codex (`thread/settings/update`) for its next turns, as Codex's own picker does, and model changes made in the terminal show in Paseo. Other settings remain native, and no Paseo defaults overwrite them when a thread attaches.
- **Native records:** Items without a dedicated projection appear as labelled JSON activity cards, preserving their native type and fields. These are record snapshots, not invented tool invocations. Unlike startup notifications, these cards are not inserted twice by Paseo's import path.
- **Async questions:** Unanswered questions remain available after native turns finish and after plugin reload. Matching native replies remove answered fields, including replies sent in later turns. Answers use Codex's structured reply envelope and question IDs, starting a turn when idle or steering the admitted active turn. For stale cards handled through ordinary host chat or Codex's local Skip, select **Hide**. This hides all remaining fields in that card across reconnects, plugin reloads and Paseo restarts; it sends no native answer, approval decision or interrupt. Paseo agent labels store only the hidden question's hashed identity, not answer state or transcript content. A failed preference save leaves the card pending.
- **Failures:** A dropped connection or timed-out mutation has an unknown outcome. Check the reconciled native history before submitting again. The bridge reconnects and rehydrates, but never automatically repeats prompts or approval responses. Missing or contradictory native turn history reports a warning instead of inventing completion. A disconnected session can retain its last running indicator alongside the warning until native state is recovered.
- **Permissions:** Terminal resolution clears the Paseo request. Paseo records external resolution as a generic denial-shaped history entry; the native notification does not include the actual decision.
- **Archiving:** Entries already archived at reconciliation are skipped. Paseo has no atomic “import only if not archived” operation, so an archive simultaneous with another client's import can race. Stop discovery while resolving that conflict.
- **Long histories:** Native history streams in pages of at most 100 items, without a lifetime item/page cutoff or retained full-payload cache in the bridge. Initial import, restart and reconnect preserve complete history. Live updates read dirty turns; question reconciliation and answer admission scan native questions and replies pagewise. Paseo itself retains its timeline in memory; this does not provide lazy mobile history or constant-memory Paseo.
- **Resources:** Each provider connection allows 128 attachments. Each native history scan has a 60-second deadline, checks attachment cancellation between pages and rejects non-advancing pagination. Exact snapshot deduplication retains IDs and SHA-256 fingerprints, not historical payloads, with a 64 MiB encoded-metadata budget. Fingerprints cannot be evicted safely because Paseo does not preserve identity for every timeline type. Question-scan metadata, hidden-question label keys and updates awaiting manager activation each have an 8 MiB budget. Hidden questions do not consume the 128 visible pending-permission slots. RPC messages and queued writes are bounded at 8 MiB, with 128 pending requests and a 15-second response deadline. Discovery metadata lists remain bounded at 10,000 entries or 200 pages. Resource exhaustion reports an error instead of silently truncating history.

For a missing socket, start normal daemon-backed Codex under the provider's configured `CODEX_HOME`; the bridge never starts a separate execution server. For a version error, align Paseo, the Codex CLI, and the running Codex daemon with the supported releases. Already-open embedded terminals do not switch to the daemon automatically; finish active work, close them, then resume those conversations through daemon-backed Codex. For a stale or deleted thread, archive its Paseo entry; other discoveries continue despite that attachment's error. Discovery failures appear in Paseo's plugin logs; `once` also reports them directly.

## Development and evidence

```sh
pnpm format
pnpm verify
```

The gate checks formatting, lint, strict types, behavioral tests, and the packed plugin. The package check copies tracked files into an isolated directory, executes manifest preparation, and loads the resulting package with those freshly installed dependencies. It cannot reuse ignored build output or workspace dependencies. Dependency downloads can use pnpm's existing store. Tests use disposable homes, an isolated real Codex daemon with a loopback model fixture, and the released Paseo host. They do not use live user credentials or contact an external model. Interactive phone/TUI acceptance remains unverified.

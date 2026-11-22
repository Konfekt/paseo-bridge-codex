import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderConfigChanges,
  ProviderEvent,
  ProviderInput,
  ProviderPermissionRequest,
  ProviderPersistence,
  ProviderPrompt,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import {
  type BridgeCommandName,
  collaborationModeSettings,
  formatBackgroundTerminals,
  formatGoal,
  formatHooks,
  formatMcpServers,
  formatPermissionProfiles,
  formatPlugins,
  formatRateLimits,
  formatSkills,
  formatStatus,
  INIT_PROMPT,
  parseGoalArgs,
  parseReviewTarget,
  parseToggle,
  parseTokenUsage,
  permissionProfiles,
  pickPermissionProfile,
  routeCommand,
  routeText,
  type SlashRoute,
  sideQuestionPrompt,
  type TokenUsage,
} from "./commands.js";
import { errorMessage } from "./errors.js";
import { permissionId, permissionResult, projectPermission } from "./permissions.js";
import {
  type NativeTurn,
  readHistory,
  readTurns,
  threadSchema,
  threadStatusSchema,
  turnSchema,
} from "./protocol.js";
import {
  type AsyncQuestion,
  AsyncQuestionProjection,
  asyncQuestionReply,
  asyncQuestionSchema,
  hiddenQuestionLabel,
  type QuestionVisibility,
} from "./questions.js";
import type { RpcClient, RpcMessage } from "./rpc.js";
import { projectItem } from "./timeline.js";

const SNAPSHOT_DELAY_MS = 75;
const MAX_PENDING_PERMISSIONS = 128;
const MAX_DIRTY_TURNS = 128;
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_SNAPSHOT_BYTES = 8 * 1024 * 1024;
type Snapshot = { item: ProviderTimelineItem; timestamp?: string };
type CommandAnswer = { text: string } | { error: string };
type SideQuestion = { turnId: string; canceled: boolean };
/** Commands that start a native Codex turn, so they wait for an active turn to end. */
const TURN_COMMANDS: ReadonlySet<BridgeCommandName> = new Set(["compact", "review", "init"]);
type PendingPermission = {
  id: string | number;
  method: string;
  params: unknown;
  request: ProviderPermissionRequest;
};

/** One attachment. Native snapshots, not buffered deltas, determine displayed text. */
export class AttachedThread {
  private readonly fingerprints = new Map<string, string>();
  private fingerprintBytes = 0;
  private readonly pendingSnapshots = new Map<string, Snapshot>();
  private pendingSnapshotBytes = 0;
  readonly permissions = new Map<string, PendingPermission>();
  private questions = new Map<string, AsyncQuestion>();
  private hiddenQuestionKeys: ReadonlySet<string> | undefined;
  private questionRevision = 0;
  activated = false;
  activeTurn: NativeTurn | undefined;
  private rpc: RpcClient | undefined;
  private readonly dirtyTurns = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  private closed = false;
  private hydrating = false;
  private mutationPending = false;
  private pendingStartEvents: NativeTurn[] | undefined;
  private turnRevision = 0;
  private turnStateDirty = false;
  // The host's last published active turn survives unsuccessful rehydration.
  private publishedTurnId: string | undefined;
  // Native model settings, published to Paseo as the session configuration.
  private model: string | null = null;
  private effort: string | null = null;
  private cwd = "";
  private name: string | null = null;
  private tokenUsage: TokenUsage | undefined;
  // Side questions answered in a bridge-made turn, which a Paseo stop cancels.
  private readonly sideQuestions = new Set<SideQuestion>();

  constructor(
    readonly sessionId: string,
    readonly agentId: string,
    readonly threadId: string,
    readonly persistence: ProviderPersistence,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly readHostTurn: (agentId: string) => Promise<string | null>,
    private readonly questionVisibility: QuestionVisibility,
  ) {}

  /** Whether this attachment currently holds a live native connection. */
  get connected(): boolean {
    return this.rpc !== undefined && !this.closed;
  }

  async hydrate(rpc: RpcClient): Promise<void> {
    this.hydrating = true;
    try {
      await this.readNativeSnapshot(rpc, true);
    } finally {
      this.hydrating = false;
    }
  }

  private async readNativeSnapshot(rpc: RpcClient, publishHistory: boolean): Promise<void> {
    this.rpc = rpc;
    this.activeTurn = undefined;
    this.permissions.clear();
    this.questions.clear();
    const response = z
      .object({
        thread: threadSchema,
        // The thread's effective settings; the thread record keeps what it was created with.
        model: z.string().nullish(),
        reasoningEffort: z.string().nullish(),
      })
      .parse(await rpc.request("thread/resume", { threadId: this.threadId, excludeTurns: true }));
    if (response.thread.id !== this.threadId) throw new Error("Codex resumed a different thread");
    if (response.thread.canAcceptDirectInput !== true)
      throw new Error("Codex thread does not accept direct input");
    const questions = new AsyncQuestionProjection();
    for await (const entry of readHistory(rpc, { threadId: this.threadId }, () =>
      this.isCurrent(rpc),
    )) {
      questions.add(entry.item);
      this.publishChangedSnapshot(entry.item, entry.startedAtMs, publishHistory);
    }
    const revision = this.turnRevision;
    const latest = await this.readLatestTurn(rpc);
    if (this.turnRevision === revision)
      this.activeTurn = latest?.status === "inProgress" ? latest : undefined;
    this.synchronizeQuestions(questions.pending());
    await this.refresh();
    this.cwd = response.thread.cwd;
    this.name = response.thread.name;
    this.model = response.model || response.thread.model;
    this.effort =
      response.reasoningEffort === undefined
        ? response.thread.reasoningEffort
        : response.reasoningEffort;
    this.emitConfig();
  }

  private emitConfig(): void {
    this.emit({
      type: "session.config",
      sessionId: this.sessionId,
      config: {
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { thinkingOption: this.effort } : {}),
        models: [],
        modes: [],
        thinkingOptions: [],
        settings: [],
      },
    });
  }

  /** Apply a model or reasoning-effort choice to the native thread, as Codex's own picker does. */
  async configure(changes: ProviderConfigChanges): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.hydrating || this.closed)
      throw new Error(
        "Codex attachment is disconnected or synchronizing; settings were not changed",
      );
    const options = { ...changes.settings, ...changes.providerOptions };
    if (changes.mode != null || Object.keys(options).length)
      throw new Error("Codex Terminal changes only the model and reasoning effort");
    if (changes.model === null || changes.thinkingOption === null)
      throw new Error("Codex Terminal cannot reset a native setting; choose a value instead");
    const update = {
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.thinkingOption !== undefined ? { effort: changes.thinkingOption } : {}),
    };
    if (!Object.keys(update).length) return;
    await rpc.request("thread/settings/update", { threadId: this.threadId, ...update });
    if (update.model !== undefined) this.model = update.model;
    if (update.effort !== undefined) this.effort = update.effort;
    this.emitConfig();
  }

  async activate(): Promise<boolean> {
    if (this.closed || !this.rpc)
      throw new Error("Codex attachment is disconnected; retry after reconnection");
    if (this.hydrating) throw new Error("Codex attachment is synchronizing; retry after recovery");
    if (!this.activated) {
      const rpc = this.rpc;
      const hidden = await this.questionVisibility.read(this.agentId);
      if (this.closed || this.rpc !== rpc || this.hydrating)
        throw new Error("Codex attachment changed during activation; retry after recovery");
      if (!this.activated) {
        // A Hide save can finish while reconnect is reading older preferences.
        this.hiddenQuestionKeys = new Set([...(this.hiddenQuestionKeys ?? []), ...hidden]);
        this.synchronizeQuestions(this.questions);
      }
    }
    if (this.activated) {
      this.turnStateDirty = true;
      await this.refresh();
      return false;
    }
    await this.refresh();
    if (this.activated) return false;
    this.activated = true;
    if (this.activeTurn) this.emitTurn(this.activeTurn);
    for (const snapshot of this.pendingSnapshots.values())
      this.emit({ type: "timeline.item", sessionId: this.sessionId, ...snapshot });
    this.pendingSnapshots.clear();
    this.pendingSnapshotBytes = 0;
    for (const pending of this.permissions.values()) this.emitPermission(pending.request);
    for (const pending of this.questions.values()) this.emitPermission(pending.request);
    return true;
  }

  accept(message: RpcMessage): void {
    if (this.closed) return;
    // Messages without object params (or for other threads) are not addressed to this attachment.
    const parsed = z.record(z.string(), z.unknown()).safeParse(message.params);
    if (!parsed.success || parsed.data["threadId"] !== this.threadId) return;
    const params = parsed.data;
    if (message.id !== undefined) {
      const request = projectPermission(message.id, message.method, message.params);
      if (!request) {
        this.notice(
          "terminal-request",
          "warning",
          `Complete ${message.method} in the Codex terminal; this request is not remotely representable.`,
        );
        return;
      }
      if (this.permissions.size >= MAX_PENDING_PERMISSIONS && !this.permissions.has(request.id))
        throw new Error("Codex pending permission limit exceeded");
      this.permissions.set(request.id, {
        id: message.id,
        method: message.method,
        params: message.params,
        request,
      });
      if (this.activated && !this.hydrating) this.emitPermission(request);
      return;
    }
    if (message.method === "thread/settings/updated") {
      // Also reports choices made in the Codex terminal. An unexpected shape only skips the sync.
      const parsed = z
        .object({
          threadSettings: z.object({ model: z.string().nullish(), effort: z.string().nullish() }),
        })
        .safeParse(params);
      if (!parsed.success) return;
      const { model, effort } = parsed.data.threadSettings;
      const nextModel = model ?? this.model;
      const nextEffort = effort === undefined ? this.effort : effort;
      if (nextModel !== this.model || nextEffort !== this.effort) {
        this.model = nextModel;
        this.effort = nextEffort;
        if (!this.hydrating) this.emitConfig();
      }
    } else if (message.method === "thread/tokenUsage/updated") {
      this.tokenUsage = parseTokenUsage(params["tokenUsage"]) ?? this.tokenUsage;
    } else if (message.method === "thread/name/updated") {
      const name = z.string().nullish().safeParse(params["threadName"]);
      if (name.success) this.name = name.data ?? null;
    } else if (message.method === "serverRequest/resolved") {
      const id = permissionId(z.union([z.string(), z.number()]).parse(params["requestId"]));
      if (this.permissions.delete(id) && this.activated) this.emitResolved(id);
    } else if (message.method === "turn/started" || message.method === "turn/completed") {
      const turn = turnSchema.parse(params["turn"]);
      this.turnRevision++;
      if (turn.status === "inProgress") this.activeTurn = turn;
      else if (this.activeTurn?.id === turn.id) this.activeTurn = undefined;
      if (this.activated && !this.hydrating) this.emitTurn(turn);
      this.markDirty(turn.id);
    } else if (message.method === "thread/status/changed" || message.method === "thread/closed") {
      if (message.method === "thread/status/changed") threadStatusSchema.parse(params["status"]);
      this.turnRevision++;
      this.turnStateDirty = true;
      this.scheduleRefresh();
    } else if (message.method.startsWith("item/")) {
      this.markDirty(z.string().parse(params["turnId"]));
    }
  }

  async send(
    input: Extract<
      ProviderInput,
      { type: "session.prompt" | "session.interrupt" | "session.permission" }
    >,
  ): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.hydrating || this.closed)
      throw new Error("Codex attachment is disconnected or synchronizing; operation was not sent");
    if (this.mutationPending) throw new Error("Another operation is pending on this attachment");
    this.mutationPending = true;
    this.turnRevision++;
    try {
      let prompt = input.type === "session.prompt" ? input.prompt : undefined;
      if (input.type === "session.permission") {
        const pending = this.permissions.get(input.permissionId);
        if (pending) {
          const result = permissionResult(pending.method, pending.params, input.response);
          await rpc.respond(pending.id, result);
          // Only serverRequest/resolved closes the request: another client may win the race.
        } else if (this.questions.has(input.permissionId)) {
          if (input.response.behavior === "deny") {
            await this.questionVisibility.hide(this.agentId, input.permissionId);
            this.hiddenQuestionKeys = new Set([
              ...(this.hiddenQuestionKeys ?? []),
              hiddenQuestionLabel(input.permissionId),
            ]);
            this.synchronizeQuestions(this.questions);
            return;
          }
          // Re-read native state before admitting an answer that another client may have sent.
          await this.reconcileTurn(rpc, this.publishedTurnId);
          const turnId = this.activeTurn?.id;
          const questionRevision = this.questionRevision;
          const questions = await this.readQuestions(rpc);
          if (this.activeTurn?.id !== turnId)
            throw new Error("The native turn changed; the question answer was not sent");
          if (this.questionRevision !== questionRevision)
            throw new Error(
              "Codex questions changed during admission; retry with the current question",
            );
          this.synchronizeQuestions(questions);
          const question = this.questions.get(input.permissionId);
          if (!question) throw new Error("Question already answered in Codex");
          const text = asyncQuestionReply(question, input.response);
          prompt = {
            clientMessageId: randomUUID(),
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text }] },
          };
        } else {
          throw new Error("Permission already resolved or belongs to another attachment");
        }
      } else if (input.type === "session.interrupt") {
        this.cancelSideQuestions();
        if (this.activeTurn)
          await rpc.request("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.activeTurn.id,
          });
      }
      const route =
        input.type === "session.prompt" && prompt ? commandRoute(prompt.input) : undefined;
      if (prompt && route) {
        await this.runCommand(rpc, prompt, route);
      } else if (prompt) {
        if (prompt.input.type !== "message")
          throw new Error("Codex Terminal accepts text prompts only");
        const content = prompt.input.content.map((part) => {
          if (part.type !== "text") throw new Error("Codex Terminal accepts text prompts only");
          return { type: "text", text: part.text, text_elements: [] as never[] };
        });
        const active = this.activeTurn;
        if (prompt.delivery === "steer" && !active)
          throw new Error("There is no active native turn to steer");
        let sentTurnId: string;
        if (active) {
          const expectedTurnId = await this.steer(rpc, content, prompt.clientMessageId, active.id);
          sentTurnId = expectedTurnId;
          if (input.type === "session.prompt")
            this.emit({
              type: "session.prompt_result",
              sessionId: this.sessionId,
              clientMessageId: prompt.clientMessageId,
              result: { type: "steer", turnId: expectedTurnId },
            });
        } else {
          const turnId = await this.startNativeTurn(
            rpc,
            input.type === "session.prompt" ? prompt.clientMessageId : undefined,
            "turn/start",
            {
              threadId: this.threadId,
              input: content,
              clientUserMessageId: prompt.clientMessageId,
            },
          );
          if (!turnId) throw new Error("Codex started no turn");
          sentTurnId = turnId;
        }
        if (input.type === "session.permission") {
          // Resolve only after the native reply appears in the authoritative snapshot.
          this.markDirty(sentTurnId);
          // An older scan may have captured the turn before this reply was sent.
          if (this.refreshing) await this.refreshing;
          await this.refresh();
        }
      }
    } finally {
      const events = this.pendingStartEvents;
      this.pendingStartEvents = undefined;
      if (events) for (const event of events) this.emitTurn(event);
      this.mutationPending = false;
      this.turnRevision++;
      if (this.turnStateDirty) this.scheduleRefresh();
    }
  }

  /**
   * Start a native turn and acknowledge it before publishing its events, even when Codex
   * finishes it before answering. Returns the started turn, if Codex reported one.
   */
  private async startNativeTurn(
    rpc: RpcClient,
    clientMessageId: string | undefined,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string | undefined> {
    this.pendingStartEvents = [];
    const response = z
      .object({ turn: turnSchema.optional() })
      .parse(await rpc.request(method, params));
    const events = this.pendingStartEvents;
    this.pendingStartEvents = undefined;
    // `thread/compact/start` answers without a turn; its turn arrives as a notification.
    const turn =
      response.turn ?? events.find((event) => event.status === "inProgress") ?? events[0];
    if (clientMessageId !== undefined)
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId,
        result: turn ? { type: "turn", turnId: turn.id } : { type: "completed" },
      });
    if (events.length) {
      for (const event of events) this.emitTurn(event);
    } else if (response.turn) {
      this.activeTurn = response.turn.status === "inProgress" ? response.turn : undefined;
      if (this.activated) this.emitTurn(response.turn);
    }
    return turn?.id;
  }

  /** Run a Codex slash command for Paseo; failures and rejections never reach the model. */
  private async runCommand(
    rpc: RpcClient,
    prompt: ProviderPrompt,
    route: SlashRoute,
  ): Promise<void> {
    const active = this.activeTurn;
    if (route.kind === "reject") return this.answerOrFail(prompt, active, { error: route.message });
    const { name, args } = route;
    if (name === "btw" || name === "side") return this.askSideQuestion(rpc, prompt, args, active);
    const startsTurn =
      TURN_COMMANDS.has(name) || (name === "plan" && args !== "" && args !== "off");
    if (startsTurn && active)
      return this.answerOrFail(prompt, active, {
        error: `Wait for the current Codex turn to finish, or stop it, before /${name}.`,
      });
    let answer: CommandAnswer | undefined;
    try {
      answer = await this.executeCommand(rpc, prompt, name, args);
    } catch (error) {
      answer = { error: errorMessage(error) };
    }
    if (answer) this.answerOrFail(prompt, active, answer);
  }

  /** Returns the answer to show, or nothing when the command started a native turn. */
  private async executeCommand(
    rpc: RpcClient,
    prompt: ProviderPrompt,
    name: Exclude<BridgeCommandName, "btw" | "side">,
    args: string,
  ): Promise<CommandAnswer | undefined> {
    const threadId = this.threadId;
    const text = (value: string): CommandAnswer => ({ text: value });
    const startTurn = async (method: string, params: Record<string, unknown>) => {
      await this.startNativeTurn(rpc, prompt.clientMessageId, method, { threadId, ...params });
      return undefined;
    };
    const turnInput = (value: string) => ({
      input: [{ type: "text", text: value, text_elements: [] }],
      clientUserMessageId: prompt.clientMessageId,
    });
    switch (name) {
      case "compact":
        return startTurn("thread/compact/start", {});
      case "review":
        return startTurn("review/start", { target: parseReviewTarget(args), delivery: "inline" });
      case "init": {
        const exists = await access(join(this.cwd, "AGENTS.md")).then(
          () => true,
          () => false,
        );
        if (exists) return text(`AGENTS.md already exists in ${this.cwd}; /init leaves it as is.`);
        return startTurn("turn/start", turnInput(INIT_PROMPT));
      }
      case "plan": {
        const mode = args === "off" ? "default" : "plan";
        const collaborationMode = collaborationModeSettings(
          await rpc.request("collaborationMode/list", {}),
          mode,
          { model: this.model, effort: this.effort },
        );
        await rpc.request("thread/settings/update", { threadId, collaborationMode });
        if (mode === "default") return text("Left Plan mode.");
        if (!args) return text("Plan mode is on. Leave it with /plan off.");
        return startTurn("turn/start", turnInput(args));
      }
      case "rename": {
        if (!args) return { error: "Name the thread: /rename <name>." };
        await rpc.request("thread/name/set", { threadId, name: args });
        this.name = args;
        return text(`Renamed the thread to "${args}".`);
      }
      case "goal": {
        const action = parseGoalArgs(args);
        if (action.type === "show")
          return text(
            formatGoal(
              z
                .object({ goal: z.unknown() })
                .parse(await rpc.request("thread/goal/get", { threadId })).goal,
            ),
          );
        if (action.type === "clear") {
          await rpc.request("thread/goal/clear", { threadId, origin: "user" });
          return text("Cleared the goal.");
        }
        const change =
          action.type === "status"
            ? { status: action.status }
            : { objective: action.objective, status: "active" };
        const { goal } = z
          .object({ goal: z.unknown() })
          .parse(await rpc.request("thread/goal/set", { threadId, origin: "user", ...change }));
        return text(formatGoal(goal));
      }
      case "status": {
        const { goal } = z
          .object({ goal: z.unknown() })
          .parse(await rpc.request("thread/goal/get", { threadId }));
        return text(
          formatStatus({
            threadId,
            name: this.name,
            cwd: this.cwd,
            model: this.model,
            effort: this.effort,
            goal,
            tokenUsage: this.tokenUsage,
          }),
        );
      }
      case "usage":
        return text(formatRateLimits(await rpc.request("account/rateLimits/read", null)));
      case "permissions": {
        const profiles = permissionProfiles(
          await rpc.request("permissionProfile/list", { cwd: this.cwd }),
        );
        if (!args) return text(formatPermissionProfiles(profiles));
        const profile = pickPermissionProfile(profiles, args);
        if (!profile)
          return {
            error: `Codex has no permission profile "${args}".\n${formatPermissionProfiles(profiles)}`,
          };
        await rpc.request("thread/settings/update", { threadId, permissions: profile });
        return text(`Permission profile for the next turns: ${profile}.`);
      }
      case "memories": {
        const enabled = parseToggle(args);
        if (enabled === undefined) return { error: "Choose /memories on or /memories off." };
        await rpc.request("thread/memoryMode/set", {
          threadId,
          mode: enabled ? "enabled" : "disabled",
        });
        return text(`Memories are ${enabled ? "on" : "off"} for this thread.`);
      }
      case "mcp":
        return text(formatMcpServers(await rpc.request("mcpServerStatus/list", { threadId })));
      case "skills":
        return text(formatSkills(await rpc.request("skills/list", { cwds: [this.cwd] })));
      case "hooks":
        return text(formatHooks(await rpc.request("hooks/list", { threadId })));
      case "plugins":
        return text(formatPlugins(await rpc.request("plugin/list", { cwds: [this.cwd] })));
      case "ps":
        return text(
          formatBackgroundTerminals(
            await rpc.request("thread/backgroundTerminals/list", { threadId }),
          ),
        );
      case "stop":
        await rpc.request("thread/backgroundTerminals/clean", { threadId });
        return text("Stopped all background terminals.");
    }
  }

  /**
   * Answer a side question from the thread's context with `thread/sample`, which adds
   * nothing to the thread. The prompt is acknowledged at once; the answer follows.
   */
  private async askSideQuestion(
    rpc: RpcClient,
    prompt: ProviderPrompt,
    question: string,
    active: NativeTurn | undefined,
  ): Promise<void> {
    if (!question)
      return this.answerOrFail(prompt, active, {
        error: "Ask a question after /btw, for example: /btw what does this function return?",
      });
    const latest = active ?? (await this.readLatestTurn(rpc));
    if (!latest)
      return this.answerOrFail(prompt, active, {
        error: "Side questions need an earlier turn; send a normal message first.",
      });
    const request = rpc.request("thread/sample", {
      threadId: this.threadId,
      expectedTurnId: latest.id,
      prompt: sideQuestionPrompt(question),
      ...(latest.status === "inProgress" ? { allowInProgressTurn: true } : {}),
    });
    const turnId = active?.id ?? this.commandTurnId(prompt);
    const side: SideQuestion = { turnId, canceled: false };
    if (active) {
      this.acknowledgeSteer(prompt, active.id);
    } else {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId },
      });
      this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });
      this.sideQuestions.add(side);
    }
    void request
      .then((response) => {
        const { text } = z.object({ text: z.string().nullish() }).parse(response);
        return text
          ? { text }
          : {
              error:
                "Codex tried to use a tool instead of answering. Side questions answer from the conversation; ask in a normal message to let Codex use tools.",
            };
      })
      .catch((error: unknown) => {
        // Codex before 0.171 samples only a thread whose latest turn has finished.
        const hint =
          latest.status === "inProgress"
            ? " Codex releases before 0.171 answer side questions only between turns."
            : "";
        return { error: `Side question failed: ${errorMessage(error)}.${hint}` };
      })
      .then((answer: CommandAnswer) => {
        if (side.canceled || this.closed) return;
        this.sideQuestions.delete(side);
        this.emitAnswer(prompt, answer);
        if (!active)
          this.emit({
            type: "session.turn",
            sessionId: this.sessionId,
            turnId,
            state: "completed",
          });
      });
  }

  private cancelSideQuestions(): void {
    for (const side of this.sideQuestions) {
      side.canceled = true;
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId: side.turnId,
        state: "canceled",
      });
    }
    this.sideQuestions.clear();
  }

  private commandTurnId(prompt: ProviderPrompt): string {
    return `paseo-command-${prompt.clientMessageId}`;
  }

  private acknowledgeSteer(prompt: ProviderPrompt, turnId: string): void {
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "steer", turnId },
    });
  }

  private emitAnswer(prompt: ProviderPrompt, answer: CommandAnswer): void {
    const id = `paseo-command-answer-${prompt.clientMessageId}`;
    this.emit({
      type: "timeline.item",
      sessionId: this.sessionId,
      item:
        "text" in answer
          ? { id, type: "assistant_message", text: answer.text }
          : { id, type: "error", message: answer.error },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Show a command's answer. During a native turn it joins that turn as accepted steering,
   * because a failed steer would make Paseo interrupt the turn to resend the command. When
   * idle, an answer is a turn of its own and a failure fails the prompt.
   */
  private answerOrFail(
    prompt: ProviderPrompt,
    active: NativeTurn | undefined,
    answer: CommandAnswer,
  ): void {
    if (active) {
      this.acknowledgeSteer(prompt, active.id);
      this.emitAnswer(prompt, answer);
      return;
    }
    if ("error" in answer) throw new Error(answer.error);
    const turnId = this.commandTurnId(prompt);
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });
    this.emitAnswer(prompt, answer);
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "completed" });
  }

  disconnect(error: Error): void {
    this.rpc = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.notice(
      "connection",
      "warning",
      `Codex disconnected: ${error.message}. Native execution state is unknown until reconnection. Pending operations are not retried.`,
    );
  }

  async reattach(rpc: RpcClient): Promise<void> {
    const wasActive = this.activated;
    const oldTurnId = this.publishedTurnId;
    const oldPermissions = [...this.permissions.keys(), ...this.questions.keys()];
    this.activated = false;
    this.hydrating = true;
    try {
      await this.readNativeSnapshot(rpc, wasActive);
      for (const id of oldPermissions)
        if (!this.permissions.has(id) && !this.questions.has(id)) this.emitResolved(id);
      const completed = await this.reconcileTurn(rpc, oldTurnId);
      if (wasActive && completed) this.emitTurn(completed);
      this.hydrating = false;
      if (wasActive) await this.activate();
      this.notice("connection", "info", "Codex connection restored.");
    } catch (error) {
      this.activated = wasActive;
      throw error;
    } finally {
      this.hydrating = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const side of this.sideQuestions) side.canceled = true;
    this.sideQuestions.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    this.permissions.clear();
    this.questions.clear();
    this.fingerprints.clear();
    this.fingerprintBytes = 0;
    this.pendingSnapshots.clear();
    this.pendingSnapshotBytes = 0;
    // Unsubscribing is best-effort: the local attachment is released even if Codex is unreachable.
    if (rpc)
      await rpc.request("thread/unsubscribe", { threadId: this.threadId }).catch((error) => {
        console.warn(`Codex thread ${this.threadId} unsubscribe failed:`, errorMessage(error));
      });
  }

  private emitTurn(turn: NativeTurn): void {
    if (this.pendingStartEvents) {
      if (this.pendingStartEvents.length >= MAX_DIRTY_TURNS)
        throw new Error("Codex pending turn event limit exceeded");
      this.pendingStartEvents.push(turn);
      return;
    }
    const state =
      turn.status === "inProgress"
        ? "started"
        : turn.status === "interrupted"
          ? "canceled"
          : turn.status;
    if (state === "started") this.publishedTurnId = turn.id;
    else if (this.publishedTurnId === turn.id) this.publishedTurnId = undefined;
    this.emit({
      type: "session.turn",
      sessionId: this.sessionId,
      turnId: turn.id,
      state,
      ...(turn.error ? { error: { message: turn.error.message } } : {}),
    });
  }

  private emitPermission(request: ProviderPermissionRequest): void {
    this.emit({ type: "session.permission", sessionId: this.sessionId, request });
  }

  private emitResolved(permissionId: string): void {
    this.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  private notice(id: string, severity: "warning" | "info", description: string): void {
    this.emit({
      type: "session.notice",
      sessionId: this.sessionId,
      notice: { id, severity, title: "Codex Terminal", description },
    });
  }

  private markDirty(turnId: string): void {
    if (this.dirtyTurns.size >= MAX_DIRTY_TURNS && !this.dirtyTurns.has(turnId))
      throw new Error("Codex pending snapshot limit exceeded");
    this.dirtyTurns.add(turnId);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.hydrating || this.timer || this.refreshing || !this.rpc) return;
    if (this.mutationPending && this.dirtyTurns.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch((error) => {
        console.error("Codex attachment synchronization failed:", error);
      });
    }, SNAPSHOT_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      return;
    }
    const rpc = this.rpc;
    if (!rpc || this.closed) return;
    const turns = [...this.dirtyTurns];
    this.dirtyTurns.clear();
    const reconcile = this.turnStateDirty && !this.mutationPending;
    if (reconcile) this.turnStateDirty = false;
    const work = (async () => {
      if (reconcile)
        await this.reconcileTurn(rpc, this.activated ? this.publishedTurnId : this.activeTurn?.id);
      try {
        let questionsChanged = false;
        for (const turnId of turns) {
          for await (const entry of readHistory(rpc, { threadId: this.threadId, turnId }, () =>
            this.isCurrent(rpc),
          )) {
            const snapshot = this.publishChangedSnapshot(
              entry.item,
              entry.startedAtMs,
              this.activated,
            );
            if (
              snapshot &&
              (snapshot.item.type === "user_message" ||
                asyncQuestionSchema.safeParse(entry.item).success)
            )
              questionsChanged = true;
          }
        }
        if (questionsChanged) {
          const questionRevision = this.questionRevision;
          const questions = await this.readQuestions(rpc);
          if (!this.isCurrent(rpc)) return;
          if (this.questionRevision === questionRevision) this.synchronizeQuestions(questions);
        }
      } catch (error) {
        // Snapshot failure requires rehydration. A per-thread state-read error
        // above must not disconnect other attachments on the shared proxy.
        try {
          await rpc.close();
        } catch (closeError) {
          this.notice("snapshot", "warning", `Could not close failed proxy: ${String(closeError)}`);
        }
        throw error;
      }
    })();
    this.refreshing = work;
    try {
      await work;
    } catch (error) {
      this.notice("snapshot", "warning", `Codex synchronization failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      this.refreshing = undefined;
      if ((this.dirtyTurns.size || this.turnStateDirty) && !this.closed) this.scheduleRefresh();
    }
  }

  private async reconcileTurn(
    rpc: RpcClient,
    previousTurnId: string | undefined,
  ): Promise<NativeTurn | undefined> {
    const revision = this.turnRevision;
    const { thread } = z
      .object({ thread: threadSchema })
      .parse(await rpc.request("thread/read", { threadId: this.threadId, includeTurns: false }));
    if (thread.id !== this.threadId) throw new Error("Codex read a different thread");
    const latest = await this.readLatestTurn(rpc);
    let previous = latest?.id === previousTurnId ? latest : undefined;
    if (previousTurnId && !previous) {
      for await (const turn of readTurns(rpc, this.threadId, () => this.isCurrent(rpc))) {
        if (turn.id !== previousTurnId) continue;
        previous = turn;
        break;
      }
    }
    if (!this.isCurrent(rpc)) return;
    const completed = previous?.status === "inProgress" ? undefined : previous;
    // A later notification invalidates the current-state read, not an older turn's
    // terminal history needed to settle the pre-disconnect Paseo turn.
    if (this.turnRevision !== revision) return completed;
    if (previousTurnId && !previous)
      throw new Error(`Codex turn ${previousTurnId} is missing; its outcome is unknown`);
    if (previous?.status === "inProgress" && previous.id !== latest?.id)
      throw new Error("Codex still reports an older turn in progress; its outcome is unknown");
    if (latest?.status === "inProgress" && thread.status.type !== "active")
      throw new Error("Codex thread and turn states disagree; native execution state is unknown");
    const active = latest?.status === "inProgress" ? latest : undefined;
    this.activeTurn = active;
    if (this.activated) {
      if (completed) {
        this.emitTurn(completed);
        this.markDirty(completed.id);
      }
      if (active && active.id !== previousTurnId) this.emitTurn(active);
    }
    return completed;
  }

  private isCurrent(rpc: RpcClient): boolean {
    return this.rpc === rpc && !this.closed;
  }

  private async readLatestTurn(rpc: RpcClient): Promise<NativeTurn | undefined> {
    const { data } = z.object({ data: z.array(turnSchema) }).parse(
      await rpc.request("thread/turns/list", {
        threadId: this.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }),
    );
    return data[0];
  }

  private async readQuestions(rpc: RpcClient): Promise<Map<string, AsyncQuestion>> {
    const questions = new AsyncQuestionProjection();
    for await (const entry of readHistory(rpc, { threadId: this.threadId }, () =>
      this.isCurrent(rpc),
    ))
      questions.add(entry.item);
    return questions.pending();
  }

  private synchronizeQuestions(pending: Map<string, AsyncQuestion>): void {
    pending = new Map(
      [...pending].filter(([id]) => !this.hiddenQuestionKeys?.has(hiddenQuestionLabel(id))),
    );
    // Hydration precedes the manager registration needed to read saved preferences.
    if (this.hiddenQuestionKeys && pending.size + this.permissions.size > MAX_PENDING_PERMISSIONS)
      throw new Error("Codex pending permission limit exceeded");
    // Even an unchanged result supersedes older in-flight history reads.
    this.questionRevision++;
    if (this.activated && !this.hydrating) {
      for (const id of this.questions.keys()) if (!pending.has(id)) this.emitResolved(id);
      for (const [id, question] of pending)
        if (JSON.stringify(question) !== JSON.stringify(this.questions.get(id)))
          this.emitPermission(question.request);
    }
    this.questions = pending;
  }

  private async steer(
    rpc: RpcClient,
    input: Array<{ type: string; text: string; text_elements: never[] }>,
    clientUserMessageId: string,
    nativeTurnId: string,
  ): Promise<string> {
    // Paseo holds its admission turn while native events may already reach this process.
    const expectedTurnId = await this.readHostTurn(this.agentId);
    if (expectedTurnId !== nativeTurnId || this.activeTurn?.id !== nativeTurnId)
      throw new Error("Paseo and Codex active turns differ; steering was not sent");
    if (this.rpc !== rpc || this.hydrating || this.closed)
      throw new Error("Codex attachment changed during admission; steering was not sent");
    const result = z.object({ turnId: z.string() }).parse(
      await rpc.request("turn/steer", {
        threadId: this.threadId,
        input,
        clientUserMessageId,
        expectedTurnId,
      }),
    );
    if (result.turnId !== expectedTurnId)
      throw new Error("Codex returned a different steering turn; outcome requires reconciliation");
    return expectedTurnId;
  }

  private publishChangedSnapshot(
    item: unknown,
    startedAtMs: number | null,
    publishImmediately: boolean,
  ): Snapshot | undefined {
    const projected = projectItem(item);
    const snapshot: Snapshot = {
      item: projected,
      ...(startedAtMs === null ? {} : { timestamp: new Date(startedAtMs).toISOString() }),
    };
    const encoded = JSON.stringify(snapshot);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    const previous = this.fingerprints.get(projected.id);
    if (fingerprint === previous) return undefined;
    const fingerprintBytes =
      this.fingerprintBytes +
      (previous === undefined ? Buffer.byteLength(projected.id) + fingerprint.length : 0);
    if (fingerprintBytes > MAX_FINGERPRINT_BYTES)
      throw new Error("Codex snapshot fingerprint metadata exceeded 64 MiB");
    if (publishImmediately) {
      this.emit({ type: "timeline.item", sessionId: this.sessionId, ...snapshot });
    } else {
      // Only the manager-registration gap needs payload retention, not session history.
      const queued = this.pendingSnapshots.get(projected.id);
      const size =
        this.pendingSnapshotBytes -
        (queued ? Buffer.byteLength(JSON.stringify(queued)) : 0) +
        Buffer.byteLength(encoded);
      if (size > MAX_PENDING_SNAPSHOT_BYTES)
        throw new Error("Codex activation update buffer exceeded 8 MiB; attachment stopped");
      this.pendingSnapshots.set(projected.id, snapshot);
      this.pendingSnapshotBytes = size;
    }
    // A failed publication must remain eligible for authoritative recovery.
    this.fingerprints.set(projected.id, fingerprint);
    this.fingerprintBytes = fingerprintBytes;
    return snapshot;
  }
}

/** The bridge command or terminal-only rejection a prompt names, if any. */
function commandRoute(input: ProviderPrompt["input"]): SlashRoute | undefined {
  if (input.type === "command")
    return (
      routeCommand(input.name.toLowerCase(), input.arguments.trim()) ?? {
        kind: "reject",
        message: `/${input.name} is not a command Codex Terminal can run.`,
      }
    );
  // Paseo sends a slash command typed during a turn as steering text.
  const [part, ...rest] = input.content;
  return part?.type === "text" && !rest.length ? routeText(part.text) : undefined;
}

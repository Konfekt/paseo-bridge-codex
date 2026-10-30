import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderInput,
  ProviderPermissionRequest,
  ProviderPersistence,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
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
} from "./questions.js";
import type { RpcClient, RpcMessage } from "./rpc.js";
import { projectItem } from "./timeline.js";

const SNAPSHOT_DELAY_MS = 75;
const MAX_PENDING_PERMISSIONS = 128;
const MAX_DIRTY_TURNS = 128;
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_SNAPSHOT_BYTES = 8 * 1024 * 1024;
type Snapshot = { item: ProviderTimelineItem; timestamp?: string };
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

  constructor(
    readonly sessionId: string,
    readonly agentId: string,
    readonly threadId: string,
    readonly persistence: ProviderPersistence,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly readHostTurn: (agentId: string) => Promise<string | null>,
  ) {}

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
      .object({ thread: threadSchema })
      .parse(await rpc.request("thread/resume", { threadId: this.threadId, excludeTurns: true }));
    if (response.thread.id !== this.threadId) throw new Error("Codex resumed a different thread");
    if (response.thread.canAcceptDirectInput !== true)
      throw new Error("Codex thread does not accept direct input");
    const questions = new AsyncQuestionProjection();
    for await (const entry of readHistory(
      rpc,
      { threadId: this.threadId },
      () => this.rpc === rpc && !this.closed,
    )) {
      questions.add(entry.item);
      this.publishChangedSnapshot(entry.item, entry.startedAtMs, publishHistory);
    }
    const revision = this.turnRevision;
    const turns = z.object({ data: z.array(turnSchema) }).parse(
      await rpc.request("thread/turns/list", {
        threadId: this.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }),
    );
    if (this.turnRevision === revision)
      this.activeTurn = turns.data.find((turn) => turn.status === "inProgress");
    this.synchronizeQuestions(questions.pending());
    await this.refresh();
    this.emit({
      type: "session.config",
      sessionId: this.sessionId,
      config: {
        ...(response.thread.model ? { model: response.thread.model } : {}),
        ...(response.thread.reasoningEffort
          ? { thinkingOption: response.thread.reasoningEffort }
          : {}),
        models: [],
        modes: [],
        thinkingOptions: [],
        settings: [],
      },
    });
  }

  async activate(): Promise<boolean> {
    if (this.closed || !this.rpc)
      throw new Error("Codex attachment is disconnected; retry after reconnection");
    if (this.hydrating) throw new Error("Codex attachment is synchronizing; retry after recovery");
    if (this.activated) {
      this.turnStateDirty = true;
      await this.refresh();
      return false;
    }
    await this.refresh();
    this.activated = true;
    if (this.activeTurn) this.emitTurn(this.activeTurn);
    for (const snapshot of this.pendingSnapshots.values())
      this.emit({ type: "timeline.item", sessionId: this.sessionId, ...snapshot });
    this.pendingSnapshots.clear();
    this.pendingSnapshotBytes = 0;
    for (const pending of this.permissions.values())
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: pending.request,
      });
    for (const pending of this.questions.values())
      this.emit({
        type: "session.permission",
        sessionId: this.sessionId,
        request: pending.request,
      });
    return true;
  }

  accept(message: RpcMessage): void {
    if (this.closed) return;
    const params = z.record(z.string(), z.unknown()).parse(message.params);
    if (params["threadId"] !== this.threadId) return;
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
      if (this.activated && !this.hydrating)
        this.emit({ type: "session.permission", sessionId: this.sessionId, request });
      return;
    }
    if (message.method === "serverRequest/resolved") {
      const id = permissionId(z.union([z.string(), z.number()]).parse(params["requestId"]));
      if (this.permissions.delete(id) && this.activated)
        this.emit({
          type: "session.permission_resolved",
          sessionId: this.sessionId,
          permissionId: id,
        });
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
        if (this.activeTurn)
          await rpc.request("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.activeTurn.id,
          });
      }
      if (prompt) {
        if (
          prompt.input.type !== "message" ||
          prompt.input.content.some((part) => part.type !== "text")
        )
          throw new Error("Codex Terminal accepts text prompts only");
        const content = prompt.input.content.map((part) => {
          if (part.type !== "text") throw new Error("Expected text content");
          return { type: "text", text: part.text, text_elements: [] };
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
          const params = {
            threadId: this.threadId,
            input: content,
            clientUserMessageId: prompt.clientMessageId,
          };
          this.pendingStartEvents = [];
          const result = z
            .object({ turn: turnSchema })
            .parse(await rpc.request("turn/start", params));
          const events = this.pendingStartEvents;
          this.pendingStartEvents = undefined;
          sentTurnId = result.turn.id;
          if (input.type === "session.prompt")
            this.emit({
              type: "session.prompt_result",
              sessionId: this.sessionId,
              clientMessageId: prompt.clientMessageId,
              result: { type: "turn", turnId: result.turn.id },
            });
          // Publish acknowledgement before completion, even for a synchronously finished turn.
          if (events.length) {
            for (const event of events) this.emitTurn(event);
          } else {
            this.activeTurn = result.turn.status === "inProgress" ? result.turn : undefined;
            if (this.activated) this.emitTurn(result.turn);
          }
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
        if (!this.permissions.has(id) && !this.questions.has(id))
          this.emit({
            type: "session.permission_resolved",
            sessionId: this.sessionId,
            permissionId: id,
          });
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc) await rpc.request("thread/unsubscribe", { threadId: this.threadId });
    this.permissions.clear();
    this.questions.clear();
    this.fingerprints.clear();
    this.fingerprintBytes = 0;
    this.pendingSnapshots.clear();
    this.pendingSnapshotBytes = 0;
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
          for await (const entry of readHistory(
            rpc,
            { threadId: this.threadId, turnId },
            () => this.rpc === rpc && !this.closed,
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
          if (this.rpc !== rpc || this.closed) return;
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
      this.notice(
        "snapshot",
        "warning",
        `Codex synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const { data } = z.object({ data: z.array(turnSchema) }).parse(
      await rpc.request("thread/turns/list", {
        threadId: this.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }),
    );
    const latest = data[0];
    let previous = latest?.id === previousTurnId ? latest : undefined;
    if (previousTurnId && !previous) {
      for await (const turn of readTurns(
        rpc,
        this.threadId,
        () => this.rpc === rpc && !this.closed,
      )) {
        if (turn.id !== previousTurnId) continue;
        previous = turn;
        break;
      }
    }
    if (this.rpc !== rpc || this.closed) return;
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

  private async readQuestions(rpc: RpcClient): Promise<Map<string, AsyncQuestion>> {
    const questions = new AsyncQuestionProjection();
    for await (const entry of readHistory(
      rpc,
      { threadId: this.threadId },
      () => this.rpc === rpc && !this.closed,
    ))
      questions.add(entry.item);
    return questions.pending();
  }

  private synchronizeQuestions(pending: Map<string, AsyncQuestion>): void {
    if (pending.size + this.permissions.size > MAX_PENDING_PERMISSIONS)
      throw new Error("Codex pending permission limit exceeded");
    // Even an unchanged result supersedes older in-flight history reads.
    this.questionRevision++;
    if (this.activated && !this.hydrating) {
      for (const id of this.questions.keys())
        if (!pending.has(id))
          this.emit({
            type: "session.permission_resolved",
            sessionId: this.sessionId,
            permissionId: id,
          });
      for (const [id, question] of pending)
        if (JSON.stringify(question) !== JSON.stringify(this.questions.get(id)))
          this.emit({
            type: "session.permission",
            sessionId: this.sessionId,
            request: question.request,
          });
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

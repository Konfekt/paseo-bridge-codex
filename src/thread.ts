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
  itemEntrySchema,
  MAX_ITEMS,
  MAX_SNAPSHOT_BYTES,
  type NativeTurn,
  readPages,
  threadSchema,
  turnSchema,
} from "./protocol.js";
import type { RpcClient, RpcMessage } from "./rpc.js";
import { projectItem } from "./timeline.js";

const SNAPSHOT_DELAY_MS = 75;
const MAX_PENDING_PERMISSIONS = 128;
const MAX_DIRTY_TURNS = 128;
type Snapshot = { item: ProviderTimelineItem; timestamp?: string };
type PendingPermission = {
  id: string | number;
  method: string;
  params: unknown;
  request: ProviderPermissionRequest;
};

/** One attachment. Native snapshots, not buffered deltas, determine displayed text. */
export class AttachedThread {
  readonly snapshots = new Map<string, Snapshot>();
  readonly permissions = new Map<string, PendingPermission>();
  activated = false;
  activeTurn: NativeTurn | undefined;
  private rpc: RpcClient | undefined;
  private readonly dirtyTurns = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  private closed = false;
  private hydrating = false;
  private snapshotBytes = 0;
  private mutationPending = false;
  private pendingStartEvents: NativeTurn[] | undefined;
  private turnRevision = 0;

  constructor(
    readonly sessionId: string,
    readonly agentId: string,
    readonly threadId: string,
    readonly persistence: ProviderPersistence,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly readHostTurn: (agentId: string) => Promise<string | null>,
  ) {}

  async hydrate(rpc: RpcClient): Promise<void> {
    this.rpc = rpc;
    this.hydrating = true;
    this.activeTurn = undefined;
    this.permissions.clear();
    const response = z
      .object({ thread: threadSchema })
      .parse(await rpc.request("thread/resume", { threadId: this.threadId, excludeTurns: true }));
    if (response.thread.id !== this.threadId) throw new Error("Codex resumed a different thread");
    if (response.thread.canAcceptDirectInput !== true)
      throw new Error("Codex thread does not accept direct input");
    const entries = await readPages(
      rpc,
      "thread/items/list",
      { threadId: this.threadId, sortDirection: "asc" },
      itemEntrySchema,
    );
    this.snapshots.clear();
    this.snapshotBytes = 0;
    for (const entry of entries) this.remember(entry.item, entry.startedAtMs);
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
    this.hydrating = false;
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

  replay(): void {
    for (const snapshot of this.snapshots.values())
      this.emit({ type: "timeline.item", sessionId: this.sessionId, ...snapshot });
  }

  async activate(): Promise<boolean> {
    if (this.closed || !this.rpc)
      throw new Error("Codex attachment is disconnected; retry after reconnection");
    if (this.activated) return false;
    await this.refresh();
    this.activated = true;
    if (this.activeTurn) this.emitTurn(this.activeTurn);
    this.replay();
    for (const pending of this.permissions.values())
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
    try {
      if (input.type === "session.permission") {
        const pending = this.permissions.get(input.permissionId);
        if (!pending)
          throw new Error("Permission already resolved or belongs to another attachment");
        const result = permissionResult(pending.method, pending.params, input.response);
        await rpc.respond(pending.id, result);
        // Only serverRequest/resolved closes the request: another client may win the race.
      } else if (input.type === "session.interrupt") {
        if (this.activeTurn)
          await rpc.request("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.activeTurn.id,
          });
      } else {
        if (
          input.prompt.input.type !== "message" ||
          input.prompt.input.content.some((part) => part.type !== "text")
        )
          throw new Error("Codex Terminal accepts text prompts only");
        const content = input.prompt.input.content.map((part) => {
          if (part.type !== "text") throw new Error("Expected text content");
          return { type: "text", text: part.text, text_elements: [] };
        });
        const active = this.activeTurn;
        if (input.prompt.delivery === "steer" && !active)
          throw new Error("There is no active native turn to steer");
        const params = {
          threadId: this.threadId,
          input: content,
          clientUserMessageId: input.prompt.clientMessageId,
        };
        if (active) {
          // Paseo holds its admission turn while native events may already reach this process.
          const expectedTurnId = await this.readHostTurn(this.agentId);
          if (!expectedTurnId || this.activeTurn?.id !== expectedTurnId)
            throw new Error("Paseo and Codex active turns differ; steering was not sent");
          if (this.rpc !== rpc || this.hydrating || this.closed)
            throw new Error("Codex attachment changed during admission; steering was not sent");
          const result = z
            .object({ turnId: z.string() })
            .parse(await rpc.request("turn/steer", { ...params, expectedTurnId }));
          if (result.turnId !== expectedTurnId)
            throw new Error(
              "Codex returned a different steering turn; outcome requires reconciliation",
            );
          this.emit({
            type: "session.prompt_result",
            sessionId: this.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "steer", turnId: expectedTurnId },
          });
        } else {
          this.pendingStartEvents = [];
          const result = z
            .object({ turn: turnSchema })
            .parse(await rpc.request("turn/start", params));
          const events = this.pendingStartEvents;
          this.pendingStartEvents = undefined;
          this.emit({
            type: "session.prompt_result",
            sessionId: this.sessionId,
            clientMessageId: input.prompt.clientMessageId,
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
      }
    } finally {
      const events = this.pendingStartEvents;
      this.pendingStartEvents = undefined;
      if (events) for (const event of events) this.emitTurn(event);
      this.mutationPending = false;
    }
  }

  disconnect(error: Error): void {
    this.rpc = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.notice(
      "connection",
      "warning",
      `Codex disconnected: ${error.message}. Pending operations are not retried.`,
    );
  }

  async reattach(rpc: RpcClient): Promise<void> {
    const wasActive = this.activated;
    const oldTurn = this.activeTurn;
    const oldPermissions = [...this.permissions.keys()];
    this.activated = false;
    await this.hydrate(rpc);
    for (const id of oldPermissions)
      if (!this.permissions.has(id))
        this.emit({
          type: "session.permission_resolved",
          sessionId: this.sessionId,
          permissionId: id,
        });
    if (oldTurn && oldTurn.id !== this.activeTurn?.id) {
      const turns = await readPages(
        rpc,
        "thread/turns/list",
        { threadId: this.threadId, sortDirection: "desc", itemsView: "notLoaded" },
        turnSchema,
      );
      const completed = turns.find((turn) => turn.id === oldTurn.id);
      if (completed && completed.status !== "inProgress") this.emitTurn(completed);
    }
    if (wasActive) await this.activate();
    this.notice("connection", "info", "Codex connection restored.");
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc) await rpc.request("thread/unsubscribe", { threadId: this.threadId });
    this.permissions.clear();
    this.snapshots.clear();
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
    if (this.hydrating || this.timer || this.refreshing || !this.rpc) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const client = this.rpc;
      void this.refresh().catch((error) => {
        this.notice(
          "snapshot",
          "warning",
          `Codex snapshot synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (client)
          void client
            .close()
            .catch((closeError) =>
              this.notice(
                "snapshot",
                "warning",
                `Could not close failed proxy: ${String(closeError)}`,
              ),
            );
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
    const work = (async () => {
      for (const turnId of turns) {
        const entries = await readPages(
          rpc,
          "thread/items/list",
          { threadId: this.threadId, turnId, sortDirection: "asc" },
          itemEntrySchema,
        );
        if (this.rpc !== rpc || this.closed) return;
        for (const entry of entries) {
          const snapshot = this.remember(entry.item, entry.startedAtMs);
          if (snapshot && this.activated)
            this.emit({ type: "timeline.item", sessionId: this.sessionId, ...snapshot });
        }
      }
    })();
    this.refreshing = work;
    try {
      await work;
    } finally {
      this.refreshing = undefined;
      const next = this.dirtyTurns.values().next().value;
      if (next !== undefined && !this.closed) this.markDirty(next);
    }
  }

  private remember(item: unknown, startedAtMs: number | null): Snapshot | undefined {
    const projected = projectItem(item);
    const snapshot: Snapshot = {
      item: projected,
      ...(startedAtMs === null ? {} : { timestamp: new Date(startedAtMs).toISOString() }),
    };
    const previous = this.snapshots.get(projected.id);
    const encoded = JSON.stringify(snapshot);
    const previousEncoded = previous ? JSON.stringify(previous) : "";
    if (encoded === previousEncoded) return undefined;
    const size =
      this.snapshotBytes - Buffer.byteLength(previousEncoded) + Buffer.byteLength(encoded);
    if (size > MAX_SNAPSHOT_BYTES || (!previous && this.snapshots.size >= MAX_ITEMS))
      throw new Error("Codex snapshot limit exceeded; attachment stopped");
    this.snapshots.set(projected.id, snapshot);
    this.snapshotBytes = size;
    return snapshot;
  }
}

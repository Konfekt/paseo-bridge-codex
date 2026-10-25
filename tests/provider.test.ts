import type {
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ID_ENV, CAPABILITIES, createBridgeProvider } from "../src/provider.js";
import type { RpcClient, RpcMessage } from "../src/rpc.js";

const threadId = "019a0000-0000-7000-8000-000000000001";
const launch: ProviderLaunch = {
  command: "codex",
  args: [],
  env: { CODEX_HOME: "/tmp/bridge-test-home" },
};
const nativeThread = {
  id: threadId,
  cwd: "/tmp",
  source: "vscode",
  originator: "codex-tui",
  parentThreadId: null,
  ephemeral: false,
  canAcceptDirectInput: true,
  name: "Terminal task",
  preview: "hello",
  updatedAt: 1234,
  model: "terminal-model",
  reasoningEffort: "high",
  status: { type: "active" },
};

class NativeDaemon implements RpcClient {
  calls: Array<{ method: string; params: unknown }> = [];
  listeners = new Set<(message: RpcMessage) => void>();
  closedListeners = new Set<(error: Error) => void>();
  activeTurn: string | null = "native-turn";
  item = { id: "answer", type: "agentMessage", text: "Hello" };
  responses: unknown[] = [];
  onMessage(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: (error: Error) => void) {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }
  private closed = false;
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closedListeners) listener(new Error("Proxy closed"));
  }
  async notify() {}
  async respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
  }
  emit(method: string, params: unknown, id?: string | number) {
    for (const listener of this.listeners)
      listener({ method, params, ...(id === undefined ? {} : { id }) });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case "initialize":
        return { userAgent: "codex/0.164.0" };
      case "thread/loaded/list":
        return { data: [threadId], nextCursor: null };
      case "thread/list":
        return { data: [nativeThread], nextCursor: null };
      case "thread/read":
        return { thread: nativeThread };
      case "thread/resume":
        return { thread: nativeThread };
      case "thread/turns/list":
        return {
          data: this.activeTurn
            ? [{ id: this.activeTurn, status: "inProgress", items: [], error: null }]
            : [],
          nextCursor: null,
        };
      case "thread/items/list":
        return {
          data: [
            { turnId: "native-turn", item: this.item, startedAtMs: 1234, completedAtMs: null },
          ],
          nextCursor: null,
        };
      case "turn/steer":
        return { turnId: this.activeTurn };
      case "turn/start":
        return { turn: { id: "remote-turn", status: "inProgress", items: [], error: null } };
      case "turn/interrupt":
        return {};
      case "thread/unsubscribe":
        return {};
      default:
        throw new Error(`Unexpected native method: ${method}`);
    }
  }
}

const open: Extract<ProviderInput, { type: "session.open" }> = {
  type: "session.open",
  requestId: "open",
  sessionId: "paseo-session",
  persistence: { version: 1, data: { threadId, codexHome: "/tmp/bridge-test-home" } },
  history: "replay",
  config: {
    cwd: "/tmp",
    env: { [AGENT_ID_ENV]: "agent-1" },
    persist: true,
    settings: {},
    mcpServers: {},
    model: "paseo-default-must-not-override",
    systemPrompt: "not native",
  },
};

describe("shared-thread provider", () => {
  it("does not revive a disconnected turn when a later native turn completes during reattachment", async () => {
    const first = new NativeDaemon();
    const recovered = new NativeDaemon();
    const original = recovered.request.bind(recovered);
    recovered.request = async (method, params) => {
      if (method === "thread/turns/list") {
        if ((params as { limit: number }).limit === 1) {
          recovered.emit("turn/completed", {
            threadId,
            turn: { id: "later-turn", status: "completed", error: null },
          });
          return {
            data: [{ id: "later-turn", status: "inProgress", error: null }],
            nextCursor: null,
          };
        }
        return {
          data: [
            { id: "later-turn", status: "completed", error: null },
            { id: "native-turn", status: "completed", error: null },
          ],
          nextCursor: null,
        };
      }
      return original(method, params);
    };
    const factory = vi.fn(async () => (factory.mock.calls.length === 1 ? first : recovered));
    const bridge = createBridgeProvider(async () => null, factory);
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      events.length = 0;
      await first.close();
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "session.notice",
              notice: expect.objectContaining({ description: "Codex connection restored." }),
            }),
          ),
        { timeout: 5000 },
      );
      expect(events.filter((event) => event.type === "session.turn")).toEqual([
        {
          type: "session.turn",
          sessionId: open.sessionId,
          turnId: "native-turn",
          state: "completed",
        },
      ]);
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "after-recovery",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Next" }] },
        },
      });
      expect(recovered.calls.some((call) => call.method === "turn/start")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("rejects a stale Paseo steering admission before mutating a newer native turn", async () => {
    const daemon = new NativeDaemon();
    const readHostTurn = vi.fn(async () => "native-turn");
    const bridge = createBridgeProvider(readHostTurn, async () => daemon);
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      // The host holds its admission for T1 while newer native events reach the plugin.
      daemon.activeTurn = "newer-turn";
      daemon.emit("turn/completed", {
        threadId,
        turn: { id: "native-turn", status: "completed", error: null },
      });
      daemon.emit("turn/started", {
        threadId,
        turn: { id: "newer-turn", status: "inProgress", error: null },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "stale-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "For the old turn only" }] },
        },
      });
      expect(
        daemon.calls.some((call) => call.method === "turn/steer" || call.method === "turn/start"),
      ).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.prompt_result",
          result: {
            type: "failed",
            error: { message: "Paseo and Codex active turns differ; steering was not sent" },
          },
        }),
      );
      expect(readHostTurn).toHaveBeenCalledWith("agent-1");
    } finally {
      await connection.close();
    }
  });

  it("recovers snapshot failures through a new proxy without replaying mutations", async () => {
    const first = new NativeDaemon();
    const recovered = new NativeDaemon();
    recovered.item.text = "Recovered output";
    const factory = vi.fn(async () => (factory.mock.calls.length === 1 ? first : recovered));
    const bridge = createBridgeProvider(async () => "native-turn", factory);
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      const original = first.request.bind(first);
      first.request = async (method, params) => {
        if (method === "thread/items/list") throw new Error("Snapshot response lost");
        if (method === "turn/steer") throw new Error("Mutation outcome unknown");
        return original(method, params);
      };
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "uncertain",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "Do this once" }] },
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.prompt_result",
          result: expect.objectContaining({ type: "failed" }),
        }),
      );
      first.emit("item/agentMessage/delta", {
        threadId,
        turnId: "native-turn",
        itemId: "answer",
        delta: " changed",
      });
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "timeline.item",
              item: expect.objectContaining({ text: "Recovered output" }),
            }),
          ),
        { timeout: 5000 },
      );
      expect(factory).toHaveBeenCalledTimes(2);
      expect(
        recovered.calls.some(
          (call) => call.method === "turn/steer" || call.method === "turn/start",
        ),
      ).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("does not overwrite a newer native completion with a stale bootstrap response", async () => {
    const daemon = new NativeDaemon();
    const original = daemon.request.bind(daemon);
    daemon.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/turns/list")
        daemon.emit("turn/completed", {
          threadId,
          turn: { id: "native-turn", status: "completed", error: null },
        });
      return result;
    };
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => daemon,
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      expect(
        events.some((event) => event.type === "session.turn" && event.state === "started"),
      ).toBe(false);
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "after-bootstrap",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Next" }] },
        },
      });
      expect(daemon.calls.some((call) => call.method === "turn/start")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("publishes the latest native snapshot when output arrives during an earlier read", async () => {
    const daemon = new NativeDaemon();
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => daemon,
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      const original = daemon.request.bind(daemon);
      let release: ((value: unknown) => void) | undefined;
      let held = false;
      daemon.request = async (method, params) => {
        if (method === "thread/items/list" && !held) {
          held = true;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return original(method, params);
      };
      daemon.emit("item/agentMessage/delta", {
        threadId,
        turnId: "native-turn",
        itemId: "answer",
        delta: " A",
      });
      await vi.waitFor(() => expect(release).toBeDefined());
      daemon.item.text = "Hello B";
      daemon.emit("item/agentMessage/delta", {
        threadId,
        turnId: "native-turn",
        itemId: "answer",
        delta: " B",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      release?.({
        data: [
          {
            turnId: "native-turn",
            item: { ...daemon.item, text: "Hello A" },
            startedAtMs: 1234,
            completedAtMs: null,
          },
        ],
        nextCursor: null,
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "timeline.item",
            item: expect.objectContaining({ text: "Hello B" }),
          }),
        ),
      );
    } finally {
      await connection.close();
    }
  });

  it("offers only persisted, loaded terminal roots without importing empty start screens or editor threads", async () => {
    const daemon = new NativeDaemon();
    const original = daemon.request.bind(daemon);
    daemon.request = async (method, params) => {
      if (method === "thread/loaded/list")
        return { data: [threadId, "unsaved", "editor", "child", "ephemeral"], nextCursor: null };
      if (method === "thread/list")
        return {
          data: [
            nativeThread,
            { ...nativeThread, id: "editor", originator: "vscode-extension" },
            { ...nativeThread, id: "child", parentThreadId: threadId },
            { ...nativeThread, id: "ephemeral", ephemeral: true },
          ],
          nextCursor: null,
        };
      if (method === "thread/read") {
        const id = (params as { threadId: string }).threadId;
        return {
          thread: {
            ...nativeThread,
            id,
            originator: id === "editor" ? "vscode-extension" : "codex-tui",
            parentThreadId: id === "child" ? threadId : null,
            ephemeral: id === "ephemeral",
          },
        };
      }
      return original(method, params);
    };
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => daemon,
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "sessions", requestId: "list" });
      const result = events.find((event) => event.type === "sessions");
      expect(result?.sessions.map((session) => session.persistence)).toEqual([open.persistence]);
      expect(daemon.calls.some((call) => call.method === "thread/resume")).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("does not resurrect a turn that completes before the prompt acknowledgement", async () => {
    const daemon = new NativeDaemon();
    daemon.activeTurn = null;
    const originalRequest = daemon.request.bind(daemon);
    daemon.request = async (method, params) => {
      const result = await originalRequest(method, params);
      if (method === "turn/start") {
        daemon.emit("turn/started", {
          threadId,
          turn: { id: "remote-turn", status: "inProgress", error: null },
        });
        daemon.emit("turn/completed", {
          threadId,
          turn: { id: "remote-turn", status: "completed", error: null },
        });
      }
      return result;
    };
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => daemon,
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "fast",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Hello" }] },
        },
      });
      expect(events.filter((event) => event.type === "session.turn").at(-1)).toMatchObject({
        state: "completed",
      });
      expect(events.findIndex((event) => event.type === "session.prompt_result")).toBeLessThan(
        events.findIndex((event) => event.type === "session.turn" && event.state === "completed"),
      );
    } finally {
      await connection.close();
    }
  });

  it("imports native history, activates busy steering, resolves approvals, and continues after terminal departure", async () => {
    const daemon = new NativeDaemon();
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => daemon,
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(open);
      expect(events).toContainEqual(expect.objectContaining({ type: "session.ready" }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ text: "Hello" }),
        }),
      );
      expect(events.filter((event) => event.type === "session.turn")).toEqual([]);
      expect(await bridge.activate("agent-1")).toBe(true);
      expect(await bridge.activate("agent-1")).toBe(false);
      expect(events).toContainEqual({
        type: "session.turn",
        sessionId: open.sessionId,
        turnId: "native-turn",
        state: "started",
      });

      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "remote-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "Change direction" }] },
        },
      });
      expect(daemon.calls).toContainEqual({
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: "native-turn",
          input: [{ type: "text", text: "Change direction", text_elements: [] }],
          clientUserMessageId: "remote-steer",
        },
      });

      daemon.item.text = "Hello terminal";
      daemon.emit("item/agentMessage/delta", {
        threadId,
        turnId: "native-turn",
        itemId: "answer",
        delta: " terminal",
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "timeline.item",
            item: expect.objectContaining({ text: "Hello terminal" }),
          }),
        ),
      );
      daemon.emit(
        "item/fileChange/requestApproval",
        { threadId, turnId: "native-turn", itemId: "edit", reason: "write file" },
        9,
      );
      expect(events).toContainEqual(expect.objectContaining({ type: "session.permission" }));
      daemon.emit("serverRequest/resolved", { threadId, requestId: 9 });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "session.permission_resolved" }),
      );

      daemon.activeTurn = null;
      daemon.emit("turn/completed", {
        threadId,
        turn: { id: "native-turn", status: "completed", error: null, items: [] },
      });
      // A terminal departure sends no bridge close; the same native thread remains attached.
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "later",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Continue" }] },
        },
      });
      expect(daemon.calls).toContainEqual({
        method: "thread/resume",
        params: { threadId, excludeTurns: true },
      });
      expect(daemon.calls).toContainEqual({
        method: "turn/start",
        params: {
          threadId,
          clientUserMessageId: "later",
          input: [{ type: "text", text: "Continue", text_elements: [] }],
        },
      });
      expect(daemon.calls.some((call) => call.method === "thread/start")).toBe(false);
    } finally {
      await connection.close();
    }
  });
});

import type {
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ID_ENV, CAPABILITIES, createBridgeProvider } from "../src/provider.js";
import type { RpcClient, RpcMessage } from "../src/rpc.js";

const threadId = "019a0000-0000-7000-8000-000000000001";
const codexHome = "/tmp/bridge-test-home";
const launch: ProviderLaunch = {
  command: "codex",
  args: [],
  env: { CODEX_HOME: codexHome },
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
  persistence: { version: 1, data: { threadId, codexHome } },
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
  it("streams full historical payloads larger than its former snapshot budget and keeps live updates", async () => {
    const daemon = new NativeDaemon();
    const itemCount = 110;
    const payloadSizeBytes = 650 * 1024;
    const textFor = (index: number, changed = false) =>
      `${index}:${"x".repeat(payloadSizeBytes)}:${changed ? "changed" : "original"}`;
    const original = daemon.request.bind(daemon);
    let lastChanged = false;
    daemon.request = async (method, params) => {
      if (method !== "thread/items/list") return original(method, params);
      const { cursor, limit, turnId } = params as {
        cursor?: string;
        limit?: number;
        turnId?: string;
      };
      const indexes =
        turnId === "native-turn"
          ? [itemCount - 1]
          : Array.from({ length: itemCount }, (_, index) => index);
      const offset = Number(cursor ?? 0);
      const page = indexes.slice(offset, offset + Math.min(limit ?? 100, 10));
      return {
        data: page.map((index) => ({
          turnId: index === itemCount - 1 ? "native-turn" : "older-turn",
          item: {
            id: `large-message-${index}`,
            type: "agentMessage",
            text: textFor(index, lastChanged && index === itemCount - 1),
          },
          startedAtMs: 1234,
          completedAtMs: null,
        })),
        nextCursor: offset + page.length < indexes.length ? String(offset + page.length) : null,
      };
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
    let firstSeen = false;
    let lastSeen = false;
    let liveSeen = false;
    let openFailure: string | undefined;
    connection.onEvent((event) => {
      if (event.type === "request.failed") openFailure = event.error.message;
      if (event.type !== "timeline.item" || event.item.type !== "assistant_message") return;
      if (event.item.id === "large-message-0") {
        expect(event.item.text).toBe(textFor(0));
        firstSeen = true;
      }
      if (event.item.id === `large-message-${itemCount - 1}`) {
        expect(event.item.text).toBe(textFor(itemCount - 1, lastChanged));
        if (lastChanged) liveSeen = true;
        else lastSeen = true;
      }
    });
    try {
      await connection.send(open);
      expect(openFailure).toBeUndefined();
      await bridge.activate("agent-1");
      expect(firstSeen).toBe(true);
      expect(lastSeen).toBe(true);
      lastChanged = true;
      daemon.emit("item/completed", {
        threadId,
        turnId: "native-turn",
        itemId: `large-message-${itemCount - 1}`,
      });
      await vi.waitFor(() => expect(liveSeen).toBe(true));
    } finally {
      await connection.close();
    }
  });

  it("does not answer an async question in a newer turn admitted during the host lookup", async () => {
    const daemon = new NativeDaemon();
    daemon.item = {
      ...daemon.item,
      id: "async-question",
      text: "Choose",
      delivery: "async",
      questions: [{ title: "Choose", options: ["One", "Two"] }],
    } as typeof daemon.item;
    const readHostTurn = async () => {
      daemon.activeTurn = "newer-turn";
      daemon.emit("turn/completed", {
        threadId,
        turn: { id: "native-turn", status: "completed", error: null },
      });
      daemon.emit("turn/started", {
        threadId,
        turn: { id: "newer-turn", status: "inProgress", error: null },
      });
      return "newer-turn";
    };
    const bridge = createBridgeProvider(readHostTurn, async () => daemon);
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    try {
      await connection.send(open);
      await bridge.activate("agent-1");
      await expect(
        connection.send({
          type: "session.permission",
          sessionId: open.sessionId,
          permissionId: "async-question",
          response: { behavior: "allow", updatedInput: { answers: { "Question 1": "One" } } },
        }),
      ).rejects.toThrow(/turn.*(differ|changed)|question.*no longer pending/i);
      expect(
        daemon.calls.some((call) => call.method === "turn/steer" || call.method === "turn/start"),
      ).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("retains unanswered fields and rejects a stale answer after another native client replies without a notification", async () => {
    const daemon = new NativeDaemon();
    const question = {
      id: "async-question",
      type: "agentMessage",
      delivery: "async",
      text: "Choose and explain",
      questions: [{ title: "Choose", options: ["One", "Two"] }, { title: "Explain" }],
    };
    const reply = (index: number, answer: string, target = question) => ({
      id: `${target.id}-reply-${index}`,
      type: "userMessage",
      content: [
        {
          type: "text",
          text: `<send_user_message_question_reply>\n${JSON.stringify([
            {
              answer,
              question: target.questions[index]?.title,
              questionItemId: JSON.stringify(["request_user_input_async", target.id, index]),
            },
          ])}\n</send_user_message_question_reply>`,
        },
      ],
    });
    const items = [question, reply(0, "One")];
    const original = daemon.request.bind(daemon);
    let holdNextRead = false;
    let releaseStaleRead: (() => void) | undefined;
    daemon.request = async (method, params) => {
      if (method !== "thread/items/list") return original(method, params);
      const result = {
        data: items.map((item) => ({
          turnId: "native-turn",
          item,
          startedAtMs: 1234,
          completedAtMs: null,
        })),
        nextCursor: null,
      };
      if (!holdNextRead) return result;
      holdNextRead = false;
      return new Promise((resolve) => {
        releaseStaleRead = () => resolve(result);
      });
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
      const pending = events.find((event) => event.type === "session.permission");
      expect(pending).toMatchObject({
        request: {
          id: "async-question",
          input: { questions: [{ header: "Question 2", question: "Explain" }] },
        },
      });
      if (pending?.type !== "session.permission") throw new Error("No pending question");
      expect(pending.request.input?.["questions"]).toHaveLength(1);
      const additionalQuestion = {
        ...question,
        id: "additional-question",
        text: "Another native question",
        questions: [{ title: "Continue?", options: ["Yes", "No"] }],
      };
      items.push(additionalQuestion);
      holdNextRead = true;
      daemon.emit("item/agentMessage/delta", {
        threadId,
        turnId: "native-turn",
        itemId: additionalQuestion.id,
        delta: " more context",
      });
      await vi.waitFor(() => expect(releaseStaleRead).toBeDefined());
      items.push(reply(0, "Yes", additionalQuestion));
      // This fresh read leaves the cached pending question unchanged, but must still
      // invalidate the older read containing an already answered additional question.
      await expect(
        connection.send({
          type: "session.permission",
          sessionId: open.sessionId,
          permissionId: "async-question",
          response: { behavior: "deny" },
        }),
      ).rejects.toThrow("Codex has no shared async-question dismissal");
      const eventCountAfterFreshRead = events.length;
      // Activation is the public refresh barrier: it cannot finish before the older read.
      const refreshed = bridge.activate("agent-1");
      releaseStaleRead?.();
      await refreshed;
      expect(
        events
          .slice(eventCountAfterFreshRead)
          .filter((event) => event.type === "session.permission"),
      ).toEqual([]);
      items.push(reply(1, "Already answered in the terminal"));
      await expect(
        connection.send({
          type: "session.permission",
          sessionId: open.sessionId,
          permissionId: "async-question",
          response: {
            behavior: "allow",
            updatedInput: { answers: { "Question 2": "Stale Android answer" } },
          },
        }),
      ).rejects.toThrow("Question already answered in Codex");
      expect(
        daemon.calls.some((call) => call.method === "turn/steer" || call.method === "turn/start"),
      ).toBe(false);
      expect(events).toContainEqual({
        type: "session.permission_resolved",
        sessionId: open.sessionId,
        permissionId: "async-question",
      });
    } finally {
      releaseStaleRead?.();
      await connection.close();
    }
  });

  it("reconciles idle and closed thread notices using the native terminal outcome", async () => {
    const daemon = new NativeDaemon();
    let status = "inProgress";
    let currentTurn = "native-turn";
    const original = daemon.request.bind(daemon);
    daemon.request = async (method, params) => {
      if (method === "thread/read")
        return {
          thread: {
            ...nativeThread,
            status: {
              type:
                status === "inProgress"
                  ? "active"
                  : status === "interrupted"
                    ? "notLoaded"
                    : "idle",
            },
          },
        };
      if (method === "thread/turns/list")
        return { data: [{ id: currentTurn, status, error: null }], nextCursor: null };
      return original(method, params);
    };
    const bridge = createBridgeProvider(
      async () => currentTurn,
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
      events.length = 0;
      status = "completed";
      daemon.emit("thread/status/changed", { threadId, status: { type: "idle" } });
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "session.turn",
          sessionId: open.sessionId,
          turnId: currentTurn,
          state: "completed",
        }),
      );

      currentTurn = "later-turn";
      status = "inProgress";
      daemon.emit("turn/started", {
        threadId,
        turn: { id: currentTurn, status, error: null },
      });
      status = "interrupted";
      daemon.emit("thread/closed", { threadId });
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "session.turn",
          sessionId: open.sessionId,
          turnId: currentTurn,
          state: "canceled",
        }),
      );
      expect(events.some((event) => event.type === "session.closed")).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("settles a previous turn without loading unrelated older turn history", async () => {
    const daemon = new NativeDaemon();
    const original = daemon.request.bind(daemon);
    let advanced = false;
    daemon.request = async (method, params) => {
      if (method !== "thread/turns/list" || !advanced) return original(method, params);
      const { cursor, limit } = params as { cursor?: string; limit: number };
      const offset = Number(cursor ?? 0);
      const turnCount = 10_002;
      const pageEnd = Math.min(offset + limit, turnCount);
      return {
        data: Array.from({ length: pageEnd - offset }, (_, index) => {
          const position = offset + index;
          return {
            id: position === 0 ? "later-turn" : position === 1 ? "native-turn" : `old-${position}`,
            status: position === 0 ? "inProgress" : "completed",
            error: null,
          };
        }),
        nextCursor: pageEnd < turnCount ? String(pageEnd) : null,
      };
    };
    const bridge = createBridgeProvider(
      async () => daemon.activeTurn,
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
      events.length = 0;
      advanced = true;
      daemon.activeTurn = "later-turn";
      await expect(bridge.activate("agent-1")).resolves.toBe(false);
      expect(events.filter((event) => event.type === "session.turn")).toEqual([
        {
          type: "session.turn",
          sessionId: open.sessionId,
          turnId: "native-turn",
          state: "completed",
        },
        {
          type: "session.turn",
          sessionId: open.sessionId,
          turnId: "later-turn",
          state: "started",
        },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("recovers every queued update after activation buffer exhaustion", async () => {
    const first = new NativeDaemon();
    const recovered = new NativeDaemon();
    const payloadSizeBytes = 5 * 1024 * 1024;
    const installHistory = (daemon: NativeDaemon, afterRecovery: boolean) => {
      const original = daemon.request.bind(daemon);
      daemon.request = async (method, params) => {
        if (method !== "thread/items/list") return original(method, params);
        const index = Number((params as { cursor?: string }).cursor ?? 0);
        return {
          data: [
            {
              turnId: "native-turn",
              item: {
                id: index === 0 ? "pending-a" : "pending-b",
                type: "agentMessage",
                text:
                  index === 0 && afterRecovery
                    ? "Latest A after recovery"
                    : (index === 0 ? "A" : "B").repeat(payloadSizeBytes),
              },
              startedAtMs: 1234,
              completedAtMs: null,
            },
          ],
          nextCursor: index === 0 ? "1" : null,
        };
      };
    };
    installHistory(recovered, true);
    let connectionCount = 0;
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => (connectionCount++ === 0 ? first : recovered),
    );
    const connection = await bridge.registration.connect({
      versions: [1],
      capabilities: [...CAPABILITIES],
      launch,
    });
    let bufferExhausted = false;
    let restored = false;
    let latestASeen = false;
    let fullBSeen = false;
    connection.onEvent((event) => {
      if (event.type === "session.notice") {
        bufferExhausted ||=
          event.notice.description?.includes("activation update buffer exceeded") === true;
        restored ||= event.notice.description === "Codex connection restored.";
      }
      if (event.type !== "timeline.item" || event.item.type !== "assistant_message") return;
      if (event.item.id === "pending-a" && event.item.text === "Latest A after recovery")
        latestASeen = true;
      if (event.item.id === "pending-b") {
        expect(event.item.text).toBe("B".repeat(payloadSizeBytes));
        fullBSeen = true;
      }
    });
    try {
      await connection.send(open);
      // Updates arrive after opening but before the manager's activation handoff.
      installHistory(first, false);
      first.emit("item/completed", { threadId, turnId: "native-turn", itemId: "pending-a" });
      await vi.waitFor(() => expect(bufferExhausted).toBe(true));
      await vi.waitFor(() => expect(restored).toBe(true), { timeout: 5000 });
      await bridge.activate("agent-1");
      expect(latestASeen).toBe(true);
      expect(fullBSeen).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("reports missing native history without inventing a terminal turn", async () => {
    const daemon = new NativeDaemon();
    let reconnecting = false;
    let historyAvailable = false;
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => {
        if (!reconnecting) return daemon;
        const recovered = new NativeDaemon();
        const original = recovered.request.bind(recovered);
        recovered.request = async (method, params) => {
          if (method === "thread/turns/list")
            return {
              data: historyAvailable
                ? [{ id: "native-turn", status: "completed", error: null }]
                : [],
              nextCursor: null,
            };
          return original(method, params);
        };
        return recovered;
      },
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
      events.length = 0;
      const original = daemon.request.bind(daemon);
      daemon.request = async (method, params) =>
        method === "thread/turns/list" ? { data: [], nextCursor: null } : original(method, params);
      await expect(bridge.activate("agent-1")).rejects.toThrow("outcome is unknown");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.notice",
          notice: expect.objectContaining({
            severity: "warning",
            description: expect.stringContaining("outcome is unknown"),
          }),
        }),
      );
      expect(events.some((event) => event.type === "session.turn")).toBe(false);
      reconnecting = true;
      await daemon.close();
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "session.notice",
              notice: expect.objectContaining({
                description: expect.stringContaining(
                  "Codex disconnected: Codex turn native-turn is missing",
                ),
              }),
            }),
          ),
        { timeout: 5000 },
      );
      historyAvailable = true;
      await vi.waitFor(
        () =>
          expect(events).toContainEqual({
            type: "session.turn",
            sessionId: open.sessionId,
            turnId: "native-turn",
            state: "completed",
          }),
        { timeout: 6000 },
      );
    } finally {
      await connection.close();
    }
  });

  it("keeps a newer turn steerable when an older reconciliation response arrives", async () => {
    const daemon = new NativeDaemon();
    const bridge = createBridgeProvider(
      async () => daemon.activeTurn,
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
      events.length = 0;
      const original = daemon.request.bind(daemon);
      daemon.request = async (method, params) => {
        if (method === "thread/turns/list") {
          daemon.activeTurn = "newer-turn";
          daemon.emit("turn/completed", {
            threadId,
            turn: { id: "native-turn", status: "completed", error: null },
          });
          daemon.emit("turn/started", {
            threadId,
            turn: { id: "newer-turn", status: "inProgress", error: null },
          });
          return {
            data: [{ id: "native-turn", status: "completed", error: null }],
            nextCursor: null,
          };
        }
        return original(method, params);
      };
      await bridge.activate("agent-1");
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "newer-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "Continue the new turn" }] },
        },
      });
      expect(
        events
          .filter((event) => event.type === "session.turn")
          .map((event) => [event.turnId, event.state]),
      ).toEqual([
        ["native-turn", "completed"],
        ["newer-turn", "started"],
      ]);
      expect(daemon.calls).toContainEqual({
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: "newer-turn",
          clientUserMessageId: "newer-steer",
          input: [{ type: "text", text: "Continue the new turn", text_elements: [] }],
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("blocks activation and prompts until reconnect reconciliation finishes", async () => {
    const first = new NativeDaemon();
    const recovered = new NativeDaemon();
    const original = recovered.request.bind(recovered);
    let turnReads = 0;
    let release: (() => void) | undefined;
    recovered.request = async (method, params) => {
      if (method === "thread/turns/list") {
        turnReads++;
        if (turnReads === 2)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          data: [{ id: "native-turn", status: "completed", error: null }],
          nextCursor: null,
        };
      }
      return original(method, params);
    };
    let reconnecting = false;
    const bridge = createBridgeProvider(
      async () => "native-turn",
      async () => (reconnecting ? recovered : first),
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
      events.length = 0;
      reconnecting = true;
      await first.close();
      await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
      await expect(bridge.activate("agent-1")).rejects.toThrow("synchronizing");
      await connection.send({
        type: "session.prompt",
        sessionId: open.sessionId,
        prompt: {
          clientMessageId: "during-reconnect",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Continue" }] },
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.prompt_result",
          result: {
            type: "failed",
            error: {
              message: "Codex attachment is disconnected or synchronizing; operation was not sent",
            },
          },
        }),
      );
      release?.();
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "session.turn")).toEqual([
          {
            type: "session.turn",
            sessionId: open.sessionId,
            turnId: "native-turn",
            state: "completed",
          },
        ]),
      );
    } finally {
      release?.();
      await connection.close();
    }
  });

  it("keeps a healthy attachment steerable when another thread has missing history", async () => {
    const daemon = new NativeDaemon();
    let missingHistory = false;
    const original = daemon.request.bind(daemon);
    daemon.request = async (method, params) => {
      const requestedId = (params as { threadId?: string }).threadId;
      if (method === "thread/resume" || method === "thread/read")
        return { thread: { ...nativeThread, id: requestedId } };
      if (method === "thread/turns/list" && requestedId === threadId && missingHistory)
        return { data: [], nextCursor: null };
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
      await connection.send(open);
      await bridge.activate("agent-1");
      await connection.send({
        ...open,
        requestId: "open-healthy",
        sessionId: "healthy-session",
        persistence: {
          version: 1,
          data: { threadId: "healthy-thread", codexHome },
        },
        config: { ...open.config, env: { [AGENT_ID_ENV]: "healthy-agent" } },
      });
      await bridge.activate("healthy-agent");
      missingHistory = true;
      await expect(bridge.activate("agent-1")).rejects.toThrow("outcome is unknown");
      await connection.send({
        type: "session.prompt",
        sessionId: "healthy-session",
        prompt: {
          clientMessageId: "healthy-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "Continue" }] },
        },
      });
      expect(events).toContainEqual({
        type: "session.prompt_result",
        sessionId: "healthy-session",
        clientMessageId: "healthy-steer",
        result: { type: "steer", turnId: "native-turn" },
      });
    } finally {
      await connection.close();
    }
  });

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

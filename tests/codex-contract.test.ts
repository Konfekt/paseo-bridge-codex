import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { expect, test, vi } from "vitest";
import { readModelCatalog } from "../src/models.js";
import {
  CODEX_TESTED_VERSION,
  cliVersion,
  isSupportedCodexVersion,
  userAgentVersion,
} from "../src/protocol.js";
import { AttachedThread } from "../src/thread.js";
import { type RealCodex, startRealCodex } from "./real-codex.js";

function cliVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parse(version), parse(minimum)];
  for (let index = 0; index < 3; index++)
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
}

/** The binary's release; the pinned package must be the tested one. */
async function releaseOf(real: RealCodex): Promise<string> {
  const version = cliVersion(
    (await execCommand(real.codex, ["--version"], { env: real.env })).stdout,
  );
  if (!version) throw new Error("Codex printed no version");
  if (!process.env["PBC_CODEX_BINARY"]) expect(version).toBe(CODEX_TESTED_VERSION);
  expect(isSupportedCodexVersion(version)).toBe(true);
  return version;
}

test("released Codex shares a durable CLI thread across official proxies without transferring daemon ownership", async () => {
  const real = await startRealCodex();
  const { temp } = real;
  const storedList = {
    archived: false,
    sourceKinds: ["cli", "vscode"],
    sortKey: "updated_at",
    sortDirection: "desc",
    modelProviders: [],
    useStateDbOnly: true,
    limit: 100,
    cursor: null,
  };
  try {
    const version = await releaseOf(real);
    const { client: terminal } = await real.connect("codex-tui", version);
    const started = (await terminal.request("thread/start", {
      cwd: temp,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: false,
    })) as {
      thread: {
        id: string;
        source: string;
        parentThreadId: string | null;
        ephemeral: boolean;
        canAcceptDirectInput: boolean | null;
        originator: string;
        historyMode: string;
      };
      model: string;
      sandbox: unknown;
      approvalPolicy: unknown;
    };
    expect(started.thread).toMatchObject({
      source: "vscode",
      parentThreadId: null,
      ephemeral: false,
      canAcceptDirectInput: true,
      originator: "codex-tui",
    });
    const { client: bridge, userAgent } = await real.connect("paseo_bridge_codex", "0.1.0");
    expect(userAgentVersion(userAgent)).toBe(version);
    expect(await bridge.request("thread/loaded/list", { limit: 100 })).toMatchObject({
      data: [started.thread.id],
      nextCursor: null,
    });
    expect(await bridge.request("thread/list", storedList)).toMatchObject({ data: [] });
    await expect(
      bridge.request("thread/resume", { threadId: started.thread.id, excludeTurns: true }),
    ).rejects.toThrow("no rollout found");
    const completed = new Promise<void>((resolve, reject) => {
      terminal.onMessage((message) => {
        if (message.method === "turn/completed") resolve();
        if (message.method === "error") reject(new Error(JSON.stringify(message.params)));
      });
    });
    await terminal.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Contract request", text_elements: [] }],
    });
    await completed;
    expect(real.modelRequests).toHaveLength(1);
    expect(await bridge.request("thread/list", storedList)).toMatchObject({
      data: [
        expect.objectContaining({
          id: started.thread.id,
          historyMode: "paginated",
          originator: "codex-tui",
        }),
      ],
    });
    const resumed = (await bridge
      .request("thread/resume", {
        threadId: started.thread.id,
        excludeTurns: true,
      })
      .catch((error: unknown) => {
        throw new Error("thread/resume failed", { cause: error });
      })) as { thread: { id: string }; model: string; sandbox: unknown; approvalPolicy: unknown };
    expect(resumed.thread.id).toBe(started.thread.id);
    expect(resumed.model).toBe(started.model);
    expect(resumed.sandbox).toEqual(started.sandbox);
    expect(resumed.approvalPolicy).toEqual(started.approvalPolicy);
    // The model picker: Codex's list, and a choice applied to the shared thread.
    const models = await readModelCatalog(bridge);
    expect(models.models.length).toBeGreaterThan(1);
    const other = models.models.find((model) => model.id !== started.model);
    if (!other) throw new Error("Codex listed no alternative model");
    const settingsUpdated = new Promise<unknown>((resolve) => {
      terminal.onMessage((message) => {
        if (message.method === "thread/settings/updated") resolve(message.params);
      });
    });
    await bridge.request("thread/settings/update", {
      threadId: started.thread.id,
      model: other.id,
    });
    expect(await settingsUpdated).toMatchObject({
      threadId: started.thread.id,
      threadSettings: { model: other.id },
    });
    const turns = (await bridge.request("thread/turns/list", {
      threadId: started.thread.id,
      limit: 100,
    })) as { data: { id: string; status: string }[]; nextCursor: string | null };
    expect(turns).toMatchObject({
      data: [expect.objectContaining({ status: "completed" })],
      nextCursor: null,
    });
    expect(
      await bridge.request("thread/items/list", {
        threadId: started.thread.id,
        turnId: turns.data[0]?.id,
        limit: 100,
      }),
    ).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ type: "agentMessage", text: "Local contract reply" }),
        }),
      ]),
      nextCursor: null,
    });
    await terminal.close();
    expect(real.daemon.exitCode).toBeNull();
    expect(await bridge.request("thread/loaded/list", { limit: 100 })).toMatchObject({
      data: [started.thread.id],
    });
    expect(await bridge.request("thread/read", { threadId: started.thread.id })).toMatchObject({
      thread: { id: started.thread.id, source: "vscode", canAcceptDirectInput: true },
    });
    await bridge.close();
    expect(real.daemon.exitCode).toBeNull();
  } finally {
    await real.close();
  }
}, 30_000);

test("released Codex runs the bridge's slash commands for Paseo without reaching the model", async () => {
  const real = await startRealCodex(
    (body) => (body.includes("<side_question>") ? "Side answer" : "Local contract reply"),
    (body) => (body.includes("Slow request") && !body.includes("<side_question>") ? 2_000 : 0),
  );
  try {
    const version = await releaseOf(real);
    const { client: terminal } = await real.connect("codex-tui", version);
    const started = (await terminal.request("thread/start", {
      cwd: real.temp,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: false,
    })) as { thread: { id: string }; model: string };
    const threadId = started.thread.id;
    const firstTurn = new Promise<void>((resolve) => {
      terminal.onMessage((message) => {
        if (message.method === "turn/completed") resolve();
      });
    });
    await terminal.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Contract request", text_elements: [] }],
    });
    await firstTurn;

    const { client: bridge } = await real.connect("paseo_bridge_codex", "0.1.0");
    const events: ProviderEvent[] = [];
    const thread: AttachedThread = new AttachedThread(
      "paseo-session",
      "agent-1",
      threadId,
      { version: 1, data: { threadId, codexHome: real.env["CODEX_HOME"] ?? "" } },
      (event) => events.push(event),
      async () => thread.activeTurn?.id ?? null,
      { read: async () => new Set<string>(), hide: async () => undefined },
    );
    bridge.onMessage((message) => thread.accept(message));
    await thread.hydrate(bridge);
    await thread.activate();
    let counter = 0;
    const send = async (input: { name: string; args?: string } | { text: string }) => {
      const clientMessageId = `command-${++counter}`;
      const from = events.length;
      await thread.send({
        type: "session.prompt",
        sessionId: "paseo-session",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input:
            "text" in input
              ? { type: "message", content: [{ type: "text", text: input.text }] }
              : { type: "command", name: input.name, arguments: input.args ?? "" },
        },
      });
      return { clientMessageId, events: () => events.slice(from) };
    };
    const answerOf = async (input: { name: string; args?: string }) => {
      const sent = await send(input);
      const item = sent
        .events()
        .find((event) => event.type === "timeline.item" && event.item.type === "assistant_message");
      if (item?.type !== "timeline.item" || item.item.type !== "assistant_message")
        throw new Error(`/${input.name} gave no answer: ${JSON.stringify(sent.events())}`);
      return item.item.text;
    };
    const turnCount = async () =>
      ((await bridge.request("thread/turns/list", { threadId, limit: 100 })) as { data: unknown[] })
        .data.length;
    // A native turn a command started settles like any other turn.
    const settles = async (sent: { events: () => ProviderEvent[] }) => {
      const result = sent.events().find((event) => event.type === "session.prompt_result");
      if (result?.type !== "session.prompt_result") throw new Error("No prompt result");
      if (result.result.type === "failed") throw new Error(result.result.error.message);
      const turnId = result.result.type === "turn" ? result.result.turnId : undefined;
      expect(turnId ?? "").not.toMatch(/^paseo-command-/);
      await vi.waitFor(
        () =>
          expect(
            sent
              .events()
              .some(
                (event) =>
                  event.type === "session.turn" &&
                  event.state === "completed" &&
                  (turnId ? event.turnId === turnId : !event.turnId.startsWith("paseo-command-")),
              ),
          ).toBe(true),
        { timeout: 15_000 },
      );
      await vi.waitFor(() => expect(thread.activeTurn).toBeUndefined(), { timeout: 15_000 });
    };

    // A side question samples the thread's context and leaves its history unchanged.
    const turnsBefore = await turnCount();
    const modelCalls = real.modelRequests.length;
    const side = await send({ name: "btw", args: "What did I ask?" });
    await vi.waitFor(() =>
      expect(side.events()).toContainEqual(
        expect.objectContaining({
          item: expect.objectContaining({ type: "assistant_message", text: "Side answer" }),
        }),
      ),
    );
    expect(side.events().at(-1)).toMatchObject({ type: "session.turn", state: "completed" });
    expect(real.modelRequests).toHaveLength(modelCalls + 1);
    expect(real.modelRequests.at(-1)).toContain("Contract request");
    expect(await turnCount()).toBe(turnsBefore);

    expect(await answerOf({ name: "rename", args: "Contract rename" })).toContain(
      "Contract rename",
    );
    expect(
      ((await bridge.request("thread/read", { threadId })) as { thread: { name: string } }).thread
        .name,
    ).toBe("Contract rename");
    const status = await answerOf({ name: "status" });
    expect(status).toContain("Thread: Contract rename");
    expect(status).toContain(`Model: ${started.model}`);
    expect(status).toContain("No goal is set");
    expect(await answerOf({ name: "permissions" })).toContain(":workspace");
    expect(await answerOf({ name: "permissions", args: "read-only" })).toContain(":read-only");
    expect(await answerOf({ name: "memories", args: "off" })).toContain("off");
    expect(await answerOf({ name: "mcp" })).toBe("No MCP servers are configured.");
    expect(await answerOf({ name: "skills" })).toContain("Skills");
    expect(await answerOf({ name: "hooks" })).toBe("No hooks are configured.");
    expect(await answerOf({ name: "plugins" })).toBeTypeOf("string");
    expect(await answerOf({ name: "ps" })).toBe("No background terminals are running.");
    expect(await answerOf({ name: "stop" })).toBe("Stopped all background terminals.");
    expect(await answerOf({ name: "plan" })).toContain("Plan mode is on");
    expect(await answerOf({ name: "plan", args: "off" })).toBe("Left Plan mode.");
    await expect(send({ name: "usage" })).rejects.toThrow("authentication required");
    await expect(send({ text: "/diff" })).rejects.toThrow("is a Codex terminal command");
    expect(real.modelRequests).toHaveLength(modelCalls + 1);

    // An active goal makes Codex continue on its own, as in its terminal.
    expect(await answerOf({ name: "goal", args: "Ship the contract" })).toBe(
      "Goal (active): Ship the contract",
    );
    expect(await answerOf({ name: "goal", args: "pause" })).toMatch(
      /^Goal \((paused|complete)\): Ship the contract$/,
    );
    expect(await answerOf({ name: "goal", args: "clear" })).toBe("Cleared the goal.");
    await vi.waitFor(() => expect(thread.activeTurn).toBeUndefined(), { timeout: 15_000 });

    // A side question during a running turn joins it without steering; Codex before 0.171
    // samples only an idle thread and says so.
    const slow = await send({ text: "Slow request" });
    await vi.waitFor(() => expect(thread.activeTurn).toBeDefined());
    const during = await send({ text: "/btw Still there?" });
    const supportsBusySample = cliVersionAtLeast(version, "0.171.0");
    await vi.waitFor(() =>
      expect(during.events()).toContainEqual(
        expect.objectContaining({
          item: supportsBusySample
            ? expect.objectContaining({ type: "assistant_message", text: "Side answer" })
            : expect.objectContaining({
                type: "error",
                message: expect.stringContaining("only between turns"),
              }),
        }),
      ),
    );
    expect(during.events()[0]).toMatchObject({ result: { type: "steer" } });
    await settles(slow);

    // Commands that start native turns.
    await settles(await send({ name: "compact" }));
    await settles(await send({ name: "review" }));
    await settles(await send({ name: "init" }));
    expect(real.modelRequests.at(-1)).toContain("Generate a file named AGENTS.md");
    await writeFile(join(real.temp, "AGENTS.md"), "# Repository Guidelines\n");
    expect(await answerOf({ name: "init" })).toContain("AGENTS.md already exists");
    await thread.close();
  } finally {
    await real.close();
  }
}, 60_000);

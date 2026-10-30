import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoDaemon, createRootLogger } from "@getpaseo/server";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

test("plugin lifecycle discovers, restores and steers terminal threads without a separate worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pbc-host-"));
  const codexHome = join(root, "codex");
  const paseoHome = join(root, "paseo");
  await mkdir(join(codexHome, "app-server-control"), { recursive: true });
  await mkdir(paseoHome);
  const require = createRequire(import.meta.url);
  const codex = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
  const http = createServer();
  const native = new WebSocketServer({ server: http });
  let permissionPending = true;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const thread = {
    id: "terminal-thread",
    cwd: root,
    source: "vscode",
    originator: "codex-tui",
    parentThreadId: null,
    ephemeral: false,
    canAcceptDirectInput: true,
    name: "Terminal contract",
    preview: "existing work",
    updatedAt: 1_700_000_000,
    model: "native-model",
    reasoningEffort: "high",
    status: { type: "active" },
  };
  const threads = [thread];
  let latestTurnId = "native-turn";
  const historicalRecordMarker = "Unique native historical record";
  const items: Array<{ turnId: string; item: Record<string, unknown> }> = [
    {
      turnId: "history-turn",
      item: {
        id: "historical-question",
        type: "agentMessage",
        delivery: "async",
        text: "An answered question from the oldest history page",
        questions: [{ title: "An answered question from the oldest history page" }],
      },
    },
    {
      turnId: "history-turn",
      item: { id: "historical-record", type: "nativeRecord", text: historicalRecordMarker },
    },
    ...Array.from({ length: 20_101 }, (_, index) => ({
      turnId: "history-turn",
      item: {
        id: `historical-message-${index}`,
        type: "agentMessage",
        text: `Historical terminal output ${index}`,
      },
    })),
    {
      turnId: "history-turn",
      item: {
        id: "historical-reply",
        type: "userMessage",
        content: [
          {
            type: "text",
            text: `<send_user_message_question_reply>\n${JSON.stringify({
              answer: "Already answered",
              question: "An answered question from the oldest history page",
              questionItemId: '["request_user_input_async","historical-question",0]',
            })}\n</send_user_message_question_reply>`,
          },
        ],
      },
    },
    {
      turnId: latestTurnId,
      item: { id: "native-message", type: "agentMessage", text: "Existing terminal output" },
    },
  ];
  const publishItem = (item: Record<string, unknown>) => {
    items.push({ turnId: latestTurnId, item });
    for (const socket of native.clients)
      socket.send(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId: latestTurnId,
            item,
          },
        }),
      );
  };
  native.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!message.method) return;
      const params = message.params ?? {};
      const requestedThread = threads.find((entry) => entry.id === params["threadId"]) ?? thread;
      requests.push({ method: message.method, params });
      if (message.id === undefined) return;
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "codex/0.164.0" };
          break;
        case "thread/loaded/list":
          result = { data: threads.map((entry) => entry.id), nextCursor: null };
          break;
        case "thread/list":
          result = { data: threads, nextCursor: null };
          break;
        case "thread/read":
        case "thread/resume":
          result = { thread: requestedThread };
          break;
        case "thread/items/list": {
          const history = items.filter(
            (entry) =>
              (requestedThread.id === thread.id || entry.turnId !== "history-turn") &&
              (!params["turnId"] || params["turnId"] === entry.turnId),
          );
          if (params["sortDirection"] === "desc") history.reverse();
          const offset = Number(params["cursor"] ?? 0);
          const limit = Number(params["limit"] ?? 100);
          const page = history.slice(offset, offset + limit);
          result = {
            data: page.map((entry) => ({
              ...entry,
              startedAtMs: 1_700_000_000_000,
              completedAtMs: null,
            })),
            nextCursor: offset + page.length < history.length ? String(offset + page.length) : null,
          };
          break;
        }
        case "thread/turns/list":
          result = {
            data: [
              {
                id: latestTurnId,
                status: requestedThread.status.type === "active" ? "inProgress" : "completed",
                error: null,
              },
            ],
            nextCursor: null,
          };
          break;
        case "turn/steer":
          publishItem({
            type: "userMessage",
            id: String(params["clientUserMessageId"]),
            clientId: params["clientUserMessageId"],
            content: params["input"],
          });
          result = { turnId: latestTurnId };
          break;
        case "turn/start":
          latestTurnId = "answer-turn";
          requestedThread.status.type = "active";
          for (const client of native.clients)
            client.send(
              JSON.stringify({
                method: "turn/started",
                params: {
                  threadId: requestedThread.id,
                  turn: { id: latestTurnId, status: "inProgress", error: null },
                },
              }),
            );
          publishItem({
            type: "userMessage",
            id: String(params["clientUserMessageId"]),
            clientId: params["clientUserMessageId"],
            content: params["input"],
          });
          result = { turn: { id: latestTurnId, status: "inProgress", error: null } };
          break;
        case "thread/unsubscribe":
          result = {};
          break;
        default:
          socket.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32601, message: `Unexpected ${message.method}` },
            }),
          );
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "thread/resume" && permissionPending)
        socket.send(
          JSON.stringify({
            id: 41,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: thread.id,
              turnId: "native-turn",
              itemId: "command",
              command: "echo contract",
              cwd: root,
              reason: null,
              availableDecisions: ["accept", "decline"],
            },
          }),
        );
    });
  });
  http.listen(join(codexHome, "app-server-control", "app-server-control.sock"));
  await once(http, "listening");
  let daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      daemonVersion: "0.13.0",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      browserToolsEnabled: false,
      staticDir: root,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: join(paseoHome, "agents"),
      relayEnabled: false,
      pluginsEnabled: true,
      providerOverrides: {
        "codex-terminal": {
          command: [process.execPath, codex],
          env: { CODEX_HOME: codexHome, HOME: codexHome },
        },
      },
    },
    createRootLogger({ level: "error" }),
  );
  let client: ReturnType<typeof createHostClient> | undefined;
  // The CLI supervisor supplies this identity and listener metadata in production.
  vi.stubEnv("PASEO_HOME", paseoHome);
  const publishListener = async (port: number) => {
    await writeFile(
      join(paseoHome, "paseo.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: hostname(),
        uid: process.getuid?.() ?? 0,
        listen: `127.0.0.1:${port}`,
      }),
    );
  };
  try {
    await daemon.start();
    const address = daemon.getListenTarget();
    if (address?.type !== "tcp") throw new Error("No bound Paseo listener");
    await publishListener(address.port);
    client = createHostClient(`127.0.0.1:${address.port}`, {
      clientId: "bridge-contract",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await client.connect();
    const pluginDirectory = process.env["PASEO_BRIDGE_TEST_PLUGIN_DIR"] ?? resolve(".");
    expect(await client.installDirectoryPlugin(pluginDirectory)).toMatchObject({
      id: "paseo-bridge-codex",
      status: "running",
    });
    const connectedClient = client;
    await expect
      .poll(
        async () =>
          (await connectedClient.getProvidersSnapshot()).entries.find(
            (provider) => provider.provider === "codex-terminal",
          )?.status,
        { timeout: 15_000 },
      )
      .toBe("ready");
    await expect
      .poll(async () => (await connectedClient.fetchAgents()).entries.length, { timeout: 15_000 })
      .toBe(1);
    const agentId = (await client.fetchAgents()).entries[0]?.agent.id;
    if (!agentId) throw new Error("No terminal thread automatically imported");
    await expect
      .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId)
      .toBe("native-turn");
    await expect.poll(() => daemon.agentManager.getAgent(agentId)?.pendingPermissions.size).toBe(1);
    expect(JSON.stringify(await client.fetchAgentTimeline(agentId))).toContain(
      "Existing terminal output",
    );
    for (const query of ["Historical terminal output 0", "Historical terminal output 20100"])
      expect(
        (await client.searchAgentTimeline({ agentId, query })).locations.length,
      ).toBeGreaterThan(0);
    expect(await client.invokePluginRpc("paseo-bridge-codex", "activate", { agentId })).toEqual({
      activated: false,
    });
    publishItem({
      id: "live-message",
      type: "agentMessage",
      text: "Live terminal output after import",
    });
    await expect
      .poll(async () => JSON.stringify(await connectedClient.fetchAgentTimeline(agentId)))
      .toContain("Live terminal output after import");
    // A long history must retain enough identity to avoid duplicating an unchanged record.
    for (const socket of native.clients)
      socket.send(
        JSON.stringify({
          method: "item/completed",
          params: { threadId: thread.id, turnId: "history-turn", itemId: "historical-record" },
        }),
      );
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.method === "thread/items/list" && request.params["turnId"] === "history-turn",
        ),
      )
      .toBe(true);
    await client.invokePluginRpc("paseo-bridge-codex", "activate", { agentId });
    const tail = await client.fetchAgentTimeline(agentId, { limit: 10, mergeWindow: false });
    const head = await client.fetchAgentTimeline(agentId, {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 0 },
      limit: 10,
      mergeWindow: false,
    });
    const recordLocations = new Set(
      [...head.entries, ...tail.entries]
        .filter((entry) => JSON.stringify(entry.item).includes(historicalRecordMarker))
        .map((entry) => entry.seqStart),
    );
    expect(recordLocations.size).toBe(1);
    await client.sendMessage(agentId, "Keep the current approach", { activeTurnBehavior: "steer" });
    await expect
      .poll(() => requests.find((request) => request.method === "turn/steer"))
      .toMatchObject({ params: { threadId: thread.id, expectedTurnId: "native-turn" } });
    for (const socket of native.clients)
      socket.send(
        JSON.stringify({
          method: "serverRequest/resolved",
          params: { threadId: thread.id, requestId: 41 },
        }),
      );
    permissionPending = false;
    await expect.poll(() => daemon.agentManager.getAgent(agentId)?.pendingPermissions.size).toBe(0);
    expect(
      requests
        .filter((request) => request.method === "thread/resume")
        .map((request) => request.params),
    ).toEqual([{ threadId: thread.id, excludeTurns: true }]);
    expect(
      requests.some(
        (request) => request.method === "thread/start" || request.method === "turn/start",
      ),
    ).toBe(false);
    // A completed async message is a question, not a blocking JSON-RPC request.
    publishItem({
      type: "agentMessage",
      id: "async-question",
      delivery: "async",
      text: "Choose the next step",
      questions: [
        { title: "Choose the next step", options: ["Review", "Implement"] },
        { title: "Additional context" },
      ],
    });
    await expect
      .poll(async () => {
        const agent = (await connectedClient.fetchAgentTimeline(agentId)).agent;
        return agent?.pendingPermissions.find((p) => p.name === "request_user_input_async");
      })
      .toMatchObject({
        id: "async-question",
        kind: "question",
        input: {
          questions: [
            {
              header: "Question 1",
              question: "Choose the next step",
              options: [{ label: "Review" }, { label: "Implement" }],
              allowOther: true,
            },
            { header: "Question 2", question: "Additional context", options: [], allowOther: true },
          ],
        },
      });
    await client.respondToPermissionAndWait(agentId, "async-question", {
      behavior: "allow",
      updatedInput: {
        answers: { "Question 1": "Review", "Question 2": "Native history remains authoritative" },
      },
    });
    const answer = items
      .map((entry) => entry.item)
      .find(
        (item) =>
          item["type"] === "userMessage" &&
          JSON.stringify(item["content"]).includes("Choose the next step"),
      );
    expect(answer?.["content"]).toEqual([
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([
          {
            answer: "Review",
            question: "Choose the next step",
            questionItemId: '["request_user_input_async","async-question",0]',
          },
          {
            answer: "Native history remains authoritative",
            question: "Additional context",
            questionItemId: '["request_user_input_async","async-question",1]',
          },
        ])}\n</send_user_message_question_reply>`,
        text_elements: [],
      },
    ]);
    expect(daemon.agentManager.getAgent(agentId)?.pendingPermissions.size).toBe(0);
    threads.push({ ...thread, id: "later-terminal-thread" });
    await expect
      .poll(async () => (await connectedClient.fetchAgents()).entries.length, { timeout: 15_000 })
      .toBe(2);
    const agentIds = (await client.fetchAgents()).entries.map((entry) => entry.agent.id).sort();
    const persistedConfig = (await client.getDaemonConfig()).config;
    expect(persistedConfig.plugins).toBeDefined();
    const restartConfig = { ...daemon.config, plugins: persistedConfig.plugins ?? {} };
    await client.close();
    client = undefined;
    await daemon.stop();
    daemon = await createPaseoDaemon(restartConfig, createRootLogger({ level: "error" }));
    await daemon.start();
    const restartedAddress = daemon.getListenTarget();
    if (restartedAddress?.type !== "tcp") throw new Error("No restarted Paseo listener");
    await publishListener(restartedAddress.port);
    client = createHostClient(`127.0.0.1:${restartedAddress.port}`, {
      clientId: "bridge-restart-contract",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await client.connect();
    const restartedClient = client;
    await expect
      .poll(
        async () =>
          (await restartedClient.getProvidersSnapshot()).entries.find(
            (provider) => provider.provider === "codex-terminal",
          )?.status,
        { timeout: 15_000 },
      )
      .toBe("ready");
    await expect
      .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId, { timeout: 15_000 })
      .toBe("native-turn");
    const agents = await client.fetchAgents();
    expect(agents.entries.map((entry) => entry.agent.id).sort()).toEqual(agentIds);
    const restoredTimeline = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 10,
    });
    expect(JSON.stringify(restoredTimeline)).toContain("Existing terminal output");
    for (const query of ["Historical terminal output 0", "Historical terminal output 20100"])
      expect(
        (await client.searchAgentTimeline({ agentId, query })).locations.length,
      ).toBeGreaterThan(0);
    expect(await client.invokePluginRpc("paseo-bridge-codex", "activate", { agentId })).toEqual({
      activated: false,
    });
    expect(daemon.agentManager.getAgent(agentId)?.pendingPermissions.size).toBe(0);
    expect(
      (await client.fetchRecentProviderSessions({ providers: ["codex-terminal"] })).entries,
    ).toEqual([]);
    await client.sendMessage(agentId, "Continue after Paseo restart", {
      activeTurnBehavior: "steer",
    });
    await expect
      .poll(() => requests.filter((request) => request.method === "turn/steer").length)
      .toBe(3);
    expect(await client.disablePlugin("paseo-bridge-codex")).toMatchObject({ status: "disabled" });
    threads.push({ ...thread, id: "while-disabled-thread" });
    const requestCount = requests.length;
    // Span a complete discovery interval while the host remains available.
    await delay(2_500);
    expect(requests).toHaveLength(requestCount);
    // Disabled providers are hidden from Paseo's directory, but their records must remain.
    expect((await daemon.agentStorage.list()).map((agent) => agent.id).sort()).toEqual(agentIds);
    expect(http.listening).toBe(true);
    expect(await client.enablePlugin("paseo-bridge-codex")).toMatchObject({ status: "running" });
    await expect
      .poll(async () => (await restartedClient.fetchAgents()).entries.length, { timeout: 15_000 })
      .toBe(3);
    const enabledIds = (await client.fetchAgents()).entries.map((entry) => entry.agent.id).sort();
    expect(enabledIds).toEqual(expect.arrayContaining(agentIds));
    expect(await client.reloadPlugin("paseo-bridge-codex")).toMatchObject({ status: "running" });
    await expect
      .poll(
        async () => {
          const current = (await restartedClient.fetchAgents()).entries;
          return current.filter((entry) => entry.agent.activeTurn?.turnId === "native-turn").length;
        },
        { timeout: 15_000 },
      )
      .toBe(3);
    expect((await client.fetchAgents()).entries.map((entry) => entry.agent.id).sort()).toEqual(
      enabledIds,
    );
    const completedTurns: string[] = [];
    const stopObserving = daemon.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_completed")
          completedTurns.push(event.event.turnId ?? "");
      },
      { agentId, replayState: false },
    );
    try {
      publishItem({
        type: "agentMessage",
        id: "delayed-question",
        delivery: "async",
        text: "Answer after completion",
        questions: [{ title: "Answer after completion", options: ["Continue"] }],
      });
      await expect
        .poll(() =>
          daemon.agentManager.getAgent(agentId)?.pendingPermissions.has("delayed-question"),
        )
        .toBe(true);
      // The native turn finishes while its completion and status notifications are lost.
      thread.status.type = "idle";
      await expect
        .poll(
          async () => {
            const current = (await restartedClient.fetchAgents()).entries.find(
              (entry) => entry.agent.id === agentId,
            )?.agent;
            return { status: current?.status, activeTurn: current?.activeTurn?.turnId ?? null };
          },
          { timeout: 10_000 },
        )
        .toEqual({ status: "idle", activeTurn: null });
      const countTurnReads = () =>
        requests.filter(
          (request) =>
            request.method === "thread/turns/list" && request.params["threadId"] === thread.id,
        ).length;
      const completedReadCount = countTurnReads();
      await expect
        .poll(countTurnReads, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(completedReadCount + 2);
      expect(completedTurns).toEqual(["native-turn"]);
      expect((await client.fetchAgents()).entries.map((entry) => entry.agent.id).sort()).toEqual(
        enabledIds,
      );
      expect(
        daemon.agentManager.getAgent(agentId)?.pendingPermissions.has("delayed-question"),
      ).toBe(true);
      await client.reloadPlugin("paseo-bridge-codex");
      await expect
        .poll(
          () => daemon.agentManager.getAgent(agentId)?.pendingPermissions.has("delayed-question"),
          { timeout: 15_000 },
        )
        .toBe(true);
      await client.respondToPermissionAndWait(agentId, "delayed-question", {
        behavior: "allow",
        updatedInput: { answers: { "Question 1": "Continue" } },
      });
      expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
      expect(items.at(-1)).toMatchObject({
        turnId: "answer-turn",
        item: {
          type: "userMessage",
          content: [
            {
              text: '<send_user_message_question_reply>\n[{"answer":"Continue","question":"Answer after completion","questionItemId":"[\\"request_user_input_async\\",\\"delayed-question\\",0]"}]\n</send_user_message_question_reply>',
            },
          ],
        },
      });
      await expect
        .poll(() =>
          daemon.agentManager.getAgent(agentId)?.pendingPermissions.has("delayed-question"),
        )
        .toBe(false);
      await client.reloadPlugin("paseo-bridge-codex");
      await expect
        .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId, { timeout: 15_000 })
        .toBe("answer-turn");
      expect(daemon.agentManager.getAgent(agentId)?.pendingPermissions.size).toBe(0);
    } finally {
      stopObserving();
    }
  } finally {
    await client?.close();
    await daemon.stop();
    vi.unstubAllEnvs();
    for (const socket of native.clients) socket.terminate();
    await new Promise<void>((done, reject) =>
      native.close((error) => (error ? reject(error) : done())),
    );
    await new Promise<void>((done, reject) =>
      http.close((error) => (error ? reject(error) : done())),
    );
  }
}, 120_000);

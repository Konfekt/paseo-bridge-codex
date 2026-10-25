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
        case "thread/items/list":
          result = {
            data: [
              {
                turnId: "native-turn",
                item: {
                  id: "native-message",
                  type: "agentMessage",
                  text: "Existing terminal output",
                },
                startedAtMs: 1_700_000_000_000,
                completedAtMs: null,
              },
            ],
            nextCursor: null,
          };
          break;
        case "thread/turns/list":
          result = {
            data: [{ id: "native-turn", status: "inProgress", error: null }],
            nextCursor: null,
          };
          break;
        case "turn/steer":
          result = { turnId: "native-turn" };
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
    expect(await client.invokePluginRpc("paseo-bridge-codex", "activate", { agentId })).toEqual({
      activated: false,
    });
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
      .toBe(2);
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
}, 60_000);

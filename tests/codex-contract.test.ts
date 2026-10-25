import { once } from "node:events";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { expect, onTestFinished, test } from "vitest";
import { connectRpc, type RpcClient } from "../src/rpc.js";

test("released Codex shares a durable CLI thread across official proxies without transferring daemon ownership", async () => {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@openai/codex/package.json");
  const nativeRequire = createRequire(packagePath);
  const platformPackage = `@openai/codex-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
  const triples: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error("Codex native contract is unsupported on this platform");
  const codex = join(
    dirname(nativeRequire.resolve(`${platformPackage}/package.json`)),
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const temp = await mkdtemp(join(tmpdir(), "pbc-real-"));
  const home = join(temp, "home");
  await mkdir(home);
  let modelRequests = 0;
  const modelServer = createServer((request, response) => {
    modelRequests++;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const item = {
        id: "message_contract",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Local contract reply", annotations: [] }],
      };
      for (const event of [
        { type: "response.created", response: { id: "response_contract", status: "in_progress" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "response_contract",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  onTestFinished(async () => {
    modelServer.closeAllConnections();
    if (modelServer.listening) {
      await new Promise<void>((resolve, reject) => {
        modelServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const modelAddress = modelServer.address();
  if (!modelAddress || typeof modelAddress === "string")
    throw new Error("Local model server has no TCP address");
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "contract"\nmodel = "gpt-6.1-sol"\n[model_providers.contract]\nname = "Local contract"\nbase_url = "http://127.0.0.1:${modelAddress.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
  );
  const socket = join(temp, "control.sock");
  const env = { CODEX_HOME: home, HOME: home, PATH: process.env["PATH"] ?? "" };
  expect((await execCommand(codex, ["--version"], { env })).stdout.trim()).toBe(
    "codex-cli 0.164.0",
  );
  const daemon = spawnProcess(codex, ["app-server", "--listen", `unix://${socket}`], {
    env,
    stdio: "pipe",
  });
  let stderr = "";
  daemon.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  daemon.stdout.resume();
  let daemonError: Error | undefined;
  daemon.on("error", (error: Error) => {
    daemonError = error;
  });
  const clients: RpcClient[] = [];
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
    let socketReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null) throw new Error(`Isolated Codex exited: ${stderr}`);
      try {
        await access(socket);
        socketReady = true;
        break;
      } catch {
        await delay(50);
      }
    }
    if (!socketReady) throw new Error(`Isolated Codex socket did not appear: ${stderr}`);
    const terminal = await connectRpc({
      command: codex,
      args: ["app-server", "proxy", "--sock", socket],
      env,
    });
    clients.push(terminal);
    await terminal.request("initialize", {
      clientInfo: { name: "codex-tui", title: "Isolated terminal contract", version: "0.164.0" },
      capabilities: { experimentalApi: true },
    });
    await terminal.notify("initialized", {});
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
    const bridge = await connectRpc({
      command: codex,
      args: ["app-server", "proxy", "--sock", socket],
      env,
    });
    clients.push(bridge);
    await bridge.request("initialize", {
      clientInfo: {
        name: "paseo_bridge_codex",
        title: "Isolated bridge contract",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    await bridge.notify("initialized", {});
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
    expect(modelRequests).toBe(1);
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
    expect(daemon.exitCode).toBeNull();
    expect(await bridge.request("thread/loaded/list", { limit: 100 })).toMatchObject({
      data: [started.thread.id],
    });
    expect(await bridge.request("thread/read", { threadId: started.thread.id })).toMatchObject({
      thread: { id: started.thread.id, source: "vscode", canAcceptDirectInput: true },
    });
    await bridge.close();
    expect(daemon.exitCode).toBeNull();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await terminateProcess(daemon);
  }
}, 30_000);

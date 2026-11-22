import { once } from "node:events";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { connectRpc, type RpcClient } from "../src/rpc.js";

/**
 * The released Codex binary from the pinned `@openai/codex`, or `PBC_CODEX_BINARY` to check
 * another release such as the oldest supported one.
 */
export function realCodexBinary(): string {
  const override = process.env["PBC_CODEX_BINARY"];
  if (override) return override;
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
  return join(
    dirname(nativeRequire.resolve(`${platformPackage}/package.json`)),
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

export interface RealCodex {
  codex: string;
  temp: string;
  env: Record<string, string>;
  socket: string;
  daemon: ReturnType<typeof spawnProcess>;
  /** Bodies of the requests Codex sent to the local model server. */
  modelRequests: string[];
  /** A client connected through Codex's official proxy, initialized as `name`. */
  connect(name: string, version: string): Promise<{ client: RpcClient; userAgent: string }>;
  close(): Promise<void>;
}

/**
 * An isolated Codex app-server daemon whose model is a local server answering every request
 * with `reply(body)` after `delayMs(body)`.
 */
export async function startRealCodex(
  reply: (body: string) => string = () => "Local contract reply",
  delayMs: (body: string) => number = () => 0,
): Promise<RealCodex> {
  const codex = realCodexBinary();
  const temp = await mkdtemp(join(tmpdir(), "pbc-real-"));
  const home = join(temp, "home");
  await mkdir(home);
  const modelRequests: string[] = [];
  const modelServer = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", async () => {
      modelRequests.push(body);
      await delay(delayMs(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const id = `response_${modelRequests.length}`;
      const item = {
        id: `message_${modelRequests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply(body), annotations: [] }],
      };
      for (const event of [
        { type: "response.created", response: { id, status: "in_progress" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id,
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
  const close = async () => {
    await Promise.all(clients.map((client) => client.close()));
    await terminateProcess(daemon);
    modelServer.closeAllConnections();
    if (modelServer.listening)
      await new Promise<void>((resolve, reject) => {
        modelServer.close((error) => (error ? reject(error) : resolve()));
      });
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
  } catch (error) {
    await close();
    throw error;
  }
  return {
    codex,
    temp,
    env,
    socket,
    daemon,
    modelRequests,
    async connect(name, version) {
      const client = await connectRpc({
        command: codex,
        args: ["app-server", "proxy", "--sock", socket],
        env,
      });
      clients.push(client);
      const { userAgent } = (await client.request("initialize", {
        clientInfo: { name, title: `Isolated ${name}`, version },
        capabilities: { experimentalApi: true },
      })) as { userAgent: string };
      await client.notify("initialized", {});
      return { client, userAgent };
    },
    close,
  };
}

import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { CODEX_VERSION, codexHome, readPages, readPointer, threadSchema } from "./protocol.js";
import { connectRpc, type RpcClient } from "./rpc.js";
import { AttachedThread } from "./thread.js";

export const PROVIDER_ID = "codex-terminal";
export const AGENT_ID_ENV = "PASEO_BRIDGE_CODEX_AGENT_ID";
export const CAPABILITIES = [
  "prompt.message",
  "prompt.steer",
  "session.list",
  "session.persistence",
  "permission",
] as const;

const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_ATTACHMENTS = 128;

export function createBridgeProvider(
  readHostTurn: (agentId: string) => Promise<string | null>,
  factory: typeof connectRpc = connectRpc,
): {
  registration: ProviderRegistration;
  activate(agentId: string): Promise<boolean>;
} {
  const attachments = new Map<string, AttachedThread>();
  return {
    registration: {
      id: PROVIDER_ID,
      label: "Codex Terminal",
      description: "Existing shared-daemon Codex CLI threads",
      command: ["codex"],
      async status({ launch }) {
        if (!launch)
          return {
            available: false,
            diagnostic: "Resolved Codex launch configuration is required",
          };
        try {
          const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
            env: launch.env,
            timeout: 5000,
          });
          if (stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
            return {
              available: false,
              diagnostic: `Codex ${CODEX_VERSION} is required; found ${stdout.trim()}`,
            };
          return { available: true };
        } catch (error) {
          return { available: false, diagnostic: message(error) };
        }
      },
      async connect(request) {
        if (!request.versions.includes(1)) throw new Error("Paseo provider protocol 1 is required");
        if (!request.launch) throw new Error("Resolved Codex launch configuration is required");
        const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
        return connection(request.launch, capabilities, factory, attachments, readHostTurn);
      },
    },
    async activate(agentId) {
      const thread = attachments.get(agentId);
      if (!thread)
        throw new Error(
          "Codex attachment is not loaded; fetch its Paseo timeline before activation",
        );
      return thread.activate();
    },
  };
}

function connection(
  launch: ProviderLaunch,
  capabilities: readonly string[],
  factory: typeof connectRpc,
  attachments: Map<string, AttachedThread>,
  readHostTurn: (agentId: string) => Promise<string | null>,
): ProviderConnection {
  const home = codexHome(launch);
  const sessions = new Map<string, AttachedThread>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let rpc: RpcClient | undefined;
  let connecting: Promise<RpcClient> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = RECONNECT_DELAY_MS;
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };

  function scheduleReconnect(): void {
    if (closed || reconnectTimer || sessions.size === 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void (async () => {
        try {
          const client = await getRpc();
          for (const thread of sessions.values()) await thread.reattach(client);
          retryDelayMs = RECONNECT_DELAY_MS;
        } catch (error) {
          const failed = rpc;
          rpc = undefined;
          if (failed) await failed.close();
          for (const thread of sessions.values()) thread.disconnect(new Error(message(error)));
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_RECONNECT_DELAY_MS);
          scheduleReconnect();
        }
      })();
    }, retryDelayMs);
  }

  async function getRpc(): Promise<RpcClient> {
    if (closed) throw new Error("Provider connection is closed");
    if (rpc) return rpc;
    if (connecting) return connecting;
    const pending = (async () => {
      const client = await factory({
        ...launch,
        args: [
          ...launch.args,
          "app-server",
          "proxy",
          "--sock",
          join(home, "app-server-control", "app-server-control.sock"),
        ],
      });
      client.onMessage((event) => {
        try {
          for (const thread of sessions.values()) thread.accept(event);
        } catch (error) {
          for (const thread of sessions.values())
            thread.disconnect(new Error(`Invalid Codex event: ${message(error)}`));
          void client.close();
        }
      });
      client.onClose((error) => {
        if (rpc !== client) return;
        rpc = undefined;
        for (const thread of sessions.values()) thread.disconnect(error);
        scheduleReconnect();
      });
      try {
        const response = z.object({ userAgent: z.string() }).parse(
          await client.request("initialize", {
            clientInfo: { name: "paseo_bridge_codex", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          }),
        );
        if (
          !new RegExp(`(?:^|[ /])${CODEX_VERSION.replaceAll(".", "\\.")}(?:$|[^0-9.])`).test(
            response.userAgent,
          )
        )
          throw new Error(
            `Shared Codex daemon must be ${CODEX_VERSION}; received ${response.userAgent}`,
          );
        await client.notify("initialized", {});
        if (closed) throw new Error("Provider closed during connection");
        rpc = client;
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    })();
    connecting = pending;
    try {
      return await pending;
    } finally {
      if (connecting === pending) connecting = undefined;
    }
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    requireProviderCapabilities(capabilities, input);
    if (input.type === "catalog") {
      emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } });
    } else if (input.type === "sessions") {
      const client = await getRpc();
      const ids = new Set(await readPages(client, "thread/loaded/list", {}, z.string()));
      const stored = await readPages(
        client,
        "thread/list",
        {
          archived: false,
          sourceKinds: ["cli", "vscode"],
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
          useStateDbOnly: true,
        },
        threadSchema,
      );
      const found = [];
      for (const saved of stored) {
        if (!ids.has(saved.id)) continue;
        const { thread } = z
          .object({ thread: threadSchema })
          .parse(await client.request("thread/read", { threadId: saved.id, includeTurns: false }));
        const terminal =
          thread.source === "cli" ||
          (thread.source === "vscode" && thread.originator === "codex-tui");
        if (
          !terminal ||
          thread.parentThreadId !== null ||
          thread.ephemeral ||
          thread.canAcceptDirectInput !== true
        )
          continue;
        if (input.cwd && input.cwd !== thread.cwd) continue;
        const title = thread.name ?? thread.preview ?? thread.id;
        if (
          input.query &&
          !`${title} ${thread.cwd}`.toLowerCase().includes(input.query.toLowerCase())
        )
          continue;
        found.push({
          persistence: { version: 1, data: { threadId: thread.id, codexHome: home } },
          cwd: thread.cwd,
          title,
          description: thread.preview,
          updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
        });
      }
      found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: input.limit === undefined ? found : found.slice(0, input.limit),
      });
    } else if (input.type === "session.open") {
      if (sessions.size >= MAX_ATTACHMENTS)
        throw new Error(`Codex attachment limit exceeded (${MAX_ATTACHMENTS})`);
      if (sessions.has(input.sessionId)) throw new Error("Paseo session is already attached");
      const pointer = readPointer(input.persistence, home);
      if ([...sessions.values()].some((thread) => thread.threadId === pointer.data.threadId))
        throw new Error("Codex thread is already attached in this provider connection");
      const agentId = input.config.env[AGENT_ID_ENV];
      if (!agentId)
        throw new Error("Codex Terminal session-open hook did not supply the Paseo agent identity");
      const client = await getRpc();
      const thread = new AttachedThread(
        input.sessionId,
        agentId,
        pointer.data.threadId,
        pointer,
        emit,
        readHostTurn,
      );
      sessions.set(input.sessionId, thread);
      attachments.set(agentId, thread);
      emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities,
        restoration: "core",
        persistence: pointer,
        cwd: input.config.cwd,
      });
      try {
        await thread.hydrate(client);
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      } catch (error) {
        sessions.delete(input.sessionId);
        if (attachments.get(agentId) === thread) attachments.delete(agentId);
        await thread.close();
        throw error;
      }
    } else if ("sessionId" in input) {
      const thread = sessions.get(input.sessionId);
      if (!thread) throw new Error("Unknown Codex attachment");
      if (input.type === "session.close") {
        sessions.delete(input.sessionId);
        if (attachments.get(thread.agentId) === thread) attachments.delete(thread.agentId);
        await thread.close();
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
      } else if (
        input.type === "session.prompt" ||
        input.type === "session.permission" ||
        input.type === "session.interrupt"
      ) {
        await thread.send(input);
        if (input.type === "session.interrupt")
          emit({ type: "request.completed", requestId: input.requestId });
      } else throw new Error(`Unsupported Codex Terminal operation: ${input.type}`);
    } else throw new Error(`Unsupported Codex Terminal operation: ${input.type}`);
  }

  return {
    version: 1,
    capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      try {
        await dispatch(input);
      } catch (error) {
        if ("requestId" in input)
          emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: message(error) },
          });
        else if (input.type === "session.prompt")
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: { message: message(error) } },
          });
        else throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const thread of sessions.values()) {
        if (attachments.get(thread.agentId) === thread) attachments.delete(thread.agentId);
        thread.disconnect(new Error("Provider closed"));
        await thread.close();
      }
      sessions.clear();
      if (rpc) await rpc.close();
      if (connecting) await connecting.catch(() => undefined);
      listeners.clear();
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

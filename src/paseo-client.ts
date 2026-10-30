import { randomUUID } from "node:crypto";
import { createHostClient } from "@getpaseo/client/node";
// FALLBACK: Paseo's daemon-control export pulls createRequire(import.meta.url)
// into its CommonJS plugin bundle. Import the pinned owning modules until that export is bundle-safe.
import { readLocalCredentialForTarget } from "../node_modules/@getpaseo/server/dist/server/server/local-credential.js";
import { resolvePaseoHome } from "../node_modules/@getpaseo/server/dist/server/server/paseo-home.js";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
} from "../node_modules/@getpaseo/server/dist/server/server/pid-lock.js";
import type { AttachedAgent, DiscoveryClient } from "./discovery.js";

const DIRECTORY_PAGE_SIZE = 200;
const MAX_DIRECTORY_PAGES = 100;
const MAX_DISCOVERED_SESSIONS = 200;
const CONNECTION_TIMEOUT_MS = 10_000;

export async function connectPaseoHost(
  home?: string,
  signal?: AbortSignal,
): Promise<{
  client: ReturnType<typeof createHostClient>;
  discovery: DiscoveryClient;
  close(): Promise<void>;
}> {
  const paseoHome = resolvePaseoHome(home ? { PASEO_HOME: home } : process.env);
  signal?.throwIfAborted();
  const instance = await getPidLockInfo(paseoHome);
  signal?.throwIfAborted();
  if (!instance || !isPidLockOwnerRunning(instance))
    throw new Error(`Paseo is not running for ${paseoHome}`);
  const { listen } = instance;
  if (!listen) throw new Error(`Paseo is not ready for ${paseoHome}`);
  const client = createHostClient(listen, {
    clientId: randomUUID(),
    clientType: "cli",
    localCredential: () => readLocalCredentialForTarget(paseoHome, listen) ?? undefined,
    connectTimeoutMs: CONNECTION_TIMEOUT_MS,
    reconnect: { enabled: false },
  });
  const abort = () => {
    void client.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const close = async () => {
    signal?.removeEventListener("abort", abort);
    await client.close();
  };
  try {
    await client.connect();
    signal?.throwIfAborted();
    return {
      client,
      close,
      discovery: {
        async sessions() {
          const response = await client.fetchRecentProviderSessions({
            providers: ["codex-terminal"],
            limit: MAX_DISCOVERED_SESSIONS,
          });
          const providerError = response.providerErrors?.find(
            (error) => error.provider === "codex-terminal",
          );
          if (providerError) throw new Error(providerError.message);
          if (response.entries.length >= MAX_DISCOVERED_SESSIONS)
            throw new Error(
              "Discovery session limit reached; refusing a potentially incomplete scan",
            );
          return response.entries;
        },
        async agents() {
          const agents: AttachedAgent[] = [];
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < MAX_DIRECTORY_PAGES; pageIndex++) {
            const response = await client.fetchAgents({
              filter: { includeArchived: true, includeBackground: true },
              page: { limit: DIRECTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            });
            agents.push(...response.entries.map((entry) => entry.agent));
            if (!response.pageInfo.hasMore) return agents;
            const nextCursor = response.pageInfo.nextCursor;
            if (!nextCursor || nextCursor === cursor)
              throw new Error("Paseo directory pagination did not advance");
            cursor = nextCursor;
          }
          throw new Error("Paseo directory page limit reached");
        },
        importSession: (session) =>
          client.importAgent({
            providerId: session.providerId,
            providerHandleId: session.providerHandleId,
            cwd: session.cwd,
            labels: { "bridge.owner": "paseo-bridge-codex" },
          }),
        async load(agentId) {
          await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 1 });
        },
        async activate(agentId) {
          await client.invokePluginRpc("paseo-bridge-codex", "activate", { agentId });
        },
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

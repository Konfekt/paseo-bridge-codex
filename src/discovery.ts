import { setTimeout as delay } from "node:timers/promises";

export interface DiscoverableSession {
  providerId: string;
  providerHandleId: string;
  cwd: string;
}
export interface AttachedAgent {
  id: string;
  provider: string;
  persistence: { sessionId: string } | null;
  archivedAt?: string | null | undefined;
}
export interface DiscoveryClient {
  sessions(): Promise<DiscoverableSession[]>;
  agents(): Promise<AttachedAgent[]>;
  importSession(session: DiscoverableSession): Promise<AttachedAgent>;
  load(agentId: string): Promise<void>;
  activate(agentId: string): Promise<void>;
}
const PROVIDER_ID = "codex-terminal";

export async function discoverOnce(client: DiscoveryClient, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const sessions = await client.sessions();
  signal?.throwIfAborted();
  const agents = await client.agents();
  const failures: Error[] = [];
  const recordFailure = (identity: string, cause: unknown) => {
    signal?.throwIfAborted();
    failures.push(
      new Error(`${identity}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
      }),
    );
  };
  for (const agent of agents) {
    signal?.throwIfAborted();
    if (agent.provider !== PROVIDER_ID || agent.archivedAt || !agent.persistence) continue;
    try {
      await client.load(agent.id);
      await client.activate(agent.id);
    } catch (error) {
      recordFailure(`Agent ${agent.id}`, error);
    }
  }
  for (const session of sessions) {
    signal?.throwIfAborted();
    if (session.providerId !== PROVIDER_ID) continue;
    if (
      agents.some(
        (agent) =>
          agent.provider === PROVIDER_ID &&
          agent.persistence?.sessionId === session.providerHandleId,
      )
    )
      continue;
    let imported: AttachedAgent;
    try {
      imported = await client.importSession(session);
    } catch (error) {
      // An import can succeed before its response is lost, or race another worker.
      const reconciled = (await client.agents()).find(
        (agent) =>
          agent.provider === PROVIDER_ID &&
          agent.persistence?.sessionId === session.providerHandleId,
      );
      if (!reconciled) {
        recordFailure(`Session ${session.providerHandleId}`, error);
        continue;
      }
      if (reconciled.archivedAt) continue;
      try {
        await client.load(reconciled.id);
      } catch (error) {
        recordFailure(`Agent ${reconciled.id}`, error);
        continue;
      }
      imported = reconciled;
    }
    agents.push(imported);
    try {
      await client.activate(imported.id);
    } catch (error) {
      recordFailure(`Agent ${imported.id}`, error);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Discovery attachment failures: ${failures.map((error) => error.message).join("; ")}`,
    );
  }
}

const POLL_INTERVAL_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

export async function watchDiscovery(
  connect: () => Promise<{ discovery: DiscoveryClient; close(): Promise<void> }>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<void> {
  let retryDelayMs = POLL_INTERVAL_MS;
  while (!signal.aborted) {
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      connection = await connect();
      await discoverOnce(connection.discovery, signal);
      retryDelayMs = POLL_INTERVAL_MS;
    } catch (error) {
      if (!signal.aborted) {
        onError(error);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    } finally {
      await connection?.close();
    }
    if (signal.aborted) return;
    try {
      await delay(retryDelayMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

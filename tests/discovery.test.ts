import { expect, test } from "vitest";
import {
  type AttachedAgent,
  type DiscoveryClient,
  discoverOnce,
  watchDiscovery,
} from "../src/discovery.js";

test("imports each missing terminal once, preserves archives and loads existing unlabelled attachments", async () => {
  const agents: AttachedAgent[] = [
    { id: "existing", provider: "codex-terminal", persistence: { sessionId: "opaque-a" } },
    {
      id: "archived",
      provider: "codex-terminal",
      persistence: { sessionId: "opaque-b" },
      archivedAt: "2026-01-01",
    },
  ];
  const available = ["opaque-a", "opaque-b", "opaque-c"].map((providerHandleId) => ({
    providerId: "codex-terminal",
    providerHandleId,
    cwd: "/work",
  }));
  const loaded: string[] = [],
    activated: string[] = [],
    imported: string[] = [];
  const client: DiscoveryClient = {
    sessions: async () => available,
    agents: async () => [...agents],
    importSession: async (session) => {
      imported.push(session.providerHandleId);
      const agent = {
        id: "new",
        provider: session.providerId,
        persistence: { sessionId: session.providerHandleId },
      };
      agents.push(agent);
      return agent;
    },
    load: async (id) => {
      loaded.push(id);
    },
    activate: async (id) => {
      activated.push(id);
    },
  };
  await discoverOnce(client);
  await discoverOnce(client);
  expect(imported).toEqual(["opaque-c"]);
  expect(loaded).toEqual(["existing", "existing", "new"]);
  expect(activated).toEqual(["existing", "new", "existing", "new"]);
});

test("reconciles an import whose response was lost without retrying the mutation", async () => {
  const shared: AttachedAgent[] = [];
  const activated: string[] = [];
  let imports = 0;
  const client: DiscoveryClient = {
    sessions: async () => [
      { providerId: "codex-terminal", providerHandleId: "opaque", cwd: "/work" },
    ],
    agents: async () => [...shared],
    importSession: async () => {
      imports++;
      shared.push({
        id: "raced",
        provider: "codex-terminal",
        persistence: { sessionId: "opaque" },
      });
      throw new Error("response lost");
    },
    load: async () => {},
    activate: async (id) => {
      activated.push(id);
    },
  };
  await discoverOnce(client);
  expect(imports).toBe(1);
  expect(activated).toEqual(["raced"]);
});

test("watch cancellation closes the owned client and prevents another pass", async () => {
  const controller = new AbortController();
  let connections = 0,
    closed = 0;
  await watchDiscovery(
    async () => {
      connections++;
      return {
        close: async () => {
          closed++;
        },
        discovery: {
          sessions: async () => {
            controller.abort();
            return [];
          },
          agents: async () => [],
          importSession: async () => {
            throw new Error("unexpected import");
          },
          load: async () => {},
          activate: async () => {},
        },
      };
    },
    controller.signal,
    () => {},
  );
  expect(connections).toBe(1);
  expect(closed).toBe(1);
});

test("a deleted attachment reports its failure without starving new terminal threads across passes", async () => {
  const deleted = new Error("native thread was deleted");
  const agents: AttachedAgent[] = [
    { id: "deleted-agent", provider: "codex-terminal", persistence: { sessionId: "old" } },
  ];
  const imports: string[] = [];
  const activations: string[] = [];
  const client: DiscoveryClient = {
    sessions: async () => [{ providerId: "codex-terminal", providerHandleId: "new", cwd: "/work" }],
    agents: async () => [...agents],
    importSession: async (session) => {
      imports.push(session.providerHandleId);
      const agent = {
        id: "new-agent",
        provider: session.providerId,
        persistence: { sessionId: session.providerHandleId },
      };
      agents.push(agent);
      return agent;
    },
    load: async (id) => {
      if (id === "deleted-agent") throw deleted;
    },
    activate: async (id) => {
      activations.push(id);
    },
  };
  const failures: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    try {
      await discoverOnce(client);
    } catch (error) {
      failures.push(error);
    }
  }
  expect(imports).toEqual(["new"]);
  expect(activations).toEqual(["new-agent", "new-agent"]);
  expect(failures).toHaveLength(2);
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain("deleted-agent");
    expect((failure as AggregateError).message).toContain("native thread was deleted");
    expect((failure as AggregateError).errors[0].cause).toBe(deleted);
  }
});

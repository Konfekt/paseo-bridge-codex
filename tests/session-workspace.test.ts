import { expect, test } from "vitest";
import {
  importIntoSessionWorkspace,
  sessionWorkspaceId,
  sessionWorkspaceTitle,
  type WorkspaceHost,
} from "../src/session-workspace.js";

const session = {
  providerId: "codex-terminal",
  providerHandleId: 'plugin:{"version":1,"data":{"threadId":"t1"}}',
  cwd: "/work/project",
  title: "Fix   the\nparser",
  firstPromptPreview: "ignored",
};

function fakeHost(existing = new Set<string>(), createError?: Error, archived = new Set<string>()) {
  const calls: Array<{ op: string; workspaceId?: string; title?: string }> = [];
  const host: WorkspaceHost<{ id: string; workspaceId: string | undefined }> = {
    async importAgent(input) {
      calls.push({
        op: "import",
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      });
      expect(input.labels).toEqual({ "bridge.owner": "paseo-bridge-codex" });
      if (
        input.workspaceId &&
        (!existing.has(input.workspaceId) || archived.has(input.workspaceId))
      )
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      return { id: "agent", workspaceId: input.workspaceId };
    },
    async createWorkspace(input) {
      calls.push({
        op: "create",
        workspaceId: input.workspaceId,
        ...(input.title ? { title: input.title } : {}),
      });
      expect(input.source).toEqual({ kind: "directory", path: "/work/project" });
      if (createError) throw createError;
      if (existing.has(input.workspaceId))
        return { workspace: null, error: "workspace_id_conflict" };
      existing.add(input.workspaceId);
      return { workspace: { id: input.workspaceId }, error: null };
    },
  };
  return { host, calls, existing };
}

test("each terminal thread gets its own stable workspace instead of the folder's shared one", () => {
  const id = sessionWorkspaceId(session.providerHandleId);
  expect(id).toMatch(/^wks_[a-f0-9]{16}$/);
  expect(sessionWorkspaceId(session.providerHandleId)).toBe(id);
  expect(sessionWorkspaceId(session.providerHandleId.replace("t1", "t2"))).not.toBe(id);
});

test("creates the thread workspace on first import and reuses it afterwards", async () => {
  const { host, calls, existing } = fakeHost();
  const id = sessionWorkspaceId(session.providerHandleId);
  expect(await importIntoSessionWorkspace(host, session)).toEqual({ id: "agent", workspaceId: id });
  expect(calls).toEqual([
    { op: "create", workspaceId: id, title: "Fix the parser" },
    { op: "import", workspaceId: id },
  ]);
  expect(existing.has(id)).toBe(true);
  calls.length = 0;
  // A retry after a lost import response finds the workspace already created.
  expect(await importIntoSessionWorkspace(host, session)).toEqual({ id: "agent", workspaceId: id });
  expect(calls.map((call) => call.op)).toEqual(["create", "import"]);
});

test("falls back to the folder workspace when the host cannot create one", async () => {
  const failures: unknown[] = [];
  const { host, calls } = fakeHost(new Set(), new Error("unsupported"));
  expect(await importIntoSessionWorkspace(host, session, (error) => failures.push(error))).toEqual({
    id: "agent",
    workspaceId: undefined,
  });
  expect(calls).toEqual([expect.objectContaining({ op: "create" }), { op: "import" }]);
  expect(failures).toHaveLength(1);
});

test("an archived thread workspace sends the thread to the folder workspace", async () => {
  const id = sessionWorkspaceId(session.providerHandleId);
  const { host, calls } = fakeHost(new Set([id]), undefined, new Set([id]));
  expect(await importIntoSessionWorkspace(host, session)).toEqual({
    id: "agent",
    workspaceId: undefined,
  });
  expect(calls.map((call) => call.op)).toEqual(["create", "import", "import"]);
});

test("other import failures are not masked by the fallback", async () => {
  const host: WorkspaceHost<never> = {
    importAgent: async () => {
      throw new Error("Provider session is already imported");
    },
    createWorkspace: async () => ({ error: null }),
  };
  await expect(importIntoSessionWorkspace(host, session)).rejects.toThrow("already imported");
});

test("titles fall back to the first prompt and are bounded", () => {
  expect(sessionWorkspaceTitle({ ...session, title: null, firstPromptPreview: "  hi  " })).toBe(
    "hi",
  );
  expect(
    sessionWorkspaceTitle({ ...session, title: null, firstPromptPreview: null }),
  ).toBeUndefined();
  const long = sessionWorkspaceTitle({ ...session, title: "x".repeat(200) });
  expect(long).toHaveLength(80);
  expect(long?.endsWith("…")).toBe(true);
});

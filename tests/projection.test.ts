import { describe, expect, it } from "vitest";
import { permissionId, permissionResult, projectPermission } from "../src/permissions.js";
import { projectItem } from "../src/timeline.js";

describe("native timeline snapshots", () => {
  it("retains native identity across authoritative message snapshots", () => {
    const initial = projectItem({ type: "agentMessage", id: "message", text: "Hello" });
    expect(projectItem({ type: "agentMessage", id: "message", text: "Hello world" })).toEqual({
      type: "assistant_message",
      id: "message",
      text: "Hello world",
    });
    expect(initial).toEqual({ type: "assistant_message", id: "message", text: "Hello" });
  });
});

describe("native approvals", () => {
  it("preserves request-id types and only permits the offered decision", () => {
    const params = {
      threadId: "thread",
      turnId: "turn",
      itemId: "command",
      command: "pwd",
      cwd: "/project",
      availableDecisions: ["accept", "cancel"],
    };
    const request = projectPermission(1, "item/commandExecution/requestApproval", params);
    expect(permissionId(1)).not.toBe(permissionId("1"));
    expect(request?.actions?.map((action) => action.id)).toEqual(["accept", "cancel"]);
    expect(
      permissionResult("item/commandExecution/requestApproval", params, {
        behavior: "allow",
        selectedActionId: "accept",
      }),
    ).toEqual({ decision: "accept" });
    expect(() =>
      permissionResult("item/commandExecution/requestApproval", params, {
        behavior: "allow",
        selectedActionId: "acceptForSession",
      }),
    ).toThrow();
  });
});

it("renders reasoning and full shell output while retaining other native content truthfully", () => {
  expect(
    projectItem({ type: "reasoning", id: "r", summary: ["First thought"], content: ["Detail"] }),
  ).toMatchObject({ type: "reasoning", text: "First thought\nDetail" });
  expect(
    projectItem({
      type: "commandExecution",
      id: "c",
      command: "pwd",
      cwd: "/project",
      status: "inProgress",
      aggregatedOutput: "/project\n",
      exitCode: null,
    }),
  ).toMatchObject({ type: "tool_call", status: "running", detail: { output: "/project\n" } });
  expect(
    projectItem({ type: "collabAgentToolCall", id: "child", status: "interrupted" }),
  ).toMatchObject({ type: "tool_call", status: "canceled" });
  expect(
    projectItem({
      type: "imageGeneration",
      id: "image",
      status: "native_custom_status",
      result: "data",
    }),
  ).toMatchObject({
    type: "notification",
    message: expect.stringContaining("native_custom_status"),
  });
  expect(projectItem({ type: "webSearch", id: "search", query: "Q" })).toMatchObject({
    type: "notification",
    message: expect.stringContaining('"query": "Q"'),
  });
  expect(() => projectItem({ type: "agentMessage", id: "bad", text: 12 })).toThrow();
});

it("maps question answers by native identity and leaves secret questions terminal-owned", () => {
  const params = {
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Select",
        isOther: false,
        isSecret: false,
        options: [{ label: "One", description: "First" }],
      },
    ],
  };
  expect(projectPermission("q", "item/tool/requestUserInput", params)).toMatchObject({
    kind: "question",
    input: { questions: [{ header: "Choice", options: [{ label: "One" }] }] },
  });
  expect(
    permissionResult("item/tool/requestUserInput", params, {
      behavior: "allow",
      updatedInput: { answers: { Choice: "One" } },
    }),
  ).toEqual({ answers: { q: { answers: ["One"] } } });
  expect(() =>
    permissionResult("item/tool/requestUserInput", params, {
      behavior: "allow",
      updatedInput: { answers: { Choice: "Unlisted" } },
    }),
  ).toThrow();
  expect(
    projectPermission("q", "item/tool/requestUserInput", {
      questions: [{ ...params.questions[0], isSecret: true }],
    }),
  ).toBeUndefined();
  expect(
    projectPermission("q", "mcpServer/elicitation/request", { mode: "openai/userVerification" }),
  ).toBeUndefined();
});

it("grants exactly requested permission profile for one turn only", () => {
  const params = {
    permissions: { network: { enabled: true }, fileSystem: null },
    reason: "Network access",
  };
  expect(projectPermission("p", "item/permissions/requestApproval", params)).toMatchObject({
    kind: "tool",
  });
  expect(
    permissionResult("item/permissions/requestApproval", params, { behavior: "allow" }),
  ).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  expect(
    permissionResult("item/permissions/requestApproval", params, { behavior: "deny" }),
  ).toEqual({ permissions: {}, scope: "turn" });
});

it("returns validated MCP form values without accepting unsupported forms", () => {
  const params = {
    mode: "form",
    message: "Name",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string", title: "Display name" } },
      required: ["name"],
    },
  };
  expect(projectPermission("m", "mcpServer/elicitation/request", params)).toMatchObject({
    kind: "question",
    input: { questions: [{ header: "name" }] },
  });
  expect(
    permissionResult("mcpServer/elicitation/request", params, {
      behavior: "allow",
      updatedInput: { answers: { name: "Ada" } },
    }),
  ).toEqual({ action: "accept", content: { name: "Ada" }, _meta: null });
  expect(
    projectPermission("m", "mcpServer/elicitation/request", {
      ...params,
      requestedSchema: { type: "object", properties: { nested: { type: "object" } } },
    }),
  ).toBeUndefined();
});

it("classifies network policy decisions by action rather than hostname text", () => {
  const decision = {
    applyNetworkPolicyAmendment: { network_policy_amendment: { host: "deny", action: "allow" } },
  };
  const params = { availableDecisions: [decision] };
  const request = projectPermission("network", "item/commandExecution/requestApproval", params);
  expect(request?.actions?.[0]?.behavior).toBe("allow");
  expect(
    permissionResult("item/commandExecution/requestApproval", params, {
      behavior: "allow",
      selectedActionId: JSON.stringify(decision),
    }),
  ).toEqual({ decision });
});

import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { afterEach, expect, test, vi } from "vitest";
import { connectRpc, type RpcClient, type RpcMessage } from "../src/rpc.js";

const launch: ProviderLaunch = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url))],
  env: { BRIDGE_RPC_TEST: "exact environment" },
};
const clients: RpcClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("bounds a response write when the proxy stops consuming input", async () => {
  const client = await connectRpc({ ...launch, args: [...launch.args, "stalled-input"] });
  clients.push(client);
  vi.useFakeTimers();
  let outcome: unknown;
  void client.respond("approval", "x".repeat(7 * 1024 * 1024)).catch((error: unknown) => {
    outcome = error;
  });
  let overflow: unknown;
  void client.respond("approval-2", "x".repeat(2 * 1024 * 1024)).catch((error: unknown) => {
    overflow = error;
  });
  await Promise.resolve();
  expect(overflow).toBeInstanceOf(Error);
  expect((overflow as Error).message).toContain("byte capacity exceeded");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("write timed out");
});

test("correlates concurrent native replies and delivers live requests through the owned proxy", async () => {
  const client = await connectRpc(launch);
  clients.push(client);
  const messages: RpcMessage[] = [];
  client.onMessage((message) => messages.push(message));
  const first = client.request("first", {});
  const second = client.request("second", {});
  await expect(second).resolves.toBe("second response");
  await expect(first).resolves.toBe("first response");
  expect(messages).toEqual([
    { method: "notice", params: { live: true } },
    { method: "approval", id: "native-1", params: { command: "pwd" } },
  ]);
  await expect(client.request("failure", {})).rejects.toThrow("native rejection");
  const answered = new Promise<RpcMessage>((resolve) => {
    client.onMessage((message) => {
      if (message.method === "answered") resolve(message);
    });
  });
  await client.respond("native-1", { decision: "accept" });
  expect((await answered).params).toEqual({ id: "native-1", result: { decision: "accept" } });
  const notified = new Promise<RpcMessage>((resolve) => {
    client.onMessage((message) => {
      if (message.method === "notified") resolve(message);
    });
  });
  await client.notify("client-notification", { initialized: true });
  expect((await notified).params).toEqual({
    method: "client-notification",
    params: { initialized: true },
  });
});

test("uses exactly the launch environment and terminates only its owned child on close", async () => {
  vi.stubEnv("BRIDGE_RPC_PARENT", "must not leak");
  const client = await connectRpc(launch);
  clients.push(client);
  const identity = (await client.request("identity", {})) as {
    pid: number;
    env: string;
    inherited?: string;
  };
  expect(identity).toMatchObject({ env: "exact environment" });
  expect(identity.inherited).toBeUndefined();
  const pending = client.request("hold", {}).catch((error: unknown) => error);
  await client.close();
  expect(await pending).toBeInstanceOf(Error);
  expect(() => process.kill(identity.pid, 0)).toThrow();
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  await expect(client.request("identity", {})).rejects.toThrow("closed");
});

test.each([
  ["malformed", /Invalid RPC proxy output.*JSON/],
  ["oversized", /Max payload size exceeded/],
  ["unterminated", /closed \(code 1006\)/],
] as const)("rejects pending work and reports the %s frame boundary", async (mode, expected) => {
  const client = await connectRpc({ ...launch, args: [...launch.args, mode] });
  clients.push(client);
  const error = await new Promise<Error>((resolve) => client.onClose(resolve));
  expect(error.message).toMatch(expected);
  await expect(client.request("identity", {})).rejects.toThrow(expected);
});

test("keeps bounded native stderr diagnostics when the proxy exits", async () => {
  const client = await connectRpc({ ...launch, args: [...launch.args, "stderr"] });
  clients.push(client);
  const result = await client.request("hold", {}).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("native failure diagnostic");
  expect(Buffer.byteLength((result as Error).message)).toBeLessThan(17 * 1024);
});

test("bounds pending requests without dropping admitted work and decodes fragmented UTF-8", async () => {
  const client = await connectRpc(launch);
  clients.push(client);
  const pending = Array.from({ length: 128 }, () =>
    client.request("hold", {}).catch((error: unknown) => error),
  );
  await expect(client.request("identity", {})).rejects.toThrow("capacity exceeded");
  await client.close();
  expect((await Promise.all(pending)).every((result) => result instanceof Error)).toBe(true);
  const fragmented = await connectRpc(launch);
  clients.push(fragmented);
  await expect(fragmented.request("fragmented", {})).resolves.toBe("a🌲z");
});

test("expires unknown-outcome mutations once and ignores their late replies", async () => {
  const client = await connectRpc(launch);
  clients.push(client);
  await expect(client.request("slow", {})).rejects.toThrow("operation outcome is unknown");
  await delay(200);
  await expect(client.request("identity", {})).resolves.toMatchObject({ env: "exact environment" });
}, 20_000);

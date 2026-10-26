import { isAbsolute, resolve } from "node:path";
import type { ProviderLaunch, ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { RpcClient } from "./rpc.js";

export const CODEX_VERSION = "0.164.0";
export const MAX_ITEMS = 10_000;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
export const pointerSchema = z
  .object({
    version: z.literal(1),
    data: z.object({ threadId: z.string().min(1).max(200), codexHome: z.string().min(1) }).strict(),
  })
  .strict();
export const threadStatusSchema = z.object({
  type: z.enum(["notLoaded", "idle", "systemError", "active"]),
});
export const threadSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  source: z.json(),
  originator: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  ephemeral: z.boolean(),
  canAcceptDirectInput: z.boolean().nullable(),
  name: z.string().nullable(),
  preview: z.string(),
  updatedAt: z.number(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  status: threadStatusSchema,
});
export const turnSchema = z.object({
  id: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
  error: z.object({ message: z.string() }).nullable().optional(),
});
export type NativeTurn = z.infer<typeof turnSchema>;
export const itemEntrySchema = z.object({
  turnId: z.string(),
  item: z.unknown(),
  startedAtMs: z.number().nullable(),
  completedAtMs: z.number().nullable(),
});

export function codexHome(launch: ProviderLaunch): string {
  const configured = launch.env["CODEX_HOME"];
  const userHome = launch.env["HOME"] ?? launch.env["USERPROFILE"];
  if (!configured && !userHome) throw new Error("Provider environment requires CODEX_HOME or HOME");
  const home = configured ?? `${userHome}/.codex`;
  if (!isAbsolute(home)) throw new Error("CODEX_HOME must be absolute");
  return resolve(home);
}

export function readPointer(
  value: ProviderPersistence | undefined,
  home: string,
): z.infer<typeof pointerSchema> {
  if (!value)
    throw new Error(
      "Codex Terminal attaches existing threads; use the discovery worker or import a session",
    );
  const pointer = pointerSchema.parse(value);
  if (pointer.data.codexHome !== home)
    throw new Error("Thread pointer belongs to a different CODEX_HOME");
  return pointer;
}

export async function readPages<T>(
  rpc: RpcClient,
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = z
      .object({ data: z.array(schema), nextCursor: z.string().nullable() })
      .parse(await rpc.request(method, { ...params, limit: PAGE_SIZE, cursor }));
    result.push(...response.data);
    if (result.length > MAX_ITEMS) throw new Error(`${method} item limit exceeded (${MAX_ITEMS})`);
    if (response.nextCursor === null) return result;
    if (cursors.has(response.nextCursor)) throw new Error(`${method} repeated pagination cursor`);
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error(`${method} page limit exceeded (${MAX_PAGES})`);
}

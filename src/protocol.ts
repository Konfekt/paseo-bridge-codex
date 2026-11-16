import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ProviderLaunch, ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { RpcClient } from "./rpc.js";

/** Oldest Codex release whose app-server contract this bridge supports; older releases are rejected. */
export const CODEX_MIN_VERSION = "0.164.0";
/** Newest verified Codex release; patch releases of this minor line count as verified too. */
export const CODEX_TESTED_VERSION = "0.169.0";
const CODEX_TESTED_LINE = CODEX_TESTED_VERSION.replace(/\.\d+$/, ".x");

/**
 * `verified`: within the tested range. `tentative`: newer than the tested range, or a
 * pre-release at or above the minimum; accepted with a warning. `unsupported`: rejected.
 */
export type CodexSupport = "verified" | "tentative" | "unsupported";

interface Release {
  core: readonly [number, number, number];
  prerelease: boolean;
}

function parseRelease(version: string): Release | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

function compareCores(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Classify `version` against an inclusive minimum and a tested minor line. */
function releaseSupport(version: string, minimum: string, tested: string): CodexSupport {
  const release = parseRelease(version);
  const min = parseRelease(minimum);
  const top = parseRelease(tested);
  if (!release || !min || !top) return "unsupported";
  const versusMin = compareCores(release.core, min.core);
  // Semver orders a pre-release before its release, so 0.164.0-alpha is below the minimum.
  if (versusMin < 0 || (versusMin === 0 && release.prerelease)) return "unsupported";
  if (release.prerelease) return "tentative";
  const testedLineEnd = [top.core[0], top.core[1], Number.MAX_SAFE_INTEGER] as const;
  return compareCores(release.core, testedLineEnd) <= 0 ? "verified" : "tentative";
}

export function codexSupport(version: string): CodexSupport {
  return releaseSupport(version, CODEX_MIN_VERSION, CODEX_TESTED_VERSION);
}

export function isSupportedCodexVersion(version: string): boolean {
  return codexSupport(version) !== "unsupported";
}

export function codexVersionRequirement(found: string): string {
  return `Codex ${CODEX_MIN_VERSION} or newer is required; found ${found || "no version output"}`;
}

function tentativeReason(version: string, range: string): string {
  return parseRelease(version)?.prerelease
    ? `is a pre-release (tested range ${range})`
    : `is newer than the tested range (${range})`;
}

export function tentativeCodexWarning(component: string, version: string): string {
  return `${component} ${version} ${tentativeReason(version, `${CODEX_MIN_VERSION} to ${CODEX_TESTED_LINE}`)}; continuing tentatively. Report problems and pin a tested release if sessions misbehave.`;
}

const warnedVersions = new Set<string>();

/** Warn once per component and version, so periodic discovery does not flood the plugin log. */
function warnOnce(
  component: string,
  version: string,
  message: string,
  warn: (message: string) => void,
): string {
  const key = `${component}\u0000${version}`;
  if (!warnedVersions.has(key)) {
    warnedVersions.add(key);
    warn(message);
  }
  return message;
}

export function warnTentativeCodex(
  component: string,
  version: string,
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  if (codexSupport(version) !== "tentative") return undefined;
  return warnOnce(component, version, tentativeCodexWarning(component, version), warn);
}

/** Oldest Paseo host the manifest admits (`paseo-plugin.json`). */
export const PASEO_MIN_VERSION = "0.14.0";
/** Newest verified Paseo host; patch releases of this minor line count as verified too. */
export const PASEO_TESTED_VERSION = "0.15.4";

/**
 * Paseo itself enforces the manifest minimum, so only newer or pre-release hosts matter here.
 * An unknown host version (older hosts may omit it) is not warned about.
 */
export function warnTentativePaseo(
  version: string | null | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  if (!version || releaseSupport(version, PASEO_MIN_VERSION, PASEO_TESTED_VERSION) !== "tentative")
    return undefined;
  const range = `${PASEO_MIN_VERSION} to ${PASEO_TESTED_VERSION.replace(/\.\d+$/, ".x")}`;
  return warnOnce(
    "Paseo host",
    version,
    `Paseo host ${version} ${tentativeReason(version, range)}; continuing tentatively. Report problems and pin a tested release if discovery or attachments misbehave.`,
    warn,
  );
}

/** Extract the release from `codex --version` output, e.g. `codex-cli 0.169.0`. */
export function cliVersion(output: string): string | null {
  // Tolerate notices printed around the version line, e.g. update hints.
  return /^codex(?:-cli)? v?(\d\S*)[^\S\n]*$/m.exec(output)?.[1] ?? null;
}

/** Extract the daemon release from its initialize user agent, e.g. `codex_cli_rs/0.169.0 (...)`. */
export function userAgentVersion(userAgent: string): string | null {
  return /^[^\s/]+\/(\S+?)(?=$|\s)/.exec(userAgent.trim())?.[1] ?? null;
}
const MAX_LIST_ITEMS = 10_000;
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 200;
const HISTORY_SCAN_TIMEOUT_MS = 60_000;
const MAX_CURSOR_FINGERPRINTS = 256;
export const pointerSchema = z
  .object({
    version: z.literal(1),
    data: z.object({ threadId: z.string().min(1).max(200), codexHome: z.string().min(1) }).strict(),
  })
  .strict();
// Known types: notLoaded, idle, systemError, active. Only "active" is interpreted, so a status
// type added by a newer Codex must not invalidate thread reads or notifications.
export const threadStatusSchema = z.object({ type: z.string() });
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
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = z
      .object({ data: z.array(schema), nextCursor: z.string().nullable() })
      .parse(await rpc.request(method, { ...params, limit: PAGE_SIZE, cursor }));
    result.push(...response.data);
    if (result.length > MAX_LIST_ITEMS)
      throw new Error(`${method} item limit exceeded (${MAX_LIST_ITEMS})`);
    if (response.nextCursor === null) return result;
    if (cursors.has(response.nextCursor)) throw new Error(`${method} repeated pagination cursor`);
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error(`${method} page limit exceeded (${MAX_LIST_PAGES})`);
}

export function readHistory(
  rpc: RpcClient,
  params: { threadId: string; turnId?: string },
  isCurrent: () => boolean,
): AsyncGenerator<z.infer<typeof itemEntrySchema>> {
  return readNativeHistory(
    rpc,
    "thread/items/list",
    { ...params, sortDirection: "asc" },
    itemEntrySchema,
    isCurrent,
  );
}

export function readTurns(
  rpc: RpcClient,
  threadId: string,
  isCurrent: () => boolean,
): AsyncGenerator<NativeTurn> {
  return readNativeHistory(
    rpc,
    "thread/turns/list",
    { threadId, sortDirection: "desc", itemsView: "notLoaded" },
    turnSchema,
    isCurrent,
  );
}

/** History length is unrestricted; each scan has bounded frames, time and cursor state. */
async function* readNativeHistory<T>(
  rpc: RpcClient,
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
  isCurrent: () => boolean,
): AsyncGenerator<T> {
  const deadline = Date.now() + HISTORY_SCAN_TIMEOUT_MS;
  let cursor: string | null = null;
  // Native cursors are opaque. Retain hashes rather than arbitrary cursor payloads.
  const cursors = new Set<string>();
  while (true) {
    if (!isCurrent()) throw new Error("Codex attachment changed during history scan");
    if (Date.now() >= deadline) throw new Error("Codex history scan exceeded 60 seconds");
    const response = z
      .object({ data: z.array(schema).max(PAGE_SIZE), nextCursor: z.string().nullable() })
      .parse(
        await rpc.request(method, {
          ...params,
          limit: PAGE_SIZE,
          cursor,
        }),
      );
    if (!isCurrent()) throw new Error("Codex attachment changed during history scan");
    if (Date.now() >= deadline) throw new Error("Codex history scan exceeded 60 seconds");
    for (const entry of response.data) yield entry;
    if (response.nextCursor === null) return;
    const fingerprint = createHash("sha256").update(response.nextCursor).digest("hex");
    if (!response.data.length || cursors.has(fingerprint))
      throw new Error(`${method} pagination did not advance`);
    cursors.add(fingerprint);
    if (cursors.size > MAX_CURSOR_FINGERPRINTS) {
      const oldest = cursors.values().next().value;
      if (oldest !== undefined) cursors.delete(oldest);
    }
    cursor = response.nextCursor;
  }
}

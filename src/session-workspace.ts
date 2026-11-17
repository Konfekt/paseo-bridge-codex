import { createHash } from "node:crypto";
import { errorMessage } from "./errors.js";
import { PLUGIN_ID } from "./ids.js";

export interface PlacedSession {
  providerId: string;
  providerHandleId: string;
  cwd: string;
  title?: string | null | undefined;
  firstPromptPreview?: string | null | undefined;
}

export interface WorkspaceHost<Agent> {
  importAgent(input: {
    providerId: string;
    providerHandleId: string;
    cwd: string;
    workspaceId?: string;
    labels: Record<string, string>;
  }): Promise<Agent>;
  createWorkspace(input: {
    source: { kind: "directory"; path: string };
    workspaceId: string;
    title?: string;
  }): Promise<unknown>;
}

const MAX_TITLE_LENGTH = 80;

/** Stable per-thread workspace ID in Paseo's `wks_<16 hex>` format, so retries and
 * restarts address the same workspace instead of creating another. */
export function sessionWorkspaceId(providerHandleId: string): string {
  const digest = createHash("sha256").update(`${PLUGIN_ID}\0${providerHandleId}`).digest("hex");
  return `wks_${digest.slice(0, 16)}`;
}

export function sessionWorkspaceTitle(session: PlacedSession): string | undefined {
  const text = (session.title ?? session.firstPromptPreview ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

/** Paseo answers a repeated create of the same workspace ID with this code. */
const WORKSPACE_EXISTS = "workspace_id_conflict";

/**
 * Paseo lists workspaces, not agents, so importing every terminal thread into the
 * folder's shared workspace hides it among that folder's other agents. Each thread
 * gets its own workspace in the same directory. Hosts that cannot provide it still
 * receive the thread in the folder workspace.
 */
export async function importIntoSessionWorkspace<Agent>(
  host: WorkspaceHost<Agent>,
  session: PlacedSession,
  onPlacementFallback: (error: unknown) => void = () => {},
): Promise<Agent> {
  const workspaceId = sessionWorkspaceId(session.providerHandleId);
  const request = {
    providerId: session.providerId,
    providerHandleId: session.providerHandleId,
    cwd: session.cwd,
    labels: { "bridge.owner": PLUGIN_ID },
  };
  const title = sessionWorkspaceTitle(session);
  let placed = false;
  try {
    const created = (await host.createWorkspace({
      source: { kind: "directory", path: session.cwd },
      workspaceId,
      ...(title ? { title } : {}),
    })) as { error?: string | null; errorCode?: string } | undefined;
    const error = created?.error;
    if (error && error !== WORKSPACE_EXISTS && created?.errorCode !== WORKSPACE_EXISTS)
      throw new Error(error);
    placed = true;
  } catch (error) {
    onPlacementFallback(error);
  }
  if (placed) {
    try {
      return await host.importAgent({ ...request, workspaceId });
    } catch (error) {
      // An archived thread workspace keeps its ID; the thread then joins the folder.
      if (!errorMessage(error).includes(`Workspace not found: ${workspaceId}`)) throw error;
      onPlacementFallback(error);
    }
  }
  return host.importAgent(request);
}

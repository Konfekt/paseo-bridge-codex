import type { PaseoApi } from "@getpaseo/client";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { watchDiscovery } from "./discovery.js";
import { connectPaseoHost } from "./paseo-client.js";
import { AGENT_ID_ENV, createBridgeProvider, PROVIDER_ID } from "./provider.js";
import { hiddenQuestionLabel, readHiddenQuestionLabels } from "./questions.js";

const activate = defineRpc({
  name: "activate",
  input: z.object({ agentId: z.string().min(1) }).strict(),
  output: z.object({ activated: z.boolean() }),
});

export function registerBridge(server: PluginServerContext): () => Promise<void> {
  const paseoHome = process.env["PASEO_HOME"];
  if (!paseoHome) throw new Error("Paseo must supply PASEO_HOME for automatic Codex discovery");
  let paseo: PaseoApi | undefined;
  const readAgent = async (agentId: string) => {
    if (!paseo) throw new Error("Paseo session-open context is unavailable");
    const result = await paseo.agents.ref(agentId).refresh();
    if (!result || result.agent.provider !== PROVIDER_ID || result.agent.archivedAt)
      throw new Error("Codex Terminal attachment is unavailable or archived");
    return result.agent;
  };
  const bridge = createBridgeProvider(
    async (agentId) => (await readAgent(agentId)).activeTurn?.turnId ?? null,
    {
      read: async (agentId) => readHiddenQuestionLabels((await readAgent(agentId)).labels),
      async hide(agentId, questionId) {
        const key = hiddenQuestionLabel(questionId);
        const agent = await readAgent(agentId);
        readHiddenQuestionLabels({ ...agent.labels, [key]: "true" });
        const connection = await connectPaseoHost(paseoHome);
        try {
          await connection.client.updateAgent(agentId, { labels: { [key]: "true" } });
        } finally {
          await connection.close();
        }
      },
    },
  );
  server.registerProvider(bridge.registration);
  const removeBefore = server.before("agent.session_open", ({ request }, context) => {
    if (request.provider !== PROVIDER_ID) return;
    paseo = context.paseo;
    return { ...request, env: { ...request.env, [AGENT_ID_ENV]: request.agentId } };
  });
  server.handle(activate, async ({ agentId }, context) => {
    const result = await context.paseo.agents.ref(agentId).refresh();
    if (!result || result.agent.provider !== PROVIDER_ID)
      throw new Error("Agent is not a Codex Terminal attachment");
    if (result.agent.archivedAt) throw new Error("Archived Codex attachments are not activated");
    return { activated: await bridge.activate(agentId) };
  });
  const controller = new AbortController();
  // Registration must return before Paseo publishes this provider and accepts connections.
  const discovery = watchDiscovery(
    () => connectPaseoHost(paseoHome, controller.signal),
    controller.signal,
    (error) => {
      console.error("Codex discovery failed; retrying:", error);
    },
  );
  void discovery.catch((error) => {
    console.error("Codex discovery stopped:", error);
  });
  return async () => {
    controller.abort();
    try {
      await discovery;
    } finally {
      removeBefore();
    }
  };
}

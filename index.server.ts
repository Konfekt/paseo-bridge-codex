import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerBridge } from "./server/activation.js";

export default function contribute(server: PluginServerContext): () => Promise<void> {
  return registerBridge(server);
}

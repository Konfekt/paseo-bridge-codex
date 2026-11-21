import type {
  ProviderCatalog,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { readPages } from "./protocol.js";
import type { RpcClient } from "./rpc.js";

// Only the fields the picker needs; Codex adds fields freely.
const codexModelSchema = z.object({
  model: z.string().min(1),
  displayName: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  defaultReasoningEffort: z.string().nullish(),
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: z.string().min(1), description: z.string().optional() }))
    .optional(),
});

function effortLabel(effort: string): string {
  return effort
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Codex's own picker list (`model/list` without hidden models), as Paseo models. */
export async function readModelCatalog(rpc: RpcClient): Promise<ProviderCatalog> {
  const listed = await readPages(rpc, "model/list", { includeHidden: false }, codexModelSchema);
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    // Thread settings and `thread.model` use the model slug, not the preset ID.
    if (seen.has(entry.model)) continue;
    seen.add(entry.model);
    const thinkingOptions: ProviderThinkingOption[] = (entry.supportedReasoningEfforts ?? []).map(
      ({ reasoningEffort, description }) => ({
        id: reasoningEffort,
        label: effortLabel(reasoningEffort),
        ...(description ? { description } : {}),
        ...(reasoningEffort === entry.defaultReasoningEffort ? { isDefault: true } : {}),
      }),
    );
    models.push({
      id: entry.model,
      label: entry.displayName || entry.model,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.isDefault ? { isDefault: true } : {}),
      ...(thinkingOptions.length ? { thinkingOptions } : {}),
      ...(entry.defaultReasoningEffort
        ? { defaultThinkingOptionId: entry.defaultReasoningEffort }
        : {}),
    });
  }
  const defaultModel = models.find((model) => model.isDefault)?.id;
  return { models, modes: [], ...(defaultModel ? { defaultModel } : {}) };
}

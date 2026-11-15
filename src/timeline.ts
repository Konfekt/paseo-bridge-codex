import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const itemSchema = z
  .object({ id: z.string().min(1), type: z.string().min(1), status: z.string().optional() })
  .catchall(z.json());
const textSchema = z.object({ text: z.string() });
const reasoningSchema = z.object({ summary: z.array(z.string()), content: z.array(z.string()) });
const toolStatusSchema = z.enum([
  "inProgress",
  "completed",
  "failed",
  "declined",
  "cancelled",
  "interrupted",
]);
type ToolCallDetail = Extract<ProviderTimelineItem, { type: "tool_call" }>["detail"];

function toolCall(
  id: string,
  name: string,
  detail: ToolCallDetail,
  status: z.infer<typeof toolStatusSchema>,
  failure: z.core.util.JSONType = null,
): ProviderTimelineItem {
  const base = { id, type: "tool_call" as const, callId: id, name, detail };
  if (status === "failed") return { ...base, status: "failed", error: failure };
  const state =
    status === "inProgress" ? "running" : status === "completed" ? "completed" : "canceled";
  return { ...base, status: state, error: null };
}

/** Project an authoritative native snapshot without retaining execution state. */
export function projectItem(value: unknown): ProviderTimelineItem {
  const item = itemSchema.parse(value);
  const id = item.id;
  switch (item.type) {
    case "agentMessage":
      return { id, type: "assistant_message", text: textSchema.parse(item).text };
    case "userMessage": {
      const user = z
        .object({
          content: z.array(z.object({ type: z.string() }).catchall(z.json())),
          clientId: z.string().nullable().optional(),
        })
        .parse(item);
      const text = user.content
        .map((input) =>
          input.type === "text" ? textSchema.parse(input).text : JSON.stringify(input),
        )
        .join("\n");
      return {
        id,
        type: "user_message",
        text,
        ...(user.clientId ? { clientMessageId: user.clientId } : {}),
      };
    }
    case "reasoning": {
      const reasoning = reasoningSchema.parse(item);
      return {
        id,
        type: "reasoning",
        text: [...reasoning.summary, ...reasoning.content].join("\n"),
      };
    }
    case "contextCompaction":
      return { id, type: "compaction", status: "completed" };
    case "plan":
      return toolCall(id, "plan", { type: "plan", text: textSchema.parse(item).text }, "completed");
    case "commandExecution": {
      const command = z
        .object({
          command: z.string(),
          cwd: z.string(),
          aggregatedOutput: z.string().nullable(),
          exitCode: z.number().int().nullable(),
          status: toolStatusSchema,
        })
        .parse(item);
      return toolCall(
        id,
        "commandExecution",
        {
          type: "shell",
          command: command.command,
          cwd: command.cwd,
          output: command.aggregatedOutput ?? "",
          exitCode: command.exitCode,
        },
        command.status,
        { exitCode: command.exitCode },
      );
    }
    default: {
      // Paseo inserts startup notifications twice on import; native record cards retain identity.
      const status = toolStatusSchema.safeParse(item.status);
      return toolCall(
        id,
        item.type,
        {
          type: "plain_text",
          label: `Codex native record: ${item.type}`,
          text: JSON.stringify(item, null, 2),
        },
        status.success ? status.data : "completed",
        item,
      );
    }
  }
}

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
      return {
        id,
        type: "tool_call",
        callId: id,
        name: "plan",
        detail: { type: "plan", text: textSchema.parse(item).text },
        status: "completed",
        error: null,
      };
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
      const detail = {
        type: "shell" as const,
        command: command.command,
        cwd: command.cwd,
        output: command.aggregatedOutput ?? "",
        exitCode: command.exitCode,
      };
      if (command.status === "failed")
        return {
          id,
          type: "tool_call",
          callId: id,
          name: "commandExecution",
          detail,
          status: "failed",
          error: { exitCode: command.exitCode },
        };
      return {
        id,
        type: "tool_call",
        callId: id,
        name: "commandExecution",
        detail,
        status:
          command.status === "inProgress"
            ? "running"
            : command.status === "completed"
              ? "completed"
              : "canceled",
        error: null,
      };
    }
    default: {
      // Preserve unrepresented native content as labelled JSON, rather than inventing semantics.
      const nativeStatus = item.status;
      if (nativeStatus === undefined || !toolStatusSchema.safeParse(nativeStatus).success) {
        return {
          id,
          type: "notification",
          level: "info",
          message: JSON.stringify(item, null, 2),
        };
      }
      const status = toolStatusSchema.parse(nativeStatus);
      const detail = {
        type: "plain_text" as const,
        label: item.type,
        text: JSON.stringify(item, null, 2),
      };
      if (status === "failed")
        return {
          id,
          type: "tool_call",
          callId: id,
          name: item.type,
          detail,
          status: "failed",
          error: item,
        };
      return {
        id,
        type: "tool_call",
        callId: id,
        name: item.type,
        detail,
        status:
          status === "inProgress" ? "running" : status === "completed" ? "completed" : "canceled",
        error: null,
      };
    }
  }
}

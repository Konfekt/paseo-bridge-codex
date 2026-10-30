import { createHash } from "node:crypto";
import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const replyOpen = "<send_user_message_question_reply>";
const replyClose = "</send_user_message_question_reply>";
const asyncQuestionName = "request_user_input_async";
const MAX_QUESTION_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_HIDDEN_QUESTION_BYTES = 8 * 1024 * 1024;
const HIDDEN_QUESTION_LABEL_PREFIX = "bridge.codex.hidden-question.";

export interface QuestionVisibility {
  /** Persisted label keys, not native question IDs. */
  read(agentId: string): Promise<ReadonlySet<string>>;
  hide(agentId: string, questionId: string): Promise<void>;
}

export function hiddenQuestionLabel(questionId: string): string {
  return HIDDEN_QUESTION_LABEL_PREFIX + createHash("sha256").update(questionId).digest("hex");
}

export function readHiddenQuestionLabels(labels: Record<string, string>): ReadonlySet<string> {
  const hidden = new Set<string>();
  let sizeBytes = 0;
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith(HIDDEN_QUESTION_LABEL_PREFIX)) continue;
    if (!/^[a-f0-9]{64}$/.test(key.slice(HIDDEN_QUESTION_LABEL_PREFIX.length)) || value !== "true")
      throw new Error("Invalid Codex hidden-question preference in Paseo agent labels");
    sizeBytes += Buffer.byteLength(key);
    if (sizeBytes > MAX_HIDDEN_QUESTION_BYTES)
      throw new Error("Codex hidden-question preferences exceeded 8 MiB");
    hidden.add(key);
  }
  return hidden;
}
export const asyncQuestionSchema = z.object({
  type: z.literal("agentMessage"),
  delivery: z.literal("async"),
  id: z.string().min(1),
  questions: z
    .array(
      z.object({
        title: z.string().min(1),
        options: z.array(z.string()).nullish(),
      }),
    )
    .min(1),
});
const replySchema = z.object({
  questionItemId: z.string(),
  question: z.string(),
  answer: z.string(),
});
const repliesSchema = z.union([replySchema, z.array(replySchema)]);
const userSchema = z.object({
  type: z.literal("userMessage"),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export type AsyncQuestion = {
  request: ProviderPermissionRequest;
  questions: Array<{ index: number; title: string; id: string }>;
};

/** One native scan retains question metadata, never ordinary historical payloads. */
export class AsyncQuestionProjection {
  private readonly answered = new Set<string>();
  private readonly messages = new Map<string, z.infer<typeof asyncQuestionSchema>>();
  private sizeBytes = 0;

  add(item: unknown): void {
    const question = asyncQuestionSchema.safeParse(item);
    if (question.success) {
      const message = question.data;
      if (
        message.questions.every((_, index) =>
          this.answered.has(JSON.stringify([asyncQuestionName, message.id, index])),
        )
      )
        return;
      const previous = this.messages.get(message.id);
      this.sizeBytes +=
        Buffer.byteLength(JSON.stringify(message)) -
        (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
      this.messages.set(message.id, message);
      if (this.sizeBytes > MAX_QUESTION_SCAN_BYTES)
        throw new Error("Codex question scan metadata exceeded 8 MiB");
      return;
    }
    const user = userSchema.safeParse(item);
    if (!user.success) return;
    const content = user.data.content.filter(
      (part) => part.type !== "skill" && part.type !== "mention",
    );
    if (content.length !== 1 || content[0]?.type !== "text") return;
    const text = content[0].text?.trim() ?? "";
    if (!text.startsWith(replyOpen) || !text.endsWith(replyClose)) return;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(replyOpen.length, -replyClose.length));
    } catch {
      // Ordinary user text can resemble an envelope without being a native reply.
      return;
    }
    const parsed = repliesSchema.safeParse(value);
    if (!parsed.success) return;
    for (const reply of Array.isArray(parsed.data) ? parsed.data : [parsed.data]) {
      if (!this.answered.has(reply.questionItemId)) {
        this.answered.add(reply.questionItemId);
        this.sizeBytes += Buffer.byteLength(reply.questionItemId);
      }
    }
    for (const [id, message] of this.messages)
      if (
        message.questions.every((_, index) =>
          this.answered.has(JSON.stringify([asyncQuestionName, id, index])),
        )
      ) {
        this.messages.delete(id);
        this.sizeBytes -= Buffer.byteLength(JSON.stringify(message));
      }
    if (this.sizeBytes > MAX_QUESTION_SCAN_BYTES)
      throw new Error("Codex question scan metadata exceeded 8 MiB");
  }

  pending(): Map<string, AsyncQuestion> {
    const pending = new Map<string, AsyncQuestion>();
    for (const message of this.messages.values()) {
      const questions = message.questions
        .map((question, index) => ({
          ...question,
          index,
          id: JSON.stringify([asyncQuestionName, message.id, index]),
        }))
        .filter((question) => !this.answered.has(question.id));
      if (!questions.length) continue;
      pending.set(message.id, {
        questions: questions.map(({ index, title, id }) => ({ index, title, id })),
        request: {
          id: message.id,
          name: asyncQuestionName,
          kind: "question",
          title: "Codex question",
          input: {
            questions: questions.map((question) => ({
              header: `Question ${question.index + 1}`,
              question: question.title,
              options: (question.options ?? []).map((label) => ({ label })),
              multiSelect: false,
              allowOther: true,
              dismissLabel: "Hide",
            })),
          },
        },
      });
    }
    return pending;
  }
}

export function asyncQuestionReply(
  question: AsyncQuestion,
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
): string {
  const { answers } = z
    .object({ answers: z.record(z.string(), z.string()) })
    .parse(response.updatedInput);
  const replies = question.questions.map((entry) => {
    const answer = answers[`Question ${entry.index + 1}`]?.trim();
    if (!answer) throw new Error(`Answer Question ${entry.index + 1} before submitting`);
    return { answer, question: entry.title, questionItemId: entry.id };
  });
  return `${replyOpen}\n${JSON.stringify(replies)}\n${replyClose}`;
}

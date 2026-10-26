import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const replyOpen = "<send_user_message_question_reply>";
const replyClose = "</send_user_message_question_reply>";
const asyncQuestionName = "request_user_input_async";
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

/** A question remains unanswered until a native reply references its identity. */
export function projectAsyncQuestions(items: unknown[]): Map<string, AsyncQuestion> {
  const answered = new Set<string>();
  for (const item of items) {
    const user = userSchema.safeParse(item);
    if (!user.success) continue;
    const content = user.data.content.filter(
      (part) => part.type !== "skill" && part.type !== "mention",
    );
    if (content.length !== 1 || content[0]?.type !== "text") continue;
    const text = content[0].text?.trim() ?? "";
    if (!text.startsWith(replyOpen) || !text.endsWith(replyClose)) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(replyOpen.length, -replyClose.length));
    } catch {
      // Ordinary user text can resemble an envelope without being a native reply.
      continue;
    }
    const parsed = repliesSchema.safeParse(value);
    if (!parsed.success) continue;
    for (const reply of Array.isArray(parsed.data) ? parsed.data : [parsed.data])
      answered.add(reply.questionItemId);
  }
  const pending = new Map<string, AsyncQuestion>();
  for (const item of items) {
    const parsed = asyncQuestionSchema.safeParse(item);
    if (!parsed.success) continue;
    const message = parsed.data;
    const questions = message.questions
      .map((question, index) => ({
        ...question,
        index,
        id: JSON.stringify([asyncQuestionName, message.id, index]),
      }))
      .filter((question) => !answered.has(question.id));
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
          })),
        },
      },
    });
  }
  return pending;
}

export function asyncQuestionReply(
  question: AsyncQuestion,
  response: ProviderPermissionResponse,
): string {
  if (response.behavior === "deny")
    throw new Error(
      "Codex has no shared async-question dismissal; submit an answer to resolve the question",
    );
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

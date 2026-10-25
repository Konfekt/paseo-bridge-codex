import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const commandMethod = "item/commandExecution/requestApproval";
const fileMethod = "item/fileChange/requestApproval";
const permissionsMethod = "item/permissions/requestApproval";
const profileSchema = z.object({
  permissions: z.object({
    network: z.object({ enabled: z.boolean().nullable() }).nullable(),
    fileSystem: z
      .object({
        read: z.array(z.string()).nullable(),
        write: z.array(z.string()).nullable(),
        globScanMaxDepth: z.number().int().nonnegative().optional(),
        entries: z.array(z.record(z.string(), z.json())).optional(),
      })
      .nullable(),
  }),
});
const elicitationMethod = "mcpServer/elicitation/request";
const formSchema = z.object({
  mode: z.literal("form"),
  message: z.string(),
  requestedSchema: z
    .object({
      type: z.literal("object"),
      $schema: z.string().optional(),
      properties: z.record(
        z.string(),
        z
          .object({
            type: z.literal("string"),
            title: z.string().optional(),
            description: z.string().optional(),
            enum: z.array(z.string()).min(1).optional(),
            minLength: z.number().int().nonnegative().optional(),
            maxLength: z.number().int().nonnegative().optional(),
            default: z.string().optional(),
          })
          .strict(),
      ),
      required: z.array(z.string()).optional(),
    })
    .strict(),
});
const questionMethod = "item/tool/requestUserInput";
const decisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z
    .object({
      acceptWithExecpolicyAmendment: z
        .object({ execpolicy_amendment: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      applyNetworkPolicyAmendment: z
        .object({
          network_policy_amendment: z
            .object({ host: z.string(), action: z.enum(["allow", "deny"]) })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);
const approvalSchema = z
  .object({
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    availableDecisions: z.array(decisionSchema).nullable().optional(),
  })
  .catchall(z.json());
const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string(),
        header: z.string(),
        question: z.string(),
        isOther: z.boolean(),
        isSecret: z.boolean(),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
      }),
    )
    .min(1),
});

export function permissionId(id: string | number): string {
  return JSON.stringify(id);
}

export function projectPermission(
  id: string | number,
  method: string,
  params: unknown,
): ProviderPermissionRequest | undefined {
  if (method === elicitationMethod) {
    const parsed = formSchema.safeParse(params);
    if (!parsed.success) return undefined;
    const form = parsed.data;
    const entries = Object.entries(form.requestedSchema.properties);
    if (!entries.length) return undefined;
    return {
      id: permissionId(id),
      name: method,
      kind: "question",
      title: form.message,
      input: {
        questions: entries.map(([key, field]) => ({
          header: key,
          question: field.description ?? field.title ?? key,
          options: field.enum?.map((label) => ({ label })) ?? [],
          multiSelect: false,
          allowOther: !field.enum,
          allowEmpty: !form.requestedSchema.required?.includes(key),
        })),
      },
    };
  }
  if (method === permissionsMethod) {
    const parsed = profileSchema.parse(params);
    return {
      id: permissionId(id),
      name: method,
      kind: "tool",
      title: "Grant requested permissions for this turn",
      description: JSON.stringify(parsed.permissions, null, 2),
      actions: [
        { id: "accept", label: "Allow for this turn", behavior: "allow" },
        { id: "decline", label: "Deny", behavior: "deny" },
      ],
    };
  }
  if (method === commandMethod || method === fileMethod) {
    const approval = approvalSchema.parse(params);
    const decisions = approval.availableDecisions ?? ["accept", "decline", "cancel"];
    return {
      id: permissionId(id),
      name: method,
      kind: "tool",
      title: method === commandMethod ? "Command approval" : "File change approval",
      description: JSON.stringify(approval, null, 2),
      actions: decisions.map((decision) => {
        const key = typeof decision === "string" ? decision : JSON.stringify(decision);
        const deny =
          decision === "decline" ||
          decision === "cancel" ||
          (typeof decision === "object" &&
            "applyNetworkPolicyAmendment" in decision &&
            decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "deny");
        return {
          id: key,
          label: key,
          behavior: deny ? "deny" : "allow",
          variant: deny ? "danger" : "primary",
        };
      }),
    };
  }
  if (method === questionMethod) {
    const { questions } = questionsSchema.parse(params);
    // Paseo cannot protect secret answers or distinguish duplicate header keys.
    if (
      questions.some((question) => question.isSecret) ||
      new Set(questions.map((question) => question.header)).size !== questions.length
    )
      return undefined;
    return {
      id: permissionId(id),
      name: "request_user_input",
      kind: "question",
      title: "Codex question",
      input: {
        questions: questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options ?? [],
          multiSelect: false,
          allowOther: question.isOther,
        })),
      },
    };
  }
  return undefined;
}

export function permissionResult(
  method: string,
  params: unknown,
  response: ProviderPermissionResponse,
): unknown {
  const request = projectPermission(0, method, params);
  if (!request) throw new Error(`Codex request is not remotely representable: ${method}`);
  if (method === elicitationMethod) {
    if (response.behavior === "deny") return { action: "decline", content: null, _meta: null };
    const form = formSchema.parse(params);
    const answers = z
      .object({ answers: z.record(z.string(), z.string()) })
      .parse(response.updatedInput).answers;
    const content: Record<string, string> = Object.create(null);
    for (const [key, field] of Object.entries(form.requestedSchema.properties)) {
      const answer = answers[key];
      if (answer === undefined || answer === "") {
        if (form.requestedSchema.required?.includes(key))
          throw new Error(`Missing MCP form field ${key}`);
        continue;
      }
      let schema = z.string();
      if (field.minLength !== undefined) schema = schema.min(field.minLength);
      if (field.maxLength !== undefined) schema = schema.max(field.maxLength);
      const value = schema.parse(answer);
      if (field.enum && !field.enum.includes(value))
        throw new Error(`Invalid MCP form field ${key}`);
      content[key] = value;
    }
    return { action: "accept", content, _meta: null };
  }
  if (method === permissionsMethod) {
    if (
      response.selectedActionId &&
      response.selectedActionId !== (response.behavior === "allow" ? "accept" : "decline")
    )
      throw new Error("Permission action was not offered for this request");
    const { network, fileSystem } = profileSchema.parse(params).permissions;
    return {
      permissions:
        response.behavior === "deny"
          ? {}
          : { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) },
      scope: "turn",
    };
  }
  if (method === questionMethod) {
    if (response.behavior === "deny") return { answers: {} };
    const answers = z
      .object({ answers: z.record(z.string(), z.string()) })
      .parse(response.updatedInput).answers;
    const questions = questionsSchema.parse(params).questions;
    const result: Record<string, { answers: string[] }> = Object.create(null);
    for (const question of questions) {
      const answer = answers[question.header];
      if (!answer?.trim()) throw new Error(`Missing answer for ${question.header}`);
      if (
        !question.isOther &&
        question.options?.length &&
        !question.options.some((option) => option.label === answer)
      )
        throw new Error(`Invalid answer for ${question.header}`);
      result[question.id] = { answers: [answer] };
    }
    return { answers: result };
  }
  const action = response.selectedActionId
    ? request.actions?.find((candidate) => candidate.id === response.selectedActionId)
    : request.actions?.find(
        (candidate) => candidate.id === (response.behavior === "allow" ? "accept" : "decline"),
      );
  if (!action || action.behavior !== response.behavior)
    throw new Error("Permission action was not offered for this request");
  const approval = approvalSchema.parse(params);
  const decisions = approval.availableDecisions ?? ["accept", "decline", "cancel"];
  const decision = decisions.find(
    (candidate) =>
      (typeof candidate === "string" ? candidate : JSON.stringify(candidate)) === action.id,
  );
  if (decision === undefined) throw new Error("Permission decision is unavailable");
  return { decision };
}

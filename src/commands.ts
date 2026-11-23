import type { ProviderCommand } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

/**
 * Slash commands the bridge runs for Paseo through the Codex app-server. Paseo lists them in
 * its command menu and sends them as commands instead of model prompts.
 */
export const BRIDGE_COMMANDS = [
  {
    name: "btw",
    description: "Ask a quick side question; it is not added to the thread",
    argumentHint: "<question>",
  },
  {
    name: "side",
    description: "Ask a quick side question; it is not added to the thread",
    argumentHint: "<question>",
  },
  {
    name: "compact",
    description: "Summarize the conversation to prevent hitting the context limit",
  },
  {
    name: "review",
    description: "Review current changes and find issues",
    argumentHint: "[base <branch> | commit <sha> | <instructions>]",
  },
  { name: "init", description: "Create an AGENTS.md file with instructions for Codex" },
  { name: "rename", description: "Rename the current thread", argumentHint: "<name>" },
  {
    name: "model",
    description: "List models or choose one, with an optional reasoning effort",
    argumentHint: "[<model> [<effort>]]",
  },
  {
    name: "goal",
    description: "Set or view the goal for a long-running task",
    argumentHint: "[<objective> | pause | resume | done | clear]",
  },
  {
    name: "plan",
    description: "Switch to Plan mode, optionally with a first prompt",
    argumentHint: "[off | <prompt>]",
  },
  { name: "status", description: "Show the thread's model, settings, goal and token usage" },
  { name: "usage", description: "Show account rate limits" },
  {
    name: "permissions",
    description: "List permission profiles or choose one",
    argumentHint: "[<profile>]",
  },
  { name: "memories", description: "Turn memory use on or off", argumentHint: "on | off" },
  { name: "mcp", description: "List MCP servers and their tools" },
  { name: "skills", description: "List the skills Codex can use here" },
  { name: "hooks", description: "List lifecycle hooks" },
  { name: "plugins", description: "List plugins" },
  { name: "ps", description: "List background terminals" },
  { name: "stop", description: "Stop all background terminals" },
] as const satisfies readonly ProviderCommand[];

export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number]["name"];

const BRIDGE_COMMAND_NAMES: ReadonlySet<string> = new Set(BRIDGE_COMMANDS.map(({ name }) => name));

/** Codex's own alternative spellings of commands the bridge runs. */
const ALIASES: Readonly<Record<string, BridgeCommandName>> = { clean: "stop" };

const IN_TERMINAL = "Use it in the Codex terminal.";
const NEW_AGENT =
  "Start a new Codex Terminal agent in Paseo, or a new Codex session in the terminal, which Paseo imports.";

/**
 * The Codex terminal's slash commands (codex-rs/tui/src/slash_command.rs, including aliases)
 * that the app-server cannot run for Paseo, with the nearest alternative. Names Codex adds
 * later reach the model as text, as before, until they are listed here or run by the bridge.
 */
export const TERMINAL_ONLY_COMMANDS: Readonly<Record<string, string>> = {
  presets: IN_TERMINAL,
  daybreak: IN_TERMINAL,
  ide: IN_TERMINAL,
  keymap: IN_TERMINAL,
  vim: IN_TERMINAL,
  "setup-default-sandbox": IN_TERMINAL,
  experimental: IN_TERMINAL,
  approve: IN_TERMINAL,
  import: IN_TERMINAL,
  new: NEW_AGENT,
  clear: NEW_AGENT,
  resume: "Import the thread from Paseo's session list.",
  fork: "Fork in the Codex terminal; Paseo imports the new thread.",
  archive: "Archive the agent in Paseo, or the thread in the Codex terminal.",
  delete: IN_TERMINAL,
  worktree: IN_TERMINAL,
  app: IN_TERMINAL,
  config: IN_TERMINAL,
  recap: "Ask Codex for a summary in a normal message.",
  voice: IN_TERMINAL,
  agents: IN_TERMINAL,
  subagents: IN_TERMINAL,
  copy: "Copy the message from Paseo.",
  export: IN_TERMINAL,
  raw: IN_TERMINAL,
  tui: IN_TERMINAL,
  diff: "Use Paseo's diff view.",
  mention: "Write the file path in your message.",
  daemon: IN_TERMINAL,
  rc: IN_TERMINAL,
  remote: IN_TERMINAL,
  warnings: IN_TERMINAL,
  cd: IN_TERMINAL,
  pwd: "Paseo shows the working directory; /status prints it too.",
  cwd: "Paseo shows the working directory; /status prints it too.",
  "debug-config": IN_TERMINAL,
  title: IN_TERMINAL,
  statusline: IN_TERMINAL,
  theme: IN_TERMINAL,
  pets: IN_TERMINAL,
  pet: IN_TERMINAL,
  apps: IN_TERMINAL,
  logout: IN_TERMINAL,
  quit: "Close the agent in Paseo.",
  exit: "Close the agent in Paseo.",
  feedback: IN_TERMINAL,
  rollout: IN_TERMINAL,
  "test-approval": IN_TERMINAL,
  "debug-m-drop": IN_TERMINAL,
  "debug-m-update": IN_TERMINAL,
};

export type SlashRoute =
  | { kind: "run"; name: BridgeCommandName; args: string }
  | { kind: "reject"; message: string };

/** Split `/name args`. A name containing `/` is a path such as `/usr/bin`, not a command. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Route a Codex command name; anything else is ordinary text for the model. */
export function routeCommand(name: string, args: string): SlashRoute | undefined {
  const canonical = ALIASES[name] ?? name;
  if (BRIDGE_COMMAND_NAMES.has(canonical))
    return { kind: "run", name: canonical as BridgeCommandName, args };
  const hint = Object.hasOwn(TERMINAL_ONLY_COMMANDS, name)
    ? TERMINAL_ONLY_COMMANDS[name]
    : undefined;
  if (hint === undefined) return undefined;
  return {
    kind: "reject",
    message: `/${name} is a Codex terminal command and is not available from Paseo. ${hint}`,
  };
}

/** Route a typed message that starts with a slash, e.g. one Paseo sent as steering. */
export function routeText(text: string): SlashRoute | undefined {
  const parsed = parseSlash(text);
  return parsed && routeCommand(parsed.name, parsed.args);
}

/** Codex's `/init` prompt (codex-rs/tui/assets/prompt_for_init_command.md, Apache-2.0). */
export const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

/** Frames a side question so the model answers it without continuing the thread's task. */
export function sideQuestionPrompt(question: string): string {
  return [
    "<side_question>",
    "This is a side question about the conversation above. Answer it directly and briefly from the conversation and what you already know.",
    "Do not continue, execute, or complete any earlier task, plan, or request, and do not call tools.",
    "",
    question,
    "</side_question>",
  ].join("\n");
}

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string }
  | { type: "custom"; instructions: string };

/** `/review`, `/review base main`, `/review commit abc123`, or free-form review instructions. */
export function parseReviewTarget(args: string): ReviewTarget {
  if (!args) return { type: "uncommittedChanges" };
  const [keyword = "", value = "", ...rest] = args.split(/\s+/);
  if (!rest.length && value) {
    if (/^(base|branch)$/i.test(keyword)) return { type: "baseBranch", branch: value };
    if (/^commit$/i.test(keyword)) return { type: "commit", sha: value };
  }
  return { type: "custom", instructions: args };
}

export type GoalAction =
  | { type: "show" }
  | { type: "clear" }
  | { type: "status"; status: "paused" | "active" | "complete" }
  | { type: "objective"; objective: string };

export function parseGoalArgs(args: string): GoalAction {
  const keyword = args.toLowerCase();
  if (!keyword) return { type: "show" };
  if (keyword === "clear") return { type: "clear" };
  if (keyword === "pause") return { type: "status", status: "paused" };
  if (keyword === "resume") return { type: "status", status: "active" };
  if (keyword === "done" || keyword === "complete") return { type: "status", status: "complete" };
  return { type: "objective", objective: args };
}

/** `on`/`off` and their usual synonyms; undefined for anything else. */
export function parseToggle(args: string): boolean | undefined {
  const value = args.toLowerCase();
  if (["on", "enable", "enabled", "true", "yes"].includes(value)) return true;
  if (["off", "disable", "disabled", "false", "no"].includes(value)) return false;
  return undefined;
}

const goalSchema = z
  .object({
    objective: z.string(),
    status: z.string(),
    tokenBudget: z.number().nullish(),
    tokensUsed: z.number().nullish(),
  })
  .nullish();

export function formatGoal(value: unknown): string {
  const goal = goalSchema.parse(value);
  if (!goal) return "No goal is set. Set one with /goal <objective>.";
  const budget =
    goal.tokenBudget == null ? "" : `, ${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens`;
  return `Goal (${goal.status}${budget}): ${goal.objective}`;
}

const tokenUsageSchema = z.object({
  total: z.object({ totalTokens: z.number() }),
  last: z.object({ totalTokens: z.number() }),
  modelContextWindow: z.number().nullish(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** The token usage from a `thread/tokenUsage/updated` notification, if it has the known shape. */
export function parseTokenUsage(value: unknown): TokenUsage | undefined {
  const parsed = tokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function formatStatus(status: {
  threadId: string;
  name: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  goal: unknown;
  tokenUsage: TokenUsage | undefined;
}): string {
  const lines = [
    `Thread: ${status.name ? `${status.name} (${status.threadId})` : status.threadId}`,
    `Directory: ${status.cwd}`,
    `Model: ${status.model ?? "default"}${status.effort ? ` (reasoning ${status.effort})` : ""}`,
    formatGoal(status.goal),
  ];
  const usage = status.tokenUsage;
  if (usage) {
    const window = usage.modelContextWindow
      ? ` of ${usage.modelContextWindow} (${Math.round((usage.last.totalTokens / usage.modelContextWindow) * 100)}% of the context window)`
      : "";
    lines.push(
      `Tokens: ${usage.last.totalTokens} in the last request${window}; ${usage.total.totalTokens} in total`,
    );
  }
  return lines.join("\n");
}

const windowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullish(),
    resetsAt: z.number().nullish(),
  })
  .nullish();
const snapshotSchema = z.object({
  limitName: z.string().nullish(),
  limitId: z.string().nullish(),
  primary: windowSchema,
  secondary: windowSchema,
});

function formatWindow(label: string, window: z.infer<typeof windowSchema>): string | undefined {
  if (!window) return undefined;
  const span = window.windowDurationMins
    ? window.windowDurationMins % 1440 === 0
      ? `${window.windowDurationMins / 1440}d`
      : window.windowDurationMins % 60 === 0
        ? `${window.windowDurationMins / 60}h`
        : `${window.windowDurationMins}m`
    : label;
  const reset = window.resetsAt ? `, resets ${new Date(window.resetsAt * 1000).toISOString()}` : "";
  return `${span} limit: ${window.usedPercent}% used${reset}`;
}

export function formatRateLimits(value: unknown): string {
  const response = z
    .object({
      rateLimits: snapshotSchema.nullish(),
      rateLimitsByLimitId: z.record(z.string(), snapshotSchema).nullish(),
    })
    .parse(value);
  const snapshots = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : response.rateLimits
      ? [response.rateLimits]
      : [];
  const lines: string[] = [];
  for (const snapshot of snapshots) {
    const windows = [
      formatWindow("primary", snapshot.primary),
      formatWindow("secondary", snapshot.secondary),
    ].filter((line): line is string => line !== undefined);
    if (!windows.length) continue;
    const name = snapshot.limitName ?? snapshot.limitId;
    lines.push(...(name && snapshots.length > 1 ? [`${name}:`] : []), ...windows);
  }
  return lines.length ? lines.join("\n") : "Codex reported no rate limits.";
}

/** Item lists with a heading, or a fallback line when there is nothing to show. */
function listing(heading: string, empty: string, items: string[]): string {
  return items.length ? [heading, ...items.map((item) => `- ${item}`)].join("\n") : empty;
}

export function formatSkills(value: unknown): string {
  const { data } = z
    .object({
      data: z.array(
        z.object({
          skills: z.array(
            z.object({ name: z.string(), description: z.string(), enabled: z.boolean() }),
          ),
        }),
      ),
    })
    .parse(value);
  const skills = data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
  return listing(
    "Skills (mention one as $name in a message):",
    "Codex found no skills here.",
    skills.map((skill) => `${skill.name}: ${skill.description}`),
  );
}

export function formatMcpServers(value: unknown): string {
  const { data } = z
    .object({
      data: z.array(
        z.object({
          name: z.string(),
          runtimeStatus: z.string().nullish(),
          authStatus: z.string().nullish(),
          tools: z.record(z.string(), z.unknown()).nullish(),
        }),
      ),
    })
    .parse(value);
  return listing(
    "MCP servers:",
    "No MCP servers are configured.",
    data.map((server) => {
      const tools = Object.keys(server.tools ?? {});
      const status = [server.runtimeStatus, server.authStatus].filter(Boolean).join(", ");
      return `${server.name}${status ? ` (${status})` : ""}: ${tools.length ? tools.join(", ") : "no tools"}`;
    }),
  );
}

export function formatHooks(value: unknown): string {
  const { data } = z
    .object({
      data: z.array(
        z.object({
          hooks: z.array(
            z.object({
              eventName: z.string(),
              enabled: z.boolean(),
              matcher: z.string().nullish(),
              sourcePath: z.string(),
            }),
          ),
          warnings: z.array(z.unknown()).optional(),
          errors: z.array(z.unknown()).optional(),
        }),
      ),
    })
    .parse(value);
  const hooks = data.flatMap((entry) => entry.hooks);
  const problems = data.reduce(
    (count, entry) => count + (entry.warnings?.length ?? 0) + (entry.errors?.length ?? 0),
    0,
  );
  const text = listing(
    "Hooks:",
    "No hooks are configured.",
    hooks.map(
      (hook) =>
        `${hook.eventName}${hook.matcher ? ` [${hook.matcher}]` : ""}${hook.enabled ? "" : " (disabled)"}: ${hook.sourcePath}`,
    ),
  );
  return problems
    ? `${text}\n${problems} warning(s) or error(s); see /hooks in the terminal.`
    : text;
}

export function formatPlugins(value: unknown): string {
  const { marketplaces } = z
    .object({
      marketplaces: z.array(
        z.object({
          name: z.string(),
          plugins: z.array(
            z.object({ name: z.string(), installed: z.boolean(), enabled: z.boolean() }),
          ),
        }),
      ),
    })
    .parse(value);
  const plugins = marketplaces.flatMap((marketplace) =>
    marketplace.plugins.map(
      (plugin) =>
        `${plugin.name} (${marketplace.name})${plugin.installed ? (plugin.enabled ? ": installed" : ": installed, disabled") : ""}`,
    ),
  );
  return listing("Plugins:", "No plugins are available.", plugins);
}

export function formatBackgroundTerminals(value: unknown): string {
  const { data } = z
    .object({ data: z.array(z.object({ command: z.string(), processId: z.string() })) })
    .parse(value);
  return listing(
    "Background terminals:",
    "No background terminals are running.",
    data.map((terminal) => `${terminal.processId}: ${terminal.command}`),
  );
}

const profilesSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), description: z.string().nullish(), allowed: z.boolean() }),
  ),
});

export function permissionProfiles(value: unknown): z.infer<typeof profilesSchema>["data"] {
  return profilesSchema.parse(value).data;
}

/** Match `workspace` to Codex's built-in `:workspace` as well as an exact profile id. */
export function pickPermissionProfile(
  profiles: z.infer<typeof profilesSchema>["data"],
  wanted: string,
): string | undefined {
  return (
    profiles.find((profile) => profile.id === wanted)?.id ??
    profiles.find((profile) => profile.id === `:${wanted}`)?.id
  );
}

export function formatPermissionProfiles(profiles: z.infer<typeof profilesSchema>["data"]): string {
  return listing(
    "Permission profiles (choose one with /permissions <profile>):",
    "Codex reported no permission profiles.",
    profiles.map(
      (profile) =>
        `${profile.id}${profile.description ? `: ${profile.description}` : ""}${profile.allowed ? "" : " (not allowed)"}`,
    ),
  );
}

const collaborationModesSchema = z.object({
  data: z.array(
    z.object({
      mode: z.string().nullish(),
      model: z.string().nullish(),
      reasoning_effort: z.string().nullish(),
    }),
  ),
});

/** Codex's preset for a collaboration mode, as its TUI applies it. */
export function collaborationModeSettings(
  modes: unknown,
  mode: "plan" | "default",
  current: { model: string | null; effort: string | null },
): { mode: "plan" | "default"; settings: Record<string, string | null> } {
  const preset = collaborationModesSchema.parse(modes).data.find((entry) => entry.mode === mode);
  if (!preset) throw new Error(`This Codex release has no ${mode} collaboration mode`);
  const model = preset.model ?? current.model;
  if (!model) throw new Error("The thread's model is unknown; choose one in Paseo first");
  return {
    mode,
    settings: {
      model,
      reasoning_effort: preset.reasoning_effort ?? current.effort,
      developer_instructions: null,
    },
  };
}

interface ModelChoice {
  id: string;
  label?: string;
  thinkingOptions?: readonly { id: string }[];
  defaultThinkingOptionId?: string;
}

/** Codex's models as `/model` lists them, marking the thread's current choice. */
export function formatModels(
  models: readonly ModelChoice[],
  current: { model: string | null; effort: string | null },
): string {
  return listing(
    `Model: ${current.model ?? "unknown"}${current.effort ? ` (${current.effort})` : ""}. Choose one with /model <model> [<effort>]:`,
    "Codex reported no models.",
    models.map((model) => {
      const efforts = model.thinkingOptions?.map((option) => option.id) ?? [];
      const label = model.label && model.label !== model.id ? ` (${model.label})` : "";
      const mark = model.id === current.model ? " [current]" : "";
      return `${model.id}${label}${mark}${efforts.length ? `: ${efforts.join(", ")}` : ""}`;
    }),
  );
}

/** Resolve `/model <model> [<effort>]` against Codex's catalog. */
export function pickModel(
  models: readonly ModelChoice[],
  args: string,
): { model: string; effort?: string } | { error: string } {
  const [wanted = "", effort, ...rest] = args.split(/\s+/).filter(Boolean);
  if (rest.length) return { error: "Use /model <model> [<effort>]." };
  const lower = wanted.toLowerCase();
  const matches = models.filter(
    (model) => model.id.toLowerCase() === lower || model.label?.toLowerCase() === lower,
  );
  const found =
    matches.length === 1
      ? matches[0]
      : matches.length === 0
        ? (() => {
            const partial = models.filter((model) => model.id.toLowerCase().includes(lower));
            return partial.length === 1 ? partial[0] : undefined;
          })()
        : undefined;
  if (!found)
    return { error: `Codex has no single model matching "${wanted}". Send /model to list them.` };
  if (effort === undefined) return { model: found.id };
  const efforts = found.thinkingOptions?.map((option) => option.id) ?? [];
  if (!efforts.includes(effort))
    return {
      error: `${found.id} supports ${efforts.length ? efforts.join(", ") : "no reasoning effort choice"}, not "${effort}".`,
    };
  return { model: found.id, effort };
}

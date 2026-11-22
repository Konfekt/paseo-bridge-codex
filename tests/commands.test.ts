import { describe, expect, it } from "vitest";
import {
  BRIDGE_COMMANDS,
  collaborationModeSettings,
  formatBackgroundTerminals,
  formatGoal,
  formatHooks,
  formatMcpServers,
  formatPermissionProfiles,
  formatPlugins,
  formatRateLimits,
  formatSkills,
  formatStatus,
  parseGoalArgs,
  parseReviewTarget,
  parseSlash,
  parseToggle,
  parseTokenUsage,
  pickPermissionProfile,
  routeCommand,
  routeText,
  sideQuestionPrompt,
  TERMINAL_ONLY_COMMANDS,
} from "../src/commands.js";

describe("Codex slash commands", () => {
  it("parses commands and leaves paths and plain text alone", () => {
    expect(parseSlash("/review base main")).toEqual({ name: "review", args: "base main" });
    expect(parseSlash("  /STATUS  ")).toEqual({ name: "status", args: "" });
    expect(parseSlash("/btw what is\nthis?")).toEqual({ name: "btw", args: "what is\nthis?" });
    expect(parseSlash("/usr/bin/env is missing")).toBeUndefined();
    expect(parseSlash("please /review")).toBeUndefined();
    expect(parseSlash("/")).toBeUndefined();
  });

  it("runs bridge commands, rejects terminal-only ones and passes unknown names to the model", () => {
    expect(routeCommand("compact", "")).toEqual({ kind: "run", name: "compact", args: "" });
    expect(routeCommand("clean", "")).toEqual({ kind: "run", name: "stop", args: "" });
    expect(routeText("/diff")).toEqual({
      kind: "reject",
      message:
        "/diff is a Codex terminal command and is not available from Paseo. Use Paseo's diff view.",
    });
    expect(routeText("/model gpt-5")).toMatchObject({ kind: "reject" });
    expect(routeText("/prompts:deploy now")).toBeUndefined();
    expect(routeText("/toString")).toBeUndefined();
    expect(routeText("/constructor")).toBeUndefined();
    expect(routeText("hello")).toBeUndefined();
  });

  it("keeps announced and rejected names apart and gives every rejection a hint", () => {
    const announced = BRIDGE_COMMANDS.map((command) => command.name);
    expect(new Set(announced).size).toBe(announced.length);
    for (const name of announced) expect(Object.hasOwn(TERMINAL_ONLY_COMMANDS, name)).toBe(false);
    for (const hint of Object.values(TERMINAL_ONLY_COMMANDS)) expect(hint).toMatch(/\.$/);
    for (const command of BRIDGE_COMMANDS) expect(command.description).not.toBe("");
  });

  it("parses review targets, goal actions and toggles", () => {
    expect(parseReviewTarget("")).toEqual({ type: "uncommittedChanges" });
    expect(parseReviewTarget("base main")).toEqual({ type: "baseBranch", branch: "main" });
    expect(parseReviewTarget("commit abc123")).toEqual({ type: "commit", sha: "abc123" });
    expect(parseReviewTarget("focus on the commit message parser")).toEqual({
      type: "custom",
      instructions: "focus on the commit message parser",
    });
    expect(parseGoalArgs("")).toEqual({ type: "show" });
    expect(parseGoalArgs("Pause")).toEqual({ type: "status", status: "paused" });
    expect(parseGoalArgs("resume")).toEqual({ type: "status", status: "active" });
    expect(parseGoalArgs("done")).toEqual({ type: "status", status: "complete" });
    expect(parseGoalArgs("clear")).toEqual({ type: "clear" });
    expect(parseGoalArgs("Ship the release")).toEqual({
      type: "objective",
      objective: "Ship the release",
    });
    expect(parseToggle("ON")).toBe(true);
    expect(parseToggle("disable")).toBe(false);
    expect(parseToggle("maybe")).toBeUndefined();
  });

  it("frames side questions so the model does not continue the thread's task", () => {
    const prompt = sideQuestionPrompt("What does foo return?");
    expect(prompt).toContain("What does foo return?");
    expect(prompt).toContain("do not call tools");
    expect(prompt.startsWith("<side_question>")).toBe(true);
  });

  it("formats app-server answers and tolerates new fields", () => {
    expect(formatGoal(null)).toContain("No goal is set");
    expect(
      formatGoal({
        objective: "Ship",
        status: "active",
        tokenBudget: 100,
        tokensUsed: 5,
        extra: 1,
      }),
    ).toBe("Goal (active, 5/100 tokens): Ship");
    const usage = parseTokenUsage({
      total: { totalTokens: 900 },
      last: { totalTokens: 250 },
      modelContextWindow: 1000,
    });
    expect(parseTokenUsage({ total: {} })).toBeUndefined();
    expect(
      formatStatus({
        threadId: "t1",
        name: "Work",
        cwd: "/repo",
        model: "gpt-x",
        effort: "high",
        goal: null,
        tokenUsage: usage,
      }),
    ).toBe(
      [
        "Thread: Work (t1)",
        "Directory: /repo",
        "Model: gpt-x (reasoning high)",
        "No goal is set. Set one with /goal <objective>.",
        "Tokens: 250 in the last request of 1000 (25% of the context window); 900 in total",
      ].join("\n"),
    );
    expect(
      formatRateLimits({
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 0 },
          secondary: { usedPercent: 40, windowDurationMins: 10080 },
        },
      }),
    ).toBe("5h limit: 12% used\n7d limit: 40% used");
    expect(formatRateLimits({ rateLimits: null })).toBe("Codex reported no rate limits.");
    expect(
      formatSkills({
        data: [
          {
            skills: [
              { name: "imagegen", description: "Make images", enabled: true },
              { name: "off", description: "Disabled", enabled: false },
            ],
          },
        ],
      }),
    ).toBe("Skills (mention one as $name in a message):\n- imagegen: Make images");
    expect(formatMcpServers({ data: [] })).toBe("No MCP servers are configured.");
    expect(
      formatMcpServers({
        data: [{ name: "docs", runtimeStatus: "connected", authStatus: "oAuth", tools: { a: {} } }],
      }),
    ).toBe("MCP servers:\n- docs (connected, oAuth): a");
    expect(
      formatHooks({
        data: [
          {
            hooks: [{ eventName: "preToolUse", enabled: false, matcher: "Bash", sourcePath: "/h" }],
            warnings: ["w"],
            errors: [],
          },
        ],
      }),
    ).toBe(
      "Hooks:\n- preToolUse [Bash] (disabled): /h\n1 warning(s) or error(s); see /hooks in the terminal.",
    );
    expect(
      formatPlugins({
        marketplaces: [{ name: "m", plugins: [{ name: "p", installed: true, enabled: false }] }],
      }),
    ).toBe("Plugins:\n- p (m): installed, disabled");
    expect(formatBackgroundTerminals({ data: [{ command: "npm run dev", processId: "7" }] })).toBe(
      "Background terminals:\n- 7: npm run dev",
    );
  });

  it("picks permission profiles by id or built-in short name", () => {
    const profiles = [
      { id: ":read-only", allowed: true },
      { id: ":workspace", description: "Edit the workspace", allowed: true },
      { id: "custom", allowed: false },
    ];
    expect(pickPermissionProfile(profiles, "workspace")).toBe(":workspace");
    expect(pickPermissionProfile(profiles, "custom")).toBe("custom");
    expect(pickPermissionProfile(profiles, "root")).toBeUndefined();
    expect(formatPermissionProfiles(profiles)).toContain(":workspace: Edit the workspace");
    expect(formatPermissionProfiles(profiles)).toContain("custom (not allowed)");
  });

  it("applies Codex's collaboration-mode presets", () => {
    const modes = {
      data: [
        { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
        { name: "Default", mode: "default", model: null, reasoning_effort: null },
      ],
    };
    expect(collaborationModeSettings(modes, "plan", { model: "gpt-x", effort: "high" })).toEqual({
      mode: "plan",
      settings: { model: "gpt-x", reasoning_effort: "medium", developer_instructions: null },
    });
    expect(collaborationModeSettings(modes, "default", { model: "gpt-x", effort: "high" })).toEqual(
      {
        mode: "default",
        settings: { model: "gpt-x", reasoning_effort: "high", developer_instructions: null },
      },
    );
    expect(() =>
      collaborationModeSettings({ data: [] }, "plan", { model: "m", effort: null }),
    ).toThrow("no plan collaboration mode");
    expect(() => collaborationModeSettings(modes, "plan", { model: null, effort: null })).toThrow(
      "model is unknown",
    );
  });
});

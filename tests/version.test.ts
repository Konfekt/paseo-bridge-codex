import { describe, expect, it, vi } from "vitest";
import {
  CODEX_TESTED_VERSION,
  cliVersion,
  codexSupport,
  codexVersionRequirement,
  isSupportedCodexVersion,
  PASEO_MIN_VERSION,
  PASEO_TESTED_VERSION,
  userAgentVersion,
  warnTentativeCodex,
  warnTentativePaseo,
} from "../src/protocol.js";

describe("Codex version gate", () => {
  it("verifies the tested range, accepts newer releases tentatively and rejects older ones", () => {
    for (const version of ["0.164.0", "0.165.0", "0.169.0", "0.169.3"])
      expect(codexSupport(version)).toBe("verified");
    for (const version of [
      "0.170.0",
      "0.171.0-alpha.5",
      "0.165.0-alpha.1.1",
      "1.0.0",
      "1.2.3+build.7",
    ])
      expect(codexSupport(version)).toBe("tentative");
    for (const version of ["0.163.9", "0.164.0-alpha.11.1", "0.1.2505172116x", "", "latest"])
      expect(codexSupport(version)).toBe("unsupported");
    expect(isSupportedCodexVersion("0.170.0")).toBe(true);
    expect(isSupportedCodexVersion("0.163.0")).toBe(false);
  });

  it("warns once per component and tentative version", () => {
    const warn = vi.fn();
    expect(warnTentativeCodex("Codex CLI", "0.169.0", warn)).toBeUndefined();
    const message = warnTentativeCodex("Codex CLI", "0.172.0", warn);
    expect(message).toContain("Codex CLI 0.172.0 is newer than the tested range");
    expect(message).toContain("0.164.0 to 0.169.x");
    warnTentativeCodex("Codex CLI", "0.172.0", warn);
    warnTentativeCodex("Shared Codex daemon", "0.172.0", warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("parses CLI version output", () => {
    expect(cliVersion("codex-cli 0.169.0\n")).toBe("0.169.0");
    expect(cliVersion("codex-cli 0.171.0-alpha.5")).toBe("0.171.0-alpha.5");
    expect(cliVersion("something else 0.169.0")).toBeNull();
    expect(cliVersion("Update available!\ncodex-cli 0.169.1\r\n")).toBe("0.169.1");
    expect(cliVersion("codex 0.170.0")).toBe("0.170.0");
    expect(cliVersion("codex-cli\n0.169.0")).toBeNull();
  });

  it("parses the daemon user agent", () => {
    expect(
      userAgentVersion(
        "codex_cli_rs/0.169.0 (Ubuntu 24.4.0; x86_64) xterm-256color (paseo_bridge_codex; 0.1.0)",
      ),
    ).toBe("0.169.0");
    expect(userAgentVersion("codex/0.164.0")).toBe("0.164.0");
    expect(userAgentVersion("no version here")).toBeNull();
  });

  it("names pre-releases as such instead of calling them newer", () => {
    const message = warnTentativeCodex("Codex CLI", "0.166.0-alpha.2", vi.fn());
    expect(message).toContain("Codex CLI 0.166.0-alpha.2 is a pre-release");
  });

  it("reports empty version output explicitly", () => {
    expect(codexVersionRequirement("")).toBe(
      "Codex 0.164.0 or newer is required; found no version output",
    );
  });
});

describe("Paseo host version warning", () => {
  it("warns once for newer or pre-release hosts and stays quiet otherwise", () => {
    const warn = vi.fn();
    for (const version of ["0.14.0", "0.15.4", "0.15.9", null, undefined, ""])
      expect(warnTentativePaseo(version, warn)).toBeUndefined();
    expect(warnTentativePaseo("0.16.0", warn)).toContain(
      "Paseo host 0.16.0 is newer than the tested range (0.14.0 to 0.15.x)",
    );
    expect(warnTentativePaseo("0.16.0-beta.2", warn)).toContain("is a pre-release");
    warnTentativePaseo("0.16.0", warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("version constants", () => {
  it("match the manifest requirement and the pinned packages", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8"));
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(manifest.requirements.paseo).toBe(`>=${PASEO_MIN_VERSION}`);
    expect(pkg.dependencies["@getpaseo/server"]).toBe(PASEO_TESTED_VERSION);
    expect(pkg.devDependencies["@openai/codex"]).toBe(CODEX_TESTED_VERSION);
  });
});

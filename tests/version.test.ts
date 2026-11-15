import { describe, expect, it, vi } from "vitest";
import {
  cliVersion,
  codexSupport,
  isSupportedCodexVersion,
  userAgentVersion,
  warnTentativeCodex,
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
    expect(message).toContain("Codex CLI 0.172.0 is newer than the tested Codex range");
    expect(message).toContain("0.164.0 to 0.169.x");
    warnTentativeCodex("Codex CLI", "0.172.0", warn);
    warnTentativeCodex("Shared Codex daemon", "0.172.0", warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("parses CLI version output", () => {
    expect(cliVersion("codex-cli 0.169.0\n")).toBe("0.169.0");
    expect(cliVersion("codex-cli 0.171.0-alpha.5")).toBe("0.171.0-alpha.5");
    expect(cliVersion("something else 0.169.0")).toBeNull();
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
});

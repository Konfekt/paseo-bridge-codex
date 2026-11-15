import { describe, expect, it } from "vitest";
import {
  CODEX_SUPPORTED_RANGE,
  cliVersion,
  isSupportedCodexVersion,
  userAgentVersion,
} from "../src/protocol.js";

describe("Codex version gate", () => {
  it("accepts verified stable releases and rejects others", () => {
    expect(CODEX_SUPPORTED_RANGE).toBe("0.164.0 to 0.169.x");
    for (const version of ["0.164.0", "0.165.0", "0.169.0", "0.169.3"])
      expect(isSupportedCodexVersion(version)).toBe(true);
    for (const version of [
      "0.163.9",
      "0.170.0",
      "1.0.0",
      "0.169.0-alpha.1",
      "0.171.0-alpha.5",
      "",
      "latest",
    ])
      expect(isSupportedCodexVersion(version)).toBe(false);
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

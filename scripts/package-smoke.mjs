import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const staging = await mkdtemp(join(tmpdir(), "pbc-package-"));
const source = join(staging, "source");
const subprocessTimeoutMs = 90_000;
const preparationTimeoutMs = 300_000;
const options = { cwd: source, timeout: subprocessTimeoutMs };

// Copy tracked inputs only: no generated server files or workspace dependency symlink.
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repository,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
for (const relative of tracked) {
  const destination = join(source, relative);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(repository, relative), destination);
}
const plugin = JSON.parse(await readFile(join(source, "paseo-plugin.json"), "utf8"));
for (const [command, ...args] of plugin.build ?? []) {
  execFileSync(command, args, { ...options, timeout: preparationTimeoutMs, stdio: "inherit" });
}
execFileSync("pnpm", ["pack", "--pack-destination", staging], {
  ...options,
  stdio: "inherit",
});
const archives = (await readdir(staging)).filter((filename) => filename.endsWith(".tgz"));
assert.equal(archives.length, 1, "Pack must create exactly one archive");
const archive = join(staging, archives[0]);
const entries = execFileSync("tar", ["-tzf", archive], {
  ...options,
  encoding: "utf8",
})
  .trim()
  .split("\n");
for (const required of [
  "package/package.json",
  "package/paseo-plugin.json",
  "package/index.server.ts",
  "package/server/activation.js",
  "package/server/provider.js",
  "package/server/cli.js",
  "package/README.md",
])
  assert(entries.includes(required), `Missing package entry: ${required}`);
for (const entry of entries) {
  assert(
    !/^package\/(?:src|tests|scripts|\.plans|\.devnotes|node_modules)\//.test(entry),
    `Development content leaked into package: ${entry}`,
  );
  assert(!entry.startsWith("/") && !entry.split("/").includes(".."), "Unsafe archive entry");
}
execFileSync("tar", ["-xzf", archive, "-C", staging], options);
const extracted = join(staging, "package");
// Paseo validates canonical module paths; install under this plugin root, as Git setup does.
for (const filename of ["pnpm-lock.yaml", "pnpm-workspace.yaml"])
  await copyFile(join(source, filename), join(extracted, filename));
execFileSync("pnpm", ["install", "--offline", "--prod", "--frozen-lockfile"], {
  cwd: extracted,
  timeout: preparationTimeoutMs,
  stdio: "inherit",
});
const manifest = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
assert.equal(manifest.bin["paseo-bridge-codex"], "server/cli.js");
const help = execFileSync(
  process.execPath,
  [join(extracted, manifest.bin["paseo-bridge-codex"]), "--help"],
  {
    ...options,
    encoding: "utf8",
  },
);
assert.match(help, /Usage: paseo-bridge-codex/);
assert.match(help, /\[once\]/);
execFileSync(
  process.execPath,
  [
    join(source, "node_modules/vitest/vitest.mjs"),
    "run",
    "tests/integration.test.ts",
    "--reporter=verbose",
  ],
  {
    ...options,
    stdio: "inherit",
    env: { ...process.env, PASEO_BRIDGE_TEST_PLUGIN_DIR: extracted },
  },
);
process.stdout.write(
  `Source preparation and packed artifact verified: ${archive}\nDependencies installed from the lockfile in an isolated tracked-source snapshot.\n`,
);

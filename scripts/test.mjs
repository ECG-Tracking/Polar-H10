// Compiles tests/*.test.ts with esbuild into a temporary folder and runs them with `node --test`.
import { build } from "esbuild";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "tests");
const files = (await readdir(testDir)).filter((f) => f.endsWith(".test.ts"));
const out = await mkdtemp(join(tmpdir(), "openbeat-tests-"));
try {
  await build({
    entryPoints: files.map((f) => join(testDir, f)),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: out,
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
  const compiled = files.map((f) => join(out, f.replace(/\.ts$/, ".mjs")));
  const run = spawnSync(process.execPath, ["--test", ...compiled], { stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally {
  await rm(out, { recursive: true, force: true });
}

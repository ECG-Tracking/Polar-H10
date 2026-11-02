// Remembers that `npm run check` passed for the exact files that would be published.
//   node scripts/stamp.mjs write   — after a passing check: save a fingerprint of those files
//   node scripts/stamp.mjs verify  — exit 0 if nothing has changed since, 1 otherwise
// The fingerprint covers every file git would upload (tracked or new, not ignored), so any edit means re-checking.
// Documentation is left out: the checks don't read it, and the changelog's "published" label is set at publish time.
const DOCS = new Set(["CHANGELOG.md", "README.md"]);
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stampFile = join(root, "node_modules", ".check-passed");

async function fingerprint() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((f) => f && !DOCS.has(f)).sort();
  const hash = createHash("sha256");
  for (const f of files) {
    let content;
    try { content = await readFile(join(root, f)); } catch { continue; } // deleted but still tracked
    hash.update(f).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

const mode = process.argv[2];
if (mode === "write") {
  await mkdir(dirname(stampFile), { recursive: true });
  await writeFile(stampFile, await fingerprint());
} else if (mode === "verify") {
  const saved = await readFile(stampFile, "utf8").catch(() => "");
  process.exitCode = saved && saved === (await fingerprint()) ? 0 : 1;
} else {
  console.error("usage: node scripts/stamp.mjs write|verify");
  process.exitCode = 2;
}

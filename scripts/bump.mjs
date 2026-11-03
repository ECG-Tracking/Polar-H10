// node scripts/bump.mjs [patch|minor|major]  — raises the app version before a publish and sets the release date.
// The version and date are shown in the app (footer and Settings) and written into the changelog heading.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(kind)) {
  console.error("usage: node scripts/bump.mjs [patch|minor|major]");
  process.exit(2);
}
const pkgPath = join(root, "package.json"), lockPath = join(root, "package-lock.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const version = kind === "major" ? `${major + 1}.0.0` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
const d = new Date();
const releaseDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
pkg.version = version;
pkg.releaseDate = releaseDate;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(`Version ${version} (${releaseDate})`);

// Development aid: runs the sleep analysis on simulated nights and prints how well it matches the truth.
//   node scripts/sleep-probe.mjs [seeds...]
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  stdin: { contents: "export { analyzeSleep } from './src/sleep'; export { simulateNight } from './src/sleepsim';", resolveDir: root, loader: "ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { analyzeSleep, simulateNight } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds.length ? seeds : [1, 2, 3]) {
  const { data, truth } = simulateNight(seed);
  const t0 = performance.now();
  const a = analyzeSleep(data);
  const ms = performance.now() - t0;
  const stages = ["awake", "light", "deep", "rem"];
  const conf = Object.fromEntries(stages.map((s) => [s, Object.fromEntries(stages.map((p) => [p, 0]))]));
  let agree = 0;
  truth.forEach((s, e) => { const p = a.stages[e]; if (conf[s][p] !== undefined) conf[s][p]++; if (p === s) agree++; });
  const tm = (s) => truth.filter((x) => x === s).length / 2;
  console.log(`seed ${seed}: ${ms.toFixed(0)} ms, agreement ${(100 * agree / truth.length).toFixed(1)} %`);
  console.log("  truth min  ", Object.fromEntries(stages.map((s) => [s, tm(s)])));
  console.log("  metrics    ", JSON.stringify(Object.fromEntries(Object.entries(a.metrics).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
  console.log("  confusion (rows = truth, columns = estimate)");
  for (const s of stages) console.log("   ", s.padEnd(6), stages.map((p) => String(conf[s][p]).padStart(5)).join(""));
}

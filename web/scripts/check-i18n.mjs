// Finds UI texts used in the code (t("some.key")) that are missing from the dictionary in src/i18n.tsx.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk("src").filter((f) => /\.tsx?$/.test(f));
const defined = new Set([...readFileSync("src/i18n.tsx", "utf8").matchAll(/^\s*"([a-zA-Z0-9_.]+)":\s*\[/gm)].map((m) => m[1]));

const staticKeys = new Map();
const families = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) staticKeys.set(m[1], file);
  for (const m of text.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]+)\$\{/g)) families.add(m[1]);
}
const missing = [...staticKeys].filter(([key]) => !defined.has(key));
console.log(`keys defined: ${defined.size}, static keys used: ${staticKeys.size}`);
for (const prefix of families) console.log(`dynamic "${prefix}…": ${[...defined].filter((k) => k.startsWith(prefix)).length} keys defined`);
if (missing.length) {
  console.log("MISSING:");
  for (const [key, file] of missing) console.log(`  ${key}   (${file.replaceAll("\\", "/")})`);
  process.exit(1);
}
console.log("no missing keys");

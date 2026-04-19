import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Tiny, dependency-free .env loader. Reads `<repo-root>/.env` if present and
// sets any keys that aren't already in `process.env`. Values are taken
// verbatim — no shell-style variable expansion, no multi-line values. Lines
// starting with `#` and blank lines are ignored. Values may be optionally
// wrapped in double or single quotes, which are stripped.
//
// Rationale for not using the `dotenv` npm package: avoids a dep for ~25
// lines of code, keeps the `scripts/` subtree small. Node's built-in
// `--env-file` flag works too but would require changing how `tsx` is
// invoked; this approach runs inside the TS entrypoint so `import` ordering
// is clean.

export function loadDotEnv(repoRoot: string): void {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

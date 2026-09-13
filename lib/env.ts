// Per-machine runtime config. Secrets and machine-local paths live in
// ~/.config/gtm-prospect-pipeline/env (chmod 600) — never in this repo.
// TWENTY_API_KEY is resolved lazily so store-only tools (conflict-scan, store-lint,
// dedupe-leg) run on machines that don't have the CRM key.
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = join(homedir(), ".config", "gtm-prospect-pipeline", "env");

function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  if ((statSync(ENV_PATH).mode & 0o077) !== 0)
    throw new Error(`${ENV_PATH} must not be group/world-accessible — run: chmod 600 ${ENV_PATH}`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnvFile();

// blank/whitespace values fall through to the default rather than producing "" paths/URLs
const get = (name: string) => {
  const v = process.env[name] ?? fileEnv[name];
  return v && v.trim() !== "" ? v : undefined;
};

export function requireTwentyApiKey(): string {
  const v = get("TWENTY_API_KEY");
  if (!v) throw new Error(`TWENTY_API_KEY not set (checked process env and ${ENV_PATH})`);
  return v;
}

// Twenty's own default listen address; point this at your instance (or a reverse proxy).
export const TWENTY_BASE_URL = (get("TWENTY_BASE_URL") ?? "http://localhost:3000").replace(/\/$/, "");
export const PIPELINE_DATA = (get("PIPELINE_DATA") ?? join(homedir(), "Data", "gtm-prospect-pipeline")).replace(/\/$/, "");

// config/ is the single source of truth for signals, sequences, caps and suppression.
// PIPELINE_CONFIG_DIR overrides its location — used by tests to run the tools against a
// fixture config without editing the shipped template. Every config reader goes through
// configPath() so the override is honoured everywhere at once.
export const CONFIG_DIR = (get("PIPELINE_CONFIG_DIR") ?? fileURLToPath(new URL("../config/", import.meta.url))).replace(/\/$/, "");
export const configPath = (file: string): string => join(CONFIG_DIR, file);

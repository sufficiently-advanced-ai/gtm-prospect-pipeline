// evals/harness/model.ts — ModelClient implementations.
//
// Live calls shell out to the Claude Code CLI (`claude -p --output-format json --model <m>`),
// which keeps API keys out of this repo (DESIGN.md §Architecture). The spawn is injectable
// so tests never make a live model call.
import { execFile } from "node:child_process";
import { REPLAYS_DIR, makeReplay, writeReplay } from "./replay.ts";
import type { ModelClient, ModelRequest, Task } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 300_000; // 300s — a long evidence-synthesis turn is slow
const RETRY_DELAY_MS = 2_000;

export type SpawnResult = { stdout: string; stderr: string; code: number };
export type SpawnFn = (cmd: string, args: string[], input: string, timeoutMs: number) => Promise<SpawnResult>;

// Default spawn: execFile + prompt on stdin (the prompt is far too big for argv).
export const execFileSpawn: SpawnFn = (cmd, args, input, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err: any, stdout: string, stderr: string) => {
        if (err && err.code === "ENOENT") return reject(new Error(`\`${cmd}\` not found on PATH`));
        if (err && (err.killed || err.signal))
          return reject(new Error(`\`${cmd}\` timed out after ${timeoutMs}ms (signal ${err.signal ?? "—"})`));
        resolvePromise({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        });
      },
    );
    // EPIPE if the CLI exits before reading stdin — the exit code/stderr is the real error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pull the assistant text out of whatever `claude -p --output-format json` printed.
//
// The happy path is a single JSON object envelope with a string `result`. This also handles:
//  - leading noise before the JSON (some shells/wrappers print warnings first),
//  - stream-json / JSONL output, where the LAST parsable line is the result envelope,
//  - an array envelope (take its last element, or the last element of type "result"),
//  - content-block shapes ({content: [{type:"text", text}]}, {message:{content:[...]}}).
// An envelope with is_error true throws (a CLI-level error must not be scored as a verdict).
export function parseClaudeEnvelope(stdout: string): string {
  const raw = (stdout ?? "").trim();
  if (!raw) throw new Error("claude CLI produced no output");

  const candidates: unknown[] = [];
  const tryPush = (s: string) => {
    try {
      candidates.push(JSON.parse(s));
    } catch {
      /* not JSON */
    }
  };
  tryPush(raw);
  const brace = raw.search(/[{[]/);
  if (brace > 0) tryPush(raw.slice(brace));
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && candidates.length < 4; i--) tryPush(lines[i]);
  if (candidates.length === 0)
    throw new Error(`claude CLI output was not JSON (first 200 chars): ${raw.slice(0, 200)}`);

  for (const candidate of candidates) {
    const env = pickEnvelope(candidate);
    if (env && typeof env === "object") {
      const e = env as Record<string, any>;
      if (e.is_error === true || e.subtype === "error_during_execution")
        throw new Error(`claude CLI returned an error envelope: ${JSON.stringify(e).slice(0, 300)}`);
      const text = extractText(e);
      if (text !== null) return text;
    }
    if (typeof env === "string") return env;
  }
  throw new Error(
    `could not find result text in claude CLI output (first 200 chars): ${raw.slice(0, 200)}`,
  );
}

function pickEnvelope(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const result = [...value].reverse().find((v: any) => v && typeof v === "object" && v.type === "result");
  return result ?? value[value.length - 1];
}

function extractText(e: Record<string, any>): string | null {
  for (const key of ["result", "text", "response", "output"]) {
    if (typeof e[key] === "string") return e[key];
  }
  const blocks = Array.isArray(e.content) ? e.content : Array.isArray(e.message?.content) ? e.message.content : null;
  if (blocks) {
    const text = blocks
      .filter((b: any) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b: any) => b.text ?? "")
      .join("");
    if (text) return text;
  }
  if (e.result && typeof e.result === "object") return extractText(e.result as Record<string, any>);
  return null;
}

// Live client. One retry on transport failure (spawn error, nonzero exit, unusable output),
// then throw — a flaky connector is never allowed to degrade into a looser result.
export function liveClient(
  model: string,
  opts: { spawn?: SpawnFn; timeoutMs?: number; cli?: string; retries?: number; extraArgs?: string[] } = {},
): ModelClient {
  const spawn = opts.spawn ?? execFileSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cli = opts.cli ?? "claude";
  const retries = opts.retries ?? 1;

  return {
    async complete(req: ModelRequest): Promise<string> {
      const args = ["-p", "--output-format", "json", "--model", req.model || model];
      if (req.system) args.push("--append-system-prompt", req.system);
      if (opts.extraArgs) args.push(...opts.extraArgs);
      // NOTE: max_tokens has no CLI equivalent; requests carrying it are run at CLI defaults.

      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(RETRY_DELAY_MS);
        try {
          const res = await spawn(cli, args, req.prompt, timeoutMs);
          if (res.code !== 0)
            throw new Error(`\`${cli}\` exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 300)}`);
          return parseClaudeEnvelope(res.stdout);
        } catch (e) {
          lastError = e;
        }
      }
      throw new Error(`model call failed after ${retries + 1} attempt(s): ${(lastError as any)?.message ?? lastError}`);
    },
  };
}

// Offline: hand back a recorded response, ignoring the request. The runner is responsible
// for having validated the replay's fixture_sha/prompt_sha first (replay.ts).
export function replayClient(response: string): ModelClient {
  return { complete: async () => response };
}

// Offline guard: any live call attempted under --offline is a bug, not a fallback.
export function offlineGuardClient(): ModelClient {
  return {
    complete: async () => {
      throw new Error("offline run attempted a live model call — runners must use recorded replays");
    },
  };
}

// Wrap a live client so every response is persisted as a replay for the $0 corpus.
export function recordingClient(
  inner: ModelClient,
  meta: { task: Task | string; fixtureId: string; fixtureSha: string; promptSha: string; model: string },
  dir: string = REPLAYS_DIR,
): ModelClient {
  return {
    async complete(req: ModelRequest): Promise<string> {
      const response = await inner.complete(req);
      writeReplay(
        makeReplay({
          fixtureId: meta.fixtureId,
          task: meta.task,
          fixtureSha: meta.fixtureSha,
          promptSha: meta.promptSha,
          model: req.model || meta.model,
          response,
        }),
        dir,
      );
      return response;
    },
  };
}

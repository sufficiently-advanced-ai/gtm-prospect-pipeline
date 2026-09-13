// evals/harness/replay.ts — the committed $0 corpus: evals/replays/<task>/<fixture_id>.json.
//
// A replay is the raw model text for one (fixture, prompt template) pair. It is VALID only
// while both shas still match: change the fixture and the recorded answer was to a different
// question; change the prompt template and it was a different ask. Either way the replay
// dies and --offline skips that fixture with a reason (never a silent pass).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Replay, Task } from "./types.ts";

export const REPLAYS_DIR = resolve(fileURLToPath(import.meta.url), "..", "..", "replays");

export function replayPath(task: Task | string, fixtureId: string, dir: string = REPLAYS_DIR): string {
  return join(dir, task, `${fixtureId}.json`);
}

// The file's PATH already encodes (task, fixture_id), and so does its content. They are
// asserted to agree: a replay whose body names a different fixture — a bad copy-paste while
// hand-editing the corpus, a mis-scripted re-record — would otherwise be replayed as if it
// answered THIS fixture's question, scoring one account's response against another account's
// gold. Fail loud; the corpus is committed data and a mismatch is corruption, not a skip.
export function readReplay(task: Task | string, fixtureId: string, dir: string = REPLAYS_DIR): Replay | null {
  const path = replayPath(task, fixtureId, dir);
  if (!existsSync(path)) return null;
  const replay = JSON.parse(readFileSync(path, "utf8")) as Replay;
  if (replay.fixture_id !== fixtureId || replay.task !== task)
    throw new Error(
      `replay ${path} is mislabeled: it records ${replay.task}/${replay.fixture_id} but sits at ` +
        `${task}/${fixtureId}. Replaying it would score one fixture's response against another's gold.`,
    );
  return replay;
}

export function writeReplay(replay: Replay, dir: string = REPLAYS_DIR): string {
  const path = replayPath(replay.task, replay.fixture_id, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(replay, null, 2)}\n`);
  return path;
}

export function isReplayValid(replay: Replay | null, fixtureSha: string, promptSha: string): boolean {
  return !!replay && replay.fixture_sha === fixtureSha && replay.prompt_sha === promptSha;
}

// Load a replay for offline use, or explain (for RunnerResult.skip_reason) why there isn't
// one. Returns {response} on success, {skip_reason} otherwise.
export function loadValidReplay(
  task: Task | string,
  fixtureId: string,
  fixtureSha: string,
  promptSha: string,
  dir: string = REPLAYS_DIR,
): { response?: string; skip_reason?: string } {
  const replay = readReplay(task, fixtureId, dir);
  if (!replay) return { skip_reason: `no replay recorded at ${replayPath(task, fixtureId, dir)}` };
  if (replay.fixture_sha !== fixtureSha)
    return {
      skip_reason: `replay is stale: fixture sha ${replay.fixture_sha.slice(0, 12)} != ${fixtureSha.slice(0, 12)}`,
    };
  if (replay.prompt_sha !== promptSha)
    return {
      skip_reason: `replay is stale: prompt sha ${replay.prompt_sha.slice(0, 12)} != ${promptSha.slice(0, 12)}`,
    };
  return { response: replay.response };
}

export function makeReplay(opts: {
  fixtureId: string;
  task: Task | string;
  fixtureSha: string;
  promptSha: string;
  model: string;
  response: string;
  now?: Date;
}): Replay {
  return {
    fixture_id: opts.fixtureId,
    task: opts.task as Task,
    fixture_sha: opts.fixtureSha,
    prompt_sha: opts.promptSha,
    model: opts.model,
    response: opts.response,
    recorded_at: (opts.now ?? new Date()).toISOString(),
  };
}

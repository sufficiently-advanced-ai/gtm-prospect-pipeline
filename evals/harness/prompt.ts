// evals/harness/prompt.ts — prompt template utilities for the runners.
//
// DESIGN.md: "Prompts come from the live skill text." Runners read skills/*/SKILL.md and
// config/icp.md at run time and compose the template from the sections the production module
// would actually follow — never a paraphrase. The composed template's sha (inputs EXCLUDED)
// is recorded per run and in the baseline, so a skill or ICP edit shows up as a sha change and
// its effect on the scores is measured.
//
// Reads are confined to the repo: the eval harness never touches $PIPELINE_DATA (the live
// store). Nothing task-specific lives here; task templates belong in harness/runners/<task>.ts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ICP_PATH } from "./icp.ts";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Read a file by repo-relative path (skills/m2-triage-route/SKILL.md, config/icp.md, …).
export function readSkillFile(relPath: string): string {
  const abs = resolve(REPO_ROOT, relPath);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep))
    throw new Error(`prompt source escapes the repo: ${relPath}`);
  if (!existsSync(abs)) throw new Error(`prompt source not found: ${relPath} (looked at ${abs})`);
  return readFileSync(abs, "utf8");
}

// The operator's judgment file, verbatim, minus its HTML comments (which are template
// instructions to the operator, not rules for the model). This is where fit and disqualifier
// judgment lives for the fit-triage and route tasks; the skill text says HOW to triage.
export function readIcp(): string {
  return stripHtmlComments(readSkillFile(ICP_PATH)).replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHtmlComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

// Extract one markdown section: the heading line through (not including) the next heading of
// the same or higher level. `heading` may be given with or without leading #'s; matching is
// case-insensitive on the heading text. Throws when absent — a renamed section must fail the
// run loudly rather than silently drop the rule it carried.
export function extractSection(md: string, heading: string): string {
  const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const lines = md.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase() === wanted) {
        start = i;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) return lines.slice(start, i).join("\n").trimEnd();
  }
  if (start === -1) throw new Error(`section not found: "${heading}"`);
  return lines.slice(start).join("\n").trimEnd();
}

// Find the section whose heading TEXT begins with `prefix` and return it verbatim (heading
// line included). Headings may carry a parenthetical tail that is edited freely; losing the
// section NAME throws, loudly, for the same reason extractSection does.
export function sectionByPrefix(md: string, prefix: string, source = "the prompt source"): string {
  const wanted = prefix.trim().toLowerCase();
  for (const line of md.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (m && m[1].trim().toLowerCase().startsWith(wanted)) return extractSection(md, m[1]);
  }
  throw new Error(`${source}: no section whose heading starts with "${prefix}"`);
}

// Compose a prompt template from parts. Each part is trimmed, empties dropped, joined by a
// blank line. The sha is sha256 of exactly that joined text — the value recorded as
// prompt_sha and used as the replay key, so any drift in the underlying skill text
// invalidates the recorded responses.
export function composeTemplate(parts: string[]): { text: string; sha: string } {
  const text = parts.map((p) => (p ?? "").trim()).filter((p) => p !== "").join("\n\n");
  return { text, sha: sha256(text) };
}

// Fenced block helper — the conventional way runners hand a fixture input to the model
// without letting it be mistaken for instructions.
export function fenced(label: string, body: string, lang = ""): string {
  return `${label}:\n\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;
}

// The model's verdict object out of a model response: fenced ```json block, else the first
// balanced {...} span (so an array-wrapped or prose-wrapped verdict still yields its object).
// Returns null when there is nothing parsable — the caller scores that as wrong
// (DESIGN.md: parse failure = wrong answer, never a skip).
//
// `preferKeyed` (optional — omit and the behavior above is EXACTLY unchanged): the caller's
// primary verdict field, e.g. "route". Why it exists: a model sometimes emits a verdict, writes
// "wait, that contradicts the evidence", and emits a corrected object — first-object parsing
// scored the answer the model had retracted.
//
// The rule is the OUTPUT PROTOCOL the runners state ("one single JSON object: the last thing
// in your reply"), enforced rather than merely requested:
//
//   1. Top-level objects are scanned with NO nested promotion: after a span that fails to
//      parse, the scan resumes past that span's balanced end, never inside it (a malformed
//      outer object must not let its nested child be promoted to "the verdict").
//   2. If nothing in the reply carries the key at all, preferKeyed has no opinion and the
//      DEFAULT path above applies unchanged — a stray example never invents a verdict.
//   3. Otherwise the TERMINAL object decides: the one whose closing brace is followed only by
//      whitespace (a closing ``` fence is tolerated, since a fenced answer is still terminal).
//      It must parse AND carry the key as a STRING. If it does not — unparseable, truncated
//      mid-emit, key null/object/array — that is a PARSE FAILURE (null → scored wrong), never
//      a fallback to an earlier object. Rescuing a contract violator by hunting backwards for
//      a better-looking answer is exactly how an eval flatters the thing it is supposed to
//      measure: the retracted object it would find is often the FORBIDDEN value.
//   4. If the reply trailed off into prose after its JSON, the verdict is accepted only when
//      it is unambiguous — exactly one object anywhere carries the key as a string. Two or
//      more candidates with no final one is unresolvable, and guessing the later one would
//      score a "for contrast, a SKIP would look like {...}" aside as the answer, converting a
//      correct reply into a FORBIDDEN HIT. Ambiguity scores wrong, never as a false regression.
//
// Accepted strictness, deliberately: an array-wrapped verdict (`[{...}]`) is not terminal
// (the `]` follows it), so it parses only under rule 4.
export function extractJsonObject(text: string, preferKeyed?: string): Record<string, unknown> | null {
  if (!text) return null;
  if (preferKeyed) {
    const decided = decideKeyed(text, preferKeyed);
    if (decided !== UNDECIDED) return decided;
    // else: no object in the reply carried the key — fall through to the default path.
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const span = balancedSpan(candidate);
    if (!span) continue;
    try {
      const parsed = JSON.parse(span);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// "preferKeyed has no opinion" — distinct from a decided `null` (parse failure).
const UNDECIDED = Symbol("undecided");

type ScannedObject = {
  value: Record<string, unknown> | null; // null = the balanced span did not parse as an object
  start: number;
  end: number; // index of the closing brace
};

// Every top-level `{...}` span in the text, in order, each with its parse result. The scan
// ALWAYS resumes at `end + 1`, even when the span failed to parse. A span that never closes
// ends the scan and is reported as `truncatedAt`: the reply stopped mid-object, and nothing
// after it can be top-level.
function scanTopLevelObjects(text: string): { objects: ScannedObject[]; truncatedAt: number | null } {
  const objects: ScannedObject[] = [];
  let truncatedAt: number | null = null;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    const end = balancedEnd(text, start);
    if (end === -1) {
      truncatedAt = start;
      break;
    }
    let value: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch {
      /* an unparseable span is recorded as such — it is still a consumed top-level span */
    }
    objects.push({ value, start, end });
    i = end + 1;
  }
  return { objects, truncatedAt };
}

// Only whitespace, optionally closing a code fence, may follow the verdict object.
const TERMINAL_TAIL_RE = /^\s*(?:```[^\n]*\s*)?$/;

function decideKeyed(text: string, key: string): Record<string, unknown> | null | typeof UNDECIDED {
  const { objects, truncatedAt } = scanTopLevelObjects(text);
  const carriesKey = objects.some((o) => o.value !== null && key in o.value);

  // Nothing attempted a keyed verdict and nothing is cut off: defer to the default path.
  if (!carriesKey && truncatedAt === null) return UNDECIDED;

  // The reply ends mid-object: the verdict never finished being written.
  if (truncatedAt !== null) return null;

  const last = objects[objects.length - 1];
  if (last && TERMINAL_TAIL_RE.test(text.slice(last.end + 1))) {
    // The reply DID end with an object, so that object is the verdict — whatever it turns out
    // to be. It must parse and carry the key as a string; anything else is a parse failure,
    // and specifically NOT a licence to go back and read the object it superseded.
    if (last.value === null) return null;
    if (typeof last.value[key] !== "string") return null;
    return last.value;
  }

  // No terminal object: the reply trailed off into prose after its JSON. Tolerated only when
  // the verdict is UNAMBIGUOUS — exactly one object in the whole reply carries the key as a
  // string ("Here you go: {...} — done." is a real and harmless shape). With two or more
  // candidates and none of them final, there is no principled way to tell the verdict from a
  // hypothetical the reasoning quoted, and guessing the later one turns a correct answer into
  // a FORBIDDEN HIT. Ambiguity is scored as a parse failure: wrong, but never a false report
  // that a lesson regressed.
  const keyedStrings = objects.filter((o) => o.value !== null && typeof o.value[key] === "string");
  return keyedStrings.length === 1 ? keyedStrings[0].value : null;
}

// Index of the `}` closing the object that opens at `start`, or -1 when it never closes.
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function balancedSpan(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = balancedEnd(text, start);
  return end === -1 ? null : text.slice(start, end + 1);
}

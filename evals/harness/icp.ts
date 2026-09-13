// evals/harness/icp.ts — the machine-read part of config/icp.md.
//
// config/icp.md is the operator's judgment file: prose the M2 module follows, plus ONE
// section the harness parses by machine — "## Drop classes", one bullet per class in the
// form `- <slug> — <description>` (lowercase snake_case slug, em-dash separator). The
// fit-triage task's `drop_class` field is validated against that list at load time, and the
// fit-triage runner quotes the same list into its output contract. Nothing about the classes
// is hardcoded here: rename a class in icp.md and the loader, the prompt, and the fixtures
// all see the new name (a fixture carrying a slug that no longer exists fails to load, loudly).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ICP_PATH = "config/icp.md";
export const DROP_CLASSES_HEADING = "Drop classes";
export const DROP_CLASS_SLUG_RE = /^[a-z][a-z0-9_]*$/;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

export type DropClass = { slug: string; description: string };

// Parse the "## Drop classes" section of an icp.md text. Throws when the section is missing,
// empty, or carries a malformed bullet — a rulebook the harness cannot read must fail the run
// rather than silently validate nothing.
export function parseDropClasses(md: string, source: string = ICP_PATH): DropClass[] {
  const lines = md.split("\n");
  const wanted = DROP_CLASSES_HEADING.toLowerCase();
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
    if (m[1].length <= level) break;
  }
  if (start === -1) throw new Error(`${source}: no "## ${DROP_CLASSES_HEADING}" section — the harness cannot validate drop_class`);

  const out: DropClass[] = [];
  const seen = new Set<string>();
  let inComment = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    // HTML comments carry the template's instructions — never a class definition.
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.trim().startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const parts = bullet[1].split(/\s+—\s+/); // em dash, the documented separator
    const slug = parts[0].trim().replace(/^`|`$/g, "");
    const description = parts.slice(1).join(" — ").trim();
    if (!DROP_CLASS_SLUG_RE.test(slug) || !description)
      throw new Error(
        `${source}: malformed drop-class bullet "${bullet[1].slice(0, 80)}" — expected \`- <slug> — <description>\` with a lowercase snake_case slug`,
      );
    if (seen.has(slug)) throw new Error(`${source}: duplicate drop class "${slug}"`);
    seen.add(slug);
    out.push({ slug, description });
  }
  if (out.length === 0) throw new Error(`${source}: "## ${DROP_CLASSES_HEADING}" lists no classes`);
  return out;
}

// Read config/icp.md from the repo and parse its drop classes. `repoRoot` is injectable for
// tests, and EVAL_ICP_FILE (tests only — a child-process scaffolder run cannot inject an
// argument) points at an alternative file; production always reads the live file.
export function loadDropClasses(repoRoot: string = REPO_ROOT): DropClass[] {
  const abs = process.env.EVAL_ICP_FILE ? resolve(process.env.EVAL_ICP_FILE) : resolve(repoRoot, ICP_PATH);
  if (!existsSync(abs)) throw new Error(`${ICP_PATH} not found at ${abs} — the drop-class vocabulary lives there`);
  return parseDropClasses(readFileSync(abs, "utf8"));
}

export const dropClassSlugs = (classes: DropClass[]): string[] => classes.map((c) => c.slug);

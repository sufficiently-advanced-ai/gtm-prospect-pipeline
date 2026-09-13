// evals/harness/contract.ts — the output protocol shared by every ENUM runner.
//
// The model reasons FIRST in prose and emits the JSON object LAST, with an explicit
// consistency requirement binding the enum field to the reasoning that precedes it. The
// failure mode this closes is label/rationale INVERSION — a reply whose `rationale` correctly
// applies the rulebook while the enum field states the opposite conclusion. Committing the
// label before any reasoning is written is what makes that possible; a settled prose
// conclusion the label must restate is what closes it. The strict single-object requirement
// stands, and the parser reads the terminal object carrying the task's primary key
// (prompt.ts extractJsonObject preferKeyed), so a reply that reasons and then emits one
// object parses exactly as intended.

// `work` names what the reasoning must actually do for this task (one clause, no period).
export function reasonFirstProtocol(work: string): string {
  return `--- OUTPUT PROTOCOL ---

Reason first, label last. Reply in exactly two parts, in this order:

1. REASONING — a short passage of plain prose in which you actually ${work}. Write no JSON
   in this part, and finish it holding a conclusion you have stated in words.
2. VERDICT — one single JSON object: the last thing in your reply, and the only JSON object
   anywhere in it.

CONSISTENCY REQUIREMENT (part of the contract, not advice): the enum field must state the
conclusion your reasoning reached. If the label you are about to write would disagree with
the reasoning you just wrote, your reasoning is not finished — settle the disagreement in the
reasoning first, then emit the object that matches it. Never emit a label your own reasoning
contradicts, and never emit a second or corrected object after the first.`;
}

// The line that opens every JSON contract block.
export const CONTRACT_HEADER = `--- OUTPUT CONTRACT ---

The VERDICT part is EXACTLY ONE JSON object and nothing but that object — no markdown fence
required, nothing after it. Shape:`;

export const INPUTS_ONLY_RULE = `Answer ONLY from the provided inputs. You have no outside knowledge of this company: do not
use anything you may recall about the name, the brand, or the domain, and do not invent
facts, people, titles, hires, products or size figures that are not in the inputs.`;

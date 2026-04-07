// The meta-meta-level (level 2): an LLM that modifies the meta-level.
//
// Just as level 1 modifies level 0's interpreter functions,
// level 2 modifies level 1's components: policies (what the
// code-generating LLM is told) and custom checks (what verification
// is run before a modification is installed).
//
// The boundary between levels 1 and 2 is another verification
// surface, with its own expressible/ecological/continuable checks.

import { chat } from "./llm.js";
import { Interpreter, InterpFnName } from "./interpreter.js";
import { MetaLevel, MetaModification, CustomCheck, modifyMetaLevel } from "./meta.js";
import { Violation } from "./verify.js";

const VALID_FN_NAMES: InterpFnName[] = [
  "baseEval", "evalVar", "evalIf", "evalDefine",
  "evalLambda", "evalBegin", "evalQuote", "baseApply",
  "evalList", "myError",
];

const SYSTEM_PROMPT = `You are the meta-meta-level (level 2) of a reflective tower.

Level 0 is a Scheme interpreter with modifiable functions:
  baseEval, evalVar, evalIf, evalDefine, evalLambda,
  evalBegin, evalQuote, baseApply, evalList, myError

Level 1 is an LLM that generates code to modify those functions.
Level 1 has these modifiable components:
  - policies: string[] — constraints appended to the code-generating LLM's prompt
  - customChecks: {name, check}[] — extra verification checks run before a
    modification is installed. Each check is a function
    (interp: Interpreter, mod: {fnName, code, description}) => Violation[]
    where Violation is {check: string, message: string}.
  - maxAttempts: number — how many tries the LLM gets to pass verification

You modify level 1's behavior. Respond with EXACTLY a JSON object
(no markdown fences):

To add a policy:
{
  "type": "policy",
  "content": "the policy text — this will be appended to level 1's system prompt",
  "description": "what this policy does"
}

To add a custom verification check:
{
  "type": "check",
  "name": "short name for the check",
  "code": "a JavaScript arrow function: (interp, mod) => { ... return violations; }",
  "description": "what this check enforces"
}

The check function receives:
  interp — the interpreter object (has .baseEval, .evalVar, .globalEnv, etc.)
  mod — the proposed modification: { fnName: string, code: string, description: string }
It must return an array of {check: string, message: string} objects (empty if ok).

To change max attempts:
{
  "type": "maxAttempts",
  "value": 5,
  "description": "why"
}

Examples:

User: "protect baseEval from modification"
{
  "type": "check",
  "name": "protect-baseEval",
  "code": "(interp, mod) => mod.fnName === 'baseEval' ? [{check: 'policy', message: 'baseEval is protected'}] : []",
  "description": "Prevents any modification to baseEval"
}

User: "tell the code generator to always use try/catch around original calls"
{
  "type": "policy",
  "content": "Always wrap calls to \`original(...)\` in a try/catch block that returns the original behavior on error.",
  "description": "Safety wrapper policy for generated code"
}
`;

export interface MetaMetaModification {
  type: "policy" | "check" | "maxAttempts";
  content?: string;    // for policy
  name?: string;       // for check
  code?: string;       // for check
  value?: number;      // for maxAttempts
  description: string;
}

// --- Verification at the level 1–2 boundary ---

interface MetaMetaVerifyResult {
  ok: boolean;
  violations: Violation[];
}

function verifyMetaModification(mod: MetaMetaModification): MetaMetaVerifyResult {
  const violations: Violation[] = [];

  // Expressible: is this a valid modification type?
  if (!["policy", "check", "maxAttempts"].includes(mod.type)) {
    violations.push({ check: "expressible", message: `unknown type "${mod.type}"` });
  }

  if (mod.type === "check") {
    // Expressible: does the check code parse?
    if (!mod.code) {
      violations.push({ check: "expressible", message: "check requires code" });
    } else {
      try {
        new Function(`return (${mod.code})`);
      } catch (e: any) {
        violations.push({ check: "expressible", message: `check code does not parse: ${e.message}` });
      }
    }

    // Ecological: no forbidden bindings in check code
    const FORBIDDEN = /\b(require|import\s*\(|process\.(exit|env|argv)|eval\s*\(|Function\s*\(|fs\.|child_process)/;
    if (mod.code && FORBIDDEN.test(mod.code)) {
      violations.push({ check: "ecological", message: "check code references forbidden bindings" });
    }

    // Continuable: does it compile to a function?
    if (mod.code) {
      try {
        const fn = new Function(`return (${mod.code})`)();
        if (typeof fn !== "function") {
          violations.push({ check: "continuable", message: "check code does not produce a function" });
        }
      } catch (e: any) {
        violations.push({ check: "continuable", message: `check code fails to compile: ${e.message}` });
      }
    }
  }

  if (mod.type === "policy" && !mod.content) {
    violations.push({ check: "expressible", message: "policy requires content" });
  }

  if (mod.type === "maxAttempts") {
    if (typeof mod.value !== "number" || mod.value < 1 || mod.value > 10) {
      violations.push({ check: "expressible", message: "maxAttempts must be a number between 1 and 10" });
    }
  }

  return { ok: violations.length === 0, violations };
}

// --- Apply a verified meta-meta modification ---

function applyMetaModification(meta: MetaLevel, mod: MetaMetaModification): void {
  switch (mod.type) {
    case "policy":
      modifyMetaLevel(meta, "policies", [...meta.policies, mod.content!]);
      break;
    case "check": {
      const fn = new Function(`return (${mod.code!})`)();
      const cc: CustomCheck = { name: mod.name || mod.description, check: fn };
      modifyMetaLevel(meta, "customChecks", [...meta.customChecks, cc]);
      break;
    }
    case "maxAttempts":
      modifyMetaLevel(meta, "maxAttempts", mod.value!);
      break;
  }
}

// --- The level 2 entry point ---

export interface MetaMetaExecResult {
  mod: MetaMetaModification;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export async function execAtMetaMetaLevel(
  request: string,
  meta: MetaLevel,
  onAttempt?: (attempt: number, mod: MetaMetaModification, violations: string[]) => void,
): Promise<MetaMetaExecResult> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await chat(
      messages,
      { system: SYSTEM_PROMPT, tier: "fast", maxTokens: 1024 },
    );

    let mod: MetaMetaModification;
    try {
      // Strip markdown fences if present
      const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "");
      mod = JSON.parse(cleaned);
    } catch {
      // Try extracting JSON
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Level 2 returned invalid JSON:\n${text}`);
      mod = JSON.parse(match[0]);
    }

    const result = verifyMetaModification(mod);
    const violations = result.violations.map(v => `${v.check}: ${v.message}`);

    if (onAttempt) onAttempt(attempt, mod, violations);

    if (result.ok) {
      applyMetaModification(meta, mod);
      return { mod, attempts: attempt };
    }

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `That failed verification:\n${violations.join("\n")}\n\nFix and try again.`,
    });
  }

  throw new Error(`Level 2 verification failed after ${MAX_ATTEMPTS} attempts`);
}

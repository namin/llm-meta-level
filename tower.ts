// A heterogeneous reflective tower of arbitrary depth.
//
// Level 0 is an exact Scheme interpreter. Levels ≥ 1 are LLMs.
// Each level N modifies level N-1 through a verified boundary.
//
// The tower is a sequence of boundaries. Boundary i sits between
// level i and level i+1. Each boundary holds policies, custom
// checks, and configuration that govern what level i+1 can do.
// New boundaries are created lazily — the tower grows upward
// on demand, like Black's infinite tower.

import { chat } from "./llm.js";
import {
  Interpreter,
  InterpFnName,
  modifyInterpreter,
  undoInterpreter,
  evaluate,
  parse,
  printValue,
} from "./interpreter.js";
import { verifyModification, Violation, VerifyResult, InterpModification } from "./verify.js";

// --- Modification types ---

// InterpModification is imported from verify.ts (the level 0↔1 artifact)

// Level N > 1 produces these (modifies a meta-level boundary)
export interface MetaModification {
  type: "policy" | "check" | "maxAttempts";
  content?: string;
  name?: string;
  code?: string;
  value?: number;
  description: string;
}

// --- Custom check installed by a higher level ---

export interface CustomCheck {
  name: string;
  check: (...args: any[]) => Violation[];
}

// --- Boundary between level N and level N+1 ---

export interface Boundary {
  policies: string[];
  customChecks: CustomCheck[];
  maxAttempts: number;
  undoStack: [string, any][];
}

function makeBoundary(): Boundary {
  return { policies: [], customChecks: [], maxAttempts: 3, undoStack: [] };
}

function modifyBoundary(b: Boundary, component: string, value: any): void {
  const old = (b as any)[component];
  b.undoStack.push([component, Array.isArray(old) ? [...old] : old]);
  (b as any)[component] = value;
}

function undoBoundary(b: Boundary): boolean {
  const entry = b.undoStack.pop();
  if (!entry) return false;
  (b as any)[entry[0]] = entry[1];
  return true;
}

// --- The tower ---

export interface Tower {
  interp: Interpreter;
  boundaries: Boundary[];  // boundaries[i] governs level i+1
}

export function makeTower(interp: Interpreter): Tower {
  return { interp, boundaries: [] };
}

// Ensure boundary exists up to index n (lazy tower growth)
function ensureBoundary(tower: Tower, n: number): void {
  while (tower.boundaries.length <= n) {
    tower.boundaries.push(makeBoundary());
  }
}

// --- System prompts ---

const INTERP_SYSTEM_PROMPT = `You are a level in a reflective tower of interpreters.

The object level is a small Scheme interpreter in TypeScript with these modifiable functions:

- baseEval(exp, env, interp) — dispatches on expression type
- evalVar(name, env, interp) — looks up a variable
- evalIf(args, env, interp) — evaluates conditionals
- evalDefine(args, env, interp) — handles define
- evalLambda(args, env, interp) — creates closures
- evalBegin(args, env, interp) — evaluates sequences
- evalQuote(args, env, interp) — handles quote
- baseApply(op, operands, env, interp) — applies a function to arguments
- evalList(exps, env, interp) — evaluates a list of expressions
- myError(msg, env, interp) — handles errors

Each function can call other interpreter functions via interp.fnName(...).
The interpreter also has interp.globalEnv (a Map<string, any>).

Respond with EXACTLY a JSON object (no markdown fences):

{
  "fnName": "the function to replace (e.g. evalVar, baseApply)",
  "code": "a JavaScript arrow function expression as a string",
  "description": "what this modification does"
}

The "code" field must be a valid JavaScript arrow function that takes
the same arguments as the function it replaces. The original function
is available as \`original\` in the closure.

Examples:

User: "make variable n always evaluate to 0"
{
  "fnName": "evalVar",
  "code": "(name, env, interp) => name === 'n' ? 0 : original(name, env, interp)",
  "description": "Variable n always evaluates to 0, others unchanged"
}

User: "make numbers work as functions that multiply their arguments"
{
  "fnName": "baseApply",
  "code": "(op, operands, env, interp) => typeof op === 'number' ? operands.reduce((a, b) => a * b, op) : original(op, operands, env, interp)",
  "description": "Numbers applied as functions multiply all arguments"
}
`;

function metaSystemPrompt(targetLevel: number): string {
  return `You are level ${targetLevel + 1} in a reflective tower of interpreters.

You modify level ${targetLevel}, which is an LLM that modifies level ${targetLevel - 1}.
Level ${targetLevel} has these modifiable components:
  - policies: string[] — constraints appended to level ${targetLevel}'s system prompt
  - customChecks: {name, check}[] — extra verification checks run before
    level ${targetLevel}'s modifications are installed. Each check is a function
    (interp, mod) => Violation[] where Violation is {check: string, message: string}.
    For interpreter modifications, mod is {fnName, code, description}.
    For meta-level modifications, mod is {type, content/code/value, description}.
  - maxAttempts: number — how many tries level ${targetLevel} gets to pass verification

Respond with EXACTLY a JSON object (no markdown fences):

To add a policy:
{
  "type": "policy",
  "content": "the policy text",
  "description": "what this policy does"
}

To add a custom verification check:
{
  "type": "check",
  "name": "short name",
  "code": "a JavaScript arrow function: (interp, mod) => { ... return violations; }",
  "description": "what this check enforces"
}

The check function receives:
  interp — the interpreter object
  mod — the proposed modification
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
  "content": "Always wrap calls to original(...) in a try/catch block.",
  "description": "Safety wrapper policy"
}
`;
}

// --- Build prompt with policies ---

function buildPrompt(basePrompt: string, boundary: Boundary): string {
  if (boundary.policies.length === 0) return basePrompt;
  return basePrompt + "\n\nAdditional policies (you MUST follow these):\n" +
    boundary.policies.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n";
}

// --- Verification ---

// Verify an interpreter modification (level 1 → level 0)
function verifyInterpMod(
  tower: Tower,
  mod: InterpModification,
  boundary: Boundary,
): VerifyResult {
  const base = verifyModification(tower.interp, mod);
  const custom: Violation[] = [];
  for (const cc of boundary.customChecks) {
    custom.push(...cc.check(tower.interp, mod));
  }
  const all = [...base.violations, ...custom];
  return { ok: all.length === 0, violations: all };
}

// Verify a meta-level modification (level N+1 → level N, N ≥ 1)
function verifyMetaMod(mod: MetaModification, boundary: Boundary): VerifyResult {
  const vs: Violation[] = [];

  if (!["policy", "check", "maxAttempts"].includes(mod.type)) {
    vs.push({ check: "expressible", message: `unknown type "${mod.type}"` });
  }

  if (mod.type === "check") {
    if (!mod.code) {
      vs.push({ check: "expressible", message: "check requires code" });
    } else {
      try { new Function(`return (${mod.code})`); }
      catch (e: any) { vs.push({ check: "expressible", message: `code does not parse: ${e.message}` }); }

      const FORBIDDEN = /\b(require|import\s*\(|process\.(exit|env|argv)|eval\s*\(|Function\s*\(|fs\.|child_process)/;
      if (FORBIDDEN.test(mod.code)) {
        vs.push({ check: "ecological", message: "code references forbidden bindings" });
      }

      try {
        const fn = new Function(`return (${mod.code})`)();
        if (typeof fn !== "function") vs.push({ check: "continuable", message: "code does not produce a function" });
      } catch (e: any) { vs.push({ check: "continuable", message: `code fails to compile: ${e.message}` }); }
    }
  }

  if (mod.type === "policy" && !mod.content) {
    vs.push({ check: "expressible", message: "policy requires content" });
  }

  if (mod.type === "maxAttempts") {
    if (typeof mod.value !== "number" || mod.value < 1 || mod.value > 10) {
      vs.push({ check: "expressible", message: "maxAttempts must be 1–10" });
    }
  }

  // Custom checks from the boundary above
  for (const cc of boundary.customChecks) {
    vs.push(...cc.check(null, mod));
  }

  return { ok: vs.length === 0, violations: vs };
}

// --- Apply modifications ---

function applyInterpMod(tower: Tower, mod: InterpModification): void {
  const original = tower.interp[mod.fnName] as Function;
  const factory = new Function("original", `return (${mod.code})`);
  modifyInterpreter(tower.interp, mod.fnName, factory(original));
}

function applyMetaMod(boundary: Boundary, mod: MetaModification): void {
  switch (mod.type) {
    case "policy":
      modifyBoundary(boundary, "policies", [...boundary.policies, mod.content!]);
      break;
    case "check": {
      const fn = new Function(`return (${mod.code!})`)();
      modifyBoundary(boundary, "customChecks", [
        ...boundary.customChecks,
        { name: mod.name || mod.description, check: fn },
      ]);
      break;
    }
    case "maxAttempts":
      modifyBoundary(boundary, "maxAttempts", mod.value!);
      break;
  }
}

// --- Parse JSON from LLM response ---

function parseJSON<T>(text: string): T {
  // Try stripping markdown fences
  const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  // Try extracting the last JSON object
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  throw new Error(`Invalid JSON:\n${text}`);
}

// --- The unified entry point ---

export interface ExecResult {
  level: number;
  description: string;
  attempts: number;
  interpMod?: InterpModification;
  metaMod?: MetaModification;
}

export type OnAttempt = (attempt: number, description: string, violations: string[]) => void;

export async function execAtLevel(
  tower: Tower,
  level: number,
  request: string,
  onAttempt?: OnAttempt,
): Promise<ExecResult> {
  if (level < 1) throw new Error("Cannot exec at level 0 (use evaluate)");

  // Ensure boundaries exist up to this level
  // boundary[level-1] governs what level N can do
  ensureBoundary(tower, level - 1);

  const boundary = tower.boundaries[level - 1];

  if (level === 1) {
    return execInterpLevel(tower, boundary, request, onAttempt);
  } else {
    // Level N > 1 modifies boundary[level-2]
    ensureBoundary(tower, level - 2);
    const target = tower.boundaries[level - 2];
    return execMetaLevelN(tower, level, boundary, target, request, onAttempt);
  }
}

async function execInterpLevel(
  tower: Tower,
  boundary: Boundary,
  request: string,
  onAttempt?: OnAttempt,
): Promise<ExecResult> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];
  const prompt = buildPrompt(INTERP_SYSTEM_PROMPT, boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 1024 });
    const mod = parseJSON<InterpModification>(text);
    const result = verifyInterpMod(tower, mod, boundary);
    const violations = result.violations.map(v => `${v.check}: ${v.message}`);

    if (onAttempt) onAttempt(attempt, mod.description, violations);

    if (result.ok) {
      applyInterpMod(tower, mod);
      return { level: 1, description: mod.description, attempts: attempt, interpMod: mod };
    }

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `Verification failed:\n${violations.join("\n")}\n\nFix and try again. JSON only.`,
    });
  }

  throw new Error(`Level 1 verification failed after ${boundary.maxAttempts} attempts`);
}

async function execMetaLevelN(
  tower: Tower,
  level: number,
  boundary: Boundary,    // governs this level
  target: Boundary,      // the boundary being modified
  request: string,
  onAttempt?: OnAttempt,
): Promise<ExecResult> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];
  const prompt = buildPrompt(metaSystemPrompt(level - 1), boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 1024 });
    const mod = parseJSON<MetaModification>(text);
    const result = verifyMetaMod(mod, boundary);
    const violations = result.violations.map(v => `${v.check}: ${v.message}`);

    if (onAttempt) onAttempt(attempt, mod.description, violations);

    if (result.ok) {
      applyMetaMod(target, mod);
      return { level, description: mod.description, attempts: attempt, metaMod: mod };
    }

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `Verification failed:\n${violations.join("\n")}\n\nFix and try again. JSON only.`,
    });
  }

  throw new Error(`Level ${level} verification failed after ${boundary.maxAttempts} attempts`);
}

// --- Undo ---

export function undoAtLevel(tower: Tower, level: number): boolean {
  if (level < 1) return false;
  if (level === 1) return undoInterpreter(tower.interp);
  const idx = level - 2;
  if (idx >= tower.boundaries.length) return false;
  return undoBoundary(tower.boundaries[idx]);
}

// --- Show tower state ---

export function showTower(tower: Tower): string {
  const lines: string[] = [];

  if (tower.interp.undoStack.length > 0) {
    lines.push("level 0 (interpreter):");
    tower.interp.undoStack.forEach(([name], i) => lines.push(`  ${i}: modified ${name}`));
  }

  for (let i = 0; i < tower.boundaries.length; i++) {
    const b = tower.boundaries[i];
    const hasState = b.undoStack.length > 0 || b.policies.length > 0 || b.customChecks.length > 0;
    if (!hasState) continue;
    lines.push(`boundary ${i}↔${i + 1}:`);
    if (b.policies.length > 0) {
      lines.push("  policies:");
      b.policies.forEach((p, j) => lines.push(`    ${j}: ${p}`));
    }
    if (b.customChecks.length > 0) {
      lines.push("  checks:");
      b.customChecks.forEach((c, j) => lines.push(`    ${j}: ${c.name}`));
    }
    if (b.undoStack.length > 0) {
      lines.push(`  undo stack: ${b.undoStack.length} entries`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "no modifications.";
}

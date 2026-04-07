// Scheme tower: level 0 is an exact Scheme interpreter,
// level 1 is an LLM that modifies interpreter functions,
// levels 2+ are governance (from core).

import { chat } from "../core/llm.js";
import { Interpreter, InterpFnName, modifyInterpreter, undoInterpreter } from "./interpreter.js";
import { verifyModification, InterpModification } from "./verify.js";
import {
  Boundary, Violation, ExecResult, OnAttempt,
  makeBoundary, ensureBoundary, undoBoundary,
  execMetaLevel, appendPolicies, showBoundaries, parseJSON,
} from "../core/governance.js";

export type { InterpModification } from "./verify.js";

// --- Tower ---

export interface Tower {
  interp: Interpreter;
  boundaries: Boundary[];
}

export function makeTower(interp: Interpreter): Tower {
  return { interp, boundaries: [] };
}

// --- Level 1: LLM modifies interpreter ---

const LEVEL1_SYSTEM_PROMPT = `You are a level in a reflective tower of interpreters.

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

function fullVerify(interp: Interpreter, mod: InterpModification, boundary: Boundary): { ok: boolean; violations: Violation[] } {
  const base = verifyModification(interp, mod);
  const custom: Violation[] = [];
  for (const cc of boundary.customChecks) custom.push(...cc.check(mod));
  return { ok: [...base.violations, ...custom].length === 0, violations: [...base.violations, ...custom] };
}

async function execLevel1(tower: Tower, request: string, onAttempt?: OnAttempt): Promise<ExecResult> {
  const boundary = tower.boundaries[0];
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];
  const prompt = appendPolicies(LEVEL1_SYSTEM_PROMPT, boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 1024 });
    const mod = parseJSON<InterpModification>(text);

    const result = fullVerify(tower.interp, mod, boundary);
    const violations = result.violations.map(v => `${v.check}: ${v.message}`);

    if (onAttempt) onAttempt(attempt, violations.length > 0 ? `REJECTED:\n${violations.join("\n")}` : "ok");

    if (result.ok) {
      const original = tower.interp[mod.fnName] as Function;
      const factory = new Function("original", `return (${mod.code})`);
      modifyInterpreter(tower.interp, mod.fnName, factory(original));
      return { level: 1, description: mod.description, attempts: attempt };
    }

    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: `Verification failed:\n${violations.join("\n")}\n\nFix and try again. JSON only.` });
  }

  throw new Error(`Level 1 verification failed after ${boundary.maxAttempts} attempts`);
}

// --- Unified exec ---

export async function execAtLevel(tower: Tower, level: number, request: string, onAttempt?: OnAttempt): Promise<ExecResult> {
  if (level < 1) throw new Error("Cannot exec at level 0");
  ensureBoundary(tower.boundaries, level - 1);

  if (level === 1) return execLevel1(tower, request, onAttempt);

  ensureBoundary(tower.boundaries, level - 2);
  return execMetaLevel(level, tower.boundaries[level - 1], tower.boundaries[level - 2], request, onAttempt);
}

// --- Undo ---

export function undoAtLevel(tower: Tower, level: number): boolean {
  if (level === 1) return undoInterpreter(tower.interp);
  const idx = level - 2;
  if (idx < 0 || idx >= tower.boundaries.length) return false;
  return undoBoundary(tower.boundaries[idx]);
}

// --- Show ---

export function showTower(tower: Tower): string {
  const lines: string[] = [];
  if (tower.interp.undoStack.length > 0) {
    lines.push("level 0 (interpreter):");
    tower.interp.undoStack.forEach(([name], i) => lines.push(`  ${i}: modified ${name}`));
  }
  const bLines = showBoundaries(tower.boundaries);
  if (bLines) lines.push(bLines);
  return lines.length > 0 ? lines.join("\n") : "no modifications.";
}

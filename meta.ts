// The LLM meta-level: given a natural language request,
// generates JavaScript code that modifies the interpreter.
// This is the approximate oracle in the heterogeneous tower.

import { chat } from "./llm.js";
import { Interpreter, InterpFnName, modifyInterpreter } from "./interpreter.js";
import { verifyModification, VerifyResult } from "./verify.js";

const SYSTEM_PROMPT = `You are the meta-level of a reflective tower of interpreters.

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

When the user asks you to modify the interpreter's behavior, respond with
EXACTLY a JSON object (no markdown fences) with these fields:

{
  "fnName": "the function to replace (e.g. evalVar, baseApply)",
  "code": "a JavaScript arrow function expression as a string",
  "description": "what this modification does"
}

The "code" field must be a valid JavaScript arrow function that takes
the same arguments as the function it replaces. You can capture the
original function via the closure — it will be available as \`original\`.

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

User: "trace all variable lookups"
{
  "fnName": "evalVar",
  "code": "(name, env, interp) => { const v = original(name, env, interp); console.log('lookup', name, '->', v); return v; }",
  "description": "Logs every variable lookup"
}
`;

export interface MetaModification {
  fnName: InterpFnName;
  code: string;
  description: string;
}

export interface ExecResult {
  mod: MetaModification;
  attempts: number;
  history: { mod: MetaModification; violations: string[] }[];
}

const MAX_ATTEMPTS = 3;

export async function execAtMetaLevel(
  request: string,
  interp: Interpreter,
  onAttempt?: (attempt: number, mod: MetaModification, violations: string[]) => void,
): Promise<ExecResult> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];
  const history: { mod: MetaModification; violations: string[] }[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await chat(
      messages,
      { system: SYSTEM_PROMPT, tier: "fast", maxTokens: 1024 },
    );

    const mod = parseModification(text);

    // --- Verification gate (cf. Blond's _check_and_spawn) ---
    const result = verifyModification(interp, mod);
    const violations = result.violations.map(v => `${v.check}: ${v.message}`);

    if (onAttempt) onAttempt(attempt, mod, violations);
    history.push({ mod, violations });

    if (result.ok) {
      applyModification(interp, mod);
      return { mod, attempts: attempt, history };
    }

    // Feed violations back to the LLM for another attempt
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `That modification failed verification:\n${violations.join("\n")}\n\nPlease fix and try again. Respond with only the corrected JSON object.`,
    });
  }

  const lastViolations = history[history.length - 1].violations;
  throw new Error(
    `Verification failed after ${MAX_ATTEMPTS} attempts:\n  ${lastViolations.join("\n  ")}`,
  );
}

function parseModification(text: string): MetaModification {
  const jsonMatches = [...text.matchAll(/\{[\s\S]*?"fnName"[\s\S]*?"code"[\s\S]*?"description"[\s\S]*?\}\s*$/gm)];
  if (jsonMatches.length === 0) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Meta-level returned invalid JSON:\n${text}`);
    }
  }
  const jsonStr = jsonMatches[jsonMatches.length - 1][0];
  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`Meta-level returned unparseable JSON:\n${jsonStr}`);
  }
}

export function applyModification(interp: Interpreter, mod: MetaModification): void {
  const original = interp[mod.fnName] as Function;
  const factory = new Function("original", `return (${mod.code})`);
  const newFn = factory(original);
  modifyInterpreter(interp, mod.fnName, newFn);
}

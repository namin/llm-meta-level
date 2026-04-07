// Verification gate for the heterogeneous tower.
//
// Blond's _check_and_spawn verifies three conditions before reflecting
// down: expressible (valid expression), ecological (well-formed
// environment), continuable (applicable continuation with arity 1).
//
// This module provides analogous checks for LLM-generated code
// modifications at the boundary between the approximate meta-level
// (LLM) and the exact object-level (interpreter).

import { Interpreter, InterpFnName, evaluate, parse, printValue, modifyInterpreter, undoInterpreter } from "./interpreter.js";
import { MetaModification } from "./meta.js";

const VALID_FN_NAMES: InterpFnName[] = [
  "baseEval", "evalVar", "evalIf", "evalDefine",
  "evalLambda", "evalBegin", "evalQuote", "baseApply",
  "evalList", "myError",
];

export interface Violation {
  check: "expressible" | "ecological" | "continuable" | "sandbox";
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  violations: Violation[];
}

// --- Expressible: is this a valid modification? ---
// Blond: is the reified expression made of constants, identifiers,
// and well-formed pairs?
// Here: does fnName refer to a real interpreter function, and does
// the code parse as a JavaScript function?

function checkExpressible(mod: MetaModification): Violation[] {
  const vs: Violation[] = [];

  if (!VALID_FN_NAMES.includes(mod.fnName)) {
    vs.push({
      check: "expressible",
      message: `unknown function "${mod.fnName}"`,
    });
  }

  try {
    new Function("original", `return (${mod.code})`);
  } catch (e: any) {
    vs.push({
      check: "expressible",
      message: `code does not parse: ${e.message}`,
    });
  }

  return vs;
}

// --- Ecological: does the code stay within its environment? ---
// Blond: is the reified environment tagged correctly and backed by
// a procedure?
// Here: does the code avoid reaching outside its scope — no require,
// dynamic eval, process access, or filesystem operations?

const FORBIDDEN = /\b(require|import\s*\(|process\.(exit|env|argv)|eval\s*\(|Function\s*\(|fs\.|child_process|__dirname|__filename)/;

function checkEcological(mod: MetaModification): Violation[] {
  if (FORBIDDEN.test(mod.code)) {
    return [{
      check: "ecological",
      message: `code references forbidden bindings`,
    }];
  }
  return [];
}

// --- Continuable: does the function have the right shape? ---
// Blond: is the reified continuation applicable with arity 1?
// Here: does the compiled function exist and have compatible arity
// with the function it replaces?

function checkContinuable(interp: Interpreter, mod: MetaModification): Violation[] {
  const vs: Violation[] = [];

  if (!VALID_FN_NAMES.includes(mod.fnName)) return vs; // caught by expressible

  try {
    const original = interp[mod.fnName] as Function;
    const factory = new Function("original", `return (${mod.code})`);
    const newFn = factory(original);

    if (typeof newFn !== "function") {
      vs.push({
        check: "continuable",
        message: `code does not produce a function`,
      });
    }
    // Arrow functions with destructuring/rest have length 0, so an
    // arity mismatch is a warning, not necessarily fatal — but it's
    // worth flagging.
  } catch (e: any) {
    vs.push({
      check: "continuable",
      message: `code fails to compile: ${e.message}`,
    });
  }

  return vs;
}

// --- Sandbox: does the modification crash on basic inputs? ---
// Beyond Blond. Temporarily install the modification, run a set of
// smoke tests, roll back. We check that basic expressions don't
// *crash*, not that they produce the same output — semantic changes
// are the whole point of exec-at-metalevel. A modification that
// makes (+ 1 2) return "III" is fine; one that makes it throw is not.

const SMOKE_TESTS: string[] = [
  "(+ 1 2)",
  "(* 3 4)",
  "(if #t 1 2)",
  "(if #f 1 2)",
  "(quote (a b c))",
  "42",
];

function checkSandbox(interp: Interpreter, mod: MetaModification): Violation[] {
  const vs: Violation[] = [];

  if (!VALID_FN_NAMES.includes(mod.fnName)) return vs;

  // Compile the new function
  let newFn: Function;
  try {
    const original = interp[mod.fnName] as Function;
    const factory = new Function("original", `return (${mod.code})`);
    newFn = factory(original);
  } catch {
    return vs; // caught by earlier checks
  }

  // Temporarily install
  const oldFn = interp[mod.fnName] as Function;
  (interp as any)[mod.fnName] = newFn;

  try {
    for (const input of SMOKE_TESTS) {
      try {
        evaluate(interp, parse(input));
      } catch (e: any) {
        vs.push({
          check: "sandbox",
          message: `crashed on ${input}: ${e.message}`,
        });
      }
    }
  } finally {
    // Roll back — this is not an undo-stack entry, just a temporary swap
    (interp as any)[mod.fnName] = oldFn;
  }

  return vs;
}

// --- The gate ---

export function verifyModification(interp: Interpreter, mod: MetaModification): VerifyResult {
  const violations = [
    ...checkExpressible(mod),
    ...checkEcological(mod),
    ...checkContinuable(interp, mod),
    ...checkSandbox(interp, mod),
  ];
  return { ok: violations.length === 0, violations };
}

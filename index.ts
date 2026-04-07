// A heterogeneous reflective tower:
// Level 0: exact Scheme-like interpreter (modifiable, like Black)
// Level 1: LLM oracle (approximate, generates modifications)
//
// Usage:
//   (+ 1 2)                         — evaluate at level 0 (exact)
//   (exec-at-metalevel "request")   — ask the LLM to modify the interpreter
//   (undo!)                         — undo the last meta-level modification
//   (show-meta)                     — show the undo stack (modification history)

import * as readline from "readline";
import {
  makeInterpreter,
  parse,
  evaluate,
  printValue,
  undoInterpreter,
  Interpreter,
  Expr,
} from "./interpreter.js";
import { execAtMetaLevel } from "./meta.js";

const interp = makeInterpreter();

// Add special forms that the base interpreter doesn't handle
const originalBaseEval = interp.baseEval;
interp.baseEval = (exp: Expr, env, interp_: Interpreter) => {
  if (Array.isArray(exp) && exp.length > 0) {
    if (exp[0] === "exec-at-metalevel") {
      // Marker — handled in the REPL loop since it's async
      return { __meta_request: exp[1] } as any;
    }
    if (exp[0] === "undo!") {
      return { __undo: true } as any;
    }
    if (exp[0] === "show-meta") {
      return { __show_meta: true } as any;
    }
  }
  return originalBaseEval(exp, env, interp_);
};

async function handleInput(line: string): Promise<string> {
  let exp: Expr;
  try {
    exp = parse(line);
  } catch (e: any) {
    return `parse error: ${e.message}`;
  }

  let result;
  try {
    result = evaluate(interp, exp);
  } catch (e: any) {
    return `error: ${e.message}`;
  }

  // Handle meta-level requests (async)
  if (result && typeof result === "object" && "__meta_request" in (result as any)) {
    const request = (result as any).__meta_request;
    // The request might be a string literal or an expression to evaluate
    const reqStr = typeof request === "string" ? request : printValue(request);
    try {
      console.log(`\x1b[2m  [meta-level] asking LLM: "${reqStr}"\x1b[0m`);
      const result = await execAtMetaLevel(reqStr, interp, (attempt, mod, violations) => {
        if (violations.length > 0) {
          console.log(`\x1b[2m  [verify] attempt ${attempt}: REJECTED\x1b[0m`);
          for (const v of violations) console.log(`\x1b[2m    ${v}\x1b[0m`);
          console.log(`\x1b[2m  [verify] feeding violations back to LLM...\x1b[0m`);
        } else {
          console.log(`\x1b[2m  [verify] attempt ${attempt}: expressible, ecological, continuable, sandbox — ok\x1b[0m`);
        }
      });
      console.log(`\x1b[2m  [meta-level] modified ${result.mod.fnName}: ${result.mod.description}\x1b[0m`);
      return `meta: ${result.mod.description}`;
    } catch (e: any) {
      return `meta error: ${e.message}`;
    }
  }

  // Handle undo
  if (result && typeof result === "object" && "__undo" in (result as any)) {
    if (undoInterpreter(interp)) {
      return "undone.";
    }
    return "nothing to undo.";
  }

  // Handle show-meta
  if (result && typeof result === "object" && "__show_meta" in (result as any)) {
    if (interp.undoStack.length === 0) return "no modifications.";
    return interp.undoStack
      .map(([name], i) => `  ${i}: modified ${name}`)
      .join("\n");
  }

  return printValue(result);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Heterogeneous Reflective Tower");
  console.log("Level 0: exact interpreter | Level 1: LLM oracle");
  console.log('Type Scheme expressions, or (exec-at-metalevel "...") to modify the interpreter.\n');

  const prompt = () => {
    rl.question("tower> ", async (line) => {
      if (!line.trim()) return prompt();
      const result = await handleInput(line.trim());
      if (result) console.log(result);
      prompt();
    });
  };

  prompt();
}

main();

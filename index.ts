// A heterogeneous reflective tower:
// Level 0: exact Scheme-like interpreter (modifiable, like Black)
// Level 1: LLM oracle (approximate, generates modifications to level 0)
// Level 2: LLM oracle (approximate, generates modifications to level 1)
//
// Usage:
//   (+ 1 2)                              — evaluate at level 0
//   (exec-at-metalevel "request")        — level 1 modifies interpreter
//   (exec-at-meta-metalevel "request")   — level 2 modifies meta-level
//   (undo!)                              — undo last level-1 modification
//   (undo-meta!)                         — undo last level-2 modification
//   (show-meta)                          — show modification history

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
import { execAtMetaLevel, makeMetaLevel, undoMetaLevel } from "./meta.js";
import { execAtMetaMetaLevel } from "./metameta.js";

const interp = makeInterpreter();
const meta = makeMetaLevel();

// Add special forms that the base interpreter doesn't handle
const originalBaseEval = interp.baseEval;
interp.baseEval = (exp: Expr, env, interp_: Interpreter) => {
  if (Array.isArray(exp) && exp.length > 0) {
    if (exp[0] === "exec-at-metalevel") {
      return { __meta_request: exp[1] } as any;
    }
    if (exp[0] === "exec-at-meta-metalevel") {
      return { __metameta_request: exp[1] } as any;
    }
    if (exp[0] === "undo!") {
      return { __undo: true } as any;
    }
    if (exp[0] === "undo-meta!") {
      return { __undo_meta: true } as any;
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

  // Handle meta-level requests (level 1)
  if (result && typeof result === "object" && "__meta_request" in (result as any)) {
    const request = (result as any).__meta_request;
    const reqStr = typeof request === "string" ? request : printValue(request);
    try {
      console.log(`\x1b[2m  [level 1] asking LLM: "${reqStr}"\x1b[0m`);
      const r = await execAtMetaLevel(reqStr, interp, meta, (attempt, mod, violations) => {
        if (violations.length > 0) {
          console.log(`\x1b[2m  [verify 0↔1] attempt ${attempt}: REJECTED\x1b[0m`);
          for (const v of violations) console.log(`\x1b[2m    ${v}\x1b[0m`);
          console.log(`\x1b[2m  [verify 0↔1] feeding violations back to LLM...\x1b[0m`);
        } else {
          console.log(`\x1b[2m  [verify 0↔1] attempt ${attempt}: ok\x1b[0m`);
        }
      });
      console.log(`\x1b[2m  [level 1] modified ${r.mod.fnName}: ${r.mod.description}\x1b[0m`);
      return `meta: ${r.mod.description}`;
    } catch (e: any) {
      return `meta error: ${e.message}`;
    }
  }

  // Handle meta-meta-level requests (level 2)
  if (result && typeof result === "object" && "__metameta_request" in (result as any)) {
    const request = (result as any).__metameta_request;
    const reqStr = typeof request === "string" ? request : printValue(request);
    try {
      console.log(`\x1b[2m  [level 2] asking LLM: "${reqStr}"\x1b[0m`);
      const r = await execAtMetaMetaLevel(reqStr, meta, (attempt, mod, violations) => {
        if (violations.length > 0) {
          console.log(`\x1b[2m  [verify 1↔2] attempt ${attempt}: REJECTED\x1b[0m`);
          for (const v of violations) console.log(`\x1b[2m    ${v}\x1b[0m`);
          console.log(`\x1b[2m  [verify 1↔2] feeding violations back to LLM...\x1b[0m`);
        } else {
          console.log(`\x1b[2m  [verify 1↔2] attempt ${attempt}: ok\x1b[0m`);
        }
      });
      console.log(`\x1b[2m  [level 2] ${r.mod.type}: ${r.mod.description}\x1b[0m`);
      return `meta-meta: ${r.mod.description}`;
    } catch (e: any) {
      return `meta-meta error: ${e.message}`;
    }
  }

  // Handle undo (level 1)
  if (result && typeof result === "object" && "__undo" in (result as any)) {
    if (undoInterpreter(interp)) return "undone.";
    return "nothing to undo.";
  }

  // Handle undo-meta (level 2)
  if (result && typeof result === "object" && "__undo_meta" in (result as any)) {
    if (undoMetaLevel(meta)) return "meta undone.";
    return "nothing to undo at meta level.";
  }

  // Handle show-meta
  if (result && typeof result === "object" && "__show_meta" in (result as any)) {
    const lines: string[] = [];
    if (interp.undoStack.length > 0) {
      lines.push("level 0↔1:");
      interp.undoStack.forEach(([name], i) => lines.push(`  ${i}: modified ${name}`));
    }
    if (meta.undoStack.length > 0) {
      lines.push("level 1↔2:");
      meta.undoStack.forEach(([name], i) => lines.push(`  ${i}: modified ${name}`));
    }
    if (meta.policies.length > 0) {
      lines.push("policies:");
      meta.policies.forEach((p, i) => lines.push(`  ${i}: ${p}`));
    }
    if (meta.customChecks.length > 0) {
      lines.push("custom checks:");
      meta.customChecks.forEach((c, i) => lines.push(`  ${i}: ${c.name}`));
    }
    return lines.length > 0 ? lines.join("\n") : "no modifications.";
  }

  return printValue(result);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Heterogeneous Reflective Tower");
  console.log("Level 0: exact interpreter | Level 1: LLM (modifies interpreter) | Level 2: LLM (modifies meta-level)");
  console.log('  (exec-at-metalevel "...")       — level 1 modifies the interpreter');
  console.log('  (exec-at-meta-metalevel "...")   — level 2 modifies the meta-level');
  console.log('  (undo!) / (undo-meta!)          — undo at level 1 / level 2');
  console.log('  (show-meta)                     — show all modifications\n');

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

// A heterogeneous reflective tower of arbitrary depth.
//
// Level 0: exact Scheme interpreter
// Levels 1, 2, 3, ...: LLM oracles, each modifying the level below
//
// Usage:
//   (+ 1 2)                    — evaluate at level 0
//   (meta 1 "request")         — level 1 modifies the interpreter
//   (meta 2 "request")         — level 2 modifies level 1's behavior
//   (meta 3 "request")         — level 3 modifies level 2's behavior, ...
//   (undo 1) / (undo 2) / ...  — undo at a level
//   (show-tower)               — show all modifications

import * as readline from "readline";
import {
  makeInterpreter,
  parse,
  evaluate,
  printValue,
  Interpreter,
  Expr,
} from "./interpreter.js";
import { makeTower, execAtLevel, undoAtLevel, showTower } from "./tower.js";

const tower = makeTower(makeInterpreter());

// Add special forms
const originalBaseEval = tower.interp.baseEval;
tower.interp.baseEval = (exp: Expr, env, interp: Interpreter) => {
  if (Array.isArray(exp) && exp.length > 0) {
    if (exp[0] === "meta" && exp.length === 3) {
      return { __meta: { level: exp[1], request: exp[2] } } as any;
    }
    if (exp[0] === "undo" && exp.length === 2) {
      return { __undo: exp[1] } as any;
    }
    if (exp[0] === "show-tower") {
      return { __show_tower: true } as any;
    }
    // Backward compat
    if (exp[0] === "exec-at-metalevel") {
      return { __meta: { level: 1, request: exp[1] } } as any;
    }
    if (exp[0] === "undo!") {
      return { __undo: 1 } as any;
    }
  }
  return originalBaseEval(exp, env, interp);
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
    result = evaluate(tower.interp, exp);
  } catch (e: any) {
    return `error: ${e.message}`;
  }

  // Handle meta requests at any level
  if (result && typeof result === "object" && "__meta" in (result as any)) {
    const { level, request } = (result as any).__meta;
    const lvl = typeof level === "number" ? level : Number(level);
    const reqStr = typeof request === "string" ? request : printValue(request);

    if (isNaN(lvl) || lvl < 1) return "error: (meta N \"...\") where N ≥ 1";

    try {
      console.log(`\x1b[2m  [level ${lvl}] asking LLM: "${reqStr}"\x1b[0m`);
      const r = await execAtLevel(tower, lvl, reqStr, (attempt, desc, violations) => {
        const boundary = `${lvl - 1}↔${lvl}`;
        if (violations.length > 0) {
          console.log(`\x1b[2m  [verify ${boundary}] attempt ${attempt}: REJECTED\x1b[0m`);
          for (const v of violations) console.log(`\x1b[2m    ${v}\x1b[0m`);
          console.log(`\x1b[2m  [verify ${boundary}] feeding violations back to LLM...\x1b[0m`);
        } else {
          console.log(`\x1b[2m  [verify ${boundary}] attempt ${attempt}: ok\x1b[0m`);
        }
      });
      if (r.interpMod) {
        console.log(`\x1b[2m  [level ${lvl}] modified ${r.interpMod.fnName}: ${r.description}\x1b[0m`);
      } else {
        console.log(`\x1b[2m  [level ${lvl}] ${r.description}\x1b[0m`);
      }
      return `level ${lvl}: ${r.description}`;
    } catch (e: any) {
      return `level ${lvl} error: ${e.message}`;
    }
  }

  // Handle undo at any level
  if (result && typeof result === "object" && "__undo" in (result as any)) {
    const lvl = Number((result as any).__undo);
    if (isNaN(lvl) || lvl < 1) return "error: (undo N) where N ≥ 1";
    if (undoAtLevel(tower, lvl)) return `level ${lvl}: undone.`;
    return `level ${lvl}: nothing to undo.`;
  }

  // Handle show-tower
  if (result && typeof result === "object" && "__show_tower" in (result as any)) {
    return showTower(tower);
  }

  return printValue(result);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Heterogeneous Reflective Tower");
  console.log("Level 0: exact interpreter | Levels 1, 2, 3, ...: LLM oracles");
  console.log('  (meta 1 "...")   — level 1 modifies the interpreter');
  console.log('  (meta 2 "...")   — level 2 modifies level 1');
  console.log('  (meta N "...")   — tower grows upward on demand');
  console.log("  (undo N)        — undo at level N");
  console.log("  (show-tower)    — show all modifications\n");

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

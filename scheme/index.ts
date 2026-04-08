import * as readline from "readline";
import { makeInterpreter, parse, evaluate, printValue, Interpreter, Expr } from "./interpreter.js";
import { makeTower, execAtLevel, undoAtLevel, showTower } from "./tower.js";

const tower = makeTower(makeInterpreter());

const originalBaseEval = tower.interp.baseEval;
tower.interp.baseEval = (exp: Expr, env, interp: Interpreter) => {
  if (Array.isArray(exp) && exp.length > 0) {
    if (exp[0] === "meta" && exp.length === 3) return { __meta: { level: exp[1], request: exp[2] } } as any;
    if (exp[0] === "undo" && exp.length === 2) return { __undo: exp[1] } as any;
    if (exp[0] === "show-tower") return { __show_tower: true } as any;
    if (exp[0] === "exec-at-metalevel") return { __meta: { level: 1, request: exp[1] } } as any;
    if (exp[0] === "undo!") return { __undo: 1 } as any;
  }
  return originalBaseEval(exp, env, interp);
};

async function handleInput(line: string): Promise<string> {
  let exp: Expr;
  try { exp = parse(line); } catch (e: any) { return `parse error: ${e.message}`; }

  let result;
  try { result = evaluate(tower.interp, exp); } catch (e: any) { return `error: ${e.message}`; }

  if (result && typeof result === "object" && "__meta" in (result as any)) {
    const { level, request } = (result as any).__meta;
    const lvl = typeof level === "number" ? level : Number(level);
    const reqStr = typeof request === "string" ? request : printValue(request);
    if (isNaN(lvl) || lvl < 1) return "error: (meta N \"...\") where N >= 1";
    try {
      console.log(`\x1b[2m  [level ${lvl}] asking LLM: "${reqStr}"\x1b[0m`);
      const r = await execAtLevel(tower, lvl, reqStr, (attempt, info) => {
        console.log(`\x1b[2m  [verify ${lvl - 1}↔${lvl}] attempt ${attempt}: ${info}\x1b[0m`);
      });
      console.log(`\x1b[2m  [level ${lvl}] ${r.description}\x1b[0m`);
      return `level ${lvl}: ${r.description}`;
    } catch (e: any) { return `level ${lvl} error: ${e.message}`; }
  }

  if (result && typeof result === "object" && "__undo" in (result as any)) {
    const lvl = Number((result as any).__undo);
    if (undoAtLevel(tower, lvl)) return `level ${lvl}: undone.`;
    return `level ${lvl}: nothing to undo.`;
  }

  if (result && typeof result === "object" && "__show_tower" in (result as any)) return showTower(tower);

  return printValue(result);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Scheme Tower — Level 0: interpreter | Levels 1+: LLM");
  console.log('  (meta N "...")  (undo N)  (show-tower)\n');
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

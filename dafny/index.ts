import * as readline from "readline";
import * as path from "path";
import { loadModule, makeTower, execAtLevel, undoAtLevel, showTower, callMethod } from "./tower.js";

const inputFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "base.dfy");
const resolvedFile = path.resolve(inputFile);
const WORK_DIR = path.dirname(resolvedFile);
console.log(`Loading and compiling ${path.basename(resolvedFile)}...`);
const tower = makeTower(loadModule(resolvedFile), WORK_DIR);
console.log(`Loaded ${tower.mod.methods.size} methods: ${[...tower.mod.methods.keys()].join(", ")}\n`);

async function handleInput(line: string): Promise<string> {
  const parts = line.match(/^\((\S+)(.*)\)$/s);
  if (!parts) return "syntax: (command args...)";
  const cmd = parts[1], argStr = parts[2].trim();

  switch (cmd) {
    case "call": {
      const args = argStr.split(/\s+/);
      if (!args[0]) return "(call MethodName arg1 ...)";
      try { return String(callMethod(tower.mod, args[0], ...args.slice(1).map(Number))); }
      catch (e: any) { return `error: ${e.message}`; }
    }
    case "meta": {
      const m = argStr.match(/^(\d+)\s+"(.+)"$/s) || argStr.match(/^(\d+)\s+'(.+)'$/s);
      if (!m) return '(meta N "request")';
      const level = Number(m[1]), request = m[2];
      try {
        console.log(`\x1b[2m  [level ${level}] asking LLM: "${request}"\x1b[0m`);
        const r = await execAtLevel(tower, level, request, (attempt, info) => {
          console.log(`\x1b[2m  [verify ${level-1}↔${level}] attempt ${attempt}: ${info}\x1b[0m`);
        });
        console.log(`\x1b[2m  [level ${level}] ${r.description}\x1b[0m`);
        return `level ${level}: ${r.description}`;
      } catch (e: any) { return `error: ${e.message}`; }
    }
    case "undo": {
      const lvl = Number(argStr.trim() || "1");
      if (undoAtLevel(tower, lvl)) return `level ${lvl}: undone.`;
      return `level ${lvl}: nothing to undo.`;
    }
    case "show-tower": return showTower(tower);
    case "show": return [...tower.mod.methods.values()].map(m => m.signature).join("\n\n");
    case "source": {
      const method = tower.mod.methods.get(argStr.trim());
      if (!method) return `unknown: ${argStr}. Available: ${[...tower.mod.methods.keys()].join(", ")}`;
      return method.full;
    }
    default: return `unknown: ${cmd}. Try: call, meta, undo, show, show-tower, source`;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Dafny Tower — Level 0: Dafny module | Levels 1+: LLM (Dafny-verified + governance)");
console.log('  (call Abs -42)  (meta N "...")  (undo N)  (show-tower)  (source Abs)\n');
const prompt = () => { rl.question("tower> ", async (line) => { if (!line.trim()) return prompt(); console.log(await handleInput(line.trim())); prompt(); }); };
prompt();

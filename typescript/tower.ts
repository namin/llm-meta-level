// TypeScript tower: level 0 is a TS module with typed functions,
// level 1 is an LLM that generates new implementations verified
// by `tsc --noEmit`, levels 2+ are governance (from core).
//
// Assurance level: type-level — between behavioral (scheme) and
// semantic (dafny) on the assurance lattice.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { createRequire } from "module";
import { chat } from "../core/llm.js";

const require = createRequire(import.meta.url);
import {
  Boundary, Violation, ExecResult, OnAttempt,
  makeBoundary, ensureBoundary, undoBoundary,
  execMetaLevel, appendPolicies, showBoundaries, parseJSON,
} from "../core/governance.js";

// --- TypeScript module ---

export interface TsFunction {
  name: string;
  signature: string;   // export function name(params): returnType
  body: string;         // everything inside the { }
  full: string;         // complete function text
}

export interface TsModule {
  functions: Map<string, TsFunction>;
  compiled: Record<string, Function>;
  undoStack: { name: string; fn: TsFunction; compiled: Function }[];
}

// Parse a TS file into exported functions
export function parseTsFile(source: string): TsFunction[] {
  const fns: TsFunction[] = [];
  const regex = /^(export\s+function\s+\w+\s*\([^)]*\)\s*:\s*\S+)\s*\{/gm;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const signature = match[1];
    const name = signature.match(/function\s+(\w+)/)?.[1] || "";
    const bodyStart = match.index + match[0].length;
    let depth = 1, i = bodyStart;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const body = source.slice(bodyStart, i - 1).trim();
    const full = source.slice(match.index, i).trim();
    fns.push({ name, signature, body, full });
  }

  return fns;
}

// Reconstruct source from module state
function reconstructSource(mod: TsModule): string {
  return [...mod.functions.values()].map(f => f.full).join("\n\n") + "\n";
}

// Compile TS source to JS and extract functions
function compileTs(source: string, workDir: string): Record<string, Function> {
  const tmpTs = path.join(workDir, "_tower_temp.ts");
  const tmpJs = path.join(workDir, "_tower_temp.js");
  fs.writeFileSync(tmpTs, source);
  try {
    execSync(`npx tsc --outDir "${workDir}" --declaration false --module commonjs --target ES2022 --strict --esModuleInterop true "${tmpTs}"`, {
      cwd: workDir, stdio: ["pipe", "pipe", "pipe"],
    });
    const code = fs.readFileSync(tmpJs, "utf8");
    const sandbox: any = { require, module: { exports: {} }, exports: {}, console };
    new vm.Script(code).runInNewContext(sandbox);
    const fns: Record<string, Function> = {};
    for (const [k, v] of Object.entries(sandbox.module.exports)) {
      if (typeof v === "function") fns[k] = v as Function;
    }
    // Also check sandbox.exports
    for (const [k, v] of Object.entries(sandbox.exports)) {
      if (typeof v === "function") fns[k] = v as Function;
    }
    return fns;
  } finally {
    try { fs.unlinkSync(tmpTs); } catch {}
    try { fs.unlinkSync(tmpJs); } catch {}
  }
}

// Type-check TS source (tsc --noEmit)
function typeCheck(source: string, workDir: string): { ok: boolean; output: string } {
  const tmpTs = path.join(workDir, "_tower_verify.ts");
  fs.writeFileSync(tmpTs, source);
  try {
    const output = execSync(`npx tsc --noEmit --strict --target ES2022 --skipLibCheck "${tmpTs}"`, {
      cwd: workDir, stdio: ["pipe", "pipe", "pipe"],
    }).toString();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: e.stderr?.toString() || e.stdout?.toString() || e.message };
  } finally {
    try { fs.unlinkSync(tmpTs); } catch {}
  }
}

// --- Load module ---

export function loadModule(tsPath: string): TsModule {
  const source = fs.readFileSync(tsPath, "utf8");
  const fns = parseTsFile(source);
  const workDir = path.dirname(tsPath);
  const compiled = compileTs(source, workDir);
  const mod: TsModule = { functions: new Map(), compiled, undoStack: [] };
  for (const f of fns) mod.functions.set(f.name, f);
  return mod;
}

export function callFunction(mod: TsModule, name: string, ...args: any[]): any {
  const fn = mod.compiled[name];
  if (!fn) throw new Error(`no compiled function: ${name}`);
  return fn(...args);
}

// --- Tower ---

export interface Tower {
  mod: TsModule;
  workDir: string;
  boundaries: Boundary[];
}

export function makeTower(mod: TsModule, workDir: string): Tower {
  return { mod, workDir, boundaries: [] };
}

// --- Level 1: LLM modifies TS functions ---

const LEVEL1_SYSTEM_PROMPT = `You are the meta-level of a type-checked reflective tower.

The object level is a TypeScript module with typed functions. You can
replace function implementations but MUST preserve the type signature.

Respond with EXACTLY a JSON object:
{
  "function": "the function name to modify",
  "body": "the new function body (everything inside the braces)",
  "description": "what this modification does"
}

IMPORTANT: The function signature (name, parameters, return type) is
FIXED. You only replace the body. The code must type-check under
--strict.
`;

interface Modification { function: string; body: string; description: string; }

async function execLevel1(tower: Tower, request: string, onAttempt?: OnAttempt): Promise<ExecResult> {
  const boundary = tower.boundaries[0];
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request }];

  let prompt = LEVEL1_SYSTEM_PROMPT + "\nThe module has these functions:\n\n";
  for (const f of tower.mod.functions.values()) prompt += "```typescript\n" + f.full + "\n```\n\n";
  prompt = appendPolicies(prompt, boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 1024 });

    let modification: Modification;
    try { modification = parseJSON<Modification>(text); }
    catch { if (onAttempt) onAttempt(attempt, "invalid JSON"); messages.push({ role: "assistant", content: text }, { role: "user", content: "Invalid JSON. Respond with only the JSON object." }); continue; }

    // Custom checks from level 2+
    const customViolations: Violation[] = [];
    for (const cc of boundary.customChecks) customViolations.push(...cc.check(modification));
    if (customViolations.length > 0) {
      const reasons = customViolations.map(v => `${v.check}: ${v.message}`).join("\n");
      if (onAttempt) onAttempt(attempt, `REJECTED by custom check:\n${reasons}`);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `Custom check failed:\n${reasons}\n\nFix and try again.` });
      continue;
    }

    const fn = tower.mod.functions.get(modification.function);
    if (!fn) {
      if (onAttempt) onAttempt(attempt, `unknown function: ${modification.function}`);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `Unknown function. Available: ${[...tower.mod.functions.keys()].join(", ")}` });
      continue;
    }

    const newFn: TsFunction = { ...fn, body: modification.body, full: fn.signature + " {\n" + modification.body + "\n}" };
    const tempFns = new Map(tower.mod.functions);
    tempFns.set(modification.function, newFn);
    const source = [...tempFns.values()].map(f => f.full).join("\n\n") + "\n";

    // --- VERIFICATION GATE: tsc --noEmit ---
    if (onAttempt) onAttempt(attempt, "running tsc --noEmit...");
    const result = typeCheck(source, tower.workDir);

    if (!result.ok) {
      if (onAttempt) onAttempt(attempt, `REJECTED by tsc:\n${result.output}`);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `TypeScript type-check failed:\n${result.output}\n\nFix the implementation.` });
      continue;
    }

    if (onAttempt) onAttempt(attempt, "TYPE-CHECKED — compiling...");
    const compiled = compileTs(source, tower.workDir);
    tower.mod.undoStack.push({ name: modification.function, fn, compiled: tower.mod.compiled[modification.function] });
    tower.mod.functions.set(modification.function, newFn);
    Object.assign(tower.mod.compiled, compiled);
    return { level: 1, description: modification.description, attempts: attempt };
  }

  throw new Error(`Level 1 type-check failed after ${boundary.maxAttempts} attempts`);
}

// --- Unified exec ---

export async function execAtLevel(tower: Tower, level: number, request: string, onAttempt?: OnAttempt): Promise<ExecResult> {
  if (level < 1) throw new Error("Cannot exec at level 0");
  ensureBoundary(tower.boundaries, level - 1);
  if (level === 1) return execLevel1(tower, request, onAttempt);
  ensureBoundary(tower.boundaries, level - 2);
  return execMetaLevel(level, tower.boundaries[level - 1], tower.boundaries[level - 2], request, onAttempt);
}

export function undoAtLevel(tower: Tower, level: number): boolean {
  if (level === 1) {
    const entry = tower.mod.undoStack.pop();
    if (!entry) return false;
    tower.mod.functions.set(entry.name, entry.fn);
    tower.mod.compiled[entry.name] = entry.compiled;
    return true;
  }
  const idx = level - 2;
  if (idx < 0 || idx >= tower.boundaries.length) return false;
  return undoBoundary(tower.boundaries[idx]);
}

export function showTower(tower: Tower): string {
  const lines: string[] = ["level 0 (TypeScript module):"];
  for (const f of tower.mod.functions.values()) lines.push(`  ${f.name}: ${f.signature.replace(/^export\s+/, "")}`);
  if (tower.mod.undoStack.length > 0) lines.push(`  undo stack: ${tower.mod.undoStack.length} entries`);
  const bLines = showBoundaries(tower.boundaries);
  if (bLines) lines.push(bLines);
  return lines.join("\n");
}

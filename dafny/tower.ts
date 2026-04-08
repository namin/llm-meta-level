// Dafny tower: level 0 is a Dafny module with specified methods,
// level 1 is an LLM that generates new implementations verified
// by `dafny verify`, levels 2+ are governance (from core).

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

// --- Dafny parsing ---

export interface DafnyMethod {
  name: string;
  signature: string;
  body: string;
  full: string;
}

export interface DafnyModule {
  preamble: string;
  methods: Map<string, DafnyMethod>;
  compiled: Record<string, Function>;
  undoStack: (
    | { action: "modify"; name: string; prev: DafnyMethod; prevCompiled: Function }
    | { action: "add"; name: string }
  )[];
}

export function parseDafnyFile(source: string): { preamble: string; methods: DafnyMethod[] } {
  const methods: DafnyMethod[] = [];
  let preamble = "";
  let pos = 0;

  while (pos < source.length) {
    const match = source.slice(pos).match(/^((?:method|function method|function)\s+\w+[\s\S]*?)\{/m);
    if (!match) {
      if (methods.length === 0) preamble = source.slice(pos);
      break;
    }
    const matchStart = pos + match.index!;
    if (methods.length === 0 && match.index! > 0) preamble = source.slice(pos, matchStart);
    const signature = match[1].trim();
    const name = signature.match(/(?:method|function method|function)\s+(\w+)/)?.[1] || "";
    const bodyStart = matchStart + match[0].length;
    let depth = 1, i = bodyStart;
    while (i < source.length && depth > 0) { if (source[i] === "{") depth++; else if (source[i] === "}") depth--; i++; }
    methods.push({ name, signature, body: source.slice(bodyStart, i - 1).trim(), full: source.slice(matchStart, i).trim() });
    pos = i;
  }
  return { preamble, methods };
}

// --- Dafny compilation and verification ---

function compileDafny(source: string, workDir: string): Record<string, Function> {
  const dfyPath = path.join(workDir, "_tower_temp.dfy");
  const jsPath = path.join(workDir, "_tower_temp.js");
  fs.writeFileSync(dfyPath, source);
  try {
    execSync(`dafny build --target:js "${dfyPath}" -o "${jsPath}"`, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
  } finally { fs.unlinkSync(dfyPath); }
  const actualJs = jsPath.endsWith(".js") ? jsPath : jsPath + ".js";
  const code = fs.readFileSync(actualJs, "utf8");
  fs.unlinkSync(actualJs);
  const sandbox: any = { require, module: { exports: {} }, console };
  new vm.Script(code + "\nmodule.exports = { _module };").runInNewContext(sandbox);
  const cls = sandbox.module.exports._module?.__default;
  if (!cls) return {};
  const methods: Record<string, Function> = {};
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (typeof cls[key] === "function" && key !== "constructor") methods[key] = cls[key];
  }
  return methods;
}

function verifyDafny(source: string, workDir: string): { ok: boolean; output: string } {
  const dfyPath = path.join(workDir, "_tower_verify.dfy");
  fs.writeFileSync(dfyPath, source);
  try {
    const output = execSync(`dafny verify "${dfyPath}"`, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] }).toString();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: e.stderr?.toString() || e.stdout?.toString() || e.message };
  } finally { fs.unlinkSync(dfyPath); }
}

// --- Load module ---

export function loadModule(dfyPath: string): DafnyModule {
  const source = fs.readFileSync(dfyPath, "utf8");
  const { preamble, methods } = parseDafnyFile(source);
  const compiled = compileDafny(source, path.dirname(dfyPath));
  const mod: DafnyModule = { preamble, methods: new Map(), compiled, undoStack: [] };
  for (const m of methods) mod.methods.set(m.name, m);
  return mod;
}

export function callMethod(mod: DafnyModule, name: string, ...args: any[]): any {
  const fn = mod.compiled[name];
  if (!fn) throw new Error(`no compiled method: ${name}`);
  const BigNumber = require("bignumber.js");
  const bnArgs = args.map(a => typeof a === "number" ? new BigNumber(a) : a);
  const result = fn(...bnArgs);
  if (result && typeof result === "object" && result.toString) {
    const s = result.toString();
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }
  return result;
}

// --- Tower ---

export interface Tower {
  mod: DafnyModule;
  workDir: string;
  boundaries: Boundary[];
}

export function makeTower(mod: DafnyModule, workDir: string): Tower {
  return { mod, workDir, boundaries: [] };
}

// --- Level 1: LLM modifies Dafny implementations ---

const LEVEL1_SYSTEM_PROMPT = `You are the meta-level of a verified reflective tower.

The object level is a Dafny module. You can modify existing methods or add new ones.

To MODIFY an existing method (replace its body, preserving the signature and spec):
{
  "method": "the method name",
  "body": "the new body (everything inside the braces)",
  "description": "what this does"
}

To ADD a new method or function:
{
  "method": "the new method name",
  "full": "the complete Dafny method/function including signature, spec, and body",
  "description": "what this adds"
}

When modifying: the signature and specification are FIXED. You only replace the body.
Include any necessary loop invariants, assertions, and decreases clauses.

When adding: you write the full declaration. It must pass dafny verify.
`;

interface Modification { method: string; body?: string; full?: string; description: string; }

async function execLevel1(tower: Tower, request: string, onAttempt?: OnAttempt): Promise<ExecResult> {
  const boundary = tower.boundaries[0];
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request }];

  let prompt = LEVEL1_SYSTEM_PROMPT + "\nThe module has these methods:\n\n";
  for (const m of tower.mod.methods.values()) prompt += "```dafny\n" + m.full + "\n```\n\n";
  prompt = appendPolicies(prompt, boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 2048 });

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

    const existing = tower.mod.methods.get(modification.method);
    const isAdd = !existing;

    // For adds, full is required
    if (isAdd && !modification.full) {
      if (onAttempt) onAttempt(attempt, `new method "${modification.method}" requires a "full" field with the complete declaration`);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `Method "${modification.method}" doesn't exist. To add it, provide a "full" field with the complete Dafny declaration (signature, spec, body).` });
      continue;
    }

    // Build the new method
    let newMethod: DafnyMethod;
    if (isAdd) {
      // Parse the full declaration to extract signature and body
      const parsed = parseDafnyFile(modification.full!);
      if (parsed.methods.length === 0) {
        if (onAttempt) onAttempt(attempt, `could not parse "full" as a Dafny method/function`);
        messages.push({ role: "assistant", content: text }, { role: "user", content: `Could not parse the "full" field as a valid Dafny method or function. Make sure it starts with "method" or "function".` });
        continue;
      }
      newMethod = parsed.methods[0];
    } else {
      newMethod = { ...existing, body: modification.body!, full: existing.signature + "\n{\n" + modification.body + "\n}" };
    }

    const tempMod = new Map(tower.mod.methods);
    tempMod.set(modification.method, newMethod);
    let source = tower.mod.preamble;
    for (const m of tempMod.values()) source += m.full + "\n\n";

    if (onAttempt) onAttempt(attempt, "running dafny verify...");
    const result = verifyDafny(source, tower.workDir);

    if (!result.ok) {
      if (onAttempt) onAttempt(attempt, `REJECTED by Dafny:\n${result.output}`);
      messages.push({ role: "assistant", content: text }, { role: "user", content: `Dafny verification failed:\n${result.output}\n\nFix the implementation.` });
      continue;
    }

    if (onAttempt) onAttempt(attempt, "VERIFIED — compiling to JS...");
    const compiled = compileDafny(source, tower.workDir);

    if (isAdd) {
      tower.mod.undoStack.push({ action: "add", name: modification.method });
    } else {
      tower.mod.undoStack.push({ action: "modify", name: modification.method, prev: existing, prevCompiled: tower.mod.compiled[modification.method] });
    }

    tower.mod.methods.set(modification.method, newMethod);
    Object.assign(tower.mod.compiled, compiled);
    return { level: 1, description: modification.description, attempts: attempt };
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

export function undoAtLevel(tower: Tower, level: number): boolean {
  if (level === 1) {
    const entry = tower.mod.undoStack.pop();
    if (!entry) return false;
    if (entry.action === "add") {
      tower.mod.methods.delete(entry.name);
      delete tower.mod.compiled[entry.name];
    } else {
      tower.mod.methods.set(entry.name, entry.prev);
      tower.mod.compiled[entry.name] = entry.prevCompiled;
    }
    return true;
  }
  const idx = level - 2;
  if (idx < 0 || idx >= tower.boundaries.length) return false;
  return undoBoundary(tower.boundaries[idx]);
}

export function showTower(tower: Tower): string {
  const lines: string[] = ["level 0 (Dafny module):"];
  for (const m of tower.mod.methods.values()) lines.push(`  ${m.name}: ${m.signature.split("\n")[0]}`);
  if (tower.mod.undoStack.length > 0) lines.push(`  undo stack: ${tower.mod.undoStack.length} entries`);
  const bLines = showBoundaries(tower.boundaries);
  if (bLines) lines.push(bLines);
  return lines.join("\n");
}

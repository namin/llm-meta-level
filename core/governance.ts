// Shared governance hierarchy for the reflective tower.
//
// Every tower instantiation (scheme, dafny, typescript) uses this
// for levels 2+. Each tower provides its own level 0 and level 1
// logic; the governance (boundaries, policies, custom checks, undo,
// meta-level LLM interaction) is identical across all towers.

import { chat } from "./llm.js";

// --- Types ---

export interface Violation {
  check: string;
  message: string;
}

export interface CustomCheck {
  name: string;
  check: (...args: any[]) => Violation[];
}

export interface Boundary {
  policies: string[];
  customChecks: CustomCheck[];
  maxAttempts: number;
  undoStack: [string, any][];
}

export interface MetaModification {
  type: "policy" | "check" | "maxAttempts";
  content?: string;
  name?: string;
  code?: string;
  value?: number;
  description: string;
}

export interface ExecResult {
  level: number;
  description: string;
  attempts: number;
}

export type OnAttempt = (attempt: number, info: string) => void;

// --- Boundary management ---

export function makeBoundary(): Boundary {
  return { policies: [], customChecks: [], maxAttempts: 3, undoStack: [] };
}

export function modifyBoundary(b: Boundary, component: string, value: any): void {
  const old = (b as any)[component];
  b.undoStack.push([component, Array.isArray(old) ? [...old] : old]);
  (b as any)[component] = value;
}

export function undoBoundary(b: Boundary): boolean {
  const entry = b.undoStack.pop();
  if (!entry) return false;
  (b as any)[entry[0]] = entry[1];
  return true;
}

export function ensureBoundary(boundaries: Boundary[], n: number): void {
  while (boundaries.length <= n) {
    boundaries.push(makeBoundary());
  }
}

// --- Meta-level system prompts ---

export function metaSystemPrompt(targetLevel: number): string {
  return `You are level ${targetLevel + 1} in a reflective tower of interpreters.

You modify level ${targetLevel}, which is an LLM that modifies level ${targetLevel - 1}.
Level ${targetLevel} has these modifiable components:
  - policies: string[] — constraints appended to level ${targetLevel}'s system prompt
  - customChecks: {name, check}[] — extra verification checks run before
    level ${targetLevel}'s modifications are installed
  - maxAttempts: number — how many tries level ${targetLevel} gets

Respond with EXACTLY a JSON object (no markdown fences):

To add a policy:
{ "type": "policy", "content": "the policy text", "description": "what it does" }

To add a custom verification check:
{ "type": "check", "name": "short name", "code": "JavaScript arrow function: (mod) => Violation[]", "description": "what it enforces" }

The check function receives mod (the proposed modification) and must return
an array of {check: string, message: string} objects (empty if ok).

To change max attempts:
{ "type": "maxAttempts", "value": 5, "description": "why" }
`;
}

export function buildMetaPrompt(targetLevel: number, boundary: Boundary): string {
  let prompt = metaSystemPrompt(targetLevel);
  if (boundary.policies.length > 0) {
    prompt += "\nAdditional policies (you MUST follow these):\n" +
      boundary.policies.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n";
  }
  return prompt;
}

// --- Meta-level verification ---

export function verifyMetaMod(mod: MetaModification, boundary: Boundary): { ok: boolean; violations: Violation[] } {
  const vs: Violation[] = [];

  if (!["policy", "check", "maxAttempts"].includes(mod.type)) {
    vs.push({ check: "expressible", message: `unknown type "${mod.type}"` });
  }

  if (mod.type === "check") {
    if (!mod.code) {
      vs.push({ check: "expressible", message: "check requires code" });
    } else {
      try { new Function(`return (${mod.code})`); }
      catch (e: any) { vs.push({ check: "expressible", message: `code does not parse: ${e.message}` }); }

      const FORBIDDEN = /\b(require|import\s*\(|process\.(exit|env|argv)|eval\s*\(|Function\s*\(|fs\.|child_process)/;
      if (FORBIDDEN.test(mod.code)) {
        vs.push({ check: "ecological", message: "code references forbidden bindings" });
      }

      try {
        const fn = new Function(`return (${mod.code})`)();
        if (typeof fn !== "function") vs.push({ check: "continuable", message: "code does not produce a function" });
      } catch (e: any) { vs.push({ check: "continuable", message: `code fails to compile: ${e.message}` }); }
    }
  }

  if (mod.type === "policy" && !mod.content) {
    vs.push({ check: "expressible", message: "policy requires content" });
  }

  if (mod.type === "maxAttempts") {
    if (typeof mod.value !== "number" || mod.value < 1 || mod.value > 10) {
      vs.push({ check: "expressible", message: "maxAttempts must be 1–10" });
    }
  }

  for (const cc of boundary.customChecks) {
    vs.push(...cc.check(mod));
  }

  return { ok: vs.length === 0, violations: vs };
}

// --- Apply meta-level modification ---

export function applyMetaMod(target: Boundary, mod: MetaModification): void {
  switch (mod.type) {
    case "policy":
      modifyBoundary(target, "policies", [...target.policies, mod.content!]);
      break;
    case "check": {
      const fn = new Function(`return (${mod.code!})`)();
      modifyBoundary(target, "customChecks", [
        ...target.customChecks,
        { name: mod.name || mod.description, check: fn },
      ]);
      break;
    }
    case "maxAttempts":
      modifyBoundary(target, "maxAttempts", mod.value!);
      break;
  }
}

// --- Meta-level exec (levels 2+) ---

export function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  throw new Error(`Invalid JSON:\n${text}`);
}

export async function execMetaLevel(
  level: number,
  boundary: Boundary,
  target: Boundary,
  request: string,
  onAttempt?: OnAttempt,
): Promise<ExecResult> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: request },
  ];
  const prompt = buildMetaPrompt(level - 1, boundary);

  for (let attempt = 1; attempt <= boundary.maxAttempts; attempt++) {
    const text = await chat(messages, { system: prompt, tier: "fast", maxTokens: 1024 });

    let mod: MetaModification;
    try { mod = parseJSON<MetaModification>(text); }
    catch {
      if (onAttempt) onAttempt(attempt, "invalid JSON from LLM");
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: "Invalid JSON. Respond with only the JSON object." });
      continue;
    }

    const result = verifyMetaMod(mod, boundary);
    if (!result.ok) {
      const reasons = result.violations.map(v => `${v.check}: ${v.message}`).join("\n");
      if (onAttempt) onAttempt(attempt, `REJECTED:\n${reasons}`);
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: `Verification failed:\n${reasons}\n\nFix and try again.` });
      continue;
    }

    if (onAttempt) onAttempt(attempt, "ok");
    applyMetaMod(target, mod);
    return { level, description: mod.description, attempts: attempt };
  }

  throw new Error(`Level ${level} verification failed after ${boundary.maxAttempts} attempts`);
}

// --- Display helpers ---

export function showBoundaries(boundaries: Boundary[]): string {
  const lines: string[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const hasState = b.policies.length > 0 || b.customChecks.length > 0 || b.undoStack.length > 0;
    if (!hasState) continue;
    lines.push(`boundary ${i}↔${i + 1}:`);
    if (b.policies.length > 0) {
      lines.push("  policies:");
      b.policies.forEach((p, j) => lines.push(`    ${j}: ${p}`));
    }
    if (b.customChecks.length > 0) {
      lines.push("  checks:");
      b.customChecks.forEach((c, j) => lines.push(`    ${j}: ${c.name}`));
    }
    if (b.undoStack.length > 0) {
      lines.push(`  undo stack: ${b.undoStack.length} entries`);
    }
  }
  return lines.join("\n");
}

// --- Append policies to any base prompt ---

export function appendPolicies(basePrompt: string, boundary: Boundary): string {
  if (boundary.policies.length === 0) return basePrompt;
  return basePrompt + "\n\nAdditional policies (you MUST follow these):\n" +
    boundary.policies.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n";
}

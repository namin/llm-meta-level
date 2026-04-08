// Local tests for the TypeScript tower — no LLM needed.
// Usage: npx tsx typescript/test-local.ts (from tower/)

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { loadModule, callFunction, parseTsFile } from "./tower.js";

const WORK_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

let passed = 0;
let failed = 0;

function assert(label: string, actual: any, expected: any) {
  if (actual === expected) { console.log(`  ok  ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}\n    expected: ${expected}\n    actual:   ${actual}`); failed++; }
}

// --- Part 1: Parsing ---

console.log("\nPart 1: Parsing");
const source = fs.readFileSync(path.join(WORK_DIR, "base.ts"), "utf8");
const fns = parseTsFile(source);
assert("found 8 functions", fns.length, 8);
assert("first is abs", fns[0].name, "abs");
assert("last is gcd", fns[7].name, "gcd");

// --- Part 2: Compile and call ---

console.log("\nPart 2: Compile and call");
const mod = loadModule(path.join(WORK_DIR, "base.ts"));
assert("abs(-42) = 42", callFunction(mod, "abs", -42), 42);
assert("abs(7) = 7", callFunction(mod, "abs", 7), 7);
assert("max(3, 7) = 7", callFunction(mod, "max", 3, 7), 7);
assert("min(3, 7) = 3", callFunction(mod, "min", 3, 7), 3);
assert("clamp(50, 0, 10) = 10", callFunction(mod, "clamp", 50, 0, 10), 10);
assert("clamp(5, 0, 10) = 5", callFunction(mod, "clamp", 5, 0, 10), 5);
assert("fib(10) = 55", callFunction(mod, "fib", 10), 55);
assert("factorial(5) = 120", callFunction(mod, "factorial", 5), 120);
assert("isPrime(7) = true", callFunction(mod, "isPrime", 7), true);
assert("isPrime(4) = false", callFunction(mod, "isPrime", 4), false);
assert("gcd(12, 8) = 4", callFunction(mod, "gcd", 12, 8), 4);

// --- Part 3: tsc rejects bad code ---

console.log("\nPart 3: Type-check rejects bad code");

// Bad: return type mismatch
const badSource = source.replace(
  /export function abs\(x: number\): number \{[\s\S]*?\n\}/,
  'export function abs(x: number): number {\n  return "not a number";\n}',
);
const tmpBad = path.join(WORK_DIR, "_test_bad.ts");
fs.writeFileSync(tmpBad, badSource);
try {
  try {
    execSync(`npx tsc --noEmit --strict --target ES2022 --skipLibCheck "${tmpBad}"`, { cwd: WORK_DIR, stdio: ["pipe", "pipe", "pipe"] });
    assert("bad return type rejected by tsc", "passed", "rejected");
  } catch {
    assert("bad return type rejected by tsc", "rejected", "rejected");
  }
} finally { fs.unlinkSync(tmpBad); }

// Good: alternative implementation
const goodSource = source.replace(
  /export function abs\(x: number\): number \{[\s\S]*?\n\}/,
  'export function abs(x: number): number {\n  return Math.abs(x);\n}',
);
const tmpGood = path.join(WORK_DIR, "_test_good.ts");
fs.writeFileSync(tmpGood, goodSource);
try {
  try {
    execSync(`npx tsc --noEmit --strict --target ES2022 --skipLibCheck "${tmpGood}"`, { cwd: WORK_DIR, stdio: ["pipe", "pipe", "pipe"] });
    assert("alt abs accepted by tsc", "accepted", "accepted");
  } catch {
    assert("alt abs accepted by tsc", "rejected", "accepted");
  }
} finally { fs.unlinkSync(tmpGood); }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

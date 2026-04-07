// Local tests for the Dafny tower — no LLM needed.
// Usage: npx tsx dafny/test-local.ts (from tower/)

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { loadModule, callMethod, parseDafnyFile } from "./tower.js";

const WORK_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

let passed = 0;
let failed = 0;

function assert(label: string, actual: any, expected: any) {
  if (actual === expected) { console.log(`  ok  ${label}`); passed++; }
  else { console.log(`  FAIL  ${label}\n    expected: ${expected}\n    actual:   ${actual}`); failed++; }
}

console.log("\nPart 1: Parsing");
const source = fs.readFileSync(path.join(WORK_DIR, "base.dfy"), "utf8");
const { methods } = parseDafnyFile(source);
assert("found 6 methods/functions", methods.length, 6);
assert("first is Abs", methods[0].name, "Abs");

console.log("\nPart 2: Compile and call");
const mod = loadModule(path.join(WORK_DIR, "base.dfy"));
assert("Abs(-42) = 42", callMethod(mod, "Abs", -42), 42);
assert("Max(3, 7) = 7", callMethod(mod, "Max", 3, 7), 7);
assert("Min(3, 7) = 3", callMethod(mod, "Min", 3, 7), 3);
assert("Clamp(50, 0, 10) = 10", callMethod(mod, "Clamp", 50, 0, 10), 10);
assert("ComputeFib(10) = 55", callMethod(mod, "ComputeFib", 10), 55);

console.log("\nPart 3: Dafny rejects bad code");
const badSource = source.replace(
  /method Abs[\s\S]*?\n\}/,
  `method Abs(x: int) returns (r: int)\n  ensures r >= 0\n  ensures r == x || r == -x\n{\n  r := x;\n}`
);
const tmpBad = path.join(WORK_DIR, "_test_bad.dfy");
fs.writeFileSync(tmpBad, badSource);
try {
  try { execSync(`dafny verify "${tmpBad}"`, { stdio: ["pipe", "pipe", "pipe"] }); assert("bad Abs rejected", "passed", "rejected"); }
  catch { assert("bad Abs rejected", "rejected", "rejected"); }
} finally { fs.unlinkSync(tmpBad); }

const goodSource = source.replace(
  /method Abs[\s\S]*?\n\}/,
  `method Abs(x: int) returns (r: int)\n  ensures r >= 0\n  ensures r == x || r == -x\n{\n  if x >= 0 { r := x; } else { r := -x; }\n}`
);
const tmpGood = path.join(WORK_DIR, "_test_good.dfy");
fs.writeFileSync(tmpGood, goodSource);
try {
  try { execSync(`dafny verify "${tmpGood}"`, { stdio: ["pipe", "pipe", "pipe"] }); assert("alt Abs accepted", "accepted", "accepted"); }
  catch { assert("alt Abs accepted", "rejected", "accepted"); }
} finally { fs.unlinkSync(tmpGood); }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

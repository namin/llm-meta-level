// LLM tests for the Dafny tower.
// Usage: npx tsx dafny/test.ts (from tower/)

import * as path from "path";
import { loadModule, makeTower, execAtLevel, undoAtLevel, callMethod } from "./tower.js";

const WORK_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

let passed = 0;
let failed = 0;

function assert(label: string, actual: any, expected: any) {
  if (actual === expected) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
    failed++;
  }
}

// --- Part 1: Modify ComputeFib to use recursion + undo ---

async function testComputeFib() {
  console.log("\nPart 1: ComputeFib — iterative → recursive → undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.dfy")), WORK_DIR);

  assert("fib(10) before", callMethod(tower.mod, "ComputeFib", 10), 55);

  await execAtLevel(tower, 1, "rewrite ComputeFib to use a simple recursive implementation instead of the iterative loop. You will need a decreases clause.");
  assert("fib(0) after", callMethod(tower.mod, "ComputeFib", 0), 0);
  assert("fib(1) after", callMethod(tower.mod, "ComputeFib", 1), 1);
  assert("fib(10) after", callMethod(tower.mod, "ComputeFib", 10), 55);

  undoAtLevel(tower, 1);
  assert("fib(10) after undo", callMethod(tower.mod, "ComputeFib", 10), 55);
}

// --- Part 2: Modify Abs to use ternary + undo ---

async function testAbs() {
  console.log("\nPart 2: Abs — alternative implementation + undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.dfy")), WORK_DIR);

  assert("abs(-5) before", callMethod(tower.mod, "Abs", -5), 5);

  await execAtLevel(tower, 1, "rewrite Abs to compute the result using multiplication: if x < 0 then r := x * -1, else r := x * 1");
  assert("abs(-42) after", callMethod(tower.mod, "Abs", -42), 42);
  assert("abs(7) after", callMethod(tower.mod, "Abs", 7), 7);
  assert("abs(0) after", callMethod(tower.mod, "Abs", 0), 0);

  undoAtLevel(tower, 1);
  assert("abs(-5) after undo", callMethod(tower.mod, "Abs", -5), 5);
}

// --- Part 3: Modify Clamp — different logic, same spec ---

async function testClamp() {
  console.log("\nPart 3: Clamp — rewritten with Max/Min calls");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.dfy")), WORK_DIR);

  assert("clamp(5,0,10) before", callMethod(tower.mod, "Clamp", 5, 0, 10), 5);

  await execAtLevel(tower, 1, "rewrite Clamp to use a single expression: r := if x < lo then lo else if x > hi then hi else x. Keep it simple.");
  assert("clamp(-5,0,10) after", callMethod(tower.mod, "Clamp", -5, 0, 10), 0);
  assert("clamp(5,0,10) after", callMethod(tower.mod, "Clamp", 5, 0, 10), 5);
  assert("clamp(50,0,10) after", callMethod(tower.mod, "Clamp", 50, 0, 10), 10);

  undoAtLevel(tower, 1);
  assert("clamp(5,0,10) after undo", callMethod(tower.mod, "Clamp", 5, 0, 10), 5);
}

// --- Run ---

async function main() {
  await testComputeFib();
  await testAbs();
  await testClamp();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

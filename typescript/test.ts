// LLM tests for the TypeScript tower.
// Usage: npx tsx typescript/test.ts (from tower/)

import * as path from "path";
import { loadModule, makeTower, execAtLevel, undoAtLevel, callFunction } from "./tower.js";

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

// --- Part 1: Modify fib to use recursion + undo ---

async function testFib() {
  console.log("\nPart 1: fib — iterative → recursive → undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.ts")), WORK_DIR);

  assert("fib(10) before", callFunction(tower.mod, "fib", 10), 55);

  await execAtLevel(tower, 1, "rewrite fib to use simple recursion: if n <= 1 return n, else return fib(n-1) + fib(n-2)");
  assert("fib(0) after", callFunction(tower.mod, "fib", 0), 0);
  assert("fib(1) after", callFunction(tower.mod, "fib", 1), 1);
  assert("fib(10) after", callFunction(tower.mod, "fib", 10), 55);

  undoAtLevel(tower, 1);
  assert("fib(10) after undo", callFunction(tower.mod, "fib", 10), 55);
}

// --- Part 2: Modify abs to use Math.abs + undo ---

async function testAbs() {
  console.log("\nPart 2: abs — custom → Math.abs → undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.ts")), WORK_DIR);

  assert("abs(-42) before", callFunction(tower.mod, "abs", -42), 42);

  await execAtLevel(tower, 1, "rewrite abs to use Math.abs");
  assert("abs(-42) after", callFunction(tower.mod, "abs", -42), 42);
  assert("abs(7) after", callFunction(tower.mod, "abs", 7), 7);
  assert("abs(0) after", callFunction(tower.mod, "abs", 0), 0);

  undoAtLevel(tower, 1);
  assert("abs(-42) after undo", callFunction(tower.mod, "abs", -42), 42);
}

// --- Part 3: Modify isPrime to use a different algorithm + undo ---

async function testIsPrime() {
  console.log("\nPart 3: isPrime — trial division → 6k±1 optimization → undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.ts")), WORK_DIR);

  assert("isPrime(7) before", callFunction(tower.mod, "isPrime", 7), true);
  assert("isPrime(4) before", callFunction(tower.mod, "isPrime", 4), false);

  await execAtLevel(tower, 1, "rewrite isPrime to use the 6k±1 optimization: check 2 and 3 first, then only check i=6k-1 and i=6k+1");
  assert("isPrime(2) after", callFunction(tower.mod, "isPrime", 2), true);
  assert("isPrime(3) after", callFunction(tower.mod, "isPrime", 3), true);
  assert("isPrime(4) after", callFunction(tower.mod, "isPrime", 4), false);
  assert("isPrime(7) after", callFunction(tower.mod, "isPrime", 7), true);
  assert("isPrime(25) after", callFunction(tower.mod, "isPrime", 25), false);
  assert("isPrime(29) after", callFunction(tower.mod, "isPrime", 29), true);

  undoAtLevel(tower, 1);
  assert("isPrime(7) after undo", callFunction(tower.mod, "isPrime", 7), true);
}

// --- Part 4: Modify factorial to use recursion + undo ---

async function testFactorial() {
  console.log("\nPart 4: factorial — iterative → recursive → undo");
  const tower = makeTower(loadModule(path.join(WORK_DIR, "base.ts")), WORK_DIR);

  assert("factorial(5) before", callFunction(tower.mod, "factorial", 5), 120);

  await execAtLevel(tower, 1, "rewrite factorial to use recursion: if n <= 1 return 1, else return n * factorial(n - 1)");
  assert("factorial(0) after", callFunction(tower.mod, "factorial", 0), 1);
  assert("factorial(1) after", callFunction(tower.mod, "factorial", 1), 1);
  assert("factorial(5) after", callFunction(tower.mod, "factorial", 5), 120);
  assert("factorial(10) after", callFunction(tower.mod, "factorial", 10), 3628800);

  undoAtLevel(tower, 1);
  assert("factorial(5) after undo", callFunction(tower.mod, "factorial", 5), 120);
}

// --- Run ---

async function main() {
  await testFib();
  await testAbs();
  await testIsPrime();
  await testFactorial();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

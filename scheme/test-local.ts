// Local tests — no LLM needed. Tests the interpreter, verification
// gate, and multi-level tower mechanics.
// Usage: npx tsx test-local.ts (from scheme/)

import {
  makeInterpreter,
  parse,
  evaluate,
  printValue,
  modifyInterpreter,
  Interpreter,
} from "./interpreter.js";
import { verifyModification } from "./verify.js";
import { makeTower, undoAtLevel, showTower } from "./tower.js";

let passed = 0;
let failed = 0;

function assert(label: string, actual: string, expected: string) {
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

function evalStr(interp: Interpreter, input: string): string {
  try {
    return printValue(evaluate(interp, parse(input)));
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

// --- Part 1: exact interpreter ---

function testExactInterpreter() {
  console.log("\nPart 1: Exact interpreter");
  const interp = makeInterpreter();

  assert("addition", evalStr(interp, "(+ 1 2)"), "3");
  assert("multiplication", evalStr(interp, "(* 3 4 5)"), "60");

  evalStr(interp, "(define (square x) (* x x))");
  assert("square", evalStr(interp, "(square 7)"), "49");

  evalStr(interp, "(define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))");
  assert("factorial", evalStr(interp, "(fact 5)"), "120");

  assert("if-then", evalStr(interp, "(if (> 3 2) 10 20)"), "10");
  assert("if-else", evalStr(interp, "(if (< 3 2) 10 20)"), "20");

  assert("quote", evalStr(interp, "(quote (1 2 3))"), "(1 2 3)");
  assert("not a function", evalStr(interp, "(2 3 4)"), "error: not a function: 2");
}

// --- Part 2: verification gate ---

function testVerification() {
  console.log("\nPart 2: Verification gate");
  const interp = makeInterpreter();

  // Expressible: good mod passes
  const good = { fnName: "evalVar" as const, code: '(name, env, interp) => original(name, env, interp)', description: "identity" };
  assert("good mod passes", verifyModification(interp, good).ok ? "ok" : "fail", "ok");

  // Expressible: bad function name
  const badName = { fnName: "bogus" as any, code: '() => 1', description: "bad" };
  assert("bad fnName rejected", verifyModification(interp, badName).ok ? "ok" : "fail", "fail");

  // Expressible: unparseable code
  const badCode = { fnName: "evalVar" as const, code: '(((', description: "bad" };
  assert("bad code rejected", verifyModification(interp, badCode).ok ? "ok" : "fail", "fail");

  // Ecological: require is forbidden
  const badEco = { fnName: "evalVar" as const, code: '(name, env, interp) => require("fs")', description: "bad" };
  assert("require rejected", verifyModification(interp, badEco).ok ? "ok" : "fail", "fail");

  // Sandbox: crashing code rejected
  const crashes = { fnName: "baseEval" as const, code: '(exp, env, interp) => { throw new Error("boom"); }', description: "bad" };
  assert("crash rejected", verifyModification(interp, crashes).ok ? "ok" : "fail", "fail");

  // Sandbox: semantic change is fine (doesn't crash)
  const semantic = { fnName: "evalVar" as const, code: '(name, env, interp) => name === "x" ? 999 : original(name, env, interp)', description: "ok" };
  assert("semantic change passes", verifyModification(interp, semantic).ok ? "ok" : "fail", "ok");
}

// --- Part 3: multi-level tower mechanics ---

function testTowerMechanics() {
  console.log("\nPart 3: Tower mechanics");
  const tower = makeTower(makeInterpreter());

  // Manual modification at level 1 (simulating what an LLM would produce)
  evalStr(tower.interp, "(define n 5)");
  const original = tower.interp.evalVar;
  const newEvalVar = (name: string, env: any, interp: any) =>
    name === "n" ? 0 : original(name, env, interp);
  modifyInterpreter(tower.interp, "evalVar", newEvalVar);
  assert("n after manual mod", evalStr(tower.interp, "n"), "0");

  undoAtLevel(tower, 1);
  assert("n after undo level 1", evalStr(tower.interp, "n"), "5");

  // Level 2: add a custom check protecting baseEval
  tower.boundaries[0] = { policies: [], customChecks: [], maxAttempts: 3, undoStack: [] };
  const b0 = tower.boundaries[0];
  const oldChecks = [...b0.customChecks];
  b0.undoStack.push(["customChecks", oldChecks]);
  b0.customChecks = [...oldChecks, {
    name: "protect-baseEval",
    check: (_interp: any, mod: any) =>
      mod.fnName === "baseEval"
        ? [{ check: "policy", message: "baseEval is protected" }]
        : [],
  }];

  // baseEval should be blocked by the custom check
  const baseEvalMod = { fnName: "baseEval" as const, code: '(exp, env, interp) => original(exp, env, interp)', description: "identity" };
  const evalVarMod = { fnName: "evalVar" as const, code: '(name, env, interp) => original(name, env, interp)', description: "identity" };

  const blocked = b0.customChecks.flatMap(cc => cc.check(tower.interp, baseEvalMod));
  assert("baseEval blocked by level 2", blocked.length > 0 ? "blocked" : "ok", "blocked");

  const allowed = b0.customChecks.flatMap(cc => cc.check(tower.interp, evalVarMod));
  assert("evalVar allowed", allowed.length === 0 ? "ok" : "blocked", "ok");

  // Undo level 2's check
  undoAtLevel(tower, 2);
  const afterUndo = b0.customChecks.flatMap(cc => cc.check(tower.interp, baseEvalMod));
  assert("baseEval allowed after undo level 2", afterUndo.length === 0 ? "ok" : "blocked", "ok");

  // Level 3: add a policy to boundary 1↔2
  tower.boundaries[1] = { policies: [], customChecks: [], maxAttempts: 3, undoStack: [] };
  const b1 = tower.boundaries[1];
  const oldPolicies = [...b1.policies];
  b1.undoStack.push(["policies", oldPolicies]);
  b1.policies = [...oldPolicies, "Only security-related checks allowed"];

  assert("level 3 policy set", b1.policies[0], "Only security-related checks allowed");
  assert("show-tower sees boundary 1↔2", showTower(tower).includes("boundary 1↔2") ? "yes" : "no", "yes");

  undoAtLevel(tower, 3);
  assert("level 3 policy undone", String(b1.policies.length), "0");
}

// --- Run ---

testExactInterpreter();
testVerification();
testTowerMechanics();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

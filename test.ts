// Run the tutorial examples as tests.
// Usage: node --loader ts-node/esm test.ts

import {
  makeInterpreter,
  parse,
  evaluate,
  printValue,
  undoInterpreter,
  Interpreter,
} from "./interpreter.js";
import { execAtMetaLevel, makeMetaLevel } from "./meta.js";

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

// --- Part 1: exact interpreter (no LLM needed) ---

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

// --- Part 2-5: LLM meta-level ---

async function testMetaLevel() {
  console.log("\nPart 2: Variable override + undo");
  {
    const interp = makeInterpreter();
    evalStr(interp, "(define n 5)");
    assert("n before", evalStr(interp, "n"), "5");

    await execAtMetaLevel("make variable n always evaluate to 0", interp, makeMetaLevel());
    assert("n after meta", evalStr(interp, "n"), "0");
    assert("(+ n 10) after meta", evalStr(interp, "(+ n 10)"), "10");

    undoInterpreter(interp);
    assert("n after undo", evalStr(interp, "n"), "5");
  }

  console.log("\nPart 3: Numbers as functions (multn)");
  {
    const interp = makeInterpreter();
    await execAtMetaLevel("make numbers work as functions that multiply their arguments", interp, makeMetaLevel());
    assert("(2 3 4)", evalStr(interp, "(2 3 4)"), "24");
    assert("(5 5)", evalStr(interp, "(5 5)"), "25");

    undoInterpreter(interp);
    assert("(2 3 4) after undo", evalStr(interp, "(2 3 4)"), "error: not a function: 2");
  }

  console.log("\nPart 4: Roman numerals");
  {
    const interp = makeInterpreter();
    await execAtMetaLevel(
      "make all applications of +, -, and * return their result as a roman numeral string instead of a number",
      interp,
      makeMetaLevel(),
    );
    assert("(+ 1 2) roman", evalStr(interp, "(+ 1 2)"), "III");
    assert("(* 4 5) roman", evalStr(interp, "(* 4 5)"), "XX");

    undoInterpreter(interp);
    assert("(+ 1 2) after undo", evalStr(interp, "(+ 1 2)"), "3");
  }
}

// --- Run ---

async function main() {
  testExactInterpreter();
  await testMetaLevel();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

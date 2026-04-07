# Tutorial

This tutorial walks through the heterogeneous reflective tower.

- **Level 0**: a small Scheme interpreter with modifiable evaluation
  functions (like Black)
- **Levels 1, 2, 3, ...**: LLMs that modify the level below, each
  governed by a verification gate (like Blond's `_check_and_spawn`)

## Setup

```bash
cd tower
npm install
```

You need AWS credentials (for Bedrock), `ANTHROPIC_API_KEY`, or
`GOOGLE_CLOUD_PROJECT` (for Vertex). See `llm.ts` for the full
resolution order.

Start the REPL:

```bash
npx tsx index.ts
```

## Part 1: The exact interpreter

Level 0 is a Scheme interpreter. It handles numbers, booleans,
strings, `define`, `lambda`, `if`, `begin`, `quote`, `set!`,
and function application.

```
tower> (+ 1 2)
3
tower> (* 3 4 5)
60
tower> (define (square x) (* x x))
square
tower> (square 7)
49
tower> (define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))
fact
tower> (fact 5)
120
```

This is all deterministic. Same input, same output, every time.

## Part 2: Modifying the interpreter from natural language

In Black, you modify the interpreter by writing Scheme at the
meta level:

```scheme
(exec-at-metalevel
  (set! eval-var
    (lambda (e r k)
      (if (eq? e 'n) (k 0) (old-eval-var e r k)))))
```

Here, you describe what you want in English:

```
tower> (define n 5)
n
tower> n
5
tower> (meta 1 "make variable n always evaluate to 0")
  [level 1] asking LLM: "make variable n always evaluate to 0"
  [verify 0↔1] attempt 1: ok
  [level 1] modified evalVar: Variable n always evaluates to 0
tower> n
0
tower> (+ n 10)
10
```

What happened? The LLM received your request and generated a JSON
object:

```json
{
  "fnName": "evalVar",
  "code": "(name, env, interp) => name === 'n' ? 0 : original(name, env, interp)",
  "description": "Variable n always evaluates to 0, others unchanged"
}
```

Before installation, the verification gate checked four conditions
(cf. Blond's `_check_and_spawn`):

- **Expressible**: `evalVar` is a valid function name, code parses
- **Ecological**: no `require`, `eval`, `process.exit`, etc.
- **Continuable**: compiles to a function
- **Sandbox**: doesn't crash on basic inputs like `(+ 1 2)`

All passed, so the code was compiled and installed.

## Part 3: Undo

Every modification is tracked. `(undo 1)` restores the previous
function:

```
tower> (undo 1)
level 1: undone.
tower> n
5
```

## Part 4: Replicating Black's examples

### multn: numbers as functions

In Black, `multn.blk` redefines `base-apply` so that numbers used
as operators multiply their arguments:

```
tower> (meta 1 "make numbers work as functions that multiply their arguments")
tower> (2 3 4)
24
tower> (5 5)
25
tower> (undo 1)
level 1: undone.
tower> (2 3 4)
error: not a function: 2
```

### Tracing

```
tower> (meta 1 "trace all variable lookups, printing the variable name and value")
tower> (define x 42)
x
tower> (+ x 1)
lookup x -> 42
43
tower> (undo 1)
level 1: undone.
```

### Roman numerals

```
tower> (meta 1 "make +, -, and * return roman numeral strings")
tower> (+ 1 2)
III
tower> (* 4 5)
XX
tower> (undo 1)
level 1: undone.
```

## Part 5: The verification gate in action

When the LLM generates bad code, the gate catches it and feeds the
violations back. The LLM gets another attempt:

```
tower> (meta 1 "do something with eval")
  [level 1] asking LLM: "do something with eval"
  [verify 0↔1] attempt 1: REJECTED
    ecological: code references forbidden bindings
  [verify 0↔1] feeding violations back to LLM...
  [verify 0↔1] attempt 2: ok
  [level 1] modified baseEval: ...
```

The gate rejected the first attempt (the LLM used `eval()`), told
it why, and the LLM self-corrected.

## Part 6: Going up — level 2 modifies level 1

Level 2 is an LLM that modifies level 1's behavior. Level 1 is
decomposed into modifiable components — just as level 0's interpreter
is decomposed into named functions:

- **policies**: constraints appended to level 1's system prompt
- **customChecks**: extra verification checks before modifications
  are installed
- **maxAttempts**: how many tries level 1 gets

```
tower> (meta 2 "protect baseEval from modification")
  [level 2] asking LLM: "protect baseEval from modification"
  [verify 1↔2] attempt 1: ok
  [level 2] Prevents any modification to baseEval
```

Now level 1 can't touch `baseEval`:

```
tower> (meta 1 "intercept all evaluation")
  [level 1] asking LLM: "intercept all evaluation"
  [verify 0↔1] attempt 1: REJECTED
    policy: baseEval is protected
  [verify 0↔1] feeding violations back to LLM...
  [verify 0↔1] attempt 2: ok
  [level 1] modified evalList: intercepts evaluation via evalList instead
```

The LLM adapted — it modified `evalList` instead of `baseEval`.

Undo at level 2 removes the protection:

```
tower> (undo 2)
level 2: undone.
```

## Part 7: Going higher — the tower grows on demand

Level 3 constrains level 2, level 4 constrains level 3, etc.
New levels are created lazily:

```
tower> (meta 3 "only allow security-related checks at level 2")
  [level 3] asking LLM: ...
  [verify 2↔3] attempt 1: ok
  [level 3] Only security-related checks allowed
```

This is a governance hierarchy:
- Level 1 writes code
- Level 2 constrains how code is written
- Level 3 constrains how constraints are set
- ...

Use `(show-tower)` to inspect the full state:

```
tower> (show-tower)
level 0 (interpreter):
  0: modified evalList
boundary 0↔1:
  checks:
    0: protect-baseEval
boundary 1↔2:
  policies:
    0: Only security-related checks allowed
  undo stack: 1 entries
```

## Part 8: How it works

The interpreter (level 0) is decomposed into named functions:

| Function | Role |
|----------|------|
| `baseEval` | Dispatch on expression type |
| `evalVar` | Look up a variable |
| `evalIf` | Evaluate conditionals |
| `evalDefine` | Handle `define` |
| `evalLambda` | Create closures |
| `evalBegin` | Evaluate sequences |
| `evalQuote` | Handle `quote` |
| `baseApply` | Apply a function to arguments |
| `evalList` | Evaluate a list of expressions |
| `myError` | Handle errors |

Each meta-level boundary is decomposed into:

| Component | Role |
|-----------|------|
| `policies` | Constraints in the system prompt |
| `customChecks` | Extra verification functions |
| `maxAttempts` | Retry budget |

When you call `(meta N "...")`:

1. The string goes to the LLM with a system prompt describing
   level N-1's modifiable components (+ any policies from
   boundary (N-1)↔N).
2. The LLM returns a JSON modification.
3. The verification gate checks it (expressible, ecological,
   continuable, sandbox for level 1; expressible, ecological,
   continuable for higher levels; plus custom checks from above).
4. If verification fails, violations are fed back to the LLM.
5. If verification passes, the modification is installed and the
   old value is pushed onto the undo stack.

## Part 9: The connection to reflective towers

In Black's reflective tower:

- Every level is the same Scheme interpreter
- `(exec-at-metalevel ...)` evaluates Scheme at the level above
- The meta level can mutate any interpreter function via `set!`
- Modifications are exact because Scheme is exact
- The tower is infinite (always another level above)

In this tower:

- Level 0 is exact; levels 1+ are approximate (LLMs)
- `(meta N "...")` sends natural language to level N
- Level N generates an exact artifact that modifies level N-1
- The generation is approximate but the modification is exact
- The tower grows lazily (new levels on demand)

The heterogeneity — exact vs. approximate — forces an explicit
boundary between every pair of levels. In Black, you can't tell
where the interpreter ends and the meta level begins (it's Scheme
all the way up). Here, the boundary is a JSON object, and that's
where verification sits — like Blond's `_check_and_spawn`, but at
every level.

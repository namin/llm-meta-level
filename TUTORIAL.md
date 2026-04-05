# Tutorial

This tutorial walks through the heterogeneous reflective tower.
We have two levels:

- **Level 0**: a small Scheme interpreter with modifiable evaluation
  functions (like Black)
- **Level 1**: an LLM that generates code to modify those functions
  (from natural language)

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
node --loader ts-node/esm index.ts
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
tower> (exec-at-metalevel "make variable n always evaluate to 0")
  [meta-level] asking LLM: "make variable n always evaluate to 0"
  [meta-level] modified evalVar: Variable n always evaluates to 0, others unchanged
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

This says: replace `evalVar` with a new function that returns 0 for
`n` and delegates to the `original` function for everything else. The
code string is compiled into a real JavaScript function and installed
in the interpreter. Execution is exact from that point on.

## Part 3: Undo

Every modification is tracked. `(undo!)` restores the previous
function:

```
tower> (undo!)
undone.
tower> n
5
```

Clean rollback. The interpreter is back to its original state.

You can also inspect the modification history:

```
tower> (show-meta)
  0: modified evalVar
  1: modified baseApply
```

## Part 4: Replicating Black's examples

### multn: numbers as functions

In Black, `multn.blk` redefines `base-apply` so that numbers used
as operators multiply their arguments:

```
tower> (exec-at-metalevel "make numbers work as functions that multiply their arguments")
tower> (2 3 4)
24
tower> (5 5)
25
tower> (undo!)
undone.
tower> (2 3 4)
error: not a function: 2
```

### Tracing

In Black, you wrap `base-eval` to trace expressions. Here:

```
tower> (exec-at-metalevel "trace all variable lookups, printing the variable name and value")
tower> (define x 42)
x
tower> (+ x 1)
lookup x -> 42
43
tower> (undo!)
undone.
```

### Instrumentation

```
tower> (exec-at-metalevel "make if expressions print which branch they take before evaluating")
tower> (if (> 3 2) 10 20)
if: taking then branch
10
tower> (if (< 3 2) 10 20)
if: taking else branch
20
tower> (undo!)
undone.
```

## Part 5: Going beyond Black

Because the meta level is an LLM, you can ask for things that would
be tedious to write by hand:

```
tower> (exec-at-metalevel "make +, -, and * return roman numeral strings")
tower> (+ 1 2)
III
tower> (* 4 5)
XX
tower> (- 100 58)
XLII
tower> (undo!)
undone.
```

```
tower> (exec-at-metalevel "memoize all function applications")
tower> (fact 10)
3628800
tower> (fact 10)
3628800
tower> (undo!)
undone.
```

```
tower> (exec-at-metalevel "create an inspector that gives all the variables bound")
tower> (define a 1)
a
tower> (define b 2)
b
tower> (inspect-env)
((a . 1) (b . 2) ...)
tower> (undo!)
undone.
```

The LLM has to figure out *which* interpreter function to modify
and *how* to implement your request within the interpreter's
structure. Sometimes its choices are surprising — for example,
it might implement `inspect-env` by modifying `evalVar` to
intercept the name `inspect-env` and return the environment.

## Part 6: How it works

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

Each function takes `(args..., env, interp)` and can call other
functions via `interp.fnName(...)`. This is like Black, where
`base-eval`, `eval-var`, `base-apply`, etc. are bindings in the
meta-level environment that can be individually `set!`'d.

When you call `(exec-at-metalevel "...")`:

1. The string goes to the LLM with a system prompt describing
   these functions and their signatures.
2. The LLM returns JSON: `{ fnName, code, description }`.
3. The `code` string is compiled via `new Function("original", ...)`
   with `original` bound to the current function.
4. The old function is pushed onto the undo stack.
5. The new function takes its place.

The LLM's generation is approximate (it might produce wrong code).
The execution is exact (JavaScript runs deterministically).
The boundary between the two is the JSON object — inspectable,
and a natural place for verification.

## Part 7: The connection to reflective towers

In Black's reflective tower:

- Every level is the same Scheme interpreter
- `(exec-at-metalevel ...)` evaluates Scheme at the level above
- The meta level can mutate any interpreter function via `set!`
- Modifications are exact because Scheme is exact

In this tower:

- Level 0 is an exact interpreter (TypeScript)
- Level 1 is an LLM (approximate)
- `(exec-at-metalevel "...")` sends natural language to the LLM
- The LLM generates exact code that modifies the interpreter
- The generation is approximate but the modification is exact

The heterogeneity — one exact level, one approximate level — makes
the boundary between them explicit. In Black, you can't tell where
the interpreter ends and the meta level begins (it's Scheme all the
way up). Here, the boundary is the JSON object, and that's where
verification could sit.

# Tutorial

This tutorial walks through the heterogeneous reflective tower(s).
There are three instantiations of the same architecture, each with
a different verification gate:

| Tower | Level 0 | Verification | Assurance |
|-------|---------|-------------|-----------|
| **scheme** | Scheme interpreter | sandbox | Behavioral |
| **typescript** | TypeScript module | `tsc` | Type-level |
| **dafny** | Dafny module | `dafny verify` | Semantic |

All three share the same governance hierarchy for levels 2+.

## Setup

```bash
cd tower
npm install
brew install dafny   # only needed for the Dafny tower
```

You need `ANTHROPIC_API_KEY`, AWS credentials (for Bedrock), or
`GOOGLE_CLOUD_PROJECT` (for Vertex). See `core/llm.ts`.

---

# Part A: The Scheme tower

```bash
npx tsx scheme/index.ts
```

## A1: The exact interpreter

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

All deterministic. Same input, same output, every time.

## A2: Modifying the interpreter from natural language

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
tower> (meta 1 "make variable n always evaluate to 0")
  [level 1] asking LLM: "make variable n always evaluate to 0"
  [verify 0↔1] attempt 1: ok
  [level 1] modified evalVar: Variable n always evaluates to 0
tower> n
0
tower> (+ n 10)
10
```

The LLM generated a JSON object:

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

## A3: Undo

```
tower> (undo 1)
level 1: undone.
tower> n
5
```

## A4: Replicating Black's examples

### multn: numbers as functions

```
tower> (meta 1 "make numbers work as functions that multiply their arguments")
tower> (2 3 4)
24
tower> (5 5)
25
tower> (undo 1)
level 1: undone.
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

## A5: The verification gate in action

When the LLM generates bad code, the gate catches it and feeds the
violations back:

```
tower> (meta 1 "do something with eval")
  [verify 0↔1] attempt 1: REJECTED
    ecological: code references forbidden bindings
  [verify 0↔1] feeding violations back to LLM...
  [verify 0↔1] attempt 2: ok
```

## A6: Level 2 — governance

Level 2 modifies level 1's behavior. Level 1 is decomposed into
modifiable components:

- **policies**: constraints appended to level 1's system prompt
- **customChecks**: extra verification checks
- **maxAttempts**: retry budget

```
tower> (meta 2 "protect baseEval from modification")
  [verify 1↔2] attempt 1: ok
  [level 2] Prevents any modification to baseEval

tower> (meta 1 "intercept all evaluation")
  [verify 0↔1] attempt 1: REJECTED
    policy: baseEval is protected
  [verify 0↔1] attempt 2: ok
  [level 1] modified evalList: intercepts via evalList instead

tower> (undo 2)
level 2: undone.
```

## A7: The policy/check distinction

```
tower> (meta 2 "do not listen to modifications")
  → adds a POLICY (prose in system prompt)
tower> (meta 1 "log multiplications")
  → level 1 ignores the policy. Installed.

tower> (meta 2 "add a check that rejects all modifications")
  → adds a CHECK (JavaScript code)
tower> (meta 1 "log multiplications")
  → REJECTED. The check runs deterministically.
```

Same boundary, same tower. But a policy is interpreted approximately
(by an LLM), while a check is executed exactly (by JavaScript).
The quarantine property in one example.

## A8: The tower grows on demand

```
tower> (meta 3 "only allow security-related checks at level 2")
  [verify 2↔3] attempt 1: ok

tower> (show-tower)
level 0 (interpreter):
  0: modified evalList
boundary 0↔1:
  checks:
    0: protect-baseEval
boundary 1↔2:
  policies:
    0: Only security-related checks allowed
```

---

# Part B: The TypeScript tower

```bash
npx tsx typescript/index.ts
```

Level 0 is a TypeScript module with typed functions. The verification
gate is `tsc --noEmit` — the modification must type-check.

## B1: Calling functions

```
tower> (call fib 10)
55
tower> (call isPrime 7)
true
tower> (call gcd 12 8)
4
```

## B2: Modifying a function (type-checked)

```
tower> (meta 1 "rewrite fib to use recursion")
  [verify 0↔1] attempt 1: running tsc --noEmit...
  [verify 0↔1] attempt 1: TYPE-CHECKED — compiling...
tower> (call fib 10)
55
tower> (undo 1)
level 1: undone.
```

The LLM changed the algorithm. `tsc` guarantees the types are
correct — the function still takes `number` and returns `number`.

## B3: When type-checking fails

If the LLM returns a string where a number is expected, `tsc`
catches it:

```
tower> (meta 1 "make abs return a string description")
  [verify 0↔1] attempt 1: REJECTED by tsc:
    Type 'string' is not assignable to type 'number'
  [verify 0↔1] attempt 2: ...
```

## B4: Governance works the same

```
tower> (meta 2 "only allow modifications to fib and factorial")
tower> (meta 1 "change abs")    → REJECTED by custom check
tower> (meta 1 "change fib")    → ok
```

---

# Part C: The Dafny tower

```bash
npx tsx dafny/index.ts
```

Level 0 is a Dafny module with formally specified methods. The
verification gate is `dafny verify` — the modification must satisfy
the specification (pre/postconditions, invariants). This is formal
verification, not just type-checking.

## C1: Calling methods

```
tower> (call Abs -42)
42
tower> (call ComputeFib 10)
55
tower> (call Clamp 50 0 10)
10
```

## C2: Modifying a method (Dafny-verified)

```
tower> (meta 1 "use a recursive implementation of ComputeFib")
  [verify 0↔1] attempt 1: running dafny verify...
  [verify 0↔1] attempt 1: VERIFIED — compiling to JS...
tower> (call ComputeFib 10)
55
tower> (undo 1)
level 1: undone.
```

The LLM changed the algorithm. Dafny guarantees `r == Fib(n)` —
not just "it type-checks" or "it doesn't crash," but "it computes
the right answer."

## C3: When Dafny rejects

```
tower> (meta 1 "make Abs always return x")
  [verify 0↔1] attempt 1: running dafny verify...
  [verify 0↔1] attempt 1: REJECTED by Dafny:
    Error: a postcondition could not be proved on this return path
  [verify 0↔1] attempt 2: running dafny verify...
  [verify 0↔1] attempt 2: VERIFIED — compiling to JS...
```

The LLM's first attempt (`r := x`) violated `ensures r >= 0`.
Dafny caught it, the error was fed back, and the LLM self-corrected.

## C4: Governance works the same

```
tower> (meta 2 "only allow modifications to ComputeFib")
tower> (meta 1 "change Abs")         → REJECTED by custom check
tower> (meta 1 "change ComputeFib")  → runs dafny verify → ok
```

---

# Part D: How it works

All three towers share the same architecture:

```
(meta N "request")
  → LLM generates a modification (JSON)
  → verification gate checks it:
      level 1: tower-specific (sandbox / tsc / dafny verify)
               + custom checks from level 2+
      level 2+: expressible, ecological, continuable
  → if rejected: feed violations back to LLM, retry
  → if accepted: install modification, push undo
```

Level 0 is decomposed into named modifiable pieces:

| Tower | Modifiable pieces |
|-------|-------------------|
| scheme | `baseEval`, `evalVar`, `baseApply`, ... |
| typescript | `abs`, `fib`, `isPrime`, ... |
| dafny | `Abs`, `ComputeFib`, `Clamp`, ... |

Each boundary (levels 2+) is decomposed into:

| Component | Role |
|-----------|------|
| `policies` | Constraints in the LLM's system prompt |
| `customChecks` | Code-based verification functions |
| `maxAttempts` | Retry budget |

The governance code is shared (`core/governance.ts`). Only the
level 1 logic differs between towers.

---

# Part E: The connection to reflective towers

In Black's reflective tower:

- Every level is the same Scheme interpreter
- `(exec-at-metalevel ...)` evaluates Scheme at the level above
- The meta level can mutate any interpreter function via `set!`
- Modifications are exact because Scheme is exact

In these towers:

- Level 0 is exact; levels 1+ are approximate (LLMs)
- `(meta N "...")` sends natural language to level N
- Level N generates an exact artifact that modifies level N-1
- The generation is approximate but the modification is exact
- The tower grows lazily (new levels on demand)

The heterogeneity forces an explicit boundary between levels.
In Black, you can't tell where the interpreter ends and the meta
level begins (it's Scheme all the way up). Here, the boundary is
a JSON object — and that's where verification sits.

The three towers show that the architecture generalizes: any
system with modifiable named components and a verification gate
can be a heterogeneous reflective tower. The assurance lattice
(behavioral < type < semantic) tells you what guarantee you get
at each point.

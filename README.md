# tower

A heterogeneous reflective tower of arbitrary depth.

Level 0 is an exact Scheme-like interpreter. Levels 1, 2, 3, ... are
LLMs, each modifying the level below. Every boundary between levels
has a verification gate modeled on Blond's `_check_and_spawn`. New
levels are created lazily — the tower grows upward on demand, like
Black's infinite tower.

## The idea

In Black, every level of the tower is the same Scheme interpreter.
Here, the levels are heterogeneous: the object level is deterministic,
the meta-levels are approximate (LLMs), and every boundary has a
verification gate.

```
         ┌─────────────────────────────────┐
         │ Level N: LLM                    │
         │   modifies boundary (N-2)↔(N-1) │
         ├─── verify (N-1)↔N ──────────────┤
         │         ...                     │
         ├─── verify 1↔2 ──────────────────┤
         │ Level 2: LLM                    │
         │   modifies boundary 0↔1         │
         ├─── verify 0↔1 ──────────────────┤
         │ Level 1: LLM                    │
         │   modifies interpreter          │
verify → ├─────────────────────────────────┤
         │ Level 0: exact interpreter      │
         │   baseEval, evalVar, baseApply  │
         └─────────────────────────────────┘
```

Each level is decomposed into modifiable components. The level above
modifies those components through a structured interface with
verification at each boundary.

## Levels

### Level 0 — exact interpreter

A Scheme interpreter decomposed into named functions (following
Black's design): `baseEval`, `evalVar`, `evalIf`, `evalDefine`,
`evalLambda`, `evalBegin`, `evalQuote`, `baseApply`, `evalList`,
`myError`. Each can be individually replaced.

### Level 1 — LLM code generator

Given a natural language request, the LLM generates a JSON object
naming which interpreter function to replace and providing the
replacement code:

```json
{
  "fnName": "evalVar",
  "code": "(name, env, interp) => name === 'n' ? 0 : original(name, env, interp)",
  "description": "Variable n always evaluates to 0"
}
```

### Levels 2, 3, ... — LLM meta-modifiers

Each level N (N ≥ 2) modifies the boundary below it. Every boundary
has the same modifiable components:

- **policies** — constraints appended to the level below's system
  prompt
- **customChecks** — extra verification checks run before a
  modification is installed
- **maxAttempts** — how many tries the level below gets to pass
  verification

This is a governance hierarchy:
- Level 1 writes code
- Level 2 constrains how code is written
- Level 3 constrains how constraints are set
- Level N constrains level N-1

## Verification gates

Every boundary has a verification gate inspired by Blond's
`_check_and_spawn`.

### Boundary 0↔1 (interpreter modifications)

| Check | Blond analogue | What it checks |
|-------|---------------|----------------|
| **Expressible** | `_expressible?` | Valid function name, code parses |
| **Ecological** | `_ecological?` | No `require`, `eval`, `process.exit`, etc. |
| **Continuable** | `_continuable?` | Compiles to a function |
| **Sandbox** | (beyond Blond) | Doesn't crash on basic inputs |
| **Custom** | (from level 2+) | Any checks installed by higher levels |

### Boundaries N↔(N+1) (meta-level modifications)

| Check | What it checks |
|-------|----------------|
| **Expressible** | Valid modification type, required fields present, code parses |
| **Ecological** | No forbidden bindings in check code |
| **Continuable** | Check code compiles to a function |
| **Custom** | Any checks installed by even higher levels |

When verification fails, violations are fed back to the LLM, which
regenerates.

## Setup

```bash
cd tower
npm install
```

Needs one of: `ANTHROPIC_API_KEY`, AWS credentials (for Bedrock),
or `GOOGLE_CLOUD_PROJECT` (for Vertex).

## Usage

```bash
npx tsx index.ts
```

### Level 0 — exact evaluation

```
tower> (+ 1 2)
3
tower> (define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))
fact
tower> (fact 5)
120
```

### Level 1 — modifying the interpreter

```
tower> (meta 1 "make numbers work as functions that multiply their arguments")
  [level 1] asking LLM: "make numbers work as functions..."
  [verify 0↔1] attempt 1: ok
  [level 1] modified baseApply: Numbers applied as functions multiply all arguments
tower> (2 3 4)
24
tower> (undo 1)
level 1: undone.
```

### Level 2 — modifying the meta-level

```
tower> (meta 2 "protect baseEval from modification")
  [level 2] asking LLM: "protect baseEval from modification"
  [verify 1↔2] attempt 1: ok
  [level 2] Prevents any modification to baseEval

tower> (meta 1 "intercept all evaluation")
  [level 1] asking LLM: "intercept all evaluation"
  [verify 0↔1] attempt 1: REJECTED
    policy: baseEval is protected
  [verify 0↔1] feeding violations back to LLM...
  [verify 0↔1] attempt 2: ok
  [level 1] modified evalList: intercepts via evalList instead

tower> (undo 2)
level 2: undone.
```

### Level 3+ — the tower grows

```
tower> (meta 3 "only allow security-related policies at level 2")
  [level 3] asking LLM: "only allow security-related policies"
  [verify 2↔3] attempt 1: ok
  [level 3] Only security-related policies allowed

tower> (show-tower)
level 0 (interpreter):
  0: modified evalList
boundary 0↔1:
  checks:
    0: protect-baseEval
  undo stack: 1 entries
boundary 1↔2:
  policies:
    0: Only security-related policies allowed
  undo stack: 1 entries
```

## Architecture

```
index.ts         REPL connecting all levels
interpreter.ts   Level 0: Scheme interpreter with named modifiable functions
tower.ts         The tower: boundaries, verification, LLM interaction at all levels
verify.ts        Verification gate for boundary 0↔1 (Blond-style checks)
llm.ts           Multi-backend LLM client
test-local.ts    Tests without LLM (interpreter, verification, tower mechanics)
test.ts          Tests with LLM (level 1 modifications)
```

## Tests

Local tests (no LLM needed):

```bash
npx tsx test-local.ts
```

Full tests (requires LLM credentials):

```bash
npx tsx test.ts
```

## How it relates to Black and Blond

In Black's reflective tower, every level is the same Scheme
interpreter. `(exec-at-metalevel ...)` evaluates Scheme at the level
above. The tower is homogeneous — Scheme all the way up — so there
is no natural boundary where verification could sit.

This tower is heterogeneous: exact at level 0, approximate at levels
1+. The heterogeneity forces an explicit interface at each
boundary — a JSON object between each pair of levels. These
interfaces are the natural verification surfaces, analogous to
Blond's `_check_and_spawn` but arising from the mismatch between
levels rather than from explicit design.

The key property: approximation is quarantined to the *production*
of artifacts (the LLM generates code or policies), while *execution*
is exact (the code runs deterministically, the policies are enforced
literally). Verification sits at the boundary between production and
execution.

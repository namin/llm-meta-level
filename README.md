# tower

A heterogeneous reflective tower where level 0 is an exact Scheme-like
interpreter, level 1 is an LLM that modifies the interpreter, and
level 2 is an LLM that modifies the meta-level itself.

## The idea

In Black, every level of the tower is the same Scheme interpreter.
Here, the levels are heterogeneous: the object level is deterministic,
the meta-levels are approximate (LLMs), and every boundary between
levels has a verification gate modeled on Blond's `_check_and_spawn`.

```
┌─────────────────────────────────────────────────┐
│ Level 2: LLM (modifies the meta-level)          │
│   adds policies, custom checks, adjusts config  │
├────────── verify 1↔2 ───────────────────────────┤
│ Level 1: LLM (modifies the interpreter)         │
│   generates code replacements for level 0       │
├────────── verify 0↔1 ───────────────────────────┤
│ Level 0: exact Scheme interpreter               │
│   baseEval, evalVar, baseApply, ...             │
└─────────────────────────────────────────────────┘
```

Each level is decomposed into named modifiable components, and the
level above modifies those components through a structured interface
with verification at each boundary.

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

The LLM's generation is approximate; the code it produces runs
exactly. The JSON boundary is where verification sits.

### Level 2 — LLM meta-modifier

Modifies level 1's behavior. Level 1 is decomposed into:

- **policies** — constraints appended to the code-generating LLM's
  system prompt (e.g., "always wrap original calls in try/catch")
- **customChecks** — extra verification checks run before a
  modification is installed (e.g., "baseEval cannot be modified")
- **maxAttempts** — how many tries the LLM gets to pass verification

Level 2 generates modifications to these components:

```json
{
  "type": "check",
  "name": "protect-baseEval",
  "code": "(interp, mod) => mod.fnName === 'baseEval' ? [{check: 'policy', message: 'baseEval is protected'}] : []",
  "description": "Prevents any modification to baseEval"
}
```

## Verification gates

Every boundary has a verification gate inspired by Blond's
`_check_and_spawn`, which checks three conditions before reflecting
down: expressible, ecological, continuable.

### Boundary 0↔1 (verify.ts)

| Check | Blond analogue | What it checks |
|-------|---------------|----------------|
| **Expressible** | `_expressible?` | Valid function name, code parses |
| **Ecological** | `_ecological?` | No `require`, `eval`, `process.exit`, etc. |
| **Continuable** | `_continuable?` | Compiles to a function |
| **Sandbox** | (beyond Blond) | Doesn't crash on basic inputs |
| **Custom** | (from level 2) | Any checks installed by level 2 |

### Boundary 1↔2 (metameta.ts)

| Check | What it checks |
|-------|----------------|
| **Expressible** | Valid modification type, required fields present, code parses |
| **Ecological** | No forbidden bindings in check code |
| **Continuable** | Check code compiles to a function |

When verification fails, violations are fed back to the LLM, which
regenerates. The meta-level adapts at the moment of reflection,
not in a separate phase.

## Setup

```bash
npm install
```

Needs one of: `ANTHROPIC_API_KEY`, AWS credentials (for Bedrock),
or `GOOGLE_CLOUD_PROJECT` (for Vertex).

## Usage

```bash
node --loader ts-node/esm index.ts
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
tower> (exec-at-metalevel "make numbers work as functions that multiply their arguments")
  [level 1] asking LLM: "make numbers work as functions..."
  [verify 0↔1] attempt 1: ok
  [level 1] modified baseApply: Numbers applied as functions multiply all arguments
tower> (2 3 4)
24
tower> (undo!)
undone.
```

### Level 2 — modifying the meta-level

```
tower> (exec-at-meta-metalevel "protect baseEval from modification")
  [level 2] asking LLM: "protect baseEval from modification"
  [verify 1↔2] attempt 1: ok
  [level 2] check: Prevents any modification to baseEval

tower> (exec-at-metalevel "intercept all evaluation")
  [level 1] asking LLM: "intercept all evaluation"
  [verify 0↔1] attempt 1: REJECTED
    policy: baseEval is protected
  [verify 0↔1] feeding violations back to LLM...
  [verify 0↔1] attempt 2: ok
  [level 1] modified evalList: intercepts via evalList instead

tower> (undo-meta!)
meta undone.
```

### Inspecting state

```
tower> (show-meta)
level 0↔1:
  0: modified baseApply
level 1↔2:
  0: modified customChecks
policies:
  0: Always wrap original calls in try/catch
custom checks:
  0: protect-baseEval
```

## Architecture

```
index.ts         REPL connecting all three levels
interpreter.ts   Level 0: Scheme interpreter with named modifiable functions
meta.ts          Level 1: LLM code generator + MetaLevel state
metameta.ts      Level 2: LLM that modifies the meta-level
verify.ts        Verification gate for boundary 0↔1
llm.ts           Multi-backend LLM client
```

## How it relates to Black and Blond

In Black's reflective tower, every level is the same Scheme
interpreter. `(exec-at-metalevel ...)` evaluates Scheme at the level
above, and `(set! base-apply ...)` replaces an interpreter function.
The tower is homogeneous — Scheme all the way up — so there is no
natural boundary where verification could sit.

This tower is heterogeneous: exact at level 0, approximate at levels
1 and 2. The heterogeneity forces an explicit interface at each
boundary — a JSON object between levels 0 and 1, another between
levels 1 and 2. These interfaces are the natural verification
surfaces, analogous to Blond's `_check_and_spawn` but arising from
the mismatch between levels rather than from explicit design.

The key property: approximation is quarantined to the *production*
of artifacts (the LLM generates code), while *execution* is exact
(the code runs deterministically). Verification sits at the boundary
between production and execution.

## Tests

```bash
node --loader ts-node/esm test.ts
```

# tower

Heterogeneous reflective towers with verified boundaries.

Three instantiations of the same architecture — one shared
governance core, three different verification gates at boundary 0↔1,
three points on the assurance lattice.

```
  ┌─────────────────────────────────────────────┐
  │ Levels 2, 3, ...: governance (shared core)  │
  ├─── verify N↔(N+1) ──────────────────────────┤
  │ Level 1: LLM generates modifications        │
  ├─── verify 0↔1 ──────────────────────────────┤
  │ Level 0: the thing being modified           │
  └─────────────────────────────────────────────┘
```

| Tower | Level 0 | Boundary 0↔1 | Assurance |
|-------|---------|--------------|-----------|
| **scheme** | Scheme interpreter (JS) | sandbox (doesn't crash) | Behavioral |
| **typescript** | TypeScript module | `tsc --noEmit` (type-checks) | Type-level |
| **dafny** | Dafny module (compiled to JS) | `dafny verify` (Boogie/Z3) | Semantic |

Levels 2+ are identical across all towers: policies, custom checks,
configuration — the governance hierarchy from `core/governance.ts`.

## Setup

```bash
cd tower
npm install
```

For LLM features, set one of: `ANTHROPIC_API_KEY`, AWS credentials
(for Bedrock), or `GOOGLE_CLOUD_PROJECT` (for Vertex).

For the Dafny tower: `brew install dafny` (needs Dafny 4.x).

## Running

### Scheme tower

```bash
npx tsx scheme/index.ts
```

```
tower> (+ 1 2)
3
tower> (meta 1 "make numbers work as functions that multiply")
  [verify 0↔1] attempt 1: ok
tower> (2 3 4)
24
tower> (undo 1)
level 1: undone.
tower> (meta 2 "protect baseEval from modification")
  [verify 1↔2] attempt 1: ok
tower> (show-tower)
```

### TypeScript tower

```bash
npx tsx typescript/index.ts
```

```
tower> (call fib 10)
55
tower> (meta 1 "rewrite fib to use recursion")
  [verify 0↔1] attempt 1: running tsc --noEmit...
  [verify 0↔1] attempt 1: TYPE-CHECKED — compiling...
tower> (call fib 10)
55
tower> (undo 1)
level 1: undone.
```

### Dafny tower

```bash
npx tsx dafny/index.ts
```

```
tower> (call ComputeFib 10)
55
tower> (meta 1 "use a recursive implementation of ComputeFib")
  [verify 0↔1] attempt 1: running dafny verify...
  [verify 0↔1] attempt 1: VERIFIED — compiling to JS...
tower> (call ComputeFib 10)
55
tower> (undo 1)
level 1: undone.
```

## Tests

Local tests (no LLM needed):

```bash
npx tsx scheme/test-local.ts       # 22 tests
npx tsx typescript/test-local.ts   # 16 tests
npx tsx dafny/test-local.ts        #  9 tests
```

LLM tests (requires API credentials):

```bash
npx tsx scheme/test.ts             # variable override, multn, roman numerals
npx tsx typescript/test.ts         # fib, abs, isPrime, factorial
npx tsx dafny/test.ts              # ComputeFib, Abs, Clamp
```

## Architecture

```
core/
  governance.ts     Shared: boundaries, policies, custom checks,
                    meta-level LLM interaction, undo — used by
                    all three towers for levels 2+
  llm.ts            Shared: multi-backend LLM client

scheme/
  interpreter.ts    Level 0: Scheme interpreter with named
                    modifiable functions (baseEval, evalVar, ...)
  verify.ts         Boundary 0↔1: expressible, ecological,
                    continuable, sandbox
  tower.ts          Scheme tower (level 1 + core governance)
  index.ts          REPL
  test-local.ts     Local tests
  test.ts           LLM tests

typescript/
  base.ts           Level 0: typed TS module (abs, max, fib, ...)
  tower.ts          TypeScript tower (level 1: tsc + core governance)
  index.ts          REPL
  test-local.ts     Local tests
  test.ts           LLM tests

dafny/
  base.dfy          Level 0: Dafny module with specs
  tower.ts          Dafny tower (level 1: dafny verify + core governance)
  index.ts          REPL
  test-local.ts     Local tests
  test.ts           LLM tests
```

## The assurance lattice

Each tower sits at a different point on the lattice:

```
    semantic    ← Dafny: artifact satisfies a formal spec
       ↑
    type        ← TypeScript: artifact type-checks
       ↑
    behavioral  ← Scheme: artifact doesn't crash
       ↑
    syntactic   ← (all: artifact parses)
```

Same request, three towers, three levels of guarantee.

## How it relates to Black and Blond

In Black's reflective tower, every level is the same Scheme
interpreter — homogeneous, Scheme all the way up. There is no
natural boundary where verification could sit.

These towers are heterogeneous: exact at level 0, approximate
at levels 1+. The heterogeneity forces an explicit interface at
each boundary. The verification gate at boundary 0↔1 is modeled
on Blond's `_check_and_spawn` — check before reflecting down.

The key property: approximation is quarantined to the *production*
of artifacts (the LLM generates code). Verification and execution
are exact.

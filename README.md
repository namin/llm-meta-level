# tower

A heterogeneous reflective tower where level 0 is an exact Scheme-like
interpreter and level 1 is an LLM.

In Black, every level of the tower is the same Scheme interpreter.
Here, the object level (level 0) is a deterministic interpreter with
modifiable evaluation functions, and the meta level (level 1) is an LLM
that generates code to modify those functions. The user writes Scheme;
the LLM writes interpreter modifications; the interpreter runs them
exactly.

## The idea

In Black, to make numbers work as multiplicative functions, you write
Scheme at the meta level:

```scheme
(exec-at-metalevel
  (let ((original-base-apply base-apply))
    (set! base-apply
      (lambda (operator operand env cont)
        (cond ((number? operator)
               (base-eval (cons '* (cons operator operand)) env cont))
              (else
               (original-base-apply operator operand env cont)))))))
```

Here, you say it in English and the LLM generates the code:

```
tower> (exec-at-metalevel "make numbers work as functions that multiply their arguments")
  [meta-level] modified baseApply: Numbers applied as functions multiply all arguments
tower> (2 3 4)
24
```

The modification has exact semantics (it's JavaScript, executed
deterministically) even though it was produced approximately (by an
LLM). Undo is exact too:

```
tower> (undo!)
undone.
tower> (2 3 4)
error: not a function: 2
```

## Architecture

```
interpreter.ts   Scheme-like interpreter decomposed into named
                 modifiable functions (baseEval, evalVar, baseApply,
                 evalIf, ...), following Black's piece-wise design.
                 Includes undo stack, parser, printer.

meta.ts          The LLM meta-level. Takes a natural language request,
                 asks the LLM to generate a JSON object with the
                 function to replace and the replacement code. Compiles
                 and installs the modification. The original function
                 is available as `original` in the generated code.

llm.ts           Multi-backend LLM client (Anthropic API, AWS Bedrock,
                 Vertex AI, Gemini). Copied from surprise/src/llm.ts.

index.ts         REPL connecting both levels.
```

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

At the REPL:

```
tower> (+ 1 2)
3
tower> (define n 5)
n
tower> (exec-at-metalevel "make variable n always evaluate to 0")
meta: Variable n always evaluates to 0, others unchanged
tower> n
0
tower> (undo!)
undone.
tower> n
5
```

## How it relates to Black

Black's interpreter is decomposed into named functions (`base-eval`,
`eval-var`, `base-apply`, etc.) living in the meta-level environment.
`(set! eval-var ...)` replaces one piece. This tower does the same
thing: the interpreter has named functions (`baseEval`, `evalVar`,
`baseApply`, ...) that can be individually swapped. The difference is
who writes the replacement: in Black, the programmer writes Scheme;
here, the LLM writes JavaScript from a natural language description.

The boundary between levels is a JSON object:

```json
{
  "fnName": "evalVar",
  "code": "(name, env, interp) => name === 'n' ? 0 : original(name, env, interp)",
  "description": "Variable n always evaluates to 0, others unchanged"
}
```

This is the reification/reflection interface. The LLM's approximate
understanding produces an exact artifact (code) that the interpreter
runs deterministically. The approximation is in the *generation*; the
execution is precise.

## Examples that work

- `"make variable n always evaluate to 0"` -- like Black's undo.blk walkthrough
- `"make numbers work as functions that multiply their arguments"` -- like Black's multn.blk
- `"trace all variable lookups"` -- like Black's transcript.scm tracing example
- `"memoize all function applications"`
- `"make if expressions print which branch they take"`
- `"make +, -, and * return roman numeral strings"`

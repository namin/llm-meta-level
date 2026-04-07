// A minimal Scheme-like interpreter with modifiable evaluation functions.
// Inspired by Black: the interpreter is decomposed into named pieces
// that can be individually replaced at the meta-level.

export type Expr = number | boolean | string | symbol | Expr[];
export type Env = Map<string, Expr>;
export type Value = Expr | Function | Closure | void;

export interface Closure {
  tag: "closure";
  params: string[];
  body: Expr[];
  env: Env;
}

function isClosure(v: any): v is Closure {
  return v && typeof v === "object" && v.tag === "closure";
}

// --- The interpreter, decomposed into named modifiable pieces ---

export interface Interpreter {
  // The named pieces (like Black's base-eval, eval-var, base-apply, etc.)
  baseEval: (exp: Expr, env: Env, interp: Interpreter) => Value;
  evalVar: (name: string, env: Env, interp: Interpreter) => Value;
  evalIf: (args: Expr[], env: Env, interp: Interpreter) => Value;
  evalDefine: (args: Expr[], env: Env, interp: Interpreter) => Value;
  evalLambda: (args: Expr[], env: Env, interp: Interpreter) => Value;
  evalBegin: (args: Expr[], env: Env, interp: Interpreter) => Value;
  evalQuote: (args: Expr[], env: Env, interp: Interpreter) => Value;
  baseApply: (op: Value, operands: Value[], env: Env, interp: Interpreter) => Value;
  evalList: (exps: Expr[], env: Env, interp: Interpreter) => Value[];
  myError: (msg: string, env: Env, interp: Interpreter) => Value;

  // The environment
  globalEnv: Env;

  // Undo stack: each entry is [functionName, previousValue]
  undoStack: [string, Function][];
}

// --- Default implementations ---

function defaultBaseEval(exp: Expr, env: Env, interp: Interpreter): Value {
  if (typeof exp === "number") return exp;
  if (typeof exp === "boolean") return exp;
  if (typeof exp === "string") {
    // Strings that look like identifiers are symbols
    return interp.evalVar(exp, env, interp);
  }
  if (Array.isArray(exp)) {
    if (exp.length === 0) return [];
    const head = exp[0];
    if (head === "quote") return interp.evalQuote(exp.slice(1), env, interp);
    if (head === "if") return interp.evalIf(exp.slice(1), env, interp);
    if (head === "define") return interp.evalDefine(exp.slice(1), env, interp);
    if (head === "lambda") return interp.evalLambda(exp.slice(1), env, interp);
    if (head === "begin") return interp.evalBegin(exp.slice(1), env, interp);
    if (head === "set!") return evalSet(exp.slice(1), env, interp);
    // Application
    const vals = interp.evalList(exp, env, interp);
    return interp.baseApply(vals[0], vals.slice(1), env, interp);
  }
  return interp.myError(`unknown expression: ${JSON.stringify(exp)}`, env, interp);
}

function evalSet(args: Expr[], env: Env, interp: Interpreter): Value {
  const name = args[0] as string;
  const val = interp.baseEval(args[1], env, interp);
  if (env.has(name)) {
    env.set(name, val as Expr);
  } else if (interp.globalEnv.has(name)) {
    interp.globalEnv.set(name, val as Expr);
  } else {
    return interp.myError(`set!: unbound variable: ${name}`, env, interp);
  }
  return name;
}

function defaultEvalVar(name: string, env: Env, interp: Interpreter): Value {
  if (env.has(name)) return env.get(name)!;
  if (interp.globalEnv.has(name)) return interp.globalEnv.get(name)!;
  return interp.myError(`unbound variable: ${name}`, env, interp);
}

function defaultEvalIf(args: Expr[], env: Env, interp: Interpreter): Value {
  const pred = interp.baseEval(args[0], env, interp);
  if (pred !== false && pred !== 0) {
    return interp.baseEval(args[1], env, interp);
  } else if (args.length > 2) {
    return interp.baseEval(args[2], env, interp);
  }
  return false;
}

function defaultEvalDefine(args: Expr[], env: Env, interp: Interpreter): Value {
  // (define name value) or (define (name params...) body...)
  if (Array.isArray(args[0])) {
    const sig = args[0] as Expr[];
    const name = sig[0] as string;
    const params = sig.slice(1) as string[];
    const body = args.slice(1);
    const closure: Closure = { tag: "closure", params, body, env: interp.globalEnv };
    interp.globalEnv.set(name, closure as any);
    return name;
  }
  const name = args[0] as string;
  const val = interp.baseEval(args[1], env, interp);
  interp.globalEnv.set(name, val as Expr);
  return name;
}

function defaultEvalLambda(args: Expr[], env: Env, interp: Interpreter): Value {
  const params = (args[0] as Expr[]).map(String);
  const body = args.slice(1);
  return { tag: "closure", params, body, env: new Map(env) } as Closure;
}

function defaultEvalBegin(args: Expr[], env: Env, interp: Interpreter): Value {
  let result: Value;
  for (const exp of args) {
    result = interp.baseEval(exp, env, interp);
  }
  return result!;
}

function defaultEvalQuote(args: Expr[], _env: Env, _interp: Interpreter): Value {
  return args[0];
}

function defaultBaseApply(op: Value, operands: Value[], env: Env, interp: Interpreter): Value {
  if (typeof op === "function") {
    return op(...operands);
  }
  if (isClosure(op)) {
    const newEnv = new Map(op.env);
    for (let i = 0; i < op.params.length; i++) {
      newEnv.set(op.params[i], operands[i] as Expr);
    }
    let result: Value;
    for (const exp of op.body) {
      result = interp.baseEval(exp, newEnv, interp);
    }
    return result!;
  }
  return interp.myError(`not a function: ${JSON.stringify(op)}`, env, interp);
}

function defaultEvalList(exps: Expr[], env: Env, interp: Interpreter): Value[] {
  return exps.map((e) => interp.baseEval(e, env, interp));
}

function defaultMyError(msg: string, _env: Env, _interp: Interpreter): Value {
  throw new Error(msg);
}

// --- Primitives ---

function makePrimitives(): Map<string, Expr> {
  const env = new Map<string, Expr>();
  const prim = (name: string, fn: Function) => env.set(name, fn as any);

  prim("+", (...args: number[]) => args.reduce((a, b) => a + b, 0));
  prim("-", (a: number, b: number) => a - b);
  prim("*", (...args: number[]) => args.reduce((a, b) => a * b, 1));
  prim("/", (a: number, b: number) => a / b);
  prim("=", (a: any, b: any) => a === b);
  prim("<", (a: number, b: number) => a < b);
  prim(">", (a: number, b: number) => a > b);
  prim("number?", (a: any) => typeof a === "number");
  prim("boolean?", (a: any) => typeof a === "boolean");
  prim("null?", (a: any) => Array.isArray(a) && a.length === 0);
  prim("pair?", (a: any) => Array.isArray(a) && a.length > 0);
  prim("car", (a: any[]) => a[0]);
  prim("cdr", (a: any[]) => a.slice(1));
  prim("cons", (a: any, b: any[]) => [a, ...(Array.isArray(b) ? b : [b])]);
  prim("list", (...args: any[]) => args);
  prim("not", (a: any) => a === false);
  prim("display", (a: any) => { process.stdout.write(String(a)); return void 0; });
  prim("newline", () => { process.stdout.write("\n"); return void 0; });

  return env;
}

// --- Create a fresh interpreter ---

export function makeInterpreter(): Interpreter {
  const interp: Interpreter = {
    baseEval: defaultBaseEval,
    evalVar: defaultEvalVar,
    evalIf: defaultEvalIf,
    evalDefine: defaultEvalDefine,
    evalLambda: defaultEvalLambda,
    evalBegin: defaultEvalBegin,
    evalQuote: defaultEvalQuote,
    baseApply: defaultBaseApply,
    evalList: defaultEvalList,
    myError: defaultMyError,
    globalEnv: makePrimitives(),
    undoStack: [],
  };
  return interp;
}

// --- Modify a named piece, with undo tracking ---

export type InterpFnName =
  | "baseEval" | "evalVar" | "evalIf" | "evalDefine"
  | "evalLambda" | "evalBegin" | "evalQuote" | "baseApply"
  | "evalList" | "myError";

export function modifyInterpreter(
  interp: Interpreter,
  fnName: InterpFnName,
  newFn: Function,
): void {
  const old = interp[fnName] as Function;
  interp.undoStack.push([fnName, old]);
  (interp as any)[fnName] = newFn;
}

export function undoInterpreter(interp: Interpreter): boolean {
  const entry = interp.undoStack.pop();
  if (!entry) return false;
  const [fnName, oldFn] = entry;
  (interp as any)[fnName] = oldFn;
  return true;
}

// --- Evaluate ---

export function evaluate(interp: Interpreter, exp: Expr): Value {
  return interp.baseEval(exp, interp.globalEnv, interp);
}

// --- S-expression parser ---

export function parse(input: string): Expr {
  const tokens = tokenize(input);
  const [result] = parseTokens(tokens, 0);
  return result;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === " " || input[i] === "\n" || input[i] === "\t") {
      i++;
    } else if (input[i] === ";") {
      while (i < input.length && input[i] !== "\n") i++;
    } else if (input[i] === "(" || input[i] === ")") {
      tokens.push(input[i]);
      i++;
    } else if (input[i] === "'") {
      tokens.push("'");
      i++;
    } else if (input[i] === '"') {
      let s = "";
      i++; // skip opening quote
      while (i < input.length && input[i] !== '"') {
        s += input[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push(`"${s}"`);
    } else {
      let tok = "";
      while (i < input.length && !" \n\t()".includes(input[i])) {
        tok += input[i];
        i++;
      }
      tokens.push(tok);
    }
  }
  return tokens;
}

function parseTokens(tokens: string[], pos: number): [Expr, number] {
  if (tokens[pos] === "'") {
    const [inner, next] = parseTokens(tokens, pos + 1);
    return [["quote", inner], next];
  }
  if (tokens[pos] === "(") {
    const list: Expr[] = [];
    let i = pos + 1;
    while (tokens[i] !== ")") {
      const [elem, next] = parseTokens(tokens, i);
      list.push(elem);
      i = next;
    }
    return [list, i + 1];
  }
  const tok = tokens[pos];
  // String literal
  if (tok.startsWith('"') && tok.endsWith('"')) {
    return [tok.slice(1, -1), pos + 1];
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(tok)) {
    return [Number(tok), pos + 1];
  }
  // Boolean
  if (tok === "#t" || tok === "true") return [true, pos + 1];
  if (tok === "#f" || tok === "false") return [false, pos + 1];
  // Symbol (identifier) — stored as string
  return [tok, pos + 1];
}

// --- Pretty printer ---

export function printValue(v: Value): string {
  if (v === undefined || v === void 0) return "";
  if (typeof v === "function") return "#<primitive>";
  if (isClosure(v)) return `#<closure (${v.params.join(" ")})>`;
  if (v instanceof Map) {
    const entries = [...v.entries()]
      .filter(([_, val]) => typeof val !== "function" && !(val && typeof val === "object" && (val as any).tag === "closure"))
      .map(([k, val]) => `(${k} . ${printValue(val)})`);
    return `(${entries.join(" ")})`;
  }
  if (Array.isArray(v)) return `(${v.map(printValue).join(" ")})`;
  if (typeof v === "boolean") return v ? "#t" : "#f";
  if (typeof v === "object" && v !== null) {
    // Handle plain objects (e.g. from LLM-generated code)
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

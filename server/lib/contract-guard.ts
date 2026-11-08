/**
 * Contract guard compiler.
 *
 * Turns Zod source text such as
 *   z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })
 * into a real Zod schema WITHOUT eval / new Function. The text is parsed by a
 * small recursive-descent parser and only allowlisted factories and methods are
 * invoked, with data-only arguments (strings, numbers, booleans, null, arrays,
 * plain objects, regex literals, and nested schemas). Nothing user-supplied is
 * ever executed as code.
 *
 * Two guard shapes are supported:
 *   - Body mode (default): the schema validates the parsed JSON request body.
 *   - Envelope mode: a top-level z.object whose only keys are `headers` and/or
 *     `body`, e.g. z.object({ headers: z.object({ "x-idempotency-key": z.string() }) }).
 *     Header names are matched in lowercase.
 */
import { z } from "zod";

const MAX_GUARD_LENGTH = 10_000;
const MAX_DEPTH = 32;
const MAX_REGEX_SOURCE = 300;
const MAX_ISSUES = 20;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export type GuardMode = "body" | "envelope";

export interface CompiledContractGuard {
  schema: z.ZodType;
  mode: GuardMode;
}

export type CompileResult =
  | { ok: true; guard: CompiledContractGuard | null }
  | { ok: false; error: string };

export interface GuardIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type GuardEvaluation =
  | { ok: true }
  | { ok: false; issues: GuardIssue[] };

class GuardSyntaxError extends Error {}

type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | RegExp
  | z.ZodType
  | Value[]
  | { [key: string]: Value };

function isSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function isPlainObject(value: unknown): value is Record<string, Value> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof RegExp) &&
    !isSchema(value)
  );
}

function assertSchema(value: Value, where: string): z.ZodType {
  if (!isSchema(value)) {
    throw new GuardSyntaxError(`${where} expects a Zod schema (e.g. z.string())`);
  }
  return value;
}

function assertShape(value: Value, where: string): Record<string, z.ZodType> {
  if (!isPlainObject(value)) {
    throw new GuardSyntaxError(`${where} expects an object of field schemas`);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(value)) {
    shape[key] = assertSchema(field, `${where} field "${key}"`);
  }
  return shape;
}

function assertSchemaArray(value: Value, where: string, min: number): z.ZodType[] {
  if (!Array.isArray(value) || value.length < min) {
    throw new GuardSyntaxError(`${where} expects an array of at least ${min} schemas`);
  }
  return value.map((item, i) => assertSchema(item, `${where}[${i}]`));
}

function assertPrimitive(value: Value, where: string): string | number | boolean | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  throw new GuardSyntaxError(`${where} expects a string, number, boolean, or null`);
}

const FACTORIES: Record<string, (args: Value[]) => z.ZodType> = {
  object: ([shape]) => z.object(assertShape(shape ?? {}, "z.object()")),
  string: () => z.string(),
  number: () => z.number(),
  int: () => z.int(),
  boolean: () => z.boolean(),
  any: () => z.any(),
  unknown: () => z.unknown(),
  null: () => z.null(),
  never: () => z.never(),
  email: () => z.email(),
  url: () => z.url(),
  uuid: () => z.uuid(),
  array: ([item]) => z.array(assertSchema(item, "z.array()")),
  enum: ([values]) => {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every((v) => typeof v === "string")
    ) {
      throw new GuardSyntaxError('z.enum() expects a non-empty array of strings, e.g. z.enum(["USD", "EUR"])');
    }
    return z.enum(values as [string, ...string[]]);
  },
  literal: ([value]) => z.literal(assertPrimitive(value, "z.literal()") as string),
  union: ([options]) =>
    z.union(assertSchemaArray(options, "z.union()", 2) as [z.ZodType, z.ZodType, ...z.ZodType[]]),
  record: (args) => {
    if (args.length === 1) {
      return z.record(z.string(), assertSchema(args[0], "z.record()"));
    }
    return z.record(
      assertSchema(args[0], "z.record() key") as z.ZodString,
      assertSchema(args[1], "z.record() value"),
    );
  },
  optional: ([inner]) => z.optional(assertSchema(inner, "z.optional()")),
  nullable: ([inner]) => z.nullable(assertSchema(inner, "z.nullable()")),
};

/** Methods that may be chained onto a schema. Arguments are data-only. */
const DATA_METHODS = new Set([
  "min",
  "max",
  "length",
  "int",
  "positive",
  "negative",
  "nonnegative",
  "nonpositive",
  "gt",
  "gte",
  "lt",
  "lte",
  "multipleOf",
  "finite",
  "regex",
  "email",
  "url",
  "uuid",
  "startsWith",
  "endsWith",
  "includes",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "nonempty",
  "optional",
  "nullable",
  "nullish",
  "default",
  "strict",
  "passthrough",
  "strip",
  "partial",
  "required",
  "describe",
]);
/** Methods whose first argument must be a schema. */
const SCHEMA_METHODS = new Set(["or", "and", "catchall"]);

function schemaTypeName(schema: z.ZodType): string {
  const def = (schema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def;
  return def?.type ?? "schema";
}

function callMethod(schema: z.ZodType, name: string, args: Value[]): z.ZodType {
  let finalArgs: unknown[] = args;
  if (SCHEMA_METHODS.has(name)) {
    finalArgs = [assertSchema(args[0], `.${name}()`)];
  } else if (name === "extend") {
    finalArgs = [assertShape(args[0], ".extend()")];
  } else if (!DATA_METHODS.has(name)) {
    throw new GuardSyntaxError(`.${name}() is not supported in contract guards`);
  }
  const fn = (schema as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new GuardSyntaxError(`.${name}() is not available on z.${schemaTypeName(schema)}()`);
  }
  const result = (fn as (...a: unknown[]) => unknown).apply(schema, finalArgs);
  if (!isSchema(result)) {
    throw new GuardSyntaxError(`.${name}() did not return a schema`);
  }
  return result;
}

/** Rejects regexes with nested quantifiers such as (a+)+ that can hang the event loop. */
function assertSafeRegex(source: string) {
  if (source.length > MAX_REGEX_SOURCE) {
    throw new GuardSyntaxError(`regex is longer than ${MAX_REGEX_SOURCE} characters`);
  }
  const nestedQuantifier = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
  if (nestedQuantifier.test(source)) {
    throw new GuardSyntaxError(
      "regex contains a nested quantifier like (a+)+, which risks catastrophic backtracking",
    );
  }
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly src: string) {}

  parseGuard(): z.ZodType {
    const value = this.parseValue();
    this.skipWs();
    if (this.src[this.pos] === ";") this.pos++;
    this.skipWs();
    if (this.pos < this.src.length) {
      this.fail(`unexpected "${this.src.slice(this.pos, this.pos + 12)}"`);
    }
    return assertSchema(value, "contract guard");
  }

  private fail(message: string): never {
    const before = this.src.slice(0, this.pos);
    const line = before.split("\n").length;
    const col = this.pos - before.lastIndexOf("\n");
    throw new GuardSyntaxError(`${message} (line ${line}, column ${col})`);
  }

  private skipWs() {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") {
        this.pos++;
      } else if (c === "/" && this.src[this.pos + 1] === "/") {
        const end = this.src.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.src.length : end + 1;
      } else if (c === "/" && this.src[this.pos + 1] === "*") {
        const end = this.src.indexOf("*/", this.pos + 2);
        if (end === -1) this.fail("unterminated comment");
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  private expect(ch: string) {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      this.fail(`expected "${ch}"`);
    }
    this.pos++;
  }

  private parseIdent(): string {
    this.skipWs();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.pos));
    if (!match) this.fail("expected an identifier");
    this.pos += match[0].length;
    return match[0];
  }

  private enter() {
    this.depth++;
    if (this.depth > MAX_DEPTH) this.fail(`nesting deeper than ${MAX_DEPTH} levels`);
  }

  private parseValue(): Value {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === undefined) this.fail("unexpected end of guard");
    if (c === '"' || c === "'" || c === "`") return this.parseString();
    if (c === "-" || c === "." || (c >= "0" && c <= "9")) return this.parseNumber();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseObject();
    if (c === "/") return this.parseRegex();
    if (c === "(") {
      this.fail("functions and expressions are not allowed in contract guards (no .refine/.transform callbacks); use data values and Zod methods");
    }
    const ident = this.parseIdent();
    switch (ident) {
      case "z":
        return this.parseZodExpression();
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return undefined;
      default:
        return this.fail(`unknown identifier "${ident}" (only z.* schemas and literal values are allowed)`);
    }
  }

  private parseArgs(): Value[] {
    this.expect("(");
    const args: Value[] = [];
    this.skipWs();
    while (this.src[this.pos] !== ")") {
      args.push(this.parseValue());
      this.skipWs();
      if (this.src[this.pos] === ",") {
        this.pos++;
        this.skipWs();
      } else if (this.src[this.pos] !== ")") {
        this.fail('expected "," or ")"');
      }
    }
    this.pos++;
    return args;
  }

  private parseZodExpression(): z.ZodType {
    this.enter();
    this.expect(".");
    const factoryName = this.parseIdent();
    const factory = hasOwn(FACTORIES, factoryName) ? FACTORIES[factoryName] : undefined;
    if (!factory) this.fail(`z.${factoryName}() is not supported in contract guards`);
    const factoryArgs = this.parseArgs();
    let schema = this.wrap(() => factory(factoryArgs));
    for (;;) {
      this.skipWs();
      if (this.src[this.pos] !== ".") break;
      this.pos++;
      const method = this.parseIdent();
      const args = this.parseArgs();
      const current = schema;
      schema = this.wrap(() => callMethod(current, method, args));
    }
    this.depth--;
    return schema;
  }

  /** Converts Zod's own construction errors into positioned guard errors. */
  private wrap(build: () => z.ZodType): z.ZodType {
    try {
      return build();
    } catch (err) {
      if (err instanceof GuardSyntaxError) this.fail(err.message);
      this.fail(err instanceof Error ? err.message : "invalid schema");
    }
  }

  private parseArray(): Value[] {
    this.enter();
    this.expect("[");
    const items: Value[] = [];
    this.skipWs();
    while (this.src[this.pos] !== "]") {
      items.push(this.parseValue());
      this.skipWs();
      if (this.src[this.pos] === ",") {
        this.pos++;
        this.skipWs();
      } else if (this.src[this.pos] !== "]") {
        this.fail('expected "," or "]"');
      }
    }
    this.pos++;
    this.depth--;
    return items;
  }

  private parseObject(): Record<string, Value> {
    this.enter();
    this.expect("{");
    const out: Record<string, Value> = {};
    this.skipWs();
    while (this.src[this.pos] !== "}") {
      const c = this.src[this.pos];
      const key = c === '"' || c === "'" || c === "`" ? this.parseString() : this.parseIdent();
      if (FORBIDDEN_KEYS.has(key)) this.fail(`"${key}" is not allowed as a key`);
      this.expect(":");
      out[key] = this.parseValue();
      this.skipWs();
      if (this.src[this.pos] === ",") {
        this.pos++;
        this.skipWs();
      } else if (this.src[this.pos] !== "}") {
        this.fail('expected "," or "}"');
      }
    }
    this.pos++;
    this.depth--;
    return out;
  }

  private parseString(): string {
    const quote = this.src[this.pos++];
    let out = "";
    for (;;) {
      const c = this.src[this.pos++];
      if (c === undefined || (c === "\n" && quote !== "`")) this.fail("unterminated string");
      if (c === quote) return out;
      if (quote === "`" && c === "$" && this.src[this.pos] === "{") {
        this.fail("template interpolation is not allowed");
      }
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.src[this.pos++];
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (e === undefined) this.fail("unterminated string");
      if (hasOwn(simple, e)) {
        out += simple[e];
      } else if (e === "u" || e === "x") {
        const braced = e === "u" && this.src[this.pos] === "{";
        const match = braced
          ? /^\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.pos))
          : new RegExp(`^[0-9a-fA-F]{${e === "u" ? 4 : 2}}`).exec(this.src.slice(this.pos));
        if (!match) this.fail("invalid escape sequence");
        out += String.fromCodePoint(Number.parseInt((braced ? match[1] : match[0]) ?? "", 16));
        this.pos += match[0].length;
      } else {
        out += e;
      }
    }
  }

  private parseNumber(): number {
    const match = /^-?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/.exec(
      this.src.slice(this.pos),
    );
    if (!match) this.fail("invalid number");
    this.pos += match[0].length;
    const value = Number(match[0].replace(/_/g, ""));
    if (!Number.isFinite(value)) this.fail("invalid number");
    return value;
  }

  private parseRegex(): RegExp {
    const start = ++this.pos;
    let inClass = false;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || c === "\n") this.fail("unterminated regex literal");
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      this.pos++;
    }
    const source = this.src.slice(start, this.pos);
    this.pos++;
    const flags = /^[a-z]*/.exec(this.src.slice(this.pos))?.[0] ?? "";
    this.pos += flags.length;
    if (!/^[imsu]*$/.test(flags)) {
      this.fail(`regex flags "${flags}" are not allowed (use i, m, s, u)`);
    }
    try {
      assertSafeRegex(source);
      return new RegExp(source, flags);
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : "invalid regex");
    }
  }
}

function detectMode(schema: z.ZodType): GuardMode {
  if (schema instanceof z.ZodObject) {
    const keys = Object.keys(schema.shape);
    if (keys.length > 0 && keys.every((k) => k === "headers" || k === "body")) {
      return "envelope";
    }
  }
  return "body";
}

/** Compiles guard text. Empty text means "no guard". */
export function compileContractGuard(text: string | null | undefined): CompileResult {
  const source = (text ?? "").trim();
  if (!source) return { ok: true, guard: null };
  if (source.length > MAX_GUARD_LENGTH) {
    return { ok: false, error: `Contract guard is longer than ${MAX_GUARD_LENGTH} characters.` };
  }
  try {
    const schema = new Parser(source).parseGuard();
    return { ok: true, guard: { schema, mode: detectMode(schema) } };
  } catch (err) {
    if (err instanceof GuardSyntaxError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : "Invalid contract guard." };
  }
}

/** Validates a request against a compiled guard. Header names must already be lowercase. */
export function evaluateContractGuard(
  guard: CompiledContractGuard,
  request: { body: unknown; headers: Record<string, string> },
): GuardEvaluation {
  const input =
    guard.mode === "envelope"
      ? { headers: request.headers, body: request.body }
      : request.body;
  const result = guard.schema.safeParse(input);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
      path: issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
      code: issue.code,
      message: issue.message,
    })),
  };
}

export const CONTRACT_GUARD_SYNTAX_HELP =
  'Real Zod syntax, compiled safely (no eval). Validates the JSON request body, e.g. z.object({ quantity: z.number().int().min(1) }). To validate headers, use an envelope: z.object({ headers: z.object({ "x-idempotency-key": z.string().regex(/^idem_/) }), body: z.object({...}).optional() }) with lowercase header names. Supported: z.object/string/number/int/boolean/array/enum/literal/union/record/email/url/uuid/any/unknown/null/optional/nullable and chained .min/.max/.length/.int/.positive/.nonnegative/.gt/.gte/.lt/.lte/.regex/.email/.url/.uuid/.startsWith/.endsWith/.includes/.trim/.optional/.nullable/.nullish/.default/.strict/.passthrough/.partial/.or/.and/.extend/.describe. Requests that fail the guard get HTTP 422 with the Zod issues.';

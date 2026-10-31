// The error-code check of docs/errors.md: one entry per error `code` the SDK can raise, and
// none for a code it no longer knows.
//
// The codes are read from packages/client/src with the TypeScript compiler, not with a grep:
//
// - every construction of an error class (`XoError` and every class that extends it) is
//   found, and the `code` of its options worked out: a literal, a template (`http_${status}`
//   reads `http_<status>`), a conditional, a `??`, a constant, a `{ code }` shorthand, an
//   options object kept in a constant or spread from one, and a code passed to a helper
//   (followed to every call of the helper);
// - a construction that gives no code gets its class's default (`opts.code ?? 'invalid_input'`
//   in the class), so a default counts only when some construction leaves the code out;
// - the `code` of a nested object (the issues of an `UnexpectedResponseError`) is not one;
// - another error's code passed on (`code: error.code`, a code destructured from a server
//   answer) is not a new code: it is listed as a pass-through;
// - a code it cannot work out fails the check, with its place, so nothing slips by. So do
//   options it cannot read statically (`new XoError(msg, opts('x'))`, options passed in as a
//   parameter, a spread argument), an error class held in a variable or chosen at run time
//   (`const E = cond ? A : B; new E(...)`, `Reflect.construct`), and a `code` set after
//   construction (`error.code = …`, `Object.assign(error, { code })`,
//   `Object.defineProperty(error, 'code', …)`).
//
// A `code` field initializer of an error class (`override readonly code = 'x'`) is that class's
// code (and its subclasses'), whatever the options say; a `code` getter fails the check.
//
// What it does not see: a copy that keeps the original's code (the orderbook client copies an
// error with `Object.defineProperties(copy, descriptors)`, descriptors read from the original),
// which raises no new code.
//
// The codes of the services that the SDK handles by name are read too: compared with a
// `.code` (`error.code === 'invalid_credentials'`) or listed in a `*_CODES` constant.
//
// docs/errors.md lists the codes in tables whose header names a `Code` and a `Class` column
// (`| Code | Class | What to do |`). Each row whose Code cell is one backticked code is an
// entry; the backticked names of its Class cell are the entry's classes. Rows of other tables
// (the fields of an error) are not entries. The check fails when:
// - a code the SDK raises, or a service code it handles by name, has no entry;
// - an entry names a code that is neither, nor named in the source's comments (a service
//   code the JSDoc documents, such as the sponsor's `policy_rejected`): a stale entry;
// - the classes of an entry are not exactly the classes that raise the code;
// - a code is listed twice.
//
//   pnpm -C scripts error-codes          check (exit 1 on any problem)
//   pnpm -C scripts error-codes --list   print every code with its classes, services and places

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** What the source says about one code the SDK raises. */
export interface CodeInfo {
  /** The error classes that raise it, sorted. */
  classes: string[];
  /** The `service` of the errors, sorted: `sdk` when none is given, left out when it varies. */
  services: string[];
  /** `mayHaveLanded` as the constructions set it: `true`, `false`, `varies` or `unset`. */
  mayHaveLanded: string[];
  /** Where it is raised, as `file:line`. */
  sites: string[];
}

export interface Extraction {
  codes: Map<string, CodeInfo>;
  /** The service codes the SDK handles by name, with where. */
  serviceCodes: Map<string, string[]>;
  /** Constructions that pass on another error's code, as `file:line`. */
  passthrough: string[];
  /** Codes that could not be worked out: each a problem, as `file:line: why`. */
  unresolved: string[];
}

/** One entry of docs/errors.md. */
export interface PageEntry {
  code: string;
  line: number;
  classes: string[];
}

const ROOT_CLASS = 'XoError';
const SERVICE_CODE = /^[A-Za-z][A-Za-z0-9_]*$/;
const CODE_CELL = /^`([^`]+)`$/;
const DELIMITER_CELL = /^:?-+:?$/;
const MAX_DEPTH = 12;

interface Resolved {
  codes: Set<string>;
  /** The value is another object's code (an error's, a server answer's), passed on. */
  passthrough: boolean;
  unresolved: string[];
}

const empty = (): Resolved => ({
  codes: new Set(),
  passthrough: false,
  unresolved: [],
});

function merge(into: Resolved, from: Resolved): Resolved {
  for (const code of from.codes) {
    into.codes.add(code);
  }
  into.passthrough ||= from.passthrough;
  into.unresolved.push(...from.unresolved);
  return into;
}

/** A program over in-memory files only: nothing outside them is read. */
function createProgram(files: Record<string, string>): {
  program: ts.Program;
  paths: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) {
    const path = `/${name}`;
    byPath.set(path, text);
    paths.set(path, name);
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    types: [],
    noEmit: true,
    strict: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name, version) => {
      const text = byPath.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, version, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => byPath.has(name),
    readFile: (name) => byPath.get(name),
    directoryExists: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...byPath.keys()].some((path) => path.startsWith(prefix));
    },
    getDirectories: () => [],
  };
  return {
    program: ts.createProgram([...byPath.keys()], options, host),
    paths,
  };
}

/** Reads the error codes of a set of source files (path → text). */
export function extractErrorCodes(files: Record<string, string>): Extraction {
  const { program, paths } = createProgram(files);
  const checker = program.getTypeChecker();
  const sources = program
    .getSourceFiles()
    .filter((file) => paths.has(file.fileName));

  const where = (node: ts.Node): string => {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    return `${paths.get(file.fileName) ?? file.fileName}:${line + 1}`;
  };

  const resolveSymbol = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };

  const declarationOf = (node: ts.Node): ts.Declaration | undefined => {
    const parent = node.parent;
    // `{ code }`: the value's symbol, not the property's.
    let symbol =
      parent !== undefined &&
      ts.isShorthandPropertyAssignment(parent) &&
      parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : resolveSymbol(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };

  // Every node of the program, once, for the walks below.
  const all: ts.Node[] = [];
  for (const file of sources) {
    const visit = (node: ts.Node) => {
      all.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  // ---- The error classes -------------------------------------------------------------
  const classDecls = all.filter(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name !== undefined,
  );
  const parentOf = (
    c: ts.ClassDeclaration,
  ): ts.ClassDeclaration | undefined => {
    const clause = c.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const base = clause?.types[0];
    if (base === undefined) {
      return undefined;
    }
    const declaration = declarationOf(base.expression);
    return declaration !== undefined && ts.isClassDeclaration(declaration)
      ? declaration
      : undefined;
  };
  const errorClasses = new Set<ts.ClassDeclaration>();
  const isError = (
    c: ts.ClassDeclaration,
    seen = new Set<ts.Node>(),
  ): boolean => {
    if (c.name?.text === ROOT_CLASS) {
      return true;
    }
    const parent = parentOf(c);
    if (parent === undefined || seen.has(parent)) {
      return false;
    }
    seen.add(parent);
    return isError(parent, seen);
  };
  for (const c of classDecls) {
    if (isError(c)) {
      errorClasses.add(c);
    }
  }

  // ---- Calls, for following a code passed to a helper ---------------------------------
  const callsOf = new Map<ts.Symbol, ts.CallExpression[]>();
  for (const node of all) {
    if (!ts.isCallExpression(node)) {
      continue;
    }
    const callee = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name
      : node.expression;
    const symbol = resolveSymbol(callee);
    if (symbol !== undefined) {
      const list = callsOf.get(symbol) ?? [];
      list.push(node);
      callsOf.set(symbol, list);
    }
  }
  const functionSymbol = (
    fn: ts.SignatureDeclaration,
  ): ts.Symbol | undefined => {
    if (
      (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
      fn.name !== undefined
    ) {
      return resolveSymbol(fn.name);
    }
    const parent = fn.parent;
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name)
    ) {
      return resolveSymbol(parent.name);
    }
    return undefined;
  };

  // ---- Working out a code ------------------------------------------------------------
  const resolve = (
    expr: ts.Expression,
    depth = 0,
    seen = new Set<ts.Node>(),
  ): Resolved => {
    const out = empty();
    if (depth > MAX_DEPTH || seen.has(expr)) {
      out.unresolved.push(
        `${where(expr)}: the code is too deeply nested to follow`,
      );
      return out;
    }
    seen.add(expr);
    const next = (e: ts.Expression) => resolve(e, depth + 1, seen);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      out.codes.add(expr.text);
      return out;
    }
    if (ts.isTemplateExpression(expr)) {
      let text = expr.head.text;
      for (const span of expr.templateSpans) {
        text += `<${span.expression.getText()}>${span.literal.text}`;
      }
      out.codes.add(text);
      return out;
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      return next(expr.expression);
    }
    if (ts.isConditionalExpression(expr)) {
      return merge(next(expr.whenTrue), next(expr.whenFalse));
    }
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return merge(next(expr.left), next(expr.right));
    }
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'code') {
      out.passthrough = true;
      return out;
    }
    if (ts.isIdentifier(expr)) {
      if (expr.text === 'undefined') {
        return out;
      }
      return resolveDeclaration(declarationOf(expr), expr, depth, seen);
    }
    out.unresolved.push(
      `${where(expr)}: cannot work out the code \`${expr.getText()}\``,
    );
    return out;
  };

  const resolveDeclaration = (
    declaration: ts.Declaration | undefined,
    at: ts.Node,
    depth: number,
    seen: Set<ts.Node>,
  ): Resolved => {
    const out = empty();
    if (declaration === undefined) {
      out.unresolved.push(
        `${where(at)}: cannot find where \`${at.getText()}\` comes from`,
      );
      return out;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return resolve(declaration.initializer, depth + 1, seen);
    }
    if (ts.isBindingElement(declaration)) {
      // Destructured from a value (a server answer): a code passed on.
      out.passthrough = true;
      return out;
    }
    if (ts.isParameter(declaration)) {
      const fn = declaration.parent;
      const index = fn.parameters.indexOf(declaration);
      const symbol = functionSymbol(fn);
      const calls = symbol === undefined ? [] : (callsOf.get(symbol) ?? []);
      if (calls.length === 0) {
        out.unresolved.push(
          `${where(at)}: the code is the parameter \`${at.getText()}\` of a function that is never called by name`,
        );
        return out;
      }
      for (const call of calls) {
        const arg = call.arguments[index];
        if (arg === undefined) {
          continue;
        }
        merge(out, resolve(arg, depth + 1, seen));
      }
      return out;
    }
    out.unresolved.push(
      `${where(at)}: cannot work out the code \`${at.getText()}\``,
    );
    return out;
  };

  /** The object literals an options argument stands for: itself, a constant's, a spread's. */
  const objectsOf = (
    expr: ts.Expression,
    depth = 0,
  ): ts.ObjectLiteralExpression[] => {
    if (depth > MAX_DEPTH) {
      return [];
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return [expr];
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      return objectsOf(expr.expression, depth + 1);
    }
    if (ts.isConditionalExpression(expr)) {
      return [
        ...objectsOf(expr.whenTrue, depth + 1),
        ...objectsOf(expr.whenFalse, depth + 1),
      ];
    }
    if (ts.isIdentifier(expr)) {
      const declaration = declarationOf(expr);
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        return objectsOf(declaration.initializer, depth + 1);
      }
    }
    return [];
  };

  interface Options {
    /** The `code` values given (property, shorthand or through a spread). */
    code?: ts.Expression[];
    /** The `service`: a literal, `dynamic` for any other value, undefined when not given. */
    service?: string;
    /** `mayHaveLanded`: `true`, `false`, `varies`, undefined when not given. */
    landed?: string;
  }

  /**
   * Reads `code`, `service` and `mayHaveLanded` of an object literal, spreads included; a
   * later property wins, as at run time. A spread that cannot be followed (a parameter) may
   * carry any `service`, so the service is `dynamic` then.
   */
  const readOptions = (o: ts.ObjectLiteralExpression, depth = 0): Options => {
    const result: Options = {};
    for (const property of o.properties) {
      if (ts.isSpreadAssignment(property)) {
        const inner = objectsOf(property.expression);
        if (inner.length === 0) {
          result.service = 'dynamic';
          continue;
        }
        for (const spread of inner.map((x) => readOptions(x, depth + 1))) {
          if (spread.code !== undefined) {
            result.code = [...(result.code ?? []), ...spread.code];
          }
          if (spread.service !== undefined) {
            result.service = spread.service;
          }
          if (spread.landed !== undefined) {
            result.landed = spread.landed;
          }
        }
        continue;
      }
      const name =
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)
          ? property.name.getText()
          : undefined;
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      if (name === undefined || value === undefined) {
        continue;
      }
      if (name === 'code') {
        result.code = [value];
      } else if (name === 'service') {
        result.service = ts.isStringLiteral(value) ? value.text : 'dynamic';
      } else if (name === 'mayHaveLanded') {
        result.landed =
          value.kind === ts.SyntaxKind.TrueKeyword
            ? 'true'
            : value.kind === ts.SyntaxKind.FalseKeyword
              ? 'false'
              : 'varies';
      }
    }
    return result;
  };

  /** The options of a call or `new`: what its object arguments say. */
  const optionsOfArgs = (args: readonly ts.Expression[]): Options => {
    const result: Options = {};
    for (const arg of args) {
      for (const o of objectsOf(arg)) {
        const read = readOptions(o);
        if (read.code !== undefined) {
          result.code = [...(result.code ?? []), ...read.code];
        }
        result.service ??= read.service;
        result.landed ??= read.landed;
      }
    }
    return result;
  };

  // ---- Class defaults ----------------------------------------------------------------
  interface ClassDefault {
    codes: Set<string>;
    /** Whether a code the caller gives is used. */
    accepts: boolean;
    /** The service the class sets itself, when it does. */
    service?: string;
    unresolved: string[];
  }
  const defaults = new Map<ts.ClassDeclaration, ClassDefault>();
  const baseDefaultOf = (c: ts.ClassDeclaration): ClassDefault => {
    const known = defaults.get(c);
    if (known !== undefined) {
      return known;
    }
    const result: ClassDefault = {
      codes: new Set(),
      accepts: false,
      unresolved: [],
    };
    defaults.set(c, result);
    const ctor = c.members.find(ts.isConstructorDeclaration);
    const parent = parentOf(c);
    const inherit = () => {
      if (parent !== undefined && errorClasses.has(parent)) {
        const from = defaultOf(parent);
        for (const code of from.codes) {
          result.codes.add(code);
        }
        result.accepts = from.accepts;
        result.service = from.service;
      }
    };
    if (ctor?.body === undefined) {
      inherit();
      return result;
    }
    if (c.name?.text === ROOT_CLASS) {
      // The base class keeps the code itself: `this.code = scrub(opts.code ?? 'xo_error')`.
      for (const node of all) {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          node.left.name.text === 'code' &&
          isInside(node, ctor)
        ) {
          let value: ts.Expression = node.right;
          while (ts.isCallExpression(value) && value.arguments.length === 1) {
            value = value.arguments[0] as ts.Expression;
          }
          const resolved = resolve(value);
          for (const code of resolved.codes) {
            result.codes.add(code);
          }
          result.accepts = resolved.passthrough;
          result.unresolved.push(...resolved.unresolved);
        }
      }
      return result;
    }
    const superCall = all.find(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.SuperKeyword &&
        isInside(node, ctor),
    );
    if (superCall === undefined) {
      inherit();
      return result;
    }
    const options = optionsOfArgs(superCall.arguments.slice(1));
    if (options.code === undefined) {
      // `super(message, opts)` or `{ ...opts, issues }`: the parent decides.
      inherit();
      if (options.service !== undefined && options.service !== 'dynamic') {
        result.service = options.service;
      }
      return result;
    }
    for (const value of options.code) {
      const resolved = resolve(value);
      for (const code of resolved.codes) {
        result.codes.add(code);
      }
      result.accepts ||= resolved.passthrough;
      result.unresolved.push(...resolved.unresolved);
    }
    if (options.service !== undefined && options.service !== 'dynamic') {
      result.service = options.service;
    }
    return result;
  };

  /**
   * A class's default, with its own `code` member applied: a field initializer
   * (`override readonly code = 'x'`) runs after `super()`, so it wins over the options and the
   * parent's default, and its subclasses inherit it; a `code` getter cannot be read.
   */
  const withCodeMember = new Set<ts.ClassDeclaration>();
  const defaultOf = (c: ts.ClassDeclaration): ClassDefault => {
    const result = baseDefaultOf(c);
    if (withCodeMember.has(c)) {
      return result;
    }
    withCodeMember.add(c);
    for (const member of c.members) {
      if (member.name?.getText() !== 'code') {
        continue;
      }
      if (ts.isGetAccessorDeclaration(member)) {
        result.unresolved.push(
          `${where(member)}: a \`code\` getter: the check cannot read it; set the code in the options`,
        );
      } else if (
        ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined
      ) {
        const resolved = resolve(member.initializer);
        result.codes = new Set(resolved.codes);
        result.accepts = false;
        result.unresolved.push(...resolved.unresolved);
      }
    }
    return result;
  };

  // ---- Every construction ------------------------------------------------------------
  const codes = new Map<
    string,
    {
      classes: Set<string>;
      services: Set<string>;
      landed: Set<string>;
      sites: string[];
    }
  >();
  const passthrough: string[] = [];
  const unresolved: string[] = [];
  const add = (
    code: string,
    cls: string,
    service: string,
    landed: string,
    site: string,
  ) => {
    const info = codes.get(code) ?? {
      classes: new Set(),
      services: new Set(),
      landed: new Set(),
      sites: [],
    };
    info.classes.add(cls);
    if (service !== 'dynamic') {
      info.services.add(service);
    }
    info.landed.add(landed);
    if (!info.sites.includes(site)) {
      info.sites.push(site);
    }
    codes.set(code, info);
  };

  /** Whether `node`, or anything in it, names an error class. */
  const mentionsErrorClass = (node: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) {
        return;
      }
      if (ts.isIdentifier(n)) {
        const d = declarationOf(n);
        if (
          d !== undefined &&
          ts.isClassDeclaration(d) &&
          errorClasses.has(d)
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  /** An argument after the message that is not options the check can read. */
  const unreadableOptions = (arg: ts.Expression): string | undefined => {
    let value: ts.Expression = arg;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value)
    ) {
      value = value.expression;
    }
    if (ts.isIdentifier(value) && value.text === 'undefined') {
      return undefined;
    }
    if (ts.isConditionalExpression(value)) {
      return (
        unreadableOptions(value.whenTrue) ?? unreadableOptions(value.whenFalse)
      );
    }
    if (objectsOf(value).length > 0) {
      return undefined;
    }
    const declaration = ts.isIdentifier(value)
      ? declarationOf(value)
      : undefined;
    const why =
      declaration !== undefined && ts.isParameter(declaration)
        ? 'options passed in as a parameter'
        : 'options it cannot read';
    return `${where(arg)}: cannot work out the code of this error: ${why} (\`${arg.getText().slice(0, 60)}\`); pass an object literal or a constant one`;
  };

  for (const node of all) {
    // A code set after construction.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'code' &&
      node.left.expression.kind !== ts.SyntaxKind.ThisKeyword
    ) {
      unresolved.push(
        `${where(node)}: a \`code\` set after construction (\`${node.getText().slice(0, 60)}\`): set it in the options instead`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const owner = node.expression.expression.text;
      const method = node.expression.name.text;
      const [, second] = node.arguments;
      const setsCode =
        owner === 'Object' &&
        ((method === 'defineProperty' &&
          second !== undefined &&
          ts.isStringLiteral(second) &&
          second.text === 'code') ||
          ((method === 'assign' || method === 'defineProperties') &&
            node.arguments
              .slice(1)
              .some((arg) =>
                objectsOf(arg).some((o) =>
                  o.properties.some((p) => p.name?.getText() === 'code'),
                ),
              )));
      if (setsCode) {
        unresolved.push(
          `${where(node)}: a \`code\` set after construction (\`Object.${method}\`): set it in the options instead`,
        );
      }
      if (
        owner === 'Reflect' &&
        method === 'construct' &&
        node.arguments[0] !== undefined &&
        mentionsErrorClass(node.arguments[0])
      ) {
        unresolved.push(
          `${where(node)}: an error class constructed with Reflect.construct: construct it with \`new\``,
        );
      }
    }
    if (!ts.isNewExpression(node)) {
      continue;
    }
    const declaration = declarationOf(node.expression);
    if (
      declaration === undefined ||
      !ts.isClassDeclaration(declaration) ||
      !errorClasses.has(declaration)
    ) {
      // An error class held in a variable, or chosen at run time.
      const held =
        declaration !== undefined && !ts.isClassDeclaration(declaration)
          ? declaration
          : undefined;
      if (
        mentionsErrorClass(node.expression) ||
        (held !== undefined && mentionsErrorClass(held))
      ) {
        unresolved.push(
          `${where(node)}: an error class held in a variable or chosen at run time (\`new ${node.expression.getText().slice(0, 40)}\`): construct each class by name`,
        );
      }
      continue;
    }
    const cls = declaration.name?.text ?? ROOT_CLASS;
    const site = where(node);
    const args = node.arguments ?? [];
    if (args.some(ts.isSpreadElement)) {
      unresolved.push(
        `${site}: cannot work out the code of this error: a spread argument`,
      );
    }
    for (const arg of args.slice(1)) {
      if (ts.isSpreadElement(arg)) {
        continue;
      }
      const problem = unreadableOptions(arg);
      if (problem !== undefined) {
        unresolved.push(problem);
      }
    }
    const options = optionsOfArgs(args.slice(1));
    const classDefault = defaultOf(declaration);
    unresolved.push(...classDefault.unresolved);
    const resolved = empty();
    if (options.code !== undefined && classDefault.accepts) {
      for (const value of options.code) {
        merge(resolved, resolve(value));
      }
    } else {
      for (const code of classDefault.codes) {
        resolved.codes.add(code);
      }
    }
    unresolved.push(...resolved.unresolved);
    if (resolved.passthrough) {
      passthrough.push(site);
    }
    const service = options.service ?? classDefault.service ?? 'sdk';
    const wrapped = node.parent;
    const landed =
      options.landed ??
      (ts.isCallExpression(wrapped) &&
      ts.isIdentifier(wrapped.expression) &&
      wrapped.expression.text === 'withLanded'
        ? (wrapped.arguments[1]?.getText() ?? 'varies')
        : 'unset');
    for (const code of resolved.codes) {
      add(code, cls, service, landed, site);
    }
  }

  // ---- Service codes handled by name -------------------------------------------------
  const serviceCodes = new Map<string, string[]>();
  const addService = (code: string, node: ts.Node) => {
    if (!SERVICE_CODE.test(code)) {
      return;
    }
    const list = serviceCodes.get(code) ?? [];
    list.push(where(node));
    serviceCodes.set(code, list);
  };
  const isCodeRead = (e: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(e) && e.name.text === 'code') ||
    (ts.isIdentifier(e) && e.text === 'code');
  for (const node of all) {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (ts.isStringLiteral(node.right) && isCodeRead(node.left)) {
        addService(node.right.text, node);
      } else if (ts.isStringLiteral(node.left) && isCodeRead(node.right)) {
        addService(node.left.text, node);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /_CODES$/.test(node.name.text) &&
      node.initializer !== undefined
    ) {
      for (const code of listedCodes(node.initializer)) {
        addService(code.text, code);
      }
    }
  }
  // A service code the SDK raises itself is an SDK code.
  for (const code of codes.keys()) {
    serviceCodes.delete(code);
  }

  const sorted = <T>(set: Iterable<T>) => [...set].sort();
  return {
    codes: new Map(
      sorted(codes.keys()).map((code) => {
        const info = codes.get(code);
        return [
          code,
          {
            classes: sorted(info?.classes ?? []),
            services: sorted(info?.services ?? []),
            mayHaveLanded: sorted(info?.landed ?? []),
            sites: info?.sites ?? [],
          },
        ];
      }),
    ),
    serviceCodes: new Map(
      sorted(serviceCodes.keys()).map((code) => [
        code,
        serviceCodes.get(code) ?? [],
      ]),
    ),
    passthrough,
    unresolved: [...new Set(unresolved)],
  };
}

function isInside(node: ts.Node, container: ts.Node): boolean {
  return (
    node.pos >= container.pos &&
    node.end <= container.end &&
    node.getSourceFile() === container.getSourceFile()
  );
}

/** The string keys of a `*_CODES` constant: an array of strings, a Set, or a Map's keys. */
function listedCodes(initializer: ts.Expression): ts.StringLiteral[] {
  let value = initializer;
  while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) {
    value = value.expression;
  }
  const strings = (array: ts.ArrayLiteralExpression) =>
    array.elements.filter(ts.isStringLiteral);
  if (ts.isArrayLiteralExpression(value)) {
    return strings(value);
  }
  if (
    ts.isNewExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.arguments?.[0] !== undefined &&
    ts.isArrayLiteralExpression(value.arguments[0])
  ) {
    const list = value.arguments[0];
    if (value.expression.text === 'Set') {
      return strings(list);
    }
    if (value.expression.text === 'Map') {
      return list.elements.flatMap((entry) =>
        ts.isArrayLiteralExpression(entry) &&
        entry.elements[0] !== undefined &&
        ts.isStringLiteral(entry.elements[0])
          ? [entry.elements[0]]
          : [],
      );
    }
  }
  return [];
}

/**
 * The cells of a Markdown table row (`| a | b |`), trimmed, or undefined for a line that is
 * not one. A pipe escaped as `\|` stays in its cell.
 */
function tableCells(text: string): string[] | undefined {
  const line = text.trim();
  if (!line.startsWith('|')) {
    return undefined;
  }
  return line
    .slice(1)
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

const isDelimiterRow = (cells: string[] | undefined): boolean =>
  cells !== undefined &&
  cells.length > 0 &&
  cells.every((cell) => DELIMITER_CELL.test(cell));

/**
 * The entries of docs/errors.md: the rows of its code tables, the tables whose header names a
 * `Code` and a `Class` column. A row whose Code cell is one backticked code is an entry, with
 * the backticked names of its Class cell.
 */
export function parseErrorsPage(markdown: string): PageEntry[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const entries: PageEntry[] = [];
  // The columns of the code table the line is in; undefined outside one.
  let columns: { code: number; class: number } | undefined;
  const names = (text: string) =>
    [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  lines.forEach((text, index) => {
    const cells = tableCells(text);
    if (cells === undefined) {
      columns = undefined;
      return;
    }
    if (isDelimiterRow(cells)) {
      return;
    }
    if (isDelimiterRow(tableCells(lines[index + 1] ?? ''))) {
      // A header: a new table starts.
      const header = cells.map((cell) => cell.toLowerCase());
      const code = header.indexOf('code');
      const cls = header.indexOf('class');
      columns = code >= 0 && cls >= 0 ? { code, class: cls } : undefined;
      return;
    }
    if (columns === undefined) {
      return;
    }
    const code = CODE_CELL.exec(cells[columns.code] ?? '');
    if (code === null) {
      return;
    }
    entries.push({
      code: code[1] ?? '',
      line: index + 1,
      classes: names(cells[columns.class] ?? ''),
    });
  });
  return entries;
}

/**
 * The problems of the page. `mentioned(code)` says whether the source names `code` (in a
 * comment, say): a documented service code may have an entry although the SDK only passes it on.
 */
export function checkErrorsPage(
  extraction: Extraction,
  entries: readonly PageEntry[],
  mentioned: (code: string) => boolean,
  page = 'docs/errors.md',
): string[] {
  const problems: string[] = [];
  const first = new Map<string, PageEntry>();
  for (const entry of entries) {
    const earlier = first.get(entry.code);
    if (earlier !== undefined) {
      problems.push(
        `${page}:${entry.line}: \`${entry.code}\` is listed twice (lines ${earlier.line} and ${entry.line})`,
      );
      continue;
    }
    first.set(entry.code, entry);
  }
  const required = [
    ...[...extraction.codes].map(([code, info]) => ({
      code,
      where: info.sites[0] ?? '',
    })),
    ...[...extraction.serviceCodes].map(([code, sites]) => ({
      code,
      where: sites[0] ?? '',
    })),
  ].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const { code, where } of required) {
    if (!first.has(code)) {
      problems.push(
        `${page}: \`${code}\` has no entry (it is in packages/client/src, first at ${where})`,
      );
    }
  }
  for (const entry of first.values()) {
    const at = `${page}:${entry.line}`;
    const info = extraction.codes.get(entry.code);
    if (info !== undefined) {
      const listed = [...new Set(entry.classes)].sort();
      if (listed.join(',') !== info.classes.join(',')) {
        problems.push(
          `${at}: \`${entry.code}\` lists class ${listed.join(', ') || '(none)'}, but the source raises it as ${info.classes.join(', ')}`,
        );
      }
      continue;
    }
    if (extraction.serviceCodes.has(entry.code) || mentioned(entry.code)) {
      continue;
    }
    problems.push(
      `${at}: \`${entry.code}\` is not raised or named anywhere in packages/client/src: remove the entry`,
    );
  }
  return problems;
}

/** The SDK's source files, by path from the repository root. */
function readSources(root: string): Record<string, string> {
  const src = join(root, 'packages', 'client', 'src');
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.ts')) {
        files[relative(root, path).split(sep).join('/')] = readFileSync(
          path,
          'utf8',
        );
      }
    }
  };
  walk(src);
  return files;
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = readSources(root);
  const extraction = extractErrorCodes(sources);
  if (process.argv.includes('--list')) {
    for (const [code, info] of extraction.codes) {
      console.log(
        `${code}\t${info.classes.join(',')}\t${info.services.join(',')}\tmayHaveLanded=${info.mayHaveLanded.join(',')}\t${info.sites.join(' ')}`,
      );
    }
    for (const [code, sites] of extraction.serviceCodes) {
      console.log(`${code}\t(service code)\t\t\t${sites.join(' ')}`);
    }
    console.log(`passthrough: ${extraction.passthrough.join(' ')}`);
  }
  const text = Object.values(sources).join('\n');
  const mentioned = (code: string) =>
    text.includes(`\`${code}\``) ||
    text.includes(`'${code}'`) ||
    text.includes(`"${code}"`);
  const page = readFileSync(join(root, 'docs', 'errors.md'), 'utf8');
  const entries = parseErrorsPage(page);
  const problems = [
    ...extraction.unresolved,
    ...checkErrorsPage(extraction, entries, mentioned),
  ];
  for (const problem of problems) {
    console.error(problem);
  }
  const summary = `error-codes: ${extraction.codes.size} codes the SDK raises and ${extraction.serviceCodes.size} service codes it handles by name in packages/client/src; docs/errors.md has ${entries.length} entries`;
  if (problems.length > 0) {
    console.error(`${summary}: ${problems.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`${summary}: OK`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

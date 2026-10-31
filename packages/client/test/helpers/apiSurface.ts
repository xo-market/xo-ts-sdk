import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The public API as the TypeScript compiler sees it: the names each entry
// exports, split into values and types, and the declaration closure of those exports, so a
// type that a public signature names but the entry does not export is caught without a build.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SRC = join(ROOT, 'src');

export const ENTRIES = {
  main: join(SRC, 'index.ts'),
  node: join(SRC, 'node.ts'),
  signing: join(SRC, 'signing/index.ts'),
  viem: join(SRC, 'viem.ts'),
} as const;

let cached: { program: ts.Program; checker: ts.TypeChecker } | undefined;

/** One program over the entries, with the package's compiler options. */
export function compile(): { program: ts.Program; checker: ts.TypeChecker } {
  if (cached === undefined) {
    const configPath = join(ROOT, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const program = ts.createProgram(Object.values(ENTRIES), {
      ...parsed.options,
      noEmit: true,
    });
    cached = { program, checker: program.getTypeChecker() };
  }
  return cached;
}

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;

/** Whether an export specifier (or its declaration) is `type`-only. */
function isTypeOnlyExport(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (d) =>
      ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly),
  );
}

const VALUE = ts.SymbolFlags.Value;
const NAMED_TYPE =
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeAlias |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum;

/** The exports of an entry, sorted: runtime values, and names that exist as types only. */
export function exportsOf(entry: string): {
  values: string[];
  types: string[];
  symbols: Map<string, ts.Symbol>;
} {
  const { program, checker } = compile();
  const file = program.getSourceFile(entry);
  const moduleSymbol =
    file === undefined ? undefined : checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) {
    throw new Error(`no module for ${entry}`);
  }
  const values: string[] = [];
  const types: string[] = [];
  const symbols = new Map<string, ts.Symbol>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = resolveAlias(checker, exported);
    symbols.set(exported.name, target);
    if (target.flags & VALUE && !isTypeOnlyExport(exported)) {
      values.push(exported.name);
    } else {
      types.push(exported.name);
    }
  }
  return { values: values.sort(), types: types.sort(), symbols };
}

function isInternal(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'internal');
}

function isPrivateMember(node: ts.Node): boolean {
  if (
    (ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name !== undefined &&
    ts.isPrivateIdentifier(node.name)
  ) {
    return true;
  }
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : [];
  return (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
}

/** An implementation signature that overloads hide: it is not in the declaration file. */
function isHiddenImplementation(node: ts.Node): boolean {
  if (
    !(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) ||
    node.body === undefined ||
    node.name === undefined
  ) {
    return false;
  }
  const name = node.name.getText();
  const siblings = ts.isClassLike(node.parent)
    ? node.parent.members
    : ts.isSourceFile(node.parent)
      ? node.parent.statements
      : [];
  return siblings.some(
    (s) =>
      s !== node &&
      (ts.isMethodDeclaration(s) || ts.isFunctionDeclaration(s)) &&
      s.name?.getText() === name &&
      s.body === undefined,
  );
}

/**
 * The named types (interfaces, type aliases, classes, enums) declared in `src` that the
 * declarations of `symbols` name in what a declaration file keeps of them: signatures,
 * members, heritage, type annotations. Bodies, initializers, private and `@internal` members
 * and hidden implementation signatures are skipped, as the d.ts drops them. Values seen only
 * through `typeof` (such as the tuples behind an enum alias) are not types and are skipped.
 * Followed transitively: the closure.
 */
export function declarationClosure(roots: Iterable<ts.Symbol>): Set<ts.Symbol> {
  const { checker } = compile();
  const seen = new Set<ts.Symbol>();
  const queue = [...roots];

  const visitNode = (node: ts.Node, found: (s: ts.Symbol) => void): void => {
    if (
      isInternal(node) ||
      isPrivateMember(node) ||
      isHiddenImplementation(node)
    ) {
      return;
    }
    if (ts.isFunctionLike(node) && 'body' in node && node.body !== undefined) {
      // Keep the signature, not the body.
      for (const part of [
        ...(node.typeParameters ?? []),
        ...node.parameters,
        ...(node.type === undefined ? [] : [node.type]),
      ]) {
        visitNode(part, found);
      }
      return;
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isParameter(node)) &&
      node.type !== undefined
    ) {
      // An annotated binding: the d.ts keeps the annotation, not the initializer.
      visitNode(node.name, found);
      visitNode(node.type, found);
      return;
    }
    if (
      ts.isTypeReferenceNode(node) ||
      ts.isExpressionWithTypeArguments(node)
    ) {
      const name = ts.isTypeReferenceNode(node)
        ? node.typeName
        : node.expression;
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol !== undefined) {
        found(resolveAlias(checker, symbol));
      }
    }
    ts.forEachChild(node, (child) => visitNode(child, found));
  };

  while (queue.length > 0) {
    const symbol = queue.pop() as ts.Symbol;
    for (const declaration of symbol.declarations ?? []) {
      if (!declaration.getSourceFile().fileName.startsWith(SRC)) {
        continue;
      }
      visitNode(declaration, (found) => {
        const inSrc = (found.declarations ?? []).some((d) =>
          d.getSourceFile().fileName.startsWith(SRC),
        );
        if (inSrc && found.flags & NAMED_TYPE && !seen.has(found)) {
          seen.add(found);
          queue.push(found);
        }
      });
    }
  }
  return seen;
}

/** The named types an entry's public signatures reach but the entry does not export. */
export function missingFromClosure(entry: string): string[] {
  const { symbols } = exportsOf(entry);
  const exported = new Set(symbols.values());
  return [...declarationClosure(exported)]
    .filter((symbol) => !exported.has(symbol))
    .map((symbol) => {
      const file = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
      return `${symbol.name} (${file.slice(SRC.length + 1)})`;
    })
    .sort();
}

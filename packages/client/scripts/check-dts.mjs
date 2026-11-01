// After `build`: every name the published declarations reach from an entry's exports must be
// exported by that entry. It reads the built `dist/**/*.d.ts` and `*.d.cts`,
// chunks included, so types the compiler inferred (which the source-level closure test in
// `test/exports.test.ts` cannot see) are checked too. `pnpm check:package` runs it.
//
// The one exception is ALLOWED_VALUES: the readonly tuples behind the closed unions (such as
// `OrderRejectionCode = (typeof ORDER_REJECTION_CODES)[number]`). They are values, every alias
// over them is exported, and exporting them would add runtime names nobody needs. A member of
// an enum (`OrderSide.BUY` as a type) is reached through its enum, which is what must be
// exported.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Values a published type may reach through `typeof` without being exported, by name. */
export const ALLOWED_VALUES = new Set([
  'ACTIVITY_TYPES',
  'ORDER_REJECTION_CODES',
]);

const NAMED_TYPE =
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeAlias |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Enum;

/** A bundler renames a clashing declaration `X$1`: the allowlist names the source name. */
const sourceName = (name) => name.replace(/\$\d+$/, '');

/**
 * Scans the declaration files `entries` (absolute paths). Every symbol their exports reach,
 * transitively through type references, heritage clauses and `typeof` queries, that is
 * declared under `distDir` and is not exported by that entry is a problem, unless it is a
 * value named in ALLOWED_VALUES.
 *
 * @param {string[]} entries
 * @param {string} distDir
 * @returns {{ problems: string[], allowedSeen: Set<string> }}
 */
export function scanDeclarations(entries, distDir) {
  const program = ts.createProgram(entries, {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const inDist = (symbol) =>
    (symbol.declarations ?? []).some((d) =>
      d.getSourceFile().fileName.startsWith(distDir),
    );
  const problems = [];
  const allowedSeen = new Set();

  for (const entry of entries) {
    const file = program.getSourceFile(entry);
    const moduleSymbol = file && checker.getSymbolAtLocation(file);
    if (moduleSymbol === undefined) {
      problems.push(`${entry}: not a module`);
      continue;
    }
    // Without an `export { ... }` list, every top-level declaration of a .d.ts is exported, and
    // nothing could be found missing: the bundler always writes one.
    if (!file.statements.some((s) => ts.isExportDeclaration(s))) {
      problems.push(
        `${entry}: no export list, so every declaration in it is public`,
      );
      continue;
    }
    const exported = new Set(
      checker.getExportsOfModule(moduleSymbol).map(resolveAlias),
    );
    const seen = new Set(exported);
    const queue = [...exported];

    const found = (symbol) => {
      if (symbol === undefined) {
        return;
      }
      const target = resolveAlias(symbol);
      // A generic's own parameter (`T` in `Page<T>`) is not a declaration to export.
      if (
        target.flags & ts.SymbolFlags.TypeParameter ||
        seen.has(target) ||
        !inDist(target)
      ) {
        return;
      }
      seen.add(target);
      queue.push(target);
      if (exported.has(target)) {
        return;
      }
      const at = target.declarations?.[0]?.getSourceFile().fileName ?? '';
      const where = `${entry.slice(distDir.length + 1)}: ${target.name} (${at.slice(distDir.length + 1)})`;
      if (target.flags & NAMED_TYPE) {
        problems.push(`${where}: a type that is reachable but not exported`);
      } else if (ALLOWED_VALUES.has(sourceName(target.name))) {
        allowedSeen.add(sourceName(target.name));
      } else {
        problems.push(`${where}: a value that is reachable but not exported`);
      }
    };

    const visit = (node) => {
      if (ts.isTypeReferenceNode(node)) {
        const symbol = checker.getSymbolAtLocation(node.typeName);
        const isEnumMember =
          symbol !== undefined &&
          resolveAlias(symbol).flags & ts.SymbolFlags.EnumMember;
        // `OrderSide.BUY`: the enum is the declaration, not its member.
        found(
          isEnumMember && ts.isQualifiedName(node.typeName)
            ? checker.getSymbolAtLocation(node.typeName.left)
            : symbol,
        );
      } else if (ts.isExpressionWithTypeArguments(node)) {
        found(checker.getSymbolAtLocation(node.expression));
      } else if (ts.isTypeQueryNode(node)) {
        let name = node.exprName;
        while (ts.isQualifiedName(name)) {
          name = name.left;
        }
        found(checker.getSymbolAtLocation(name));
      }
      ts.forEachChild(node, visit);
    };

    while (queue.length > 0) {
      const symbol = queue.pop();
      for (const declaration of symbol.declarations ?? []) {
        if (declaration.getSourceFile().fileName.startsWith(distDir)) {
          visit(declaration);
        }
      }
    }
  }
  return { problems, allowedSeen };
}

/** The published entries of this package: ESM and CommonJS declarations. */
export function packageEntries(distDir) {
  return [
    'index.d.ts',
    'index.d.cts',
    'node.d.ts',
    'node.d.cts',
    'signing/index.d.ts',
    'signing/index.d.cts',
    'viem.d.ts',
    'viem.d.cts',
  ].map((name) => join(distDir, name));
}

const main = resolve(fileURLToPath(import.meta.url));
if (process.argv[1] !== undefined && resolve(process.argv[1]) === main) {
  const distDir = resolve(dirname(main), '../dist');
  const entries = packageEntries(distDir);
  const missing = entries.filter((entry) => !existsSync(entry));
  if (missing.length > 0) {
    console.error(
      `check-dts: run the build first; missing ${missing.join(', ')}`,
    );
    process.exit(1);
  }
  const { problems, allowedSeen } = scanDeclarations(entries, distDir);
  const stale = [...ALLOWED_VALUES].filter((name) => !allowedSeen.has(name));
  for (const name of stale) {
    problems.push(
      `ALLOWED_VALUES names ${name}, which no declaration reaches any more: drop it`,
    );
  }
  if (problems.length > 0) {
    console.error(`check-dts: ${problems.length} problem(s)`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    `check-dts: ${entries.length} entries, every reachable declaration exported (${allowedSeen.size} allowed value tuples)`,
  );
}

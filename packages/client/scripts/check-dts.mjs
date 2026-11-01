// After `build`, two checks of the published declarations, `dist/**/*.d.ts` and `*.d.cts`:
//
// - Each entry declares exactly the names pinned in `test/exports.lists.ts`, values as values.
//   The source-level test of those lists cannot see what the declaration build drops (a name
//   the JavaScript exports but TypeScript users could not import).
// - Every name the declarations reach from an entry's exports is exported by that entry,
//   chunks included, so types the compiler inferred (which the source-level closure test in
//   `test/exports.test.ts` cannot see) are checked too.
//
// `pnpm check:package` runs it.
//
// The one exception is ALLOWED_VALUES: the readonly tuples behind the closed unions (such as
// `OrderRejectionCode = (typeof ORDER_REJECTION_CODES)[number]`). They are values, every alias
// over them is exported, and exporting them would add runtime names nobody needs. A member of
// an enum (`OrderSide.BUY` as a type) is reached through its enum, which is what must be
// exported.

import { existsSync, readFileSync } from 'node:fs';
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

/**
 * The names a declaration file exports, sorted: runtime values, and names that exist as types
 * only (an interface, an alias, or anything exported with `export type`).
 *
 * @param {string} entry
 * @returns {{ values: string[], types: string[] }}
 */
export function declaredExports(entry) {
  const program = ts.createProgram([entry], {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  const moduleSymbol = file && checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) {
    throw new Error(`${entry}: not a module`);
  }
  const values = [];
  const types = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const typeOnly = (exported.declarations ?? []).some(
      (d) =>
        ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly),
    );
    if (target.flags & ts.SymbolFlags.Value && !typeOnly) {
      values.push(exported.name);
    } else {
      types.push(exported.name);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

/** The four entries, as the pinned lists name them (`MAIN_VALUES`, `NODE_TYPES`, ...). */
const PINNED_ENTRIES = ['main', 'node', 'signing', 'viem'];

/**
 * The pinned public API of each entry, read from `test/exports.lists.ts` without running it:
 * the string elements of each `<ENTRY>_VALUES` and `<ENTRY>_TYPES` array.
 *
 * @param {string} listsFile
 * @returns {Record<string, { values: string[], types: string[] }>}
 */
export function readPinnedLists(listsFile) {
  const source = ts.createSourceFile(
    listsFile,
    readFileSync(listsFile, 'utf8'),
    ts.ScriptTarget.ES2022,
  );
  const arrays = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      let init = declaration.initializer;
      while (init !== undefined && ts.isAsExpression(init)) {
        init = init.expression;
      }
      if (
        !ts.isIdentifier(declaration.name) ||
        init === undefined ||
        !ts.isArrayLiteralExpression(init)
      ) {
        continue;
      }
      const name = declaration.name.text;
      arrays.set(
        name,
        init.elements.map((element) => {
          if (!ts.isStringLiteral(element)) {
            throw new Error(
              `${listsFile}: ${name} holds something other than a string`,
            );
          }
          return element.text;
        }),
      );
    }
  }
  const lists = {};
  for (const entry of PINNED_ENTRIES) {
    const pick = (kind) => {
      const name = `${entry.toUpperCase()}_${kind}`;
      const list = arrays.get(name);
      if (list === undefined) {
        throw new Error(`${listsFile}: no ${name} array`);
      }
      return list;
    };
    lists[entry] = { values: pick('VALUES'), types: pick('TYPES') };
  }
  return lists;
}

/**
 * Which pinned entry a published declaration file belongs to, from its path under `dist`.
 *
 * @param {string} file
 * @returns {string}
 */
export function pinnedEntryOf(file) {
  const stem = file
    .replaceAll('\\', '/')
    .replace(/\.d\.c?ts$/, '')
    .replace(/\/index$/, '');
  return stem === 'index' ? 'main' : stem;
}

/**
 * What differs between the names a declaration file exports and its entry's pinned lists. A
 * pinned name the declarations lack is one the build dropped: the JavaScript exports it, but
 * TypeScript users cannot import it.
 *
 * @param {string} file
 * @param {{ values: string[], types: string[] }} declared
 * @param {{ values: readonly string[], types: readonly string[] }} pinned
 * @returns {string[]}
 */
export function comparePinned(file, declared, pinned) {
  const problems = [];
  const declaredAll = new Set([...declared.values, ...declared.types]);
  const pinnedAll = new Set([...pinned.values, ...pinned.types]);
  for (const name of [...pinned.values, ...pinned.types].sort()) {
    if (!declaredAll.has(name)) {
      problems.push(`${file}: ${name} is pinned but not declared`);
    } else if (
      pinned.values.includes(name) &&
      !declared.values.includes(name)
    ) {
      problems.push(
        `${file}: ${name} is a pinned value but the declarations have it as a type only`,
      );
    } else if (pinned.types.includes(name) && !declared.types.includes(name)) {
      problems.push(
        `${file}: ${name} is a pinned type but the declarations have it as a runtime value`,
      );
    }
  }
  for (const name of [...declaredAll].sort()) {
    if (!pinnedAll.has(name)) {
      problems.push(`${file}: ${name} is declared but not in the pinned lists`);
    }
  }
  return problems;
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
  const pinned = readPinnedLists(
    resolve(dirname(main), '../test/exports.lists.ts'),
  );
  for (const entry of entries) {
    const file = entry.slice(distDir.length + 1);
    problems.push(
      ...comparePinned(
        file,
        declaredExports(entry),
        pinned[pinnedEntryOf(file)],
      ),
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
    `check-dts: ${entries.length} entries declare exactly their pinned names, and every reachable declaration is exported (${allowedSeen.size} allowed value tuples)`,
  );
}

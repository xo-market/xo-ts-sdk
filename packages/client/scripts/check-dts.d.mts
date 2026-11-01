/** Values a published type may reach through `typeof` without being exported, by name. */
export declare const ALLOWED_VALUES: ReadonlySet<string>;
/** Scans declaration files for reachable names their entry does not export. */
export declare function scanDeclarations(
  entries: string[],
  distDir: string,
): { problems: string[]; allowedSeen: Set<string> };
/** The names a declaration file exports, sorted: runtime values and type-only names. */
export declare function declaredExports(entry: string): {
  values: string[];
  types: string[];
};
/** The pinned values and types of each entry, read from `test/exports.lists.ts`. */
export declare function readPinnedLists(
  listsFile: string,
): Record<string, { values: string[]; types: string[] }>;
/** Which pinned entry (`main`, `node`, `signing`, `viem`) a declaration file belongs to. */
export declare function pinnedEntryOf(file: string): string;
/** What differs between the names a declaration file exports and its pinned lists. */
export declare function comparePinned(
  file: string,
  declared: { values: string[]; types: string[] },
  pinned: { values: readonly string[]; types: readonly string[] },
): string[];
/** The published entries of this package: ESM and CommonJS declarations. */
export declare function packageEntries(distDir: string): string[];

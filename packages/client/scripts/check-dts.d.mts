/** Values a published type may reach through `typeof` without being exported, by name. */
export declare const ALLOWED_VALUES: ReadonlySet<string>;
/** Scans declaration files for reachable names their entry does not export. */
export declare function scanDeclarations(
  entries: string[],
  distDir: string,
): { problems: string[]; allowedSeen: Set<string> };
/** The published entries of this package: ESM and CommonJS declarations. */
export declare function packageEntries(distDir: string): string[];

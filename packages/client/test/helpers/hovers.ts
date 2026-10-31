import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// What an editor shows on a member of a client: the TypeScript language service's quick info
// for `<receiver>.<member>`, which is what a hover reads. The docs tests of the clients check
// it member by member.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');
const VIRTUAL = join(SRC, '__hover.ts');

/** The quick info of one member. */
export interface Hover {
  signature: string;
  summary: string;
  tags: Array<{ name: string; text: string }>;
  /** The member's parameters as the checker sees them, to match them with the @param tags. */
  parameters: string[];
}

function languageService(
  files: readonly string[],
  source: string,
): ts.LanguageService {
  const config = ts.readConfigFile(
    join(ROOT, 'tsconfig.json'),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const names = [...files.map((file) => join(SRC, file)), VIRTUAL];
  return ts.createLanguageService({
    getScriptFileNames: () => names,
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      if (file === VIRTUAL) {
        return ts.ScriptSnapshot.fromString(source);
      }
      const text = ts.sys.readFile(file);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => ({ ...parsed.options, noEmit: true }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => file === VIRTUAL || ts.sys.fileExists(file),
    readFile: (file) => (file === VIRTUAL ? source : ts.sys.readFile(file)),
    readDirectory: ts.sys.readDirectory,
  });
}

/**
 * The hovers of `members` of `receiver` in a probe file: `prelude` (imports and the
 * declaration of `receiver`, as written in `src/`), then one `<receiver>.<member>;` line per
 * member.
 *
 * @param files - The source files the probe imports, relative to `src/`.
 */
export function hoversOf(o: {
  files: readonly string[];
  prelude: readonly string[];
  receiver: string;
  members: readonly string[];
}): Map<string, Hover> {
  const { receiver, members } = o;
  const source = [
    ...o.prelude,
    ...members.map((member) => `${receiver}.${member};`),
    '',
  ].join('\n');
  const service = languageService(o.files, source);
  const program = service.getProgram();
  const file = program?.getSourceFile(VIRTUAL);
  if (program === undefined || file === undefined) {
    throw new Error('the probe file did not compile');
  }
  const checker = program.getTypeChecker();
  const hovers = new Map<string, Hover>();
  for (const member of members) {
    const at = source.indexOf(`${receiver}.${member};`);
    const position = at + receiver.length + 2;
    const info = service.getQuickInfoAtPosition(VIRTUAL, position);
    if (info === undefined) {
      continue;
    }
    let parameters: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === member &&
        node.getStart() === at
      ) {
        const [signature] = checker.getTypeAtLocation(node).getCallSignatures();
        parameters = signature?.parameters.map((p) => p.name) ?? [];
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    hovers.set(member, {
      signature: ts.displayPartsToString(info.displayParts),
      summary: ts.displayPartsToString(info.documentation),
      tags: (info.tags ?? []).map((tag) => ({
        name: tag.name,
        text: ts.displayPartsToString(tag.text),
      })),
      parameters,
    });
  }
  return hovers;
}

/** `name` with its first letter in upper case: the error union of a member is `<Name>Error`. */
export const capitalized = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { dedent, findBlocks, parseRegions } from '../docs-snippets.js';

// docs/quickstart.md: each step names the example to run (Run `npx tsx <file>.ts`) and shows
// code quoted from docs/snippets/. That code must also be in the example, line for line (the
// indent aside), so the page shows what the user runs. Change both together.

const ROOT = new URL('../../', import.meta.url);
const PAGE = 'docs/quickstart.md';
const EXAMPLES = 'examples/scripts/src/';
const RUN = /Run `npx tsx ([a-z0-9-]+\.ts)`/;

const read = (path: string): string =>
  readFileSync(new URL(path, ROOT), 'utf8').replaceAll('\r\n', '\n');

interface Quote {
  /** The step's heading, such as `2. List markets`. */
  step: string;
  /** The script the step runs, or `null` when it names none. */
  example: string | null;
  /** The quoted region, as `docs/snippets/<file>.ts#<region>`. */
  source: string;
  path: string;
  region: string;
}

/** Every code block of the page that quotes a region, with the script its step runs. */
function quotes(markdown: string): Quote[] {
  const lines = markdown.split('\n');
  const found: Quote[] = [];
  for (const block of findBlocks(markdown)) {
    const marker = block.marker;
    if (marker?.kind !== 'region') {
      continue;
    }
    let start = block.line - 1;
    while (start > 0 && !(lines[start] ?? '').startsWith('## ')) {
      start -= 1;
    }
    let end = start + 1;
    while (end < lines.length && !(lines[end] ?? '').startsWith('## ')) {
      end += 1;
    }
    const step = (lines[start] ?? '').replace(/^#+ /, '');
    const run = RUN.exec(lines.slice(start, end).join('\n'));
    found.push({
      step,
      example: run?.[1] ?? null,
      source: `${marker.path}#${marker.region}`,
      path: marker.path,
      region: marker.region,
    });
  }
  return found;
}

/** Whether `code` is a run of whole lines of `script`, ignoring the indent common to each. */
function appearsIn(script: string, code: string): boolean {
  const lines = script.split('\n');
  const count = code.split('\n').length;
  for (let i = 0; i + count <= lines.length; i += 1) {
    if (dedent(lines.slice(i, i + count).join('\n')) === code) {
      return true;
    }
  }
  return false;
}

const found = quotes(read(PAGE));

describe(`${PAGE}: the code of each step is in the example it runs`, () => {
  test('the page quotes code in its steps', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  test.each(found)(
    '$step: $source is in the example',
    ({ step, example, source, path, region }) => {
      expect(
        example,
        `${PAGE}, "${step}" quotes ${source} but names no script to run (Run \`npx tsx <file>.ts\`)`,
      ).not.toBeNull();
      const text = parseRegions(read(path), path).get(region);
      expect(text, `no region "${region}" in ${path}`).toBeDefined();
      const code = dedent(text ?? '');
      const script = `${EXAMPLES}${example}`;
      expect(
        appearsIn(read(script), code),
        `${PAGE}, "${step}" shows ${source}, but ${script} (the script it runs) does not hold that code. Make them the same again. The code:\n\n${code}\n`,
      ).toBe(true);
    },
  );
});

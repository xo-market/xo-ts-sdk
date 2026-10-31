import { describe, expect, test } from 'vitest';
import { createPublicClient } from '../../src/clients/public';
import { capitalized, hoversOf } from '../helpers/hovers';
import { testEnv } from '../helpers/testEnv';

// What an editor shows on a member of a public client: the TypeScript language service's
// quick info for `client.<member>`, which is what a hover reads. Every member must carry its
// whole public documentation there: the summary, a `@param` per parameter, the `@throws` of
// its error union and an `@example`.

const MEMBERS = Object.keys(
  createPublicClient({ environment: testEnv }),
).sort();

describe('what an editor shows on a member of a public client', () => {
  const hovers = hoversOf({
    files: ['clients/public.ts'],
    prelude: [
      "import { createPublicClient } from './clients/public';",
      'const client = createPublicClient();',
    ],
    receiver: 'client',
    members: MEMBERS,
  });

  test('every member has a hover', () => {
    expect([...hovers.keys()].sort()).toEqual(MEMBERS);
  });

  test.each(MEMBERS)('%s: the signature and a summary', (member) => {
    const hover = hovers.get(member);
    // A generic member shows its type parameters first: `subscribe<const S ...>(`.
    expect(hover?.signature).toMatch(
      new RegExp(`^\\(method\\) PublicClient\\.${member}[(<]`),
    );
    expect(hover?.summary.length).toBeGreaterThan(40);
    // The documentation that points elsewhere is not the documentation.
    expect(hover?.summary).not.toMatch(/documentation is on/i);
  });

  test.each(MEMBERS)('%s: a @param for each parameter, in order', (member) => {
    const hover = hovers.get(member);
    const described = hover?.tags
      .filter((tag) => tag.name === 'param')
      .map((tag) => tag.text.split(' ')[0]);
    expect(described).toEqual(hover?.parameters);
  });

  test.each(MEMBERS)('%s: a @throws that names its error union', (member) => {
    const throws = hovers.get(member)?.tags.filter((t) => t.name === 'throws');
    expect(throws).toHaveLength(1);
    expect(throws?.[0]?.text.startsWith(`{${capitalized(member)}Error}`)).toBe(
      true,
    );
  });

  test.each(MEMBERS)(
    '%s: an @example that calls it, without imports',
    (member) => {
      const examples = hovers
        .get(member)
        ?.tags.filter((t) => t.name === 'example');
      expect(examples).toHaveLength(1);
      expect(examples?.[0]?.text).toContain(`client.${member}(`);
      expect(examples?.[0]?.text).not.toMatch(/^\s*import /m);
    },
  );
});

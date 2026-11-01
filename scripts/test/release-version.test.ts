import { describe, expect, test } from 'vitest';
import {
  changelogSection,
  parseStatus,
  pendingChangesets,
  preflightProblems,
  pullRequestBody,
  pullRequestTitle,
  releaseBranch,
  unexpectedChanges,
} from '../release-version.js';

// `pnpm release:version` (scripts/release-version.ts): the Version Packages step, run by a
// maintainer because the organization lets GitHub Actions open no pull request. These tests
// cover its decisions; the git and gh calls around them are thin.

describe('pendingChangesets', () => {
  test('the .md files of .changeset/, without its README, sorted', () => {
    expect(
      pendingChangesets([
        'config.json',
        'README.md',
        'zesty-otters-sing.md',
        'initial-release.md',
      ]),
    ).toEqual(['initial-release.md', 'zesty-otters-sing.md']);
  });

  test('none pending', () => {
    expect(pendingChangesets(['config.json', 'README.md'])).toEqual([]);
  });
});

describe('releaseBranch', () => {
  test.each([
    ['0.1.0', 'release/0.1.0'],
    ['1.12.3', 'release/1.12.3'],
    ['0.2.0-next.1', 'release/0.2.0-next.1'],
  ])('%s → %s', (version, branch) => {
    expect(releaseBranch(version)).toBe(branch);
  });

  test.each(['', '0.1', 'v0.1.0', '0.1.0 ', '0.1.0;rm -rf', '../0.1.0'])(
    'refuses %j',
    (version) => {
      expect(() => releaseBranch(version)).toThrow(/not a version/);
    },
  );
});

describe('unexpectedChanges', () => {
  test('what changeset version writes is expected', () => {
    expect(
      unexpectedChanges([
        '.changeset/initial-release.md',
        'packages/client/package.json',
        'packages/client/CHANGELOG.md',
      ]),
    ).toEqual([]);
  });

  test('anything else is reported', () => {
    expect(
      unexpectedChanges([
        'packages/client/package.json',
        '.changeset/config.json',
        'pnpm-lock.yaml',
        'packages/client/src/index.ts',
        'package.json',
      ]),
    ).toEqual([
      '.changeset/config.json',
      'pnpm-lock.yaml',
      'packages/client/src/index.ts',
      'package.json',
    ]);
  });
});

describe('parseStatus', () => {
  test('status and path of each line of git status --porcelain', () => {
    expect(
      parseStatus(
        ' D .changeset/initial-release.md\n M packages/client/package.json\n?? packages/client/CHANGELOG.md\n',
      ),
    ).toEqual([
      { status: ' D', path: '.changeset/initial-release.md' },
      { status: ' M', path: 'packages/client/package.json' },
      { status: '??', path: 'packages/client/CHANGELOG.md' },
    ]);
  });

  test('empty output, no entries', () => {
    expect(parseStatus('')).toEqual([]);
  });
});

describe('changelogSection', () => {
  const changelog = [
    '# @xomarket/client',
    '',
    '## 0.2.0',
    '',
    '### Minor Changes',
    '',
    '- abc1234: Deposit and withdraw.',
    '',
    '## 0.1.0',
    '',
    '- 93f2226: First release.',
    '',
  ].join('\n');

  test('the entry of the version, up to the next version', () => {
    expect(changelogSection(changelog, '0.2.0')).toBe(
      '### Minor Changes\n\n- abc1234: Deposit and withdraw.',
    );
  });

  test('the last entry runs to the end', () => {
    expect(changelogSection(changelog, '0.1.0')).toBe(
      '- 93f2226: First release.',
    );
  });

  test('no entry: empty', () => {
    expect(changelogSection(changelog, '9.9.9')).toBe('');
  });
});

describe('the pull request', () => {
  test('title', () => {
    expect(pullRequestTitle('@xomarket/client', '0.2.0')).toBe(
      'chore(release): @xomarket/client 0.2.0',
    );
  });

  test('body: the version, that merging publishes nothing, and the changelog', () => {
    const body = pullRequestBody(
      '@xomarket/client',
      '0.2.0',
      '- abc1234: Deposit and withdraw.',
    );
    expect(body).toContain('**0.2.0**');
    expect(body).toContain('Merging this publishes nothing.');
    expect(body).toContain('- abc1234: Deposit and withdraw.');
  });

  test('body without a changelog entry says so', () => {
    expect(pullRequestBody('@xomarket/client', '0.2.0', '')).toContain(
      '_No entry found for this version._',
    );
  });
});

describe('preflightProblems', () => {
  const ok = {
    branch: 'main',
    status: '',
    head: 'abc',
    originMain: 'abc',
    pending: ['zesty-otters-sing.md'],
    ghLoggedIn: true,
  };

  test('all is well: no problem', () => {
    expect(preflightProblems(ok)).toEqual([]);
  });

  test('every problem is reported at once', () => {
    const problems = preflightProblems({
      branch: 'feat/x',
      status: ' M README.md',
      head: 'abc',
      originMain: 'def',
      pending: [],
      ghLoggedIn: false,
    });
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/switch to main/);
    expect(problems.join('\n')).toMatch(/working tree has changes/);
    expect(problems.join('\n')).toMatch(/origin\/main/);
    expect(problems.join('\n')).toMatch(/nothing to release/);
    expect(problems.join('\n')).toMatch(/gh auth login/);
  });
});

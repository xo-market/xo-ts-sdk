import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { Signer } from '../src/viem';
import * as viem from '../src/viem';
import * as publicSigner from '../src/wallet/publicSigner';
import { clobAuthVector } from './signing/helpers';

const KEY = clobAuthVector.inputs.privateKey;

describe('@xomarket/client/viem', () => {
  test('exports privateKey and signerFrom, the same functions as the wallet module', () => {
    expect(Object.keys(viem).sort()).toEqual(['privateKey', 'signerFrom']);
    expect(viem.privateKey).toBe(publicSigner.privateKey);
    expect(viem.signerFrom).toBe(publicSigner.signerFrom);
  });

  test('a signer made by either function is a Signer', async () => {
    const fromKey: Signer = viem.privateKey(KEY);
    const fromAccount: Signer = viem.signerFrom(privateKeyToAccount(KEY));
    expectTypeOf(
      fromKey.getAddress,
    ).returns.resolves.toEqualTypeOf<`0x${string}`>();
    expect(await fromKey.getAddress()).toBe(await fromAccount.getAddress());
    expect(await fromKey.signMessage('xo')).toBe(
      await fromAccount.signMessage('xo'),
    );
  });

  test('is a package export with ESM and CommonJS declarations, built as an entry', () => {
    const root = join(import.meta.dirname, '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.exports['./viem']).toEqual({
      import: {
        types: './dist/viem.d.ts',
        default: './dist/viem.js',
      },
      require: {
        types: './dist/viem.d.cts',
        default: './dist/viem.cjs',
      },
    });
    expect(readFileSync(join(root, 'tsdown.config.ts'), 'utf8')).toContain(
      "'src/viem.ts'",
    );
  });
});

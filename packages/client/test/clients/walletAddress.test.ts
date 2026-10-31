import { type Address, getAddress, type Hex, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { resolveWalletAddress } from '../../src/clients/walletAddress';
import { UserInputError, XoError } from '../../src/core/errors';
import { kernelCreateAccountCalldata } from '../../src/signing/kernel';
import { testEnv } from '../helpers/testEnv';

// The `wallet` option of the secure client: an address, resolved to the signer's own wallet
// or to one of its smart wallets, with read-only calls to the smart wallet factory only.

const env = testEnv;
const OWNER: Address = privateKeyToAccount(`0x${'42'.repeat(32)}`).address;
const UNRELATED: Address = getAddress(
  '0x00000000000000000000000000000000000bad01',
);

/** The address the fake factory gives the owner's smart wallet at `index`. */
const smartWalletAt = (index: number): Address =>
  getAddress(`0x${(0xc0de00 + index).toString(16).padStart(40, '0')}`);

/**
 * A factory that knows the owner's smart wallets 0 to 9, each at {@link smartWalletAt}. It
 * matches the calldata the Kernel helpers build, so a call for another owner, another index
 * or another contract is an error, as a node would answer a revert.
 */
function factory() {
  const calldata = new Map<string, number>();
  for (let index = 0; index < 10; index += 1) {
    calldata.set(
      kernelCreateAccountCalldata(
        OWNER,
        BigInt(index),
        env.contracts.ecdsaValidator,
      ),
      index,
    );
  }
  const indexes: number[] = [];
  const read = vi.fn(async ({ to, data }: { to: Address; data: Hex }) => {
    const index = calldata.get(data.toLowerCase());
    if (
      to.toLowerCase() !== env.contracts.kernelFactory.toLowerCase() ||
      index === undefined
    ) {
      throw new Error('execution reverted');
    }
    indexes.push(index);
    return pad(smartWalletAt(index).toLowerCase() as Hex, { size: 32 });
  });
  return { read, indexes };
}

describe('resolveWalletAddress', () => {
  test('without a wallet: the plain wallet of the signer, and nothing is read', async () => {
    const { read } = factory();
    expect(await resolveWalletAddress(OWNER, undefined, env, read)).toEqual({
      type: 'eoa',
    });
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    ['lower case', OWNER.toLowerCase()],
    ['checksummed', OWNER],
    ['upper case', `0x${OWNER.slice(2).toUpperCase()}`],
  ])(
    'the signer address in %s: the plain wallet, and nothing is read',
    async (_, wallet) => {
      const { read } = factory();
      expect(await resolveWalletAddress(OWNER, wallet, env, read)).toEqual({
        type: 'eoa',
      });
      expect(read).not.toHaveBeenCalled();
    },
  );

  test('a smart wallet at index 3: smart_wallet index 3, after reading indexes 0 to 3 only', async () => {
    const { read, indexes } = factory();
    expect(
      await resolveWalletAddress(OWNER, smartWalletAt(3), env, read),
    ).toEqual({ type: 'smart_wallet', index: 3n });
    expect(indexes).toEqual([0, 1, 2, 3]);
  });

  test('a smart wallet at index 0 is found with one read', async () => {
    const { read, indexes } = factory();
    expect(
      await resolveWalletAddress(
        OWNER,
        smartWalletAt(0).toLowerCase(),
        env,
        read,
      ),
    ).toEqual({ type: 'smart_wallet', index: 0n });
    expect(indexes).toEqual([0]);
  });

  test('a smart wallet at index 9, the last one looked at', async () => {
    const { read } = factory();
    expect(
      await resolveWalletAddress(OWNER, smartWalletAt(9), env, read),
    ).toEqual({ type: 'smart_wallet', index: 9n });
  });

  test('an unrelated address: UserInputError wallet_not_owned, after indexes 0 to 9', async () => {
    const { read, indexes } = factory();
    const error = await resolveWalletAddress(OWNER, UNRELATED, env, read).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('wallet_not_owned');
    expect((error as Error).message).not.toContain(UNRELATED);
    expect((error as Error).message).not.toContain(UNRELATED.toLowerCase());
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test.each([
    ['not hex', 'my wallet'],
    ['too short', '0x1234'],
    ['empty', ''],
  ])(
    'a wallet that is not an address (%s): invalid_input, nothing read, not repeated',
    async (_, wallet) => {
      const { read } = factory();
      const error = await resolveWalletAddress(OWNER, wallet, env, read).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_input');
      if (wallet !== '') {
        expect((error as Error).message).not.toContain(wallet);
      }
      expect(read).not.toHaveBeenCalled();
    },
  );

  test('a factory read that fails: smart_wallet_address_unavailable, and the search stops', async () => {
    const read = vi.fn(async () => {
      throw new Error('rpc down at https://rpc.example/secret-key');
    });
    const error = await resolveWalletAddress(OWNER, UNRELATED, env, read).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).code).toBe('smart_wallet_address_unavailable');
    expect((error as Error).message).not.toContain('secret-key');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

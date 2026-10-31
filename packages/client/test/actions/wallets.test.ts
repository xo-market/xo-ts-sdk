import { type Address, getAddress, type Hex, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChainReader } from '../../src/account/chain';
import { FetchSmartWalletAddressError } from '../../src/actions/wallets';
import { createPublicClient } from '../../src/clients/public';
import { resolveWalletAddress } from '../../src/clients/walletAddress';
import { setClientSeams } from '../../src/core/wiring';
import { kernelCreateAccountCalldata } from '../../src/signing/kernel';
import { caught } from '../helpers/dataRig';
import { testEnv } from '../helpers/testEnv';

// fetchSmartWalletAddress: the address of an owner's smart wallet, from one read of the smart
// wallet factory, the same lookup that resolves the secure client's `wallet` option.

const env = testEnv;
const OWNER: Address = privateKeyToAccount(`0x${'42'.repeat(32)}`).address;

/** The address the fake factory gives the owner's smart wallet at `index`. */
const smartWalletAt = (index: number): Address =>
  getAddress(`0x${(0xc0de00 + index).toString(16).padStart(40, '0')}`);

/**
 * A chain whose smart wallet factory knows the owner's smart wallets 0 to 9. It matches the
 * calldata of the Kernel helpers, so a read for another owner, index or contract reverts.
 */
function factoryChain() {
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
  const readContract = vi.fn(
    async ({ to, data }: { to: Address; data: Hex }) => {
      const index = calldata.get(data.toLowerCase());
      if (
        to.toLowerCase() !== env.contracts.kernelFactory.toLowerCase() ||
        index === undefined
      ) {
        throw new Error('execution reverted');
      }
      return pad(smartWalletAt(index).toLowerCase() as Hex, { size: 32 });
    },
  );
  setClientSeams({ chain: { readContract } as unknown as ChainReader });
  return { readContract };
}

afterEach(() => {
  setClientSeams({});
});

describe('fetchSmartWalletAddress', () => {
  test.each([0, 3])(
    'index %i: the factory address, the one the secure client resolves for that index',
    async (index) => {
      const { readContract } = factoryChain();
      const client = createPublicClient({ environment: env });
      const address = await client.fetchSmartWalletAddress({
        owner: OWNER,
        index,
      });
      expect(address).toBe(smartWalletAt(index));
      expect(readContract).toHaveBeenCalledTimes(1);
      // Passed as the `wallet` option, it names that smart wallet of the owner.
      expect(
        await resolveWalletAddress(OWNER, address, env, readContract),
      ).toEqual({ type: 'smart_wallet', index: BigInt(index) });
    },
  );

  test('without an index: smart wallet 0; the owner may be written in any case', async () => {
    factoryChain();
    const client = createPublicClient({ environment: env });
    expect(
      await client.fetchSmartWalletAddress({ owner: OWNER.toLowerCase() }),
    ).toBe(smartWalletAt(0));
  });

  test.each([
    ['an owner that is not an address', { owner: '0x1234' }],
    ['no owner', { index: 0 }],
    ['a negative index', { owner: OWNER, index: -1 }],
    ['an index that is not whole', { owner: OWNER, index: 1.5 }],
    ['an index past the safe integers', { owner: OWNER, index: 2 ** 53 }],
    ['a key it does not take', { owner: OWNER, wallet: OWNER }],
  ])('%s: a UserInputError before any read', async (_, request) => {
    const { readContract } = factoryChain();
    const client = createPublicClient({ environment: env });
    const error = await caught(() =>
      client.fetchSmartWalletAddress(request as never),
    );
    expect(error).toMatchObject({
      name: 'UserInputError',
      code: 'invalid_input',
    });
    expect(FetchSmartWalletAddressError.isError(error)).toBe(true);
    expect(readContract).not.toHaveBeenCalled();
  });

  test('bad options: a UserInputError before any read', async () => {
    const { readContract } = factoryChain();
    const client = createPublicClient({ environment: env });
    const error = await caught(() =>
      client.fetchSmartWalletAddress({ owner: OWNER }, { retries: 9 }),
    );
    expect(error).toMatchObject({ code: 'invalid_request_options' });
    expect(readContract).not.toHaveBeenCalled();
  });

  test('an aborted signal: a RequestAbortedError, and nothing is read', async () => {
    const { readContract } = factoryChain();
    const client = createPublicClient({ environment: env });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const error = await caught(() =>
      client.fetchSmartWalletAddress(
        { owner: OWNER },
        { signal: controller.signal },
      ),
    );
    expect(error).toMatchObject({ name: 'RequestAbortedError' });
    expect(FetchSmartWalletAddressError.isError(error)).toBe(true);
    expect(readContract).not.toHaveBeenCalled();
  });

  test('a factory that cannot be read: smart_wallet_address_unavailable, without its cause', async () => {
    setClientSeams({
      chain: {
        readContract: async () => {
          throw new Error('rpc down at https://node.example/key');
        },
      } as unknown as ChainReader,
    });
    const client = createPublicClient({ environment: env });
    const error = await caught(() =>
      client.fetchSmartWalletAddress({ owner: OWNER, index: 3 }),
    );
    expect(error).toMatchObject({
      name: 'XoError',
      code: 'smart_wallet_address_unavailable',
      service: 'chain',
    });
    expect(String((error as Error).message)).not.toContain('node.example');
    expect(FetchSmartWalletAddressError.isError(error)).toBe(true);
  });
});

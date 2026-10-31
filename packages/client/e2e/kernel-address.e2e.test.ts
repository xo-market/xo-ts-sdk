import {
  createPublicClient as createRpcClient,
  decodeAbiParameters,
  getAddress,
} from 'viem';
import { expect, test } from 'vitest';
import { createPublicClient } from '../src/index';
import { kernelCreateAccountCalldata } from '../src/signing/kernel';
import { kernelVector } from '../test/signing/helpers';
import { describeLive, env, readOnlyRpc } from './setup';

// A live check of the Kernel vectors (test-vectors/kernel.json) against the mainnet factory,
// by hand and through the public client's `fetchSmartWalletAddress`. It never sends a
// transaction: `eth_chainId` and `eth_call`, through the read-only RPC transport and the global
// `fetch`, which the read-only guard covers. It runs only when XO_E2E=1, and it is not part of `pnpm test` (the unit config
// includes test/** only). Every expected value is read from the vector file.
const {
  factory,
  ecdsaValidator,
  owner,
  index,
  expectedCalldata,
  expectedAccount,
} = kernelVector.createAccount;

describeLive('Kernel account address (live)', () => {
  // ccipRead false: never follow an off-chain lookup that a contract asks for.
  const client = createRpcClient({
    transport: readOnlyRpc(),
    ccipRead: false,
  });

  test('the RPC serves the chain of the mainnet preset', async () => {
    await expect(client.getChainId()).resolves.toBe(env.chainId);
  });

  test('the mainnet factory returns the vector account for the vector owner', async () => {
    // The vectors name the factory and validator of the preset.
    expect(getAddress(factory)).toBe(getAddress(env.contracts.kernelFactory));
    expect(getAddress(ecdsaValidator)).toBe(
      getAddress(env.contracts.ecdsaValidator),
    );
    const calldata = kernelCreateAccountCalldata(
      owner,
      BigInt(index),
      env.contracts.ecdsaValidator,
    );
    expect(calldata).toBe(expectedCalldata);
    const { data } = await client.call({
      to: env.contracts.kernelFactory,
      data: calldata,
    });
    expect(data).toBeDefined();
    const [account] = decodeAbiParameters(
      [{ type: 'address' }],
      data as `0x${string}`,
    );
    expect(account).toBe(expectedAccount);
  });

  test('fetchSmartWalletAddress gives the vector account, at the vector index and by default', async () => {
    const xo = createPublicClient();
    await expect(
      xo.fetchSmartWalletAddress({ owner, index: Number(index) }),
    ).resolves.toBe(expectedAccount);
    if (index === '0') {
      await expect(xo.fetchSmartWalletAddress({ owner })).resolves.toBe(
        expectedAccount,
      );
    }
    // Another index is another smart wallet.
    const other = await xo.fetchSmartWalletAddress({
      owner,
      index: Number(index) + 1,
    });
    expect(other).not.toBe(expectedAccount);
    // The owner in any case reaches the same smart wallet.
    await expect(
      xo.fetchSmartWalletAddress({
        owner: owner.toLowerCase(),
        index: Number(index),
      }),
    ).resolves.toBe(expectedAccount);
  });
});

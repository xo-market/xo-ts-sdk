import type { Address } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import { normalizeAddress } from '../core/address';
import {
  makeErrorGuard,
  RequestAbortedError,
  TimeoutError,
  UserInputError,
  XoError,
} from '../core/errors';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import { lookupKernelAddress } from '../wallet/identity';
import { fields, parseInput, underCall } from './internal';

// The smart wallets of an owner: their addresses come from the smart wallet factory, on chain,
// whether or not they are deployed yet. The same lookup tells the secure client which smart
// wallet its `wallet` option names.

/** What {@link PublicClient.fetchSmartWalletAddress} takes. */
export type FetchSmartWalletAddressRequest = {
  /** The address of the key that owns the smart wallet: a signer's own address, `0x` and 40 hex digits. */
  owner: string;
  /** Which of the owner's smart wallets: a whole number from 0. Defaults to 0, the first. */
  index?: number;
};

const FetchSmartWalletAddressSchema = z.strictObject({
  owner: fields.address(),
  index: fields.whole(0, Number.MAX_SAFE_INTEGER).optional(),
});

/**
 * The error union of {@link PublicClient.fetchSmartWalletAddress}: the request and options
 * (`UserInputError`), the options' `RequestAbortedError` and `TimeoutError`, and a plain
 * {@link XoError} `smart_wallet_address_unavailable` when the factory cannot be read.
 */
export type FetchSmartWalletAddressError =
  | UserInputError
  | RequestAbortedError
  | TimeoutError
  | XoError;
/** The guard of {@link FetchSmartWalletAddressError}. */
export const FetchSmartWalletAddressError = makeErrorGuard(
  UserInputError,
  RequestAbortedError,
  TimeoutError,
  XoError,
);

/**
 * Reads the address of an owner's smart wallet from the smart wallet factory: one read of the
 * chain, no call to XO's API and no signature.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchSmartWalletAddress(
  ctx: ActionContext,
  request: FetchSmartWalletAddressRequest,
  options?: RequestOptions,
): Promise<Address> {
  const input = parseInput(
    'fetchSmartWalletAddress',
    request,
    FetchSmartWalletAddressSchema,
  );
  const call = parseRequestOptions(options);
  const owner = normalizeAddress(input.owner);
  return underCall(call, () =>
    lookupKernelAddress(owner, BigInt(input.index ?? 0), ctx.env, (read) =>
      ctx.chain.readContract(read),
    ),
  );
}

import type { TypedDataDefinition, TypedDataDomain } from 'viem';
import { UserInputError } from '../core/errors';
import { assertUint, normalizeDomain } from './internal';

/** The EIP-712 types of a signed single-order cancel: `CancelOrder(uint64 orderId,string marketId)`. */
export const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: 'orderId', type: 'uint64' },
    { name: 'marketId', type: 'string' },
  ],
} as const;

/** The EIP-712 types of a signed cancel-all: `CancelAll(string marketId)`. */
export const CANCEL_ALL_TYPES = {
  CancelAll: [{ name: 'marketId', type: 'string' }],
} as const;

function assertMarketId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserInputError(`marketId must be a string, not ${typeof value}`);
  }
  return value;
}

/**
 * The typed data to sign to cancel one order. It is signed under the same domain as
 * orders (see `orderDomain`).
 *
 * `marketId` may be `''`: the gateway does not forbid it, so it is not rejected here.
 * @throws UserInputError if `orderId` is not a bigint in `[0, 2^64)`, `marketId` is not a string, or the domain is incomplete or malformed (see `orderDomain`).
 */
export function cancelOrderTypedData(
  orderId: bigint,
  marketId: string,
  domain: TypedDataDomain,
): TypedDataDefinition<typeof CANCEL_ORDER_TYPES, 'CancelOrder'> {
  return {
    domain: normalizeDomain(domain),
    types: CANCEL_ORDER_TYPES,
    primaryType: 'CancelOrder',
    message: {
      orderId: assertUint(orderId, 64, 'orderId'),
      marketId: assertMarketId(marketId),
    },
  };
}

/**
 * The typed data to sign to cancel every open order in a market. An empty `marketId`
 * means a global cancel-all. It is signed under the same domain as orders.
 * @throws UserInputError if `marketId` is not a string or the domain is incomplete or malformed (see `orderDomain`).
 */
export function cancelAllTypedData(
  marketId: string,
  domain: TypedDataDomain,
): TypedDataDefinition<typeof CANCEL_ALL_TYPES, 'CancelAll'> {
  return {
    domain: normalizeDomain(domain),
    types: CANCEL_ALL_TYPES,
    primaryType: 'CancelAll',
    message: { marketId: assertMarketId(marketId) },
  };
}

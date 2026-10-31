import type { Hex } from 'viem';

/** The side of an order or a trade. */
export type Side = 'BUY' | 'SELL';
/** The time in force of an order: good till cancelled or till a date, fill or kill, fill and kill. */
export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

/**
 * A base-10 decimal in **whole units**: a price between 0 and 1, dollars, shares. For example
 * `"0.57"` or `"153.641122"`. Never an amount in a token's raw smallest units: one and a half
 * dollars is `"1.5"`, not `"1500000"`.
 */
export type DecimalString = string;

/**
 * An amount in a token's **raw smallest units**: for a 6-decimal USDC, `"570000"` is 0.57 and
 * `"1000000"` is one dollar. The data client types the backend indexer's amounts with it (a
 * market's `totalVolume`, an outcome's `currentPrice`, an activity's `collateralAmount` and
 * `shareAmount`, and so on), and the orderbook client its micro-unit amounts (balances,
 * positions, capacities, a placement's `makingAmount` and `takingAmount`, a trade's
 * `maker_original_size` and the like).
 *
 * It is a string at runtime. The brand only exists so that a raw amount is not passed where
 * a whole-unit {@link DecimalString} is expected: the order builders' `price`, `size` and
 * `amount`, `transferUsdc` and `merge` refuse it at compile time. For a 6-decimal token,
 * viem's `formatUnits(BigInt(raw), 6)` turns it into whole units.
 */
export type RawUnitsString = string & { readonly __brand: 'RawUnitsString' };

/** A CTF condition id: `0x` and 64 hex digits, the orderbook's market id. */
export type ConditionId = Hex & { readonly __brand: 'ConditionId' };
/** Decimal-string U256 outcome token id. */
export type TokenId = string & { readonly __brand: 'TokenId' };
/** The EIP-712 hash of a signed order: `0x` and 64 hex digits. */
export type OrderHash = Hex & { readonly __brand: 'OrderHash' };

/** Where an error came from: a service, the chain, or the SDK itself (`'sdk'`). */
export type Service = 'backend' | 'orderbook' | 'sponsor' | 'chain' | 'sdk';

import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import type { Side } from '../../src/core/types';
import {
  deriveAmounts,
  gatewayTick,
  MIN_NOTIONAL_MICRO,
  MIN_SIZE_MICRO,
  notionalBelowMinimum,
  TICK_DENOM,
  validateOrderSize,
} from '../../src/orderbook/amounts';

const SIDES: readonly Side[] = ['BUY', 'SELL'];
const U64_MAX = 2n ** 64n - 1n;

describe('constants', () => {
  test('match the gateway admission floors', () => {
    expect(MIN_SIZE_MICRO).toBe(1_000_000n);
    expect(MIN_NOTIONAL_MICRO).toBe(1000n);
    expect(TICK_DENOM).toBe(1000n);
  });
});

describe('deriveAmounts', () => {
  test('SELL floors the taker (a reference vector)', () => {
    expect(deriveAmounts('SELL', 570n, 153_641_122n)).toEqual({
      makerAmount: 153_641_122n,
      takerAmount: 87_575_439n,
    });
  });

  test('BUY ceils the maker (a reference vector)', () => {
    expect(deriveAmounts('BUY', 570n, 153_641_122n)).toEqual({
      makerAmount: 87_575_440n,
      takerAmount: 153_641_122n,
    });
  });

  test('SELL at tick 200 floors rather than ceils', () => {
    expect(deriveAmounts('SELL', 200n, 230_333_327n).takerAmount).toBe(
      46_066_665n,
    );
  });

  test('is exact when tick * size divides evenly', () => {
    expect(deriveAmounts('BUY', 500n, 2_000_000n)).toEqual({
      makerAmount: 1_000_000n,
      takerAmount: 2_000_000n,
    });
    expect(deriveAmounts('SELL', 500n, 2_000_000n)).toEqual({
      makerAmount: 2_000_000n,
      takerAmount: 1_000_000n,
    });
  });

  test('uses bigint math beyond Number.MAX_SAFE_INTEGER', () => {
    const size = 9_007_199_254_740_993_000n; // > 2^53, a multiple of 1000
    expect(deriveAmounts('SELL', 999n, size)).toEqual({
      makerAmount: size,
      takerAmount: 8_998_192_055_486_252_007n,
    });
    // an exact division: BUY and SELL agree
    expect(deriveAmounts('BUY', 999n, size)).toEqual({
      makerAmount: 8_998_192_055_486_252_007n,
      takerAmount: size,
    });
  });

  test('a huge size with a remainder: BUY maker is exactly SELL taker + 1', () => {
    const size = 9_007_199_254_740_993_123n; // 999 * size % 1000 === 877
    const sell = deriveAmounts('SELL', 999n, size);
    const buy = deriveAmounts('BUY', 999n, size);
    expect(sell.takerAmount).toBe(8_998_192_055_486_252_129n);
    expect(buy.makerAmount).toBe(8_998_192_055_486_252_130n);
    expect(buy.makerAmount).toBe(sell.takerAmount + 1n);
    expect(gatewayTick('SELL', sell.makerAmount, sell.takerAmount)).toBe(999n);
    expect(gatewayTick('BUY', buy.makerAmount, buy.takerAmount)).toBe(999n);
  });

  test('accepts a size of exactly the u64 maximum', () => {
    expect(deriveAmounts('SELL', 999n, U64_MAX)).toEqual({
      makerAmount: U64_MAX,
      takerAmount: 18_428_297_329_635_842_063n,
    });
    expect(deriveAmounts('BUY', 999n, U64_MAX)).toEqual({
      makerAmount: 18_428_297_329_635_842_064n,
      takerAmount: U64_MAX,
    });
  });

  test('rejects an amount above the u64 maximum, naming the field', () => {
    const tooBig = U64_MAX + 1n;
    for (const tick of [1n, 500n, 999n]) {
      expect(() => deriveAmounts('SELL', tick, tooBig)).toThrow(UserInputError);
      expect(() => deriveAmounts('SELL', tick, tooBig)).toThrow(
        /makerAmount.*u64/,
      );
      expect(() => deriveAmounts('BUY', tick, tooBig)).toThrow(UserInputError);
      expect(() => deriveAmounts('BUY', tick, tooBig)).toThrow(
        /takerAmount.*u64/,
      );
    }
    expect(() => deriveAmounts('SELL', 500n, 2n ** 200n)).toThrow(/u64/);
  });

  test.each([0n, -1n, 1000n, 1001n])('rejects out-of-range tick %s', (tick) => {
    for (const side of SIDES) {
      expect(() => deriveAmounts(side, tick, 1_000_000n)).toThrow(
        UserInputError,
      );
      expect(() => deriveAmounts(side, tick, 1_000_000n)).toThrow(/tick/);
    }
  });

  test.each([0n, -1n])('rejects non-positive size %s', (size) => {
    for (const side of SIDES) {
      expect(() => deriveAmounts(side, 500n, size)).toThrow(UserInputError);
      expect(() => deriveAmounts(side, 500n, size)).toThrow(/sizeMicro/);
    }
  });

  test('rejects non-bigint inputs with a field-named UserInputError', () => {
    const bad: unknown[] = [500, 500.5, '500', null, undefined, Number.NaN];
    for (const value of bad) {
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
        deriveAmounts('BUY', value as any, 1_000_000n),
      ).toThrow(/tick/);
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
        deriveAmounts('BUY', 500n, value as any),
      ).toThrow(/sizeMicro/);
    }
  });

  test('rejects an unknown side', () => {
    for (const side of ['buy', 'sell', '', 'HOLD', null, undefined]) {
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
        deriveAmounts(side as any, 500n, 1_000_000n),
      ).toThrow(/side/);
    }
  });
});

describe('gatewayTick', () => {
  test('SELL recovers the tick from the floored taker (a reference vector)', () => {
    expect(gatewayTick('SELL', 230_333_327n, 46_066_665n)).toBe(200n);
  });

  test('BUY floors maker * 1000 / taker', () => {
    expect(gatewayTick('BUY', 87_575_440n, 153_641_122n)).toBe(570n);
    // flooring the BUY maker instead of ceiling it drifts a tick down
    expect(gatewayTick('BUY', 87_575_439n, 153_641_122n)).toBe(569n);
  });

  test('SELL ceils taker * 1000 / maker', () => {
    expect(gatewayTick('SELL', 153_641_122n, 87_575_439n)).toBe(570n);
    // ceiling the SELL taker instead of flooring it drifts a tick up
    expect(gatewayTick('SELL', 153_641_122n, 87_575_440n)).toBe(571n);
  });

  test.each([0n, -5n])('rejects non-positive makerAmount %s', (amount) => {
    for (const side of SIDES) {
      expect(() => gatewayTick(side, amount, 1000n)).toThrow(UserInputError);
      expect(() => gatewayTick(side, amount, 1000n)).toThrow(/makerAmount/);
    }
  });

  test.each([0n, -5n])('rejects non-positive takerAmount %s', (amount) => {
    for (const side of SIDES) {
      expect(() => gatewayTick(side, 1000n, amount)).toThrow(UserInputError);
      expect(() => gatewayTick(side, 1000n, amount)).toThrow(/takerAmount/);
    }
  });

  test('rejects non-bigint amounts', () => {
    const bad: unknown[] = [1000, 1000.5, '1000', null, undefined];
    for (const value of bad) {
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
        gatewayTick('BUY', value as any, 1000n),
      ).toThrow(/makerAmount/);
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
        gatewayTick('BUY', 1000n, value as any),
      ).toThrow(/takerAmount/);
    }
  });

  test('rejects an unknown side', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
    expect(() => gatewayTick('buy' as any, 1000n, 1000n)).toThrow(/side/);
  });
});

describe('round trip', () => {
  test('gatewayTick(derive(tick, size)) === tick for every tick, both sides', () => {
    const sizes = [1_000_000n, 1_234_567n, 153_641_122n, 999_999_999n];
    let cases = 0;
    for (const side of SIDES) {
      for (let t = 1n; t <= 999n; t++) {
        for (const size of sizes) {
          const { makerAmount, takerAmount } = deriveAmounts(side, t, size);
          const recovered = gatewayTick(side, makerAmount, takerAmount);
          if (recovered !== t) {
            throw new Error(
              `${side} tick ${t} size ${size}: gateway recomputed ${recovered} from ${makerAmount}/${takerAmount}`,
            );
          }
          cases++;
        }
      }
    }
    expect(cases).toBe(2 * 999 * 4);
  });
});

describe('round trip: residue sweep', () => {
  // The round trip holds for every size >= 1000 micro-units because the rounding
  // remainder (at most 999) is smaller than the size. Sweep a contiguous run of
  // sizes so every remainder of tick * size mod 1000 is hit at every tick.
  test('every size 1_000_000..1_001_000 x every tick x both sides', () => {
    let failures = 0;
    let first = '';
    let cases = 0;
    for (const side of SIDES) {
      for (let size = 1_000_000n; size <= 1_001_000n; size++) {
        for (let t = 1n; t <= 999n; t++) {
          const { makerAmount, takerAmount } = deriveAmounts(side, t, size);
          cases++;
          if (gatewayTick(side, makerAmount, takerAmount) !== t) {
            failures++;
            if (first === '') first = `${side} tick ${t} size ${size}`;
          }
        }
      }
    }
    expect({ failures, first }).toEqual({ failures: 0, first: '' });
    expect(cases).toBe(2 * 1001 * 999);
  });
});

describe('notionalBelowMinimum', () => {
  test('returns the failing notional when below the minimum', () => {
    expect(notionalBelowMinimum(1n, 999_999n)).toBe(999n);
    expect(notionalBelowMinimum(1n, 1n)).toBe(0n);
  });

  test('is undefined at and above the minimum (inclusive floor)', () => {
    expect(notionalBelowMinimum(1n, 1_000_000n)).toBeUndefined();
    expect(notionalBelowMinimum(999n, 1_000_000n)).toBeUndefined();
    expect(notionalBelowMinimum(500n, 2000n)).toBeUndefined();
  });

  test('checks the complement tick too', () => {
    // own = floor(999 * 999_999 / 1000) = 998_999 passes; the complement tick 1 gives
    // floor(1 * 999_999 / 1000) = 999 and is the one reported
    expect(notionalBelowMinimum(999n, 999_999n)).toBe(999n);
  });

  test('reports the own tick first when both are below', () => {
    expect(notionalBelowMinimum(400n, 1000n)).toBe(400n); // complement 600
    expect(notionalBelowMinimum(600n, 1000n)).toBe(600n); // complement 400
  });

  test('uses bigint math beyond Number.MAX_SAFE_INTEGER', () => {
    expect(
      notionalBelowMinimum(1n, 9_007_199_254_740_993_000n),
    ).toBeUndefined();
  });

  test('rejects an invalid tick or size', () => {
    for (const tick of [0n, 1000n, -1n]) {
      expect(() => notionalBelowMinimum(tick, 1_000_000n)).toThrow(/tick/);
    }
    for (const size of [0n, -1n]) {
      expect(() => notionalBelowMinimum(500n, size)).toThrow(/sizeMicro/);
    }
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
    expect(() => notionalBelowMinimum(500 as any, 1000n)).toThrow(/tick/);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
    expect(() => notionalBelowMinimum(500n, 1000 as any)).toThrow(/sizeMicro/);
  });
});

describe('validateOrderSize', () => {
  test('rejects a size below 1 share', () => {
    expect(() => validateOrderSize('BUY', 500n, 900_000n)).toThrow(
      UserInputError,
    );
    expect(() => validateOrderSize('BUY', 500n, 900_000n)).toThrow(
      /at least 1 share/,
    );
    expect(() => validateOrderSize('SELL', 500n, 999_999n)).toThrow(
      /at least 1 share/,
    );
  });

  test('accepts exactly 1 share at a mid price', () => {
    for (const side of SIDES) {
      expect(() => validateOrderSize(side, 500n, 1_000_000n)).not.toThrow();
    }
  });

  test('accepts the extreme ticks at exactly 1 share (notional == 1000)', () => {
    // tick 1: floor(1 * 1e6 / 1000) = 1000; complement 999 is far above
    // tick 999: complement 1 -> floor(1 * 1e6 / 1000) = 1000
    for (const side of SIDES) {
      expect(() => validateOrderSize(side, 1n, 1_000_000n)).not.toThrow();
      expect(() => validateOrderSize(side, 999n, 1_000_000n)).not.toThrow();
    }
  });

  test('rejects just under 1 share even at the extreme ticks', () => {
    for (const side of SIDES) {
      for (const tick of [1n, 999n]) {
        expect(() => validateOrderSize(side, tick, 999_999n)).toThrow(
          /at least 1 share/,
        );
      }
    }
  });

  test('notional floor is inclusive: floor(tick * size / 1000) == 1000 passes on the own tick and the complement', () => {
    // At exactly 1 share the smallest side of the pair is tick 1 (own) or
    // tick 999 (complement 1), both landing on notional 1000 == the minimum.
    expect((1n * MIN_SIZE_MICRO) / TICK_DENOM).toBe(MIN_NOTIONAL_MICRO);
    expect(((TICK_DENOM - 999n) * MIN_SIZE_MICRO) / TICK_DENOM).toBe(
      MIN_NOTIONAL_MICRO,
    );
    for (const side of SIDES) {
      expect(() => validateOrderSize(side, 1n, MIN_SIZE_MICRO)).not.toThrow();
      expect(() => validateOrderSize(side, 999n, MIN_SIZE_MICRO)).not.toThrow();
    }
  });

  test('accepts every tick at a range of admissible sizes', () => {
    const sizes = [1_000_000n, 1_000_001n, 2_500_000n, 999_999_999n];
    for (const side of SIDES) {
      for (let t = 1n; t <= 999n; t++) {
        for (const size of sizes) {
          expect(() => validateOrderSize(side, t, size)).not.toThrow();
        }
      }
    }
  });

  test('accepts a size of exactly the u64 maximum', () => {
    for (const side of SIDES) {
      expect(() => validateOrderSize(side, 500n, U64_MAX)).not.toThrow();
    }
  });

  test('rejects a size above the u64 maximum, naming the field and limit', () => {
    for (const side of SIDES) {
      for (const size of [U64_MAX + 1n, 2n ** 128n]) {
        expect(() => validateOrderSize(side, 500n, size)).toThrow(
          UserInputError,
        );
        expect(() => validateOrderSize(side, 500n, size)).toThrow(
          /sizeMicro.*u64/,
        );
      }
    }
  });

  test.each([0n, -1n, 1000n])('rejects out-of-range tick %s', (tick) => {
    expect(() => validateOrderSize('BUY', tick, 1_000_000n)).toThrow(/tick/);
  });

  test.each([0n, -1n])('rejects non-positive size %s', (size) => {
    expect(() => validateOrderSize('BUY', 500n, size)).toThrow(/sizeMicro/);
  });

  test('rejects an unknown side', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
    expect(() => validateOrderSize('x' as any, 500n, 1_000_000n)).toThrow(
      /side/,
    );
  });
});

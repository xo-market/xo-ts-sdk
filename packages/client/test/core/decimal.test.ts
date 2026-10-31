import { describe, expect, test } from 'vitest';
import {
  fromMicro,
  fromUnits,
  isDecimalString,
  MICRO,
  numberToDecimal,
  priceToTick,
  tickToPrice,
  toDecimalString,
  toMicro,
  toUnits,
} from '../../src/core/decimal';
import { UserInputError } from '../../src/core/errors';
import type { DecimalString, RawUnitsString } from '../../src/core/types';

describe('MICRO', () => {
  test('is 1e6 as a bigint', () => {
    expect(MICRO).toBe(1_000_000n);
  });
});

describe('toMicro', () => {
  test('toMicro converts numbers exactly', () => {
    expect(toMicro(153.641122, 'size')).toBe(153_641_122n);
    expect(toMicro('0.57', 'price')).toBe(570_000n);
    expect(toMicro(1, 'size')).toBe(1_000_000n);
  });

  test('toMicro rejects >6 decimals, negatives, NaN', () => {
    for (const bad of ['1.0000001', -1, Number.NaN, '1e3', '']) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
      expect(() => toMicro(bad as any, 'size')).toThrow(UserInputError);
    }
  });

  test('bigint input means whole units', () => {
    expect(toMicro(5n, 'size')).toBe(5_000_000n);
    expect(toMicro(0n, 'size')).toBe(0n);
  });

  test('rejects negative bigints', () => {
    expect(() => toMicro(-5n, 'size')).toThrow(UserInputError);
  });

  test('accepts plain decimal strings', () => {
    expect(toMicro('0', 'size')).toBe(0n);
    expect(toMicro('5', 'size')).toBe(5_000_000n);
    expect(toMicro('0.000001', 'size')).toBe(1n);
    expect(toMicro('123.456789', 'size')).toBe(123_456_789n);
    expect(toMicro('1.50', 'size')).toBe(1_500_000n);
    expect(toMicro('007', 'size')).toBe(7_000_000n);
  });

  test('accepts exactly 6 decimals for numbers', () => {
    expect(toMicro(0.000001, 'size')).toBe(1n);
    expect(toMicro(0.57, 'price')).toBe(570_000n);
    expect(toMicro(0.3, 'size')).toBe(300_000n);
    // 0.1 + 0.2 === 0.30000000000000004 has too many decimals, so it must be rejected, not rounded
    expect(() => toMicro(0.1 + 0.2, 'size')).toThrow(UserInputError);
  });

  test('rejects exponent forms', () => {
    for (const bad of ['1e3', '1E3', '1e-7', 1e-7, 1e21, 1e-10]) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects signs', () => {
    for (const bad of ['-1', '+1', '-0.5', -0.5, '-0']) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects whitespace', () => {
    for (const bad of [' 1', '1 ', ' 1 ', '1 .5', '\t1', '1\n']) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects leading or trailing dot and empty strings', () => {
    for (const bad of ['.5', '5.', '.', '', '1..5', '1.2.3']) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects NaN and Infinity', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects more than 6 decimals', () => {
    for (const bad of ['0.0000001', '1.1234567', 0.1234567]) {
      expect(() => toMicro(bad, 'size')).toThrow(UserInputError);
    }
  });

  test('rejects non-string/number/bigint input', () => {
    for (const bad of [null, undefined, {}, [], true]) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
      expect(() => toMicro(bad as any, 'size')).toThrow(UserInputError);
    }
  });

  test('error message names the field', () => {
    expect(() => toMicro('abc', 'orderSize')).toThrow(/orderSize/);
    expect(() => toMicro(-1n, 'orderSize')).toThrow(/orderSize/);
    expect(() => toMicro(Number.NaN, 'orderSize')).toThrow(/orderSize/);
  });
});

describe('toUnits and fromUnits', () => {
  test('converts exactly with any number of decimals', () => {
    expect(toUnits('1.5', 18, 'amount')).toBe(1_500_000_000_000_000_000n);
    expect(toUnits('0.000000000000000001', 18, 'amount')).toBe(1n);
    expect(toUnits(42, 0, 'amount')).toBe(42n);
    expect(toUnits('7', 2, 'amount')).toBe(700n);
    expect(fromUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(fromUnits(1n, 18)).toBe('0.000000000000000001');
    expect(fromUnits(42n, 0)).toBe('42');
  });

  test('with 6 decimals it is toMicro', () => {
    for (const value of ['0', '1', '0.57', '153.641122', 0.1, 25] as const) {
      expect(toUnits(value, 6, 'amount')).toBe(toMicro(value, 'amount'));
    }
    expect(fromUnits(570_000n, 6)).toBe(fromMicro(570_000n));
  });

  test.each([
    ['more decimals than the token has', '0.0000001', 6],
    ['a fraction on a token without decimals', '1.5', 0],
    ['an exponent', 1e-7, 18],
    ['a sign', '-1', 6],
    ['whitespace', ' 1', 6],
    ['a bare dot', '1.', 6],
    ['an infinite number', Number.POSITIVE_INFINITY, 6],
  ])('refuses %s, without repeating the value', (_what, value, decimals) => {
    expect(() => toUnits(value as string, decimals, 'amount')).toThrow(
      UserInputError,
    );
    try {
      toUnits(value as string, decimals, 'amount');
    } catch (error) {
      expect((error as Error).message).toMatch(/^amount/);
      expect((error as Error).message).not.toContain(String(value).trim());
    }
  });

  test('refuses decimals that a token cannot have', () => {
    expect(() => toUnits('1', -1, 'amount')).toThrow(UserInputError);
    expect(() => toUnits('1', 256, 'amount')).toThrow(UserInputError);
    expect(() => toUnits('1', 1.5, 'amount')).toThrow(UserInputError);
  });
});

describe('fromMicro', () => {
  test('fromMicro / tickToPrice format', () => {
    expect(fromMicro(87_575_439n)).toBe('87.575439');
    expect(tickToPrice(570n)).toBe('0.570');
  });

  test('trims trailing zeros and drops the dot', () => {
    expect(fromMicro(1_000_000n)).toBe('1');
    expect(fromMicro(500_000n)).toBe('0.5');
    expect(fromMicro(1_500_000n)).toBe('1.5');
    expect(fromMicro(0n)).toBe('0');
    expect(fromMicro(1n)).toBe('0.000001');
    expect(fromMicro(10_000_000n)).toBe('10');
    expect(fromMicro(100_000_000n)).toBe('100');
  });

  test('supports negatives', () => {
    expect(fromMicro(-5n)).toBe('-0.000005');
    expect(fromMicro(-1_000_000n)).toBe('-1');
    expect(fromMicro(-1_500_000n)).toBe('-1.5');
  });

  test('round-trips with toMicro', () => {
    for (const s of [
      '0',
      '1',
      '0.5',
      '87.575439',
      '0.000001',
      '123456789.123456',
    ]) {
      expect(fromMicro(toMicro(s, 'x'))).toBe(s);
    }
  });
});

describe('priceToTick', () => {
  test('priceToTick requires a 0.001 multiple in 0.001..0.999', () => {
    expect(priceToTick('0.57')).toBe(570n);
    expect(priceToTick(0.001)).toBe(1n);
    for (const bad of [0, 1, '0.0005', '0.5705', 1.2]) {
      expect(() => priceToTick(bad)).toThrow(UserInputError);
    }
  });

  test('accepts trailing zeros up to 6 decimals', () => {
    expect(priceToTick('0.570000')).toBe(570n);
    expect(priceToTick('0.57')).toBe(570n);
    expect(priceToTick('0.999')).toBe(999n);
    expect(priceToTick('0.001')).toBe(1n);
    expect(priceToTick(0.999)).toBe(999n);
    expect(priceToTick(0.57)).toBe(570n);
  });

  test('rejects out of range and non-multiples', () => {
    for (const bad of [
      '0',
      '0.000',
      '1',
      '1.000',
      '0.0009',
      '0.9995',
      '0.5705',
      '0.000001',
      2,
      -0.5,
    ]) {
      expect(() => priceToTick(bad)).toThrow(UserInputError);
    }
  });

  test('uses the shared toMicro grammar', () => {
    for (const bad of ['1e-3', '.5', '0.', ' 0.5', '', Number.NaN, 1e-7]) {
      expect(() => priceToTick(bad)).toThrow(UserInputError);
    }
  });

  test('error message names the field', () => {
    expect(() => priceToTick('0.5705', 'limitPrice')).toThrow(/limitPrice/);
    expect(() => priceToTick(1.2, 'limitPrice')).toThrow(/limitPrice/);
  });

  test('has a default field name', () => {
    expect(() => priceToTick('bad')).toThrow(/price/);
  });
});

describe('tickToPrice', () => {
  test('always has 3 decimals', () => {
    expect(tickToPrice(570n)).toBe('0.570');
    expect(tickToPrice(1n)).toBe('0.001');
    expect(tickToPrice(10n)).toBe('0.010');
    expect(tickToPrice(100n)).toBe('0.100');
    expect(tickToPrice(999n)).toBe('0.999');
  });

  test('throws outside 1..999', () => {
    for (const bad of [0n, -1n, 1000n, 5000n]) {
      expect(() => tickToPrice(bad)).toThrow(UserInputError);
    }
  });

  test('round-trips with priceToTick', () => {
    for (let t = 1n; t <= 999n; t++) {
      expect(priceToTick(tickToPrice(t))).toBe(t);
    }
  });
});

describe('numberToDecimal (exact, textual)', () => {
  test('plain numbers keep their shortest round-trip digits', () => {
    expect(numberToDecimal(0.57)).toBe('0.57');
    expect(numberToDecimal(153.641122)).toBe('153.641122');
    expect(numberToDecimal(5)).toBe('5');
    expect(numberToDecimal(-2.5)).toBe('-2.5');
    expect(numberToDecimal(123456789.123)).toBe('123456789.123');
    expect(numberToDecimal(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  test('is not toFixed: 0.1 + 0.2 keeps its round-trip digits', () => {
    expect(numberToDecimal(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(numberToDecimal(1.005)).toBe('1.005');
  });

  test('expands negative exponents textually', () => {
    expect(numberToDecimal(1e-7)).toBe('0.0000001');
    expect(numberToDecimal(1.5e-7)).toBe('0.00000015');
    expect(numberToDecimal(-1e-7)).toBe('-0.0000001');
    expect(numberToDecimal(1.2345e-10)).toBe('0.00000000012345');
    expect(numberToDecimal(Number.MIN_VALUE)).toBe(`0.${'0'.repeat(323)}5`);
  });

  test('expands positive exponents textually', () => {
    expect(numberToDecimal(1e21)).toBe('1000000000000000000000');
    expect(numberToDecimal(1.5e21)).toBe('1500000000000000000000');
    expect(numberToDecimal(1.2345e25)).toBe('12345000000000000000000000');
    expect(numberToDecimal(-1e22)).toBe('-10000000000000000000000');
    expect(numberToDecimal(Number.MAX_VALUE)).toMatch(
      /^17976931348623157\d{292}$/,
    );
  });

  test('zero and negative zero are "0"', () => {
    expect(numberToDecimal(0)).toBe('0');
    expect(numberToDecimal(-0)).toBe('0');
  });

  test('rejects NaN and infinities', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => numberToDecimal(bad, 'price')).toThrow(UserInputError);
    }
  });

  test('round-trips: the result is a plain decimal that parses back to the same number', () => {
    const samples: number[] = [];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2000; i++) {
      const exponent = Math.floor(next() * 60) - 30;
      samples.push((next() - 0.5) * 10 ** exponent);
    }
    for (const n of samples) {
      const text = numberToDecimal(n);
      expect(isDecimalString(text)).toBe(true);
      expect(Number(text)).toBe(n === 0 ? 0 : n);
    }
  });
});

describe('isDecimalString', () => {
  test('accepts plain decimals with any number of places', () => {
    for (const ok of [
      '0',
      '5',
      '0.57',
      '-1.5',
      '1000000000000000000',
      '0.0000001',
      '123.456789012345678',
    ]) {
      expect(isDecimalString(ok)).toBe(true);
    }
  });

  test('rejects exponents, signs, whitespace and bare dots', () => {
    for (const bad of [
      '',
      '.5',
      '5.',
      '1e3',
      '1E-7',
      '+1',
      ' 1',
      '1 ',
      '1,5',
      'NaN',
      'Infinity',
      '--1',
      '1.2.3',
      '0x10',
    ]) {
      expect(isDecimalString(bad)).toBe(false);
    }
    expect(isDecimalString(5)).toBe(false);
    expect(isDecimalString(null)).toBe(false);
  });
});

describe('toDecimalString', () => {
  test('a plain decimal string passes through unchanged, padding included', () => {
    expect(toDecimalString('0.570', 'price')).toBe('0.570');
    expect(toDecimalString('1000000', 'amount')).toBe('1000000');
    expect(toDecimalString('-1.50', 'pnl')).toBe('-1.50');
  });

  test('a number is converted exactly', () => {
    expect(toDecimalString(0.57, 'price')).toBe('0.57');
    expect(toDecimalString(1e-7, 'price')).toBe('0.0000001');
  });

  test('a string in exponent form is expanded in the text, like a number', () => {
    expect(toDecimalString('1e3', 'x')).toBe('1000');
    expect(toDecimalString('1E3', 'x')).toBe('1000');
    expect(toDecimalString('1e+21', 'x')).toBe('1000000000000000000000');
    expect(toDecimalString('1e-7', 'x')).toBe('0.0000001');
    expect(toDecimalString('1.5E-7', 'x')).toBe('0.00000015');
    expect(toDecimalString('-2.5e3', 'x')).toBe('-2500');
    expect(toDecimalString('-1e-7', 'x')).toBe('-0.0000001');
    expect(toDecimalString('1.2345e2', 'x')).toBe('123.45');
    expect(toDecimalString('12.5e-1', 'x')).toBe('1.25');
  });

  test('exponent strings with leading or trailing zeros come out as plain decimals', () => {
    expect(toDecimalString('0.5e1', 'x')).toBe('5');
    expect(toDecimalString('0.05e1', 'x')).toBe('0.5');
    expect(toDecimalString('100e-2', 'x')).toBe('1.00');
    expect(toDecimalString('0e5', 'x')).toBe('0');
    expect(toDecimalString('1.50e2', 'x')).toBe('150');
    expect(toDecimalString('1.50e-1', 'x')).toBe('0.150');
    for (const text of ['0.5e1', '0.05e1', '100e-2', '0e5', '1.50e2']) {
      expect(isDecimalString(toDecimalString(text, 'x'))).toBe(true);
    }
  });

  test('a string and the number it prints as expand to the same text', () => {
    let seed = 987;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 1500; i++) {
      const n = (next() - 0.5) * 10 ** (Math.floor(next() * 60) - 30);
      expect(toDecimalString(String(n), 'x')).toBe(numberToDecimal(n));
    }
  });

  test('an exponent beyond 400 is refused instead of written out', () => {
    expect(() => toDecimalString('1e401', 'x')).toThrow(UserInputError);
    expect(() => toDecimalString('1e-401', 'x')).toThrow(UserInputError);
    expect(() => toDecimalString('1e999999999', 'x')).toThrow(UserInputError);
    expect(toDecimalString('1e400', 'x')).toHaveLength(401);
  });

  test('anything else is a UserInputError that does not echo the value', () => {
    for (const bad of [
      '',
      'abc',
      '.5e1',
      '1e',
      'e5',
      '1e1.5',
      '1 e3',
      '+1e3',
      Number.NaN,
      null,
      undefined,
      {},
      5n,
    ]) {
      expect(() => toDecimalString(bad, 'price')).toThrow(UserInputError);
    }
    try {
      toDecimalString('secret-value', 'price');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });
});

describe('RawUnitsString is not whole units', () => {
  const raw = '570000' as RawUnitsString;

  test('priceToTick and toMicro refuse a raw-units amount at compile time', () => {
    // @ts-expect-error a raw token-unit price is not a whole-unit price
    expect(() => priceToTick(raw)).toThrow(UserInputError);
    // @ts-expect-error a raw token-unit amount is not a whole-unit amount
    expect(() => toMicro(raw, 'size')).not.toThrow();
  });

  test('whole-unit strings, literals and numbers still type-check', () => {
    expect(priceToTick('0.57')).toBe(570n);
    expect(priceToTick(0.57)).toBe(570n);
    const text: string = '0.57';
    expect(priceToTick(text)).toBe(570n);
    const decimal: DecimalString = '0.57';
    expect(priceToTick(decimal)).toBe(570n);
    expect(toMicro(5n, 'size')).toBe(5_000_000n);
  });

  test('the brand is a string at runtime and fromMicro turns it into whole units', () => {
    expect(typeof raw).toBe('string');
    expect(fromMicro(BigInt(raw))).toBe('0.57');
  });
});

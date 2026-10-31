import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// examples/scripts/src/deposit.ts: the deposit through XO's bridge. Once a payment is confirmed,
// the line that says what to send names it, and the next line says not to send again if the
// script stops before the payment completes. A payment with no address yet says to send nothing.
// The client is a fake: nothing here reaches a host.

// A path in a variable, so that this package's type check (NodeNext) leaves the example to its
// own (`pnpm --filter @xomarket/examples typecheck`, which resolves imports as bundlers do).
const EXAMPLE = fileURLToPath(
  new URL('../../examples/scripts/src/deposit.ts', import.meta.url),
);

const fake = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('@xomarket/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xomarket/client')>();
  return { ...actual, createSecureClient: vi.fn(async () => fake.client) };
});

const DEPOSIT_ADDRESS = '0x00000000000000000000000000000000000000d1';
const USDC_ON_BASE = 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const quote = {
  paymentId: 'pay_q',
  input: { assetId: USDC_ON_BASE, amount: '5' },
  output: { assetId: 'xo:usdc', amount: '4.9' },
  fees: { total: '0.1', currency: 'USD' },
  acceptBy: '2026-10-29T11:00:00.000Z',
};

/** A client whose bridge confirms `payment` and whose wait does `wait`. */
function client(payment: unknown, wait: () => Promise<unknown>) {
  return {
    wallet: '0x00000000000000000000000000000000000000a1',
    listBridgeAssets: vi.fn(() => ({
      firstPage: async () => ({
        items: [{ assetId: USDC_ON_BASE, chain: 'base', symbol: 'USDC' }],
        hasMore: false,
      }),
    })),
    quoteDeposit: vi.fn(async () => [quote]),
    createDeposit: vi.fn(async () => payment),
    waitForBridgePayment: vi.fn(wait),
  };
}

/** Runs the script (a top-level-await module) once, with its output captured. */
async function run(): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((line: unknown) => void lines.push(String(line)));
  try {
    await import(EXAMPLE);
    return { lines, error: undefined };
  } catch (error) {
    return { lines, error };
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('XO_PK', `0x${'11'.repeat(32)}`);
  vi.stubEnv('XO_DEPOSIT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('examples/scripts/src/deposit.ts', () => {
  test('the send line names the payment, and the next one says not to send again', async () => {
    const c = client(
      {
        paymentId: 'pay_1',
        status: 'AWAITING_FUNDS',
        fundBy: '2026-10-29T12:00:00.000Z',
        deposit: {
          address: DEPOSIT_ADDRESS,
          amount: '5',
          assetId: USDC_ON_BASE,
          chain: 'base',
        },
      },
      // The wait runs out with the payment not final.
      async () => {
        throw new Error('Payment pay_1 was not final after waiting');
      },
    );
    fake.client = c;

    const { lines, error } = await run();
    expect(String(error)).toContain('Payment pay_1 was not final');
    expect(c.listBridgeAssets).toHaveBeenCalledWith({ direction: 'deposit' });
    expect(c.quoteDeposit).toHaveBeenCalledWith({
      assetId: USDC_ON_BASE,
      amount: '5',
    });
    expect(c.createDeposit).toHaveBeenCalledTimes(1);
    expect(c.createDeposit).toHaveBeenCalledWith({ quote });
    expect(lines).toContain(
      `Payment pay_1: send exactly 5 of ${USDC_ON_BASE} on base to ${DEPOSIT_ADDRESS}, once, before 2026-10-29T12:00:00.000Z`,
    );
    expect(lines).toContain(
      "If this stops after you sent the funds, the payment goes on: do not send again, and follow it with waitForBridgePayment({ paymentId: 'pay_1' }). If you sent nothing, send nothing: the payment expires at 2026-10-29T12:00:00.000Z",
    );
    expect(c.waitForBridgePayment).toHaveBeenCalledWith(
      { paymentId: 'pay_1' },
      { timeout: 30 * 60_000 },
    );
  });

  test('a payment with no address yet says to send nothing, and waits for nothing', async () => {
    const c = client(
      {
        paymentId: 'pay_2',
        status: 'CONFIRM_UNKNOWN',
        fundBy: null,
        deposit: null,
      },
      async () => expect.fail('waitForBridgePayment() was called'),
    );
    fake.client = c;

    const { lines, error } = await run();
    expect(String(error)).toContain(
      'Payment pay_2 is CONFIRM_UNKNOWN, with no deposit address yet: send nothing',
    );
    expect(lines.some((line) => line.includes('send exactly'))).toBe(false);
    expect(c.waitForBridgePayment).not.toHaveBeenCalled();
  });

  test('a payment that is not awaiting funds says to send nothing, even with an address', async () => {
    const c = client(
      {
        paymentId: 'pay_3',
        status: 'PROCESSING',
        fundBy: null,
        deposit: {
          address: DEPOSIT_ADDRESS,
          amount: '5',
          assetId: USDC_ON_BASE,
          chain: 'base',
        },
      },
      async () => expect.fail('waitForBridgePayment() was called'),
    );
    fake.client = c;

    const { lines, error } = await run();
    expect(String(error)).toContain('Payment pay_3 is PROCESSING');
    expect(lines.some((line) => line.includes('send exactly'))).toBe(false);
    expect(c.waitForBridgePayment).not.toHaveBeenCalled();
  });
});

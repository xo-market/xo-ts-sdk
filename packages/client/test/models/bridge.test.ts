import { type Address, getAddress } from 'viem';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  BridgeAssetsSchema,
  BridgePaymentSchema,
  type BridgeAsset as RawBridgeAsset,
  type BridgePayment as RawBridgePayment,
  type BridgeQuote as RawBridgeQuote,
} from '../../src/bridge/schemas';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { DecimalString } from '../../src/core/types';
import {
  type BridgeAsset,
  type BridgeDeposit,
  type BridgeFees,
  type BridgePayment,
  type BridgePaymentStatus,
  type DepositQuote,
  toBridgeAsset,
  toBridgePayment,
  toDepositQuote,
  toWithdrawalQuote,
  type WithdrawalQuote,
} from '../../src/models/bridge';
import {
  ACCEPT_BY,
  assetFixture,
  BASE_USDC,
  DEPOSIT_ADDRESS,
  ETH_USDT,
  FUND_BY,
  paymentFixture,
  RECIPIENT,
  XO_USDC_ASSET,
} from '../helpers/mockBridge';
import { keysOf, wireStyleKeys } from '../helpers/modelKeys';
import { OWNER } from '../helpers/railChain';

function asset(patch: Record<string, unknown> = {}): RawBridgeAsset {
  const [row] = BridgeAssetsSchema.lenient.parse({
    data: [assetFixture(patch)],
  }).data;
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

function payment(patch: Record<string, unknown> = {}): RawBridgePayment {
  return BridgePaymentSchema.lenient.parse(paymentFixture(patch));
}

const FEES = {
  total: '0.1',
  conversion: '0',
  network: '0.05',
  business: '0.05',
  currency: 'USD',
};

function quote(patch: Partial<RawBridgeQuote> = {}): RawBridgeQuote {
  return {
    paymentId: 'quote_1',
    direction: 'deposit',
    input: { asset: BASE_USDC, amount: '25.5' },
    output: { asset: XO_USDC_ASSET, amount: '25.4' },
    fees: FEES,
    latencySeconds: 90,
    acceptBy: ACCEPT_BY,
    ...patch,
  };
}

describe('toBridgeAsset', () => {
  test('maps an asset: the asset id, the network and the token', () => {
    expect(toBridgeAsset(asset())).toEqual({
      assetId: BASE_USDC,
      chain: 'base',
      chainId: '8453',
      addressFamily: 'EVM',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      isNative: false,
      image: 'https://assets.example.com/usdc.png',
    });
  });

  test('an asset without a logo or an EVM chain has null for each', () => {
    const mapped = toBridgeAsset(
      asset({ imageUrl: null, chainId: null, addressFamily: 'SOLANA' }),
    );

    expect(mapped.image).toBeNull();
    expect(mapped.chainId).toBeNull();
    expect(mapped.addressFamily).toBe('SOLANA');
  });

  test('a native coin is marked, and a chain id too large for a number stays exact text', () => {
    const big = '9'.repeat(77);
    const mapped = toBridgeAsset(asset({ isNative: true, chainId: big }));

    expect(mapped.isNative).toBe(true);
    expect(mapped.chainId).toBe(big);
  });

  test('has no snake_case or *ID-style key, and does not change the input', () => {
    const input = asset();
    const before = structuredClone(input);

    expect(wireStyleKeys(toBridgeAsset(input))).toEqual([]);
    expect(Object.keys(toBridgeAsset(input)).sort()).toEqual(
      [
        'assetId',
        'chain',
        'chainId',
        'addressFamily',
        'symbol',
        'name',
        'decimals',
        'address',
        'isNative',
        'image',
      ].sort(),
    );
    expect(input).toEqual(before);
  });

  test('has the public types', () => {
    expectTypeOf<BridgeAsset['assetId']>().toEqualTypeOf<string>();
    expectTypeOf<BridgeAsset['chainId']>().toEqualTypeOf<string | null>();
    expectTypeOf<BridgeAsset['decimals']>().toEqualTypeOf<number>();
    expectTypeOf<BridgeAsset['image']>().toEqualTypeOf<string | null>();
  });
});

describe('toDepositQuote and toWithdrawalQuote', () => {
  test('toDepositQuote maps an option: what goes in, what comes out, what it costs', () => {
    expect(toDepositQuote(quote())).toEqual({
      paymentId: 'quote_1',
      input: { assetId: BASE_USDC, amount: '25.5' },
      output: { assetId: XO_USDC_ASSET, amount: '25.4' },
      fees: {
        total: '0.1',
        conversion: '0',
        network: '0.05',
        business: '0.05',
        currency: 'USD',
      },
      latencySeconds: 90,
      acceptBy: ACCEPT_BY,
    });
  });

  test('toWithdrawalQuote also names the recipient', () => {
    expect(
      toWithdrawalQuote(
        quote({
          direction: 'withdraw',
          input: { asset: XO_USDC_ASSET, amount: '25' },
          output: { asset: ETH_USDT, amount: '24.9' },
          recipient: RECIPIENT,
        }),
      ),
    ).toEqual({
      paymentId: 'quote_1',
      input: { assetId: XO_USDC_ASSET, amount: '25' },
      output: { assetId: ETH_USDT, amount: '24.9' },
      fees: {
        total: '0.1',
        conversion: '0',
        network: '0.05',
        business: '0.05',
        currency: 'USD',
      },
      latencySeconds: 90,
      acceptBy: ACCEPT_BY,
      recipient: RECIPIENT,
    });
  });

  test('a delivery time XO does not state is null', () => {
    expect(
      toDepositQuote(quote({ latencySeconds: null })).latencySeconds,
    ).toBeNull();
  });

  test('a fee that is not a plain decimal is null, and the currency stays', () => {
    const mapped = toDepositQuote(
      quote({ fees: { ...FEES, network: 'n/a', business: '' } }),
    );

    expect(mapped.fees).toEqual({
      total: '0.1',
      conversion: '0',
      network: null,
      business: null,
      currency: 'USD',
    });
  });

  test('a quote of the other direction is refused, naming the field', () => {
    expect(() => toDepositQuote(quote({ direction: 'withdraw' }))).toThrow(
      UnexpectedResponseError,
    );
    expect(() =>
      toWithdrawalQuote(quote({ direction: 'deposit', recipient: RECIPIENT })),
    ).toThrow(/direction/);
  });

  test('a withdrawal quote without a recipient is refused', () => {
    expect(() => toWithdrawalQuote(quote({ direction: 'withdraw' }))).toThrow(
      /recipient/,
    );
  });

  test('has the fields of the model and nothing else, and no snake_case key', () => {
    const deposit = toDepositQuote(quote());

    expect(Object.keys(deposit).sort()).toEqual(
      [
        'paymentId',
        'input',
        'output',
        'fees',
        'latencySeconds',
        'acceptBy',
      ].sort(),
    );
    expect(keysOf(deposit)).not.toContain('direction');
    expect(wireStyleKeys(deposit)).toEqual([]);
  });

  test('does not change its input', () => {
    const input = quote();
    const before = structuredClone(input);
    const mapped = toDepositQuote(input);
    mapped.input.amount = '1';

    expect(input).toEqual(before);
  });

  test('has the public types', () => {
    expectTypeOf<DepositQuote['paymentId']>().toEqualTypeOf<string>();
    expectTypeOf<
      DepositQuote['input']['amount']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<DepositQuote['latencySeconds']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<WithdrawalQuote['recipient']>().toEqualTypeOf<string>();
    expectTypeOf<BridgeFees['network']>().toEqualTypeOf<DecimalString | null>();
  });
});

describe('toBridgePayment', () => {
  test('maps a confirmed deposit that waits for its funds', () => {
    expect(toBridgePayment(payment())).toEqual({
      paymentId: 'pay_1',
      direction: 'deposit',
      status: 'AWAITING_FUNDS',
      providerStatus: 'PENDING',
      input: { assetId: BASE_USDC, amount: '25.5' },
      output: { assetId: XO_USDC_ASSET, amount: '25.4' },
      fees: {
        total: '0.1',
        conversion: '0',
        network: '0.05',
        business: '0.05',
        currency: 'USD',
      },
      ownerAddress: getAddress(OWNER),
      destinationAddress: OWNER,
      recipient: null,
      acceptBy: ACCEPT_BY,
      fundBy: FUND_BY,
      deposit: {
        address: DEPOSIT_ADDRESS,
        amount: '25.5',
        assetId: BASE_USDC,
        chain: 'base',
      },
      verification: null,
      fundingClaimedAt: null,
      fundingTransactionHash: null,
      deliveryTransactionHash: null,
      recoveryUrl: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
      completedAt: null,
    });
  });

  test('a completed payment has its transactions and its completion time', () => {
    const mapped = toBridgePayment(
      payment({
        status: 'COMPLETE',
        fundingTxHash: `0x${'aa'.repeat(32)}`,
        deliveryTxHash: 'SolanaSignature1111',
        completedAt: '2026-10-21T12:03:00.000Z',
      }),
    );

    expect(mapped).toMatchObject({
      status: 'COMPLETE',
      fundingTransactionHash: `0x${'aa'.repeat(32)}`,
      deliveryTransactionHash: 'SolanaSignature1111',
      completedAt: '2026-10-21T12:03:00.000Z',
    });
  });

  test('a withdrawal names its recipient, and a halted payment its recovery page', () => {
    const mapped = toBridgePayment(
      payment({
        direction: 'withdraw',
        status: 'HALTED',
        recipient: RECIPIENT,
        recoveryUrl: 'https://recover.example/p/1',
        fundingClaimedAt: '2026-10-21T12:01:00.000Z',
      }),
    );

    expect(mapped).toMatchObject({
      direction: 'withdraw',
      recipient: RECIPIENT,
      recoveryUrl: 'https://recover.example/p/1',
      fundingClaimedAt: '2026-10-21T12:01:00.000Z',
    });
  });

  test('a payment that waits for a signature lists what to sign', () => {
    const mapped = toBridgePayment(
      payment({
        status: 'NEEDS_VERIFICATION',
        verification: {
          items: [
            {
              reason: 'EVM_OWNER',
              signatureType: 'EIP712',
              payload: '{"a":1}',
            },
          ],
        },
      }),
    );

    expect(mapped.verification).toEqual([
      { reason: 'EVM_OWNER', signatureType: 'EIP712', payload: '{"a":1}' },
    ]);
  });

  test('a payment before its quote is confirmed has no owner and no deadline to fund', () => {
    const mapped = toBridgePayment(
      payment({
        status: 'QUOTED',
        ownerAddress: null,
        fundBy: null,
        deposit: null,
        hallidayStatus: null,
      }),
    );

    expect(mapped).toMatchObject({
      status: 'QUOTED',
      ownerAddress: null,
      fundBy: null,
      deposit: null,
      providerStatus: null,
    });
  });

  test('the owner address is checksummed, and a destination on another network is kept as it is', () => {
    const mapped = toBridgePayment(
      payment({
        ownerAddress: OWNER.toLowerCase(),
        destinationAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      }),
    );

    expect(mapped.ownerAddress).toBe(getAddress(OWNER));
    expect(mapped.destinationAddress).toBe(
      '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    );
  });

  test('a status added later passes through as its own string', () => {
    expect(toBridgePayment(payment({ status: 'REFUNDING' })).status).toBe(
      'REFUNDING',
    );
  });

  test('has no snake_case or *ID-style key, and no name of the bridge provider', () => {
    const mapped = toBridgePayment(payment());

    expect(wireStyleKeys(mapped)).toEqual([]);
    for (const name of [
      'hallidayStatus',
      'fundingTxHash',
      'deliveryTxHash',
      'token',
    ]) {
      expect(keysOf(mapped), name).not.toContain(name);
    }
  });

  test('copies its lists and does not change the input', () => {
    const input = payment({
      status: 'NEEDS_VERIFICATION',
      verification: {
        items: [
          { reason: 'EVM_OWNER', signatureType: 'EIP191', payload: 'hi' },
        ],
      },
    });
    const before = structuredClone(input);
    const mapped = toBridgePayment(input);
    mapped.verification?.pop();

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(toBridgePayment(input)))).toEqual(
      toBridgePayment(input),
    );
  });

  test('has the public types', () => {
    expectTypeOf<
      BridgePayment['status']
    >().toEqualTypeOf<BridgePaymentStatus>();
    expectTypeOf<
      BridgePayment['ownerAddress']
    >().toEqualTypeOf<Address | null>();
    expectTypeOf<
      BridgePayment['deposit']
    >().toEqualTypeOf<BridgeDeposit | null>();
    expectTypeOf<BridgePayment['direction']>().toEqualTypeOf<
      'deposit' | 'withdraw'
    >();
    expectTypeOf<BridgeDeposit['amount']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<BridgePayment['fundingTransactionHash']>().toEqualTypeOf<
      string | null
    >();
  });
});

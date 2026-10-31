import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, type Hex, keccak256 } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from 'vitest';
import { type ChainReader, createChainReader } from '../../src/account/chain';
import {
  TimeoutError,
  TransactionFailedError,
  XoError,
} from '../../src/core/errors';
import type { ResolveDeps } from '../../src/markets/resolve';
import type { ContractReader as OrderbookChainReader } from '../../src/orderbook/client';
import { OWNER, TX_HASH } from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

// createChainReader against a fake JSON-RPC node (msw on env.rpcUrl). It checks the JSON-RPC
// each method sends and how answers and failures come back.

const env = testEnv;
const USDC = env.contracts.usdc;

interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

type Answer = (req: RpcRequest) => unknown;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A node that answers per method. A method without an answer is a JSON-RPC error. */
function node(answers: Record<string, Answer>): RpcRequest[] {
  const seen: RpcRequest[] = [];
  server.use(
    http.post(env.rpcUrl, async ({ request }) => {
      const payload = (await request.json()) as RpcRequest | RpcRequest[];
      const one = (req: RpcRequest) => {
        seen.push(req);
        const answer = answers[req.method];
        if (answer === undefined) {
          return {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32601, message: `method ${req.method} not found` },
          };
        }
        const result = answer(req);
        if (result instanceof Error) {
          return {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32000, message: result.message },
          };
        }
        return { jsonrpc: '2.0', id: req.id, result };
      };
      return HttpResponse.json(
        Array.isArray(payload) ? payload.map(one) : one(payload),
      );
    }),
  );
  return seen;
}

const BLOCK = {
  number: '0x10',
  hash: `0x${'01'.repeat(32)}`,
  parentHash: `0x${'02'.repeat(32)}`,
  timestamp: '0x6ad4fb87',
  baseFeePerGas: '0x0',
  gasLimit: '0x1c9c38000',
  gasUsed: '0x0',
  logsBloom: `0x${'00'.repeat(256)}`,
  miner: `0x${'00'.repeat(20)}`,
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  extraData: '0x',
  transactions: [],
  uncles: [],
};

function simCall(gasUsed: number, ok = true) {
  return {
    returnData: '0x',
    logs: [],
    gasUsed: `0x${gasUsed.toString(16)}`,
    status: ok ? '0x1' : '0x0',
  };
}

describe('createChainReader', () => {
  test('is a full ChainReader that the orderbook client and resolveMarket accept', () => {
    const reader = createChainReader(env);
    expectTypeOf(reader).toMatchTypeOf<ChainReader>();
    expectTypeOf(reader).toMatchTypeOf<OrderbookChainReader>();
    expectTypeOf(reader).toMatchTypeOf<NonNullable<ResolveDeps['chain']>>();
  });

  test('getNonce: eth_getTransactionCount(address, pending)', async () => {
    const seen = node({ eth_getTransactionCount: () => '0x7' });
    expect(await createChainReader(env).getNonce(OWNER)).toBe(7n);
    expect(seen.map((r) => [r.method, r.params])).toEqual([
      ['eth_getTransactionCount', [OWNER, 'pending']],
    ]);
  });

  test("getCode: '0x' for an address without code", async () => {
    node({ eth_getCode: () => '0x' });
    expect(await createChainReader(env).getCode(OWNER)).toBe('0x');
  });

  test('readContract: eth_call, raw result', async () => {
    const seen = node({ eth_call: () => `0x${'00'.repeat(31)}01` });
    const reader = createChainReader(env);
    expect(await reader.readContract({ to: USDC, data: '0x18160ddd' })).toBe(
      `0x${'00'.repeat(31)}01`,
    );
    expect(seen[0]?.method).toBe('eth_call');
    const [request] = (seen[0] as RpcRequest).params as [
      { to: string; data: string },
    ];
    expect(request.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(request.data).toBe('0x18160ddd');
  });

  test('estimateGas: eth_estimateGas from the executor', async () => {
    const seen = node({ eth_estimateGas: () => '0x8aad' });
    const gas = await createChainReader(env).estimateGas({
      from: OWNER,
      to: USDC,
      data: '0x095ea7b3',
      value: 0n,
    });
    expect(gas).toBe(0x8aadn);
    expect(seen[0]?.params[0]).toMatchObject({
      from: OWNER,
      to: USDC,
      data: '0x095ea7b3',
    });
  });

  test('simulateBundleGas: eth_simulateV1 with the calls from the executor; sums gasUsed', async () => {
    const seen = node({
      eth_simulateV1: (req) => {
        const [{ blockStateCalls }] = req.params as [
          { blockStateCalls: Array<{ calls: unknown[] }> },
        ];
        // viem appends one empty call to read the block; it answers for every call sent.
        const calls = blockStateCalls[0]?.calls ?? [];
        return [
          {
            ...BLOCK,
            calls: calls.map((_, i) =>
              simCall(i === 0 ? 300_000 : i === 1 ? 35_501 : 21_000),
            ),
          },
        ];
      },
    });
    const gas = await createChainReader(env).simulateBundleGas({
      from: OWNER,
      calls: [
        { to: env.contracts.kernelFactory, data: '0xea6d13ac' },
        { to: USDC, data: '0x095ea7b3', value: 0n },
      ],
    });
    expect(gas).toBe(335_501n);
    const [{ blockStateCalls }] = (seen[0] as RpcRequest).params as [
      {
        blockStateCalls: Array<{
          calls: Array<{ from: Address; to: Address; data: Hex }>;
        }>;
      },
    ];
    expect(blockStateCalls[0]?.calls.slice(0, 2)).toMatchObject([
      { from: OWNER, to: env.contracts.kernelFactory, data: '0xea6d13ac' },
      { from: OWNER, to: USDC, data: '0x095ea7b3' },
    ]);
  });

  test('simulateBundleGas rejects if any call reverts', async () => {
    node({
      eth_simulateV1: (req) => {
        const [{ blockStateCalls }] = req.params as [
          { blockStateCalls: Array<{ calls: unknown[] }> },
        ];
        const calls = blockStateCalls[0]?.calls ?? [];
        return [
          { ...BLOCK, calls: calls.map((_, i) => simCall(30_000, i !== 1)) },
        ];
      },
    });
    const error = await createChainReader(env)
      .simulateBundleGas({
        from: OWNER,
        calls: [
          { to: USDC, data: '0x01' },
          { to: USDC, data: '0x02' },
        ],
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('bundle_simulation_reverted');
    expect(error.message).toContain('calls[1]');
  });

  test('getFees: from the latest block and eth_maxPriorityFeePerGas', async () => {
    node({
      eth_getBlockByNumber: () => ({ ...BLOCK, baseFeePerGas: '0x64' }),
      eth_maxPriorityFeePerGas: () => '0x2',
    });
    const fees = await createChainReader(env).getFees();
    expect(fees.maxPriorityFeePerGas).toBe(2n);
    expect(fees.maxFeePerGas >= 100n + 2n).toBe(true);
  });

  test('waitForReceipt: maps the receipt', async () => {
    node({
      eth_getTransactionReceipt: () => ({
        transactionHash: TX_HASH,
        blockHash: `0x${'03'.repeat(32)}`,
        blockNumber: '0x2a',
        transactionIndex: '0x0',
        from: OWNER,
        to: USDC,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x0',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x0',
        type: '0x76',
      }),
    });
    expect(await createChainReader(env).waitForReceipt(TX_HASH, 5_000)).toEqual(
      {
        txHash: TX_HASH,
        status: 'reverted',
        blockNumber: 42n,
      },
    );
  });

  test('waitForReceipt: no receipt within the timeout → TimeoutError', async () => {
    node({
      eth_getTransactionReceipt: () => null,
      eth_blockNumber: () => '0x10',
      eth_getTransactionByHash: () => null,
    });
    const error = await createChainReader(env)
      .waitForReceipt(TX_HASH, 50)
      .catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.service).toBe('chain');
  });

  test('sendRawTransaction: returns the node hash; a JSON-RPC error is a definite rejection', async () => {
    const seen = node({ eth_sendRawTransaction: () => TX_HASH });
    const reader = createChainReader(env);
    expect(await reader.sendRawTransaction?.('0x02f8')).toBe(TX_HASH);
    expect(seen.map((r) => r.method)).toEqual(['eth_sendRawTransaction']);

    server.resetHandlers();
    const rejected = node({
      eth_sendRawTransaction: () =>
        new Error('insufficient funds for gas * price + value'),
    });
    const error = await reader.sendRawTransaction?.('0x02f8').catch((e) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.code).toBe('rejected_by_node');
    // Sent once: the write client never retries.
    expect(rejected).toHaveLength(1);
  });

  test('sendRawTransaction: "nonce too low" → nonce_too_low, mayHaveLanded true, with the hash of the bytes', async () => {
    node({
      eth_sendRawTransaction: () => new Error('Nonce too low: next nonce 6'),
    });
    const error = await createChainReader(env)
      .sendRawTransaction?.('0x02f8')
      .catch((e) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('nonce_too_low');
    expect(error.mayHaveLanded).toBe(true);
    expect(error.transactionHash).toBe(keccak256('0x02f8'));
  });

  test('sendRawTransaction: "unknown transaction type" is not "known transaction"', async () => {
    node({
      eth_sendRawTransaction: () => new Error('unknown transaction type 0x02'),
    });
    const error = await createChainReader(env)
      .sendRawTransaction?.('0x02f8')
      .catch((e) => e);
    expect(error).toBeInstanceOf(XoError);
    expect(error).not.toBeInstanceOf(TransactionFailedError);
    expect(error.message).toContain('outcome unknown');
  });

  test('getTransaction: eth_getTransactionByHash, found or not_found; a failed lookup throws', async () => {
    const seen = node({
      eth_getTransactionByHash: (req) =>
        req.params[0] === TX_HASH ? { hash: TX_HASH, blockNumber: null } : null,
    });
    const reader = createChainReader(env);
    expect(await reader.getTransaction?.(TX_HASH)).toBe('found');
    expect(await reader.getTransaction?.(`0x${'cd'.repeat(32)}`)).toBe(
      'not_found',
    );
    expect(seen.map((r) => [r.method, r.params])).toEqual([
      ['eth_getTransactionByHash', [TX_HASH]],
      ['eth_getTransactionByHash', [`0x${'cd'.repeat(32)}`]],
    ]);

    server.resetHandlers();
    node({ eth_getTransactionByHash: () => new Error('internal error') });
    const error = await reader.getTransaction?.(TX_HASH).catch((e) => e);
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('chain_rpc_failed');
  });

  test('sendRawTransaction: "already known" resolves with the hash of the bytes', async () => {
    const seen = node({
      eth_sendRawTransaction: () => new Error('already known'),
    });
    const reader = createChainReader(env);
    expect(await reader.sendRawTransaction?.('0x02f8')).toBe(
      keccak256('0x02f8'),
    );
    expect(seen).toHaveLength(1);
  });

  test.each([
    'Insufficient Funds for gas * price + value',
    'intrinsic gas too low',
    'replacement transaction underpriced',
    'max fee per gas less than block base fee',
    'exceeds block gas limit',
    'invalid sender',
    'invalid chain id',
    'transaction type not supported',
  ])(
    'sendRawTransaction: "%s" → rejected_by_node, mayHaveLanded false',
    async (message) => {
      node({ eth_sendRawTransaction: () => new Error(message) });
      const error = await createChainReader(env)
        .sendRawTransaction?.('0x02f8')
        .catch((e) => e);
      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error.code).toBe('rejected_by_node');
      expect(error.mayHaveLanded).toBe(false);
      expect(error.message.toLowerCase()).toContain(message.toLowerCase());
    },
  );

  test.each([
    [-32603, 'internal error'],
    [-32000, 'gateway timeout'],
    [-32000, 'unknown text'],
  ])(
    'sendRawTransaction: %i "%s" → not a rejection (outcome unknown)',
    async (code, message) => {
      server.use(
        http.post(env.rpcUrl, async ({ request }) => {
          const req = (await request.json()) as RpcRequest;
          return HttpResponse.json({
            jsonrpc: '2.0',
            id: req.id,
            error: { code, message },
          });
        }),
      );
      const error = await createChainReader(env)
        .sendRawTransaction?.('0x02f8')
        .catch((e) => e);
      expect(error).toBeInstanceOf(XoError);
      expect(error).not.toBeInstanceOf(TransactionFailedError);
      expect(error.code).toBe('chain_rpc_failed');
      expect(error.message).toContain('outcome unknown');
      expect(error.message).toContain(message);
    },
  );

  test('sendRawTransaction: an HTTP failure is not a rejection, and is not retried', async () => {
    let posts = 0;
    server.use(
      http.post(env.rpcUrl, () => {
        posts += 1;
        return new HttpResponse('bad gateway', { status: 502 });
      }),
    );
    const error = await createChainReader(env)
      .sendRawTransaction?.('0x02f8')
      .catch((e) => e);
    expect(error).toBeInstanceOf(XoError);
    expect(error).not.toBeInstanceOf(TransactionFailedError);
    expect(posts).toBe(1);
  });

  test('a failure never quotes the RPC URL and keeps no cause', async () => {
    const custom = { ...env, rpcUrl: 'https://rpc.example.test/key/abc123' };
    server.use(
      http.post(
        'https://rpc.example.test/key/abc123',
        () => new HttpResponse('nope', { status: 500 }),
      ),
    );
    const error = await createChainReader(custom)
      .getNonce(OWNER)
      .catch((e) => e);
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('chain_rpc_failed');
    expect(error.service).toBe('chain');
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('abc123');
    expect(JSON.stringify(error)).not.toContain('abc123');
  });
});

import type { Address, Hex } from 'viem';
import { describe, expectTypeOf, test } from 'vitest';
import {
  type BackendCredential,
  type BatchOperationResult,
  type BatchOpsIncompleteError,
  type BatchPlaceIncompleteError,
  type ConditionId,
  type CredentialStore,
  createPublicClient,
  createSecureClient,
  type DecimalString,
  type EnvironmentConfig,
  type ErrorGuard,
  isPublicClient,
  isSecureClient,
  ListMarketsError,
  type Market,
  type MarketEvent,
  type MarketOutcome,
  type MarketTopicEvent,
  type OrderbookCredential,
  type OrderResponse,
  OrderSide,
  OrderType,
  type Page,
  type Paginated,
  type PublicClient,
  type PublicClientOptions,
  production,
  type RateLimitUpdate,
  type RequestOptions,
  type RequestRejectedError,
  type SecureClient,
  type SecureClientOptions,
  type Service,
  type SignedOrder,
  type Signer,
  type StoredCredentials,
  type SubscriptionHandle,
  type TokenId,
  type TransactionFailedError,
  type UserInputError,
  type WalletCredentials,
  type XoError,
  type XoErrorOptions,
} from '../src/index';
import { fileStore, installShutdownHooks } from '../src/node';
import type {
  ClobAuthParams,
  EvTx,
  OrderStruct,
  WireOrder,
} from '../src/signing/index';
import { privateKey, signerFrom, type Signer as ViemSigner } from '../src/viem';

// Compile-time only (vitest typecheck, and `tsc`): the public types, as a user names them from
// the four entries, and the README snippet as written there.

describe('the README snippet', () => {
  test('compiles as written', async () => {
    const client = createPublicClient();
    const page = await client.listMarkets({ pageSize: 5 }).firstPage();
    expectTypeOf(page).toEqualTypeOf<Page<Market>>();

    const secure = await createSecureClient({
      // biome-ignore lint/style/noNonNullAssertion: the README snippet, verbatim
      signer: privateKey(process.env.XO_PK!),
      store: fileStore('./.xo'),
    });
    expectTypeOf(secure).toEqualTypeOf<SecureClient>();
    expectTypeOf(secure.wallet).toEqualTypeOf<Address>();
  });

  test('the other forms the snippet names', async () => {
    const signer = {} as Signer;
    await createSecureClient({ signer });
    await createSecureClient({
      signer,
      wallet: '0x0000000000000000000000000000000000000002',
    });
    await createSecureClient({ signer, rail: 'direct', shutdownHooks: false });
    await createSecureClient({
      signer,
      credentials: { backend: { apiKey: 'xo_sk_data_x' } },
    });
    // @ts-expect-error a rail is 'sponsored' or 'direct'
    await createSecureClient({ signer, rail: 'bundler' });
    await createSecureClient({
      signer,
      // @ts-expect-error the wallet is an address, not an object
      wallet: { type: 'smart_wallet', index: 0 },
    });
    // @ts-expect-error there is no environment name: leave it out for XO mainnet
    createPublicClient({ environment: 'mainnet' });
    // @ts-expect-error the old client's options are gone
    createPublicClient({ env: production });
  });
});

describe('the clients', () => {
  test('a public client is synchronous; a secure one signs in first', () => {
    expectTypeOf(createPublicClient)
      .parameter(0)
      .toEqualTypeOf<PublicClientOptions | undefined>();
    expectTypeOf(createPublicClient).returns.toEqualTypeOf<PublicClient>();
    expectTypeOf(createSecureClient)
      .parameter(0)
      .toEqualTypeOf<SecureClientOptions>();
    expectTypeOf(createSecureClient).returns.toEqualTypeOf<
      Promise<SecureClient>
    >();
    expectTypeOf<SecureClient>().toExtend<PublicClient>();
  });

  test('the guards narrow', () => {
    const value: unknown = undefined;
    if (isSecureClient(value)) {
      expectTypeOf(value).toEqualTypeOf<SecureClient>();
    }
    if (isPublicClient(value)) {
      expectTypeOf(value).toEqualTypeOf<PublicClient>();
    }
  });

  test('every read takes the options of the call; a list is paginated', () => {
    expectTypeOf<PublicClient['listMarkets']>()
      .parameter(1)
      .toEqualTypeOf<RequestOptions | undefined>();
    expectTypeOf<PublicClient['listMarkets']>().returns.toEqualTypeOf<
      Paginated<Market>
    >();
    expectTypeOf<RequestOptions>().toEqualTypeOf<{
      signal?: AbortSignal;
      timeout?: number | false;
      retries?: number;
    }>();
  });

  test('the market topic delivers market events', async () => {
    const handle = await createPublicClient().subscribe([
      { topic: 'market', assetIds: ['1'] },
    ]);
    expectTypeOf(handle).toEqualTypeOf<SubscriptionHandle<MarketTopicEvent>>();
  });
});

describe('the options a client takes', () => {
  test('the environment is a config, mainnet by default', () => {
    expectTypeOf(production).toEqualTypeOf<EnvironmentConfig>();
    expectTypeOf<PublicClientOptions['environment']>().toEqualTypeOf<
      EnvironmentConfig | undefined
    >();
    expectTypeOf<EnvironmentConfig>().not.toHaveProperty('bundler');
    expectTypeOf<EnvironmentConfig['bridge']>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  test('the rate-limit callback', () => {
    expectTypeOf<PublicClientOptions['onRateLimitUpdate']>().toEqualTypeOf<
      ((update: RateLimitUpdate) => void) | undefined
    >();
    expectTypeOf<RateLimitUpdate['retryAfter']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<RateLimitUpdate['service']>().toEqualTypeOf<Service>();
  });

  test('the signers of /viem are the Signer the client takes', () => {
    expectTypeOf<ViemSigner>().toEqualTypeOf<Signer>();
    expectTypeOf(privateKey).returns.toEqualTypeOf<Signer>();
    expectTypeOf(signerFrom).returns.toEqualTypeOf<Signer>();
    expectTypeOf<SecureClientOptions['signer']>().toEqualTypeOf<Signer>();
  });

  test('the stores of /node are the store the client takes', () => {
    expectTypeOf(fileStore).returns.toEqualTypeOf<CredentialStore>();
    expectTypeOf(fileStore).returns.toExtend<
      NonNullable<SecureClientOptions['store']>
    >();
    expectTypeOf(installShutdownHooks).returns.toEqualTypeOf<() => void>();
  });

  test('exported credentials are what the credentials option takes', () => {
    expectTypeOf<Required<WalletCredentials>>().toExtend<
      NonNullable<SecureClientOptions['credentials']>
    >();
  });
});

describe('the public types', () => {
  test('a user can implement the extension points', () => {
    const store: CredentialStore = {
      persistent: true,
      get: async () => ({ backend: {} as BackendCredential }),
      set: async (_key: string, _value: StoredCredentials) => {},
      delete: async () => {},
    };
    const signer: Signer = {
      getAddress: async () => '0x0000000000000000000000000000000000000001',
      signMessage: async () => '0x00',
      signTypedData: async () => '0x00',
    };
    expectTypeOf(store).toExtend<CredentialStore>();
    expectTypeOf(signer).toExtend<Signer>();
    expectTypeOf<OrderbookCredential['secret']>().toEqualTypeOf<string>();
  });

  test('nested model types are nameable', () => {
    expectTypeOf<Market['outcomes']['yes']>().toEqualTypeOf<MarketOutcome>();
    expectTypeOf<Market['events']>().toEqualTypeOf<MarketEvent[]>();
    expectTypeOf<MarketOutcome['tokenId']>().toEqualTypeOf<TokenId | null>();
    expectTypeOf<SignedOrder['orderType']>().toEqualTypeOf<OrderType>();
    // The batch errors carry public values, never the entries of XO's answers.
    expectTypeOf<BatchPlaceIncompleteError['results']>().toEqualTypeOf<
      OrderResponse[]
    >();
    expectTypeOf<BatchOpsIncompleteError['results']>().toEqualTypeOf<
      BatchOperationResult[]
    >();
  });

  test('the enums are values and types', () => {
    expectTypeOf(OrderSide.BUY).toExtend<OrderSide>();
    expectTypeOf(OrderType.GTD).toExtend<OrderType>();
    expectTypeOf<`${OrderSide}`>().toEqualTypeOf<'BUY' | 'SELL'>();
    expectTypeOf<`${OrderType}`>().toEqualTypeOf<
      'GTC' | 'GTD' | 'FOK' | 'FAK'
    >();
  });

  test('the shared types', () => {
    expectTypeOf<DecimalString>().toEqualTypeOf<string>();
    expectTypeOf<TokenId>().toExtend<string>();
    expectTypeOf<ConditionId>().toExtend<Hex>();
    expectTypeOf<Service>().toEqualTypeOf<
      'backend' | 'orderbook' | 'sponsor' | 'chain' | 'sdk'
    >();
    expectTypeOf<XoErrorOptions['code']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TransactionFailedError>().not.toHaveProperty('userOpHash');
  });

  test('an action error guard narrows to its union', () => {
    const error: unknown = undefined;
    expectTypeOf(ListMarketsError).toExtend<ErrorGuard<ListMarketsError>>();
    if (ListMarketsError.isError(error)) {
      expectTypeOf(error).toEqualTypeOf<ListMarketsError>();
      expectTypeOf(error).toExtend<XoError>();
    }
    expectTypeOf<RequestRejectedError>().toExtend<ListMarketsError>();
    expectTypeOf<UserInputError>().toExtend<ListMarketsError>();
  });

  test('the signing entry', () => {
    expectTypeOf<OrderStruct['salt']>().toEqualTypeOf<bigint>();
    expectTypeOf<WireOrder>().toBeObject();
    expectTypeOf<EvTx['calls']>().toBeArray();
    expectTypeOf<ClobAuthParams['nonce']>().toEqualTypeOf<bigint>();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import * as publicClient from '../src/clients/public';
import * as shutdown from '../src/core/shutdown';
import * as main from '../src/index';
import * as node from '../src/node';
import * as signing from '../src/signing/index';
import * as viem from '../src/viem';
import * as publicSigner from '../src/wallet/publicSigner';
import {
  MAIN_TYPES,
  MAIN_VALUES,
  NODE_TYPES,
  NODE_VALUES,
  SIGNING_TYPES,
  SIGNING_VALUES,
  VIEM_TYPES,
  VIEM_VALUES,
} from './exports.lists';
import {
  declarationClosure,
  ENTRIES,
  exportsOf,
  missingFromClosure,
  SRC,
} from './helpers/apiSurface';

// The public API, pinned: the exact names of the four entries, values
// and types, read with the TypeScript compiler (`checker.getExportsOfModule`), the runtime
// names, and the declaration closure (every type a public signature names is exported).

const PINNED = {
  main: { values: MAIN_VALUES, types: MAIN_TYPES, runtime: main },
  node: { values: NODE_VALUES, types: NODE_TYPES, runtime: node },
  signing: { values: SIGNING_VALUES, types: SIGNING_TYPES, runtime: signing },
  viem: { values: VIEM_VALUES, types: VIEM_TYPES, runtime: viem },
} as const;

describe('public exports', () => {
  test('the pinned lists are sorted, without duplicates, values and types apart', () => {
    for (const { values, types } of Object.values(PINNED)) {
      for (const list of [values, types]) {
        expect([...list].sort()).toEqual([...list]);
        expect(new Set(list).size).toBe(list.length);
      }
      expect(
        values.filter((name) => (types as readonly string[]).includes(name)),
      ).toEqual([]);
    }
  });

  test.each(Object.keys(PINNED) as (keyof typeof PINNED)[])(
    '%s: exactly the pinned values and types (TypeScript compiler API)',
    (entry) => {
      const { values, types } = exportsOf(ENTRIES[entry]);
      expect(values).toEqual([...PINNED[entry].values]);
      expect(types).toEqual([...PINNED[entry].types]);
    },
    60_000,
  );

  test.each(Object.keys(PINNED) as (keyof typeof PINNED)[])(
    '%s: the runtime exports are the pinned values, each defined',
    (entry) => {
      const { runtime, values } = PINNED[entry];
      expect(Object.keys(runtime).sort()).toEqual([...values]);
      for (const [name, value] of Object.entries(runtime)) {
        expect(value, name).toBeDefined();
      }
    },
  );

  test('one implementation each: the entries re-export, they do not copy', () => {
    expect(node.installShutdownHooks).toBe(shutdown.installShutdownHooks);
    expect(viem.privateKey).toBe(publicSigner.privateKey);
    expect(main.createPublicClient).toBe(publicClient.createPublicClient);
  });

  test('the old client and its parts are not exported', () => {
    const all = Object.values(PINNED).flatMap(({ values, types }) => [
      ...values,
      ...types,
    ]);
    for (const old of [
      'XoClient',
      'environments',
      'EnvironmentName',
      'fromPrivateKey',
      'fromViemAccount',
      'fromViemWalletClient',
      'Transport',
      'TransportRequest',
      'Session',
      'Clock',
      'OrderbookClient',
      'DataClient',
      'AccountClient',
      'BridgeClient',
      'OrderbookRealtime',
      'BackendRealtime',
      'SponsoredRail',
      'DirectRail',
      'CallOptions',
      'Paginator',
      'RateLimitInfo',
      'resolveMarket',
      'memoryStore',
    ]) {
      expect(all).not.toContain(old);
    }
  });

  test("no entry of XO's answers is exported: the batch errors carry public values", () => {
    const all = Object.values(PINNED).flatMap(({ values, types }) => [
      ...values,
      ...types,
    ]);
    for (const wire of [
      'BatchPlaceEntry',
      'BatchPlaceResult',
      'BatchOpsEntry',
      'BatchOpResult',
      'CancelResult',
    ]) {
      expect(all).not.toContain(wire);
    }
  });

  test('no internal helper is reachable from an entry', () => {
    const all = Object.values(PINNED).flatMap(({ values, types }) => [
      ...values,
      ...types,
    ]);
    for (const internal of [
      'isValidSecret',
      'serializeByExecutor',
      'nextNonce',
      'markAccepted',
      'resetNonceTracking',
      'setNonceClock',
      'sessionInternals',
      'registerSessionInternals',
      'withLanded',
      'closedObject',
      'setClientSeams',
      'resetProcessState',
      'hasShutdownSignals',
      'processShared',
      'createCore',
      'DataDeps',
      'SessionRail',
      'optionalFunction',
      'readEnvironment',
      'bindActions',
      'Bound',
      'BoundAction',
      'publicActions',
      'secureActions',
      'brandClient',
      'toInternalSigner',
      'makeErrorGuard',
      'toPaginated',
      'parseRequestOptions',
      'resolveEnvironment',
      'ActionContext',
      'MarketExtras',
      'RawEventRow',
    ]) {
      expect(all).not.toContain(internal);
    }
  });
});

describe('the declaration closure', () => {
  test.each(Object.keys(PINNED) as (keyof typeof PINNED)[])(
    '%s: every type a public signature names is exported',
    (entry) => {
      expect(missingFromClosure(ENTRIES[entry])).toEqual([]);
    },
    60_000,
  );

  test('the walk is not vacuous: it reaches nested response and option types', () => {
    const { symbols } = exportsOf(ENTRIES.main);
    const reached = (root: string) =>
      [...declarationClosure([symbols.get(root) as ts.Symbol])].map(
        (s) => s.name,
      );
    expect(reached('Market')).toEqual(
      expect.arrayContaining([
        'MarketOutcomes',
        'MarketTrading',
        'MarketEvent',
      ]),
    );
    expect(reached('SecureClient')).toEqual(
      expect.arrayContaining([
        'PublicClient',
        'PlaceLimitOrderRequest',
        'OrderResponse',
        'Paginated',
        'Page',
        'RequestOptions',
      ]),
    );
    expect(reached('SubscriptionHandle')).toContain('ReconnectedInfo');
    expect(reached('BatchPlaceIncompleteError')).toContain('OrderResponse');
    expect(reached('BatchOpsIncompleteError')).toContain(
      'BatchOperationResult',
    );
    // Neither a client's context nor its bound actions are part of it: they are @internal.
    expect(reached('SecureClient')).not.toContain('ActionContext');
    expect(reached('PublicClient')).not.toContain('Bound');
  });
});

describe('@internal members stay out of the published declarations', () => {
  test('the build strips them (tsdown dts: stripInternal)', () => {
    const config = readFileSync(join(SRC, '../tsdown.config.ts'), 'utf8');
    expect(config).toMatch(/stripInternal:\s*true/);
  });

  test("Subscription's producer side, its constructor and stopHeartbeat are @internal, and stripped", () => {
    const files = [
      join(SRC, 'realtime/subscription.ts'),
      join(SRC, 'orderbook/client.ts'),
    ];
    const emitted: Record<string, string> = {};
    const program = ts.createProgram(files, {
      declaration: true,
      emitDeclarationOnly: true,
      stripInternal: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
    });
    program.emit(
      undefined,
      (name, text) => {
        emitted[name] = text;
      },
      undefined,
      true,
    );
    const subscription = Object.entries(emitted).find(([name]) =>
      name.endsWith('realtime/subscription.d.ts'),
    )?.[1];
    const orderbook = Object.entries(emitted).find(([name]) =>
      name.endsWith('orderbook/client.d.ts'),
    )?.[1];
    // A member declaration starts a line; the class docs may still mention them in prose.
    const declares = (text: string | undefined, member: string) =>
      new RegExp(`^\\s+${member}\\(`, 'm').test(text ?? '');
    expect(subscription).toContain('class Subscription');
    expect(declares(subscription, 'close')).toBe(true);
    for (const member of [
      'push',
      'pushReconnected',
      'pushError',
      'constructor',
    ]) {
      expect(declares(subscription, member), member).toBe(false);
    }
    expect(declares(orderbook, 'startHeartbeat')).toBe(true);
    expect(declares(orderbook, 'stopHeartbeat')).toBe(false);
  }, 120_000);
});

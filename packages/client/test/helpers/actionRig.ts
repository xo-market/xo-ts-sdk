import type { SetupServer } from 'msw/node';
import type { ChainReader } from '../../src/account/chain';
import type { ActionContext } from '../../src/clients/context';
import { Clock } from '../../src/core/clock';
import { OrderbookClient } from '../../src/orderbook/client';
import { RealtimeHub } from '../../src/realtime/merged';
import { type DataRigOptions, dataRig, env } from './dataRig';
import { conditionIdOf } from './mockBackendData';
import { chainStub, prepare } from './mockChain';
import {
  type FixtureMarket,
  installMarketData,
  TOKEN_YES,
} from './mockMarketData';

// The context an action runs on, over the fakes of the backend, the order book and the chain:
// the same wiring a client builds, with every request going to an msw handler. The backend
// fake has markets 1..14 (the plain CLOB ones are 1, 3, 8, 10 and 12) and the rewards fake
// enrols markets 1 and 2. The order book fake knows every CLOB market but id 3, holds id 9
// inactive, and every one it knows is prepared on the chain stub.

/** The clock the actions read: a day in October, before the fixtures' expiry on 2026-12-01. */
export const NOW_MS = Date.parse('2026-10-18T00:00:00.000Z');

/**
 * The outcome tokens of a backend fixture market. The order book fake uses the same ones, so
 * a joined market agrees with its list row.
 */
export const yesTokenOf = (id: number): string =>
  (BigInt(TOKEN_YES) + BigInt(id * 10)).toString();
export const noTokenOf = (id: number): string =>
  (BigInt(TOKEN_YES) + BigInt(id * 10 + 1)).toString();

/** The ids the order book fake knows. */
export const ORDERBOOK_IDS = [1, 2, 4, 8, 9, 10, 11, 12];
/** The id the order book fake holds inactive. */
export const INACTIVE_ID = 9;

function orderbookMarkets(): FixtureMarket[] {
  return ORDERBOOK_IDS.map((id) => ({
    condition_id: conditionIdOf(id),
    yes: yesTokenOf(id),
    no: noTokenOf(id),
    active: id !== INACTIVE_ID,
  }));
}

export interface ActionRigOptions extends DataRigOptions {
  /** The order book markets; defaults to {@link ORDERBOOK_IDS}. */
  orderbookMarkets?: FixtureMarket[];
}

export function actionRig(server: SetupServer, o: ActionRigOptions = {}) {
  const strict = o.strict ?? true;
  const base = dataRig(server, { ...o, strict });
  const orderbook = installMarketData(server, {
    markets: o.orderbookMarkets ?? orderbookMarkets(),
  });
  const orderbookClient = new OrderbookClient({
    transport: base.transport,
    env,
    strictResponses: strict,
  });
  const chain = chainStub(env);
  for (const id of ORDERBOOK_IDS) {
    prepare(chain, conditionIdOf(id), yesTokenOf(id));
  }
  const clock = new Clock({
    fetchServerTimeSec: async () => Math.floor(NOW_MS / 1000),
    now: () => NOW_MS,
  });
  const ctx: ActionContext = {
    env,
    orderbook: orderbookClient,
    data: base.client,
    // The stub answers `readContract` only, which is all the discovery actions read through.
    chain: chain.reader as unknown as ChainReader,
    clock,
    strict,
    realtime: new RealtimeHub({ env, orderbook: orderbookClient, strict }),
  };
  return { ...base, ctx, orderbook, chain, clock };
}

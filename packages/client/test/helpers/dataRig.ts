import type { SetupServer } from 'msw/node';
import { expect } from 'vitest';
import { Session } from '../../src/auth/session';
import { Clock } from '../../src/core/clock';
import { Transport } from '../../src/core/transport';
import { DataClient } from '../../src/data/client';
import { installAccountData } from './mockAccountData';
import {
  type BackendData,
  type DataRequest,
  installBackendData,
} from './mockBackendData';
import { installRewardsData } from './mockRewardsData';
import { testEnv } from './testEnv';

export const env = testEnv;

/** A backend API key the session holds and the fake's `shared` route accepts. */
export const API_KEY =
  'xo_sk_data_0123456789abcdef_0123456789abcdef0123456789abcdef';

export interface DataRigOptions {
  /** Reject response fields the schemas do not know. */
  strict?: boolean;
  /**
   * Give the client a session installed on the transport: `true` holds a backend key
   * (`API_KEY`), `'none'` has neither a signer nor a key.
   */
  session?: boolean | 'none';
  /** Install the session on the transport (`setAuth`). Defaults to true. */
  install?: boolean;
  /** The backend key a `session: true` session holds, instead of {@link API_KEY}. The fake accepts it. */
  apiKey?: string;
  /** A client without a session and without credentials on the transport. */
  maxRetries?: number;
}

export function dataRig(server: SetupServer, o: DataRigOptions = {}) {
  const transport = new Transport({
    env,
    version: '9.9.9',
    maxRetries: o.maxRetries ?? 0,
  });
  const backend = installBackendData(server, {
    validKeys: [API_KEY, ...(o.apiKey === undefined ? [] : [o.apiKey])],
  });
  const account = installAccountData(server, backend);
  const rewards = installRewardsData(server, backend);
  const session = o.session
    ? new Session({
        env,
        transport,
        clock: new Clock({
          fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
        }),
        ...(o.session === 'none'
          ? {}
          : { credentials: { backend: { apiKey: o.apiKey ?? API_KEY } } }),
        readContract: async () => '0x',
        warn: () => {},
      })
    : undefined;
  if (session !== undefined && o.install !== false) {
    transport.setAuth(session);
  }
  const client = new DataClient({
    transport,
    ...(session === undefined ? {} : { session }),
    ...(o.strict === undefined ? {} : { strictResponses: o.strict }),
  });
  return { client, backend, account, rewards, transport, session };
}

/** The last request that reached the fake. */
export function last(backend: BackendData): DataRequest {
  const request = backend.requests.at(-1);
  if (request === undefined) {
    throw new Error('no request reached the fake backend');
  }
  return request;
}

/** Runs `run` and returns what it threw, or fails. Works for sync and async throws. */
export async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** The "METHOD /path" of every request, in order. */
export const calls = (backend: BackendData): string[] =>
  backend.requests.map((request) => `${request.method} ${request.path}`);

/** Asserts no request was made. */
export function expectNoRequest(backend: BackendData): void {
  expect(backend.requests).toEqual([]);
}

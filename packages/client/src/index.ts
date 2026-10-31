// `@xomarket/client`: the universal entry. No Node builtin is reachable from here (the
// Node-only parts live in `@xomarket/client/node`, the signing kit in
// `@xomarket/client/signing`).
//
// Explicit names only: never `export *`, and nothing marked `@internal` or from an
// `internal.ts`. What is here is what a user names to create a client, call it, read what it
// returns or catch what it throws.

/**
 * `@xomarket/client`: the universal entry of the SDK. Nothing here needs a Node builtin.
 *
 * @module @xomarket/client
 */

// ---------------------------------------------------------------------------
// The environment and requests
// ---------------------------------------------------------------------------

export { type EnvironmentConfig, production } from './core/env';
export type { RequestOptions } from './core/requestOptions';
export type { RateLimitUpdate } from './core/transport';
export { SDK_VERSION } from './core/version';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export type {
  BackendCredential,
  CredentialStore,
  StoredCredentials,
} from './auth/store';
export type { OrderbookCredential } from './signing/hmac';

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export { OrderSide, OrderType } from './models/enums';
export type { OrderStruct, WireOrder } from './signing/order';

// ---------------------------------------------------------------------------
// Errors: every class, and the type of the guards
// ---------------------------------------------------------------------------

export { MintedKeyError } from './auth/backendAuth';
export {
  AuthRequiredError,
  type ErrorGuard,
  PaginationLimitError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
  type XoErrorOptions,
} from './core/errors';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  ConditionId,
  DecimalString,
  OrderHash,
  Service,
  TokenId,
} from './core/types';

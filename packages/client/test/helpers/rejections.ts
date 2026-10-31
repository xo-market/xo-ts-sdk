import { isRejected, isServerFailure } from '../../src/core/errors';

/** For `toSatisfy`: the error is a `RequestRejectedError` with exactly this HTTP status. */
export function rejectedWith(status: number): (error: unknown) => boolean {
  return (error) => isRejected(error, status);
}

/** For `toSatisfy`: the error is a `RequestRejectedError` with a 5xx status. */
export function serverFailure(error: unknown): boolean {
  return isServerFailure(error);
}

/** For `toSatisfy`: the error is the orderbook's 503 `trading_paused` rejection. */
export function tradingPaused(error: unknown): boolean {
  return isRejected(error, 503) && error.code === 'trading_paused';
}

// Code that docs/errors.md and docs/sdk-direction.md quote: type-checked, never run.

import { FetchMarketError, type PublicClient, XoError } from '@xomarket/client';

// #region describe-error
function describeError(error: unknown): string {
  return error instanceof XoError
    ? `${error.name} ${error.code}${error.mayHaveLanded === undefined ? '' : ` mayHaveLanded=${error.mayHaveLanded}`}: ${error.message}`
    : String(error);
}

// #endregion describe-error

export { describeError };

/** Reads a market, and names what went wrong when it cannot. */
export async function marketOrExplain(client: PublicClient, slug: string) {
  // #region error-guard
  try {
    return await client.fetchMarket({ slug });
  } catch (error) {
    if (FetchMarketError.isError(error)) {
      console.log(`${error.name} ${error.code}: ${error.message}`);
    }
    throw error;
  }
  // #endregion error-guard
}

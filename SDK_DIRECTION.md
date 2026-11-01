# SDK direction

The rules that shape `@xomarket/client`. They explain why a method is named and shaped the way it
is, and what we keep the same as the SDK grows. A new method follows them, so once you know a few
methods you can guess the rest.

## Built around what you want to do

The API is organised by the job: read a market, read a book, place an order, move money. It is
never organised by which XO service answers. You ask for markets, a book or an order, and the
services behind them do not show. We translate each service's shapes into the SDK's own models once,
at the edge, and the raw shapes stay inside. So when a service changes, the SDK absorbs it, and
your code does not break with it.

## A method's prefix says what it does

| Prefix | What the method does |
| --- | --- |
| `list*` | Reads a long list and returns a paginated result, always. |
| `fetch*` | Reads one item, or one plain collection, always. |
| `create*` | Signs an order and does not send it. |
| `post*` | Sends orders that are already signed. |
| `place*` | Signs and sends. |
| `cancel*` | Cancels. |
| `setup*` | Does a one-time setup so the account can trade. |
| `waitFor*` | Polls until the thing reaches a final state. |

On-chain actions are named for the action: `mergePositions`, `redeemPositions`, `transferErc20`.

## One request object, then options

A method takes one request object, or nothing. There are no positional ids. A read then takes an
optional last argument, `{ signal, timeout, retries }`, for that call alone.

<!-- snippet: docs/snippets/production.ts#request-options -->
```ts
const book = await client.fetchOrderBook(
  { assetId },
  { timeout: 5_000, retries: 0, signal },
);
```

A call that changes something takes no options. An order, a cancel, an on-chain transaction or a
payment is sent once and never retried, and a send is never signed again either. Deleting the
client's own API key, when it closes, rotates its key or ends authentication, is retried: deleting
it twice is harmless. When the outcome of a send is uncertain, the error says
`mayHaveLanded: true` and carries the id to check, such as the `orderHash`, the `paymentId` or the
`transactionHash`. For a cancel, read your open orders.

## Names and values

- Everything is camelCase. An identifier ends in `Id`: `orderId`, `marketId`, `conditionId`,
  `assetId`.
- An outcome token is an `assetId` in a request and `outcomes.yes.tokenId` on a market, since the
  market model names its outcomes.
- A set of strings is a TypeScript enum: `OrderSide.BUY`, `OrderType.GTC`.
- An input accepts plain values: strings or numbers for prices and sizes, strings for ids. An
  output carries branded types, and an amount is a decimal string in whole units, so `'1.5'` is one
  and a half USDC. Bigints appear only for facts of the chain, such as a block number or a nonce.
- "No value" is `null`. A field that is not known yet is `null` too, and the docs of the field say
  when it fills in. A price that does not exist, such as the midpoint of a book with an empty
  side, is `null` as well, never a price of 0.

## Refusals are values, failures are errors

When XO turns an order down, the placement returns `{ ok: false, code, message }`. Nothing was
placed, and the `code` stays the same between releases. An error is thrown when the call could not
be carried out, or when its outcome is unknown. Every method names the errors it can throw, and
each has a guard of the same name that narrows what you caught.

<!-- snippet: docs/snippets/errors.ts#error-guard -->
```ts
try {
  return await client.fetchMarket({ slug });
} catch (error) {
  if (FetchMarketError.isError(error)) {
    console.log(`${error.name} ${error.code}: ${error.message}`);
  }
  throw error;
}
```

Every error has a stable `code`, and [Errors](docs/errors.md) lists them all.

## Documented in the code

Every public method has a comment that says what it does for you without naming a backend service.
It lists the errors it throws with `@throws`, and has one `@example` that needs no imports. The
[API reference](docs/reference/README.md) is generated from those comments, and the code blocks of
these pages are copied from code that is compiled, so a page cannot drift from the code.

## One network

The SDK runs on XO mainnet. There is no environment name to choose: both factories take an optional
`environment` object, and leave it out for mainnet. Pass your own object only to point at another
deployment, such as a local one.

## Changes between versions

The SDK follows [semantic versioning](https://semver.org). Below 1.0.0, a minor version can change
the API, and the [changelog](docs/changelog.md) says what changed in each version. We aim to avoid
breaking changes, and to give a way out first when we cannot.

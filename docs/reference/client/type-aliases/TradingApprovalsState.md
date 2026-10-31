# Type Alias: TradingApprovalsState

```ts
type TradingApprovalsState = object;
```

What the account has set up for trading.

## Properties

### conditionalTokensApproved

```ts
conditionalTokensApproved: boolean;
```

Whether the exchange may move the account's outcome tokens.

***

### deployed

```ts
deployed: boolean;
```

Whether the trading account exists on chain. A plain wallet always does.

***

### marketManagerApproved

```ts
marketManagerApproved: boolean | null;
```

Whether the market manager may spend the account's USDC. `null` when it was not read.

***

### ready

```ts
ready: boolean;
```

Whether the account can trade: it is deployed and the exchange is approved for USDC and outcome tokens.

***

### usdcApproved

```ts
usdcApproved: boolean;
```

Whether the exchange may spend the account's USDC.

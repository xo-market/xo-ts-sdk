# Type Alias: SecureListUserRewardsOrdersRequest

```ts
type SecureListUserRewardsOrdersRequest = object;
```

What `listUserRewardsOrders` takes on a signed-in client: a wallet, or none for its own.

## Properties

### conditionId?

```ts
conditionId?: string;
```

Only the orders of this market: its id on the order book, `0x` and 64 hex digits.

***

### epoch?

```ts
epoch?: number;
```

The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Without it the day in
progress is listed.

***

### live?

```ts
live?: boolean;
```

Whether the day in progress also lists the resting orders that have not been scored yet.
`false` lists the scored orders alone. On by default.

***

### pageSize?

```ts
pageSize?: number;
```

How many orders a page holds, from 1 to 1000.

***

### user?

```ts
user?: string;
```

The wallet whose orders to list. Leave it out for the client's own wallet.

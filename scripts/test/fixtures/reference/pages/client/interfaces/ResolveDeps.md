# Interface: ResolveDeps

What [resolveMarket](../functions/resolveMarket.md) needs. The facade wires these; a test can pass its own.

## Properties

### chain?

```ts
optional chain?: ContractReader;
```

Reads the chain (read-only `eth_call`). Without it the three on-chain checks are
`'unchecked'` and `tradable.ok` is false.

***

### data

```ts
data: DataClient;
```

***

### env

```ts
env: EnvironmentConfig;
```

Where the ConditionalTokens and CTFExchange contracts are.

***

### nowMs?

```ts
optional nowMs?: () => number;
```

The clock for the expiry check, in milliseconds. Pass the server clock (the session's
`Clock`, `nowSec() * 1000`) so a wrong local clock cannot hide an expiry. Defaults to the
local clock, `Date.now()`.

#### Returns

`number`

***

### orderbook

```ts
orderbook: OrderbookClient;
```

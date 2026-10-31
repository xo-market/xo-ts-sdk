# Interface: SignedOrder

A signed order, ready to place. The builders return it deeply frozen: changing it would
break its signature, and `postOrder` refuses an order whose hash no longer matches.

## Properties

### order

```ts
readonly order: Readonly<OrderStruct>;
```

***

### orderHash

```ts
readonly orderHash: OrderHash;
```

***

### orderType

```ts
readonly orderType: OrderType;
```

How long the order lives: `OrderType.GTC`, `GTD`, `FOK` or `FAK`.

***

### postOnly

```ts
readonly postOnly: boolean;
```

***

### wire

```ts
readonly wire: Readonly<WireOrder>;
```

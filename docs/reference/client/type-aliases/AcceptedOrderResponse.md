# Type Alias: AcceptedOrderResponse

```ts
type AcceptedOrderResponse = object;
```

An order that XO accepted.

## Properties

### makingAmount

```ts
makingAmount: DecimalString | null;
```

What the order gave up in the fills made at placement, in whole units: dollars for a
buy, shares for a sell. `"0"` when nothing filled. `null` when XO did not report it,
which is the case for every order posted in a batch (`postOrders`, `postOrderBatch`):
read the account's trades for those.

***

### ok

```ts
ok: true;
```

`true`: the order was accepted.

***

### orderHash

```ts
orderHash: OrderHash;
```

The hash of the signed order, computed here before it was sent. Use it to look the order
up again, for example when the answer to a placement never arrived.

***

### orderId

```ts
orderId: string;
```

The order's id, as XO gives it. On XO it is the order's hash.

***

### status

```ts
status: OrderPostStatus;
```

What became of the order.

***

### takingAmount

```ts
takingAmount: DecimalString | null;
```

What the order received in the fills made at placement, in whole units: shares for a
buy, dollars for a sell. `"0"` when nothing filled. `null` when XO did not report it, as
for [AcceptedOrderResponse.makingAmount](#makingamount).

***

### tradeIds

```ts
tradeIds: string[] | null;
```

The ids of the trades made at placement. Empty when nothing filled. `null` when XO did not
report them, which is the case for every order posted in a batch (`postOrders`,
`postOrderBatch`): read the account's trades for those. Later fills of a resting order
make new trades that are not listed here.

***

### transactionsHashes

```ts
transactionsHashes: Hex[] | null;
```

The settlement transactions of the fills made at placement. Settlement happens after the
match, so this can be empty even when the order filled: read the trades for the hashes.
`null` when XO did not report them, as for [AcceptedOrderResponse.tradeIds](#tradeids).

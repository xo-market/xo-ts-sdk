# Type Alias: RejectedOrderResponse

```ts
type RejectedOrderResponse = object;
```

An order that XO refused. Nothing was placed.

## Properties

### code

```ts
code: OrderRejectionCode;
```

Why the order was refused.

***

### message

```ts
message: string;
```

XO's words for the refusal.

***

### ok

```ts
ok: false;
```

`false`: the order was refused.

***

### orderHash

```ts
orderHash: OrderHash;
```

The hash of the signed order, computed here before it was sent.

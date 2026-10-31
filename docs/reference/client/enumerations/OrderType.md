# Enumeration: OrderType

How long an order lives, and what happens to the part that does not fill at once.

## Example

```ts
OrderType.GTC; // 'GTC'
```

## Enumeration Members

### FAK

```ts
FAK: "FAK";
```

Fill and kill: fills what it can at once and drops the rest.

***

### FOK

```ts
FOK: "FOK";
```

Fill or kill: fills completely at once, or not at all.

***

### GTC

```ts
GTC: "GTC";
```

Good till cancelled: rests on the book until it fills or you cancel it.

***

### GTD

```ts
GTD: "GTD";
```

Good till date: rests until it fills, you cancel it, or its expiration passes.

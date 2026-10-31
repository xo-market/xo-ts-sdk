# Type Alias: PortfolioEvent

```ts
type PortfolioEvent = object;
```

`positions`: the account's positions each time they change (and once when the subscription
opens): the positions `listPositions` lists, in the first 100 markets of the account (all of
them for an account in fewer markets). Replace what you hold with each one.

## Properties

### positions

```ts
positions: Position[];
```

The positions.

***

### timestamp

```ts
timestamp: number;
```

When XO built the list, in Unix milliseconds.

***

### topic

```ts
topic: "portfolio";
```

`'portfolio'`.

***

### type

```ts
type: "positions";
```

`'positions'`.

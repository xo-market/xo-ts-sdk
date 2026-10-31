# Interface: Market

A market.

The orderbook identifies a CLOB market by `conditionId`; `contractMarketId` is the
indexer's key (the condition id for V3 CLOB markets, the contract address for older ones).

## Properties

### conditionId?

```ts
optional conditionId?: string | null;
```

The CTF condition id: the orderbook's `market_id` for CLOB markets.

***

### id

```ts
id: number;
```

***

### slug

```ts
slug: string;
```

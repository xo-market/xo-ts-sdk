# Type Alias: RedemptionResult

```ts
type RedemptionResult = 
  | {
  conditionId: ConditionId;
  ok: true;
  transaction: TransactionHandle;
}
  | {
  conditionId: ConditionId;
  error: XoError;
  ok: false;
};
```

What became of one market of `redeemAllPositions`. `ok: true` when its redemption was sent
and mined: check `transaction.wait()` for a revert. `ok: false` when it was not redeemed,
with why in `error`: `mayHaveLanded: false` means nothing was sent for it (a check failed,
the market is not resolved on chain, or an earlier market's send may have landed and the
rest were held back with `skipped_after_ambiguous`); any other error may have landed, so
look its `transactionHash` (or `nonce`) up before you redeem that market again.

## Union Members

### Type Literal

```ts
{
  conditionId: ConditionId;
  ok: true;
  transaction: TransactionHandle;
}
```

#### conditionId

```ts
conditionId: ConditionId;
```

The market redeemed.

#### ok

```ts
ok: true;
```

The redemption was sent and mined.

#### transaction

```ts
transaction: TransactionHandle;
```

The redemption's transaction.

***

### Type Literal

```ts
{
  conditionId: ConditionId;
  error: XoError;
  ok: false;
}
```

#### conditionId

```ts
conditionId: ConditionId;
```

The market.

#### error

```ts
error: XoError;
```

Why. Its `mayHaveLanded` says whether a transaction may have been sent.

#### ok

```ts
ok: false;
```

The market was not redeemed.

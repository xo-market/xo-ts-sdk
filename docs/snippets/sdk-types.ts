// Code that docs/README.md quotes: type-checked, never run.

// #region types
import type {
  ConditionId,
  DecimalString,
  Market,
  OrderBook,
  TokenId,
} from '@xomarket/client';
// #endregion types

export type Used = [ConditionId, DecimalString, Market, OrderBook, TokenId];

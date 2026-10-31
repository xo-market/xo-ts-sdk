# Type Alias: OrderRejectionCode

```ts
type OrderRejectionCode = typeof ORDER_REJECTION_CODES[number];
```

Why XO refused an order, as the `code` of a [RejectedOrderResponse](RejectedOrderResponse.md). A code stays the
same between releases; the `message` next to it is XO's own words and can change.

- `post_only_would_cross`: a post-only order would have traded at once.
- `duplicate_order`: this exact signed order is already on the book or has already traded.
- `size_below_minimum`: fewer shares than the smallest order.
- `notional_below_minimum`: too small in dollars at this price.
- `price_out_of_range`: the price is outside 0.001 to 0.999.
- `invalid_expiration`: the expiration is missing, in the past or too soon.
- `market_not_active`: the market is not open for orders: not started, paused or over.
- `market_not_found`: XO has no market for this token.
- `insufficient_balance`: not enough USDC for the order.
- `insufficient_position`: fewer shares than the order sells.
- `account_not_found`: XO does not know this trading account.
- `order_cancelled_during_hold`: the order was cancelled while it waited to be matched.
- `trading_paused`: trading is paused for everyone.
- `rejected`: any other refusal. The `message` has the reason.

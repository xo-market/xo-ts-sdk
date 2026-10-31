/**
 * Which side of the book an order or a trade is on.
 *
 * @example
 * OrderSide.BUY; // 'BUY'
 */
export enum OrderSide {
  /** Buy shares: bid for them. */
  BUY = 'BUY',
  /** Sell shares: offer them. */
  SELL = 'SELL',
}

/**
 * How long an order lives, and what happens to the part that does not fill at once.
 *
 * @example
 * OrderType.GTC; // 'GTC'
 */
export enum OrderType {
  /** Good till cancelled: rests on the book until it fills or you cancel it. */
  GTC = 'GTC',
  /** Good till date: rests until it fills, you cancel it, or its expiration passes. */
  GTD = 'GTD',
  /** Fill or kill: fills completely at once, or not at all. */
  FOK = 'FOK',
  /** Fill and kill: fills what it can at once and drops the rest. */
  FAK = 'FAK',
}

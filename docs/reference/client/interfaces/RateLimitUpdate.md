# Interface: RateLimitUpdate

What a client's rate-limit callback receives, once per response that carries a rate-limit
header and once per 429. Fields the response did not carry are left out.

## Example

```ts
const client = createPublicClient({
  onRateLimitUpdate: (update) => {
    if (update.remaining === 0) {
      console.log(`${update.service} limit reached; resets in ${update.resetMs} ms`);
    }
  },
});
```

## Properties

### limit?

```ts
optional limit?: number;
```

From `X-RateLimit-Limit`.

***

### path

```ts
path: string;
```

The request path, without the query.

***

### remaining?

```ts
optional remaining?: number;
```

From `X-RateLimit-Remaining`.

***

### resetMs?

```ts
optional resetMs?: number;
```

From `X-RateLimit-Reset`, which is in seconds, converted to milliseconds.

***

### retryAfter?

```ts
optional retryAfter?: number;
```

How long the service asks to wait, in milliseconds: from `retry_after_ms` or `Retry-After` on a 429.

***

### service

```ts
service: Service;
```

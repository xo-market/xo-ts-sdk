# Interface: StoredCredentials

Everything stored for one `(env, trading address)` pair. Each kind is optional.

## Properties

### backend?

```ts
optional backend?: BackendCredential;
```

***

### mintPause?

```ts
optional mintPause?: object;
```

Not a secret. Set by a session whose backend key request may have created a key it did
not get (its answer was lost or could not be used), and removed when a key is stored:
when that happened (`atMs`, unix milliseconds by the local clock) and how long logins
stay paused after it (`pauseMs`). A session that starts later honours what is left of
the pause, and asks for a 1-day key until a mint succeeds. A record without it, or with
a malformed one, loads as before.

#### atMs

```ts
atMs: number;
```

#### pauseMs

```ts
pauseMs: number;
```

***

### orderbook?

```ts
optional orderbook?: OrderbookCredential;
```

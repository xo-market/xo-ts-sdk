# Interface: ErrorGuard\<E\>

The guard of an error union: the value of the same name as the union, such as
`ListMarketsError`, whose `isError` narrows a caught `unknown` to exactly the errors that
call can throw.

## Example

```ts
try {
  await client.fetchMarket({ slug });
} catch (error) {
  if (FetchMarketError.isError(error)) {
    console.log(error.code);
  }
}
```

## Type Parameters

| Type Parameter |
| ------ |
| `E` *extends* [`XoError`](../classes/XoError.md) |

## Methods

### isError()

```ts
isError(error): error is E;
```

True when `error` is an instance of any of the guarded classes.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | `unknown` |

#### Returns

`error is E`

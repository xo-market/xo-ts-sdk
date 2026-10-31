# Type Alias: Page\<T\>

```ts
type Page<T> = object;
```

One page of a list.

## Example

```ts
const page = await client.listMarkets({ pageSize: 20 }).firstPage();
console.log(page.items.length, page.hasMore);
```

## Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Properties

### hasMore

```ts
hasMore: boolean;
```

Whether another page can be read after this one.

***

### items

```ts
items: T[];
```

The rows of this page.

***

### limitReached?

```ts
optional limitReached?: boolean;
```

`true` on the last page a listing can reach, when more rows exist beyond its depth cap.
`hasMore` is `false` then. Narrow the listing with filters to reach the rest. Absent when
the listing ended by itself.

***

### nextCursor?

```ts
optional nextCursor?: string;
```

Where the next page starts, for `from`. Opaque: keep it as given. Only while `hasMore` is
`true`.

***

### totalCount?

```ts
optional totalCount?: number;
```

How many rows the whole listing holds, when the service says.

# Type Alias: Paginated\<T\>

```ts
type Paginated<T> = AsyncIterable<Page<T>> & object;
```

A lazy list of pages. Nothing is requested until you read it: `for await` walks the pages in
order, stops after the page with `hasMore: false`, and fetches nothing more when you `break`.
Every walk starts again from the first page (or from the cursor given to `from`).

## Type Parameters

| Type Parameter |
| ------ |
| <a id="type-parameter-t"></a> `T` |

## Type Declaration

### firstPage()

```ts
firstPage(): Promise<Page<T>>;
```

Reads only the first page.

#### Returns

`Promise`\<[`Page`](Page.md)\<`T`\>\>

#### Throws

when the request fails or is cancelled, or the answer does not match its schema.

### from()

```ts
from(cursor?): Paginated<T>;
```

The same list, starting at the page a cursor points to: pass the `nextCursor` of a page of
this list, exactly as given, to carry on from there, even in another process. With no
cursor it starts at the first page. Nothing is requested until the result is read.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `cursor?` | `string` |

#### Returns

`Paginated`\<`T`\>

#### Throws

`invalid_cursor` when the cursor is not one this list gave out: it
  belongs to another list, comes from another SDK version, or was cut short or changed.

#### Throws

when the cursor lies beyond the deepest page the listing
  can reach.

## Example

```ts
const markets = client.listMarkets({ pageSize: 20 });
for await (const page of markets) {
  console.log(page.items.length);
}
const first = await markets.firstPage();
const second = await markets.from(first.nextCursor).firstPage();
```

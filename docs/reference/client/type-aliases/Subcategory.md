# Type Alias: Subcategory

```ts
type Subcategory = object;
```

A node under a category, such as `Football` under `Sports`, with the nodes under it.

## Properties

### active

```ts
active: boolean;
```

Whether the subcategory is in use.

***

### categoryId

```ts
categoryId: string;
```

The id of the category it belongs to.

***

### children

```ts
children: Subcategory[];
```

The subcategories under this one. Empty when there are none.

***

### description

```ts
description: string | null;
```

What the subcategory covers.

***

### id

```ts
id: string;
```

XO's id for the subcategory.

***

### marketCount

```ts
marketCount: number;
```

How many CLOB markets are filed under it, the nodes under it included.

***

### name

```ts
name: string;
```

The subcategory's name.

***

### parentId

```ts
parentId: string | null;
```

The id of the subcategory it sits under. `null` for a node directly under its category.

***

### slug

```ts
slug: string;
```

The subcategory's URL name.

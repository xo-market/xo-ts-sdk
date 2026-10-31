# Type Alias: Category

```ts
type Category = object;
```

A category that markets are filed under, such as `Sports`.

## Properties

### active

```ts
active: boolean;
```

Whether the category is in use.

***

### description

```ts
description: string | null;
```

What the category covers.

***

### id

```ts
id: string;
```

XO's id for the category.

***

### marketCount

```ts
marketCount: number | null;
```

How many CLOB markets are filed under the category. `null` when XO gave no count.

***

### name

```ts
name: string;
```

The category's name.

# Type Alias: ListRewardGroupsRequest

```ts
type ListRewardGroupsRequest = object;
```

What [PublicClient.listRewardGroups](../interfaces/PublicClient.md#listrewardgroups) takes. Every key is optional.

## Properties

### currency?

```ts
optional currency?: "CP" | "USDC";
```

Only the groups that pay in this currency.

***

### includeInactive?

```ts
optional includeInactive?: boolean;
```

Also list the groups that are not paying now.

***

### pageSize?

```ts
optional pageSize?: number;
```

How many groups a page holds, from 1 to 100.

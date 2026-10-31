# Type Alias: RewardsUserProfile

```ts
type RewardsUserProfile = object;
```

The profile of the XO user behind a rewards wallet.

## Properties

### achievements

```ts
achievements: string[];
```

The keys of the badges the user earned.

***

### convictionPoints

```ts
convictionPoints: DecimalString;
```

The user's conviction points, as an exact decimal.

***

### name

```ts
name: string | null;
```

The user's display name.

***

### profileImage

```ts
profileImage: string | null;
```

The user's picture.

***

### tier

```ts
tier: string;
```

The user's tier, such as `Believer`.

***

### userId

```ts
userId: string;
```

XO's id for the user.

***

### username

```ts
username: string;
```

The user's unique name.

***

### verifiedBadge

```ts
verifiedBadge: boolean;
```

Whether the user is verified.

# Type Alias: Profile

```ts
type Profile = object;
```

The account's own profile.

## Properties

### bio

```ts
bio: string | null;
```

The account's biography.

***

### convictionPoints

```ts
convictionPoints: DecimalString;
```

The account's conviction points, as an exact decimal.

***

### createdAt

```ts
createdAt: string;
```

When the account was created, as an ISO 8601 time.

***

### id

```ts
id: string;
```

XO's id for the account.

***

### isAmbassador

```ts
isAmbassador: boolean;
```

Whether the account is an ambassador.

***

### isOg

```ts
isOg: boolean;
```

Whether the account holds the OG role (the top 5% of the daily leaderboard).

***

### isPrivate

```ts
isPrivate: boolean;
```

Whether the profile is hidden from other users.

***

### lastActiveAt

```ts
lastActiveAt: string | null;
```

When the account was last active, as an ISO 8601 time.

***

### lastLoginAt

```ts
lastLoginAt: string | null;
```

When the account last signed in, as an ISO 8601 time.

***

### name

```ts
name: string | null;
```

The account's display name.

***

### points

```ts
points: ProfilePoints;
```

The points the account has earned.

***

### profileImage

```ts
profileImage: string | null;
```

The account's picture.

***

### referralCode

```ts
referralCode: string | null;
```

The account's referral code.

***

### socials

```ts
socials: ProfileSocials;
```

The account's connected social handles.

***

### status

```ts
status: "ACTIVE" | "SUSPENDED" | "BANNED" | "INACTIVE" | string & object;
```

The account's standing, such as `ACTIVE`.

***

### tier

```ts
tier: string;
```

The account's tier, such as `Believer`.

***

### updatedAt

```ts
updatedAt: string;
```

When the account last changed, as an ISO 8601 time.

***

### username

```ts
username: string;
```

The account's unique name.

***

### verifiedBadge

```ts
verifiedBadge: boolean;
```

Whether the account is verified.

***

### volume

```ts
volume: DecimalString;
```

The total volume the account has traded, in dollars.

***

### wallet

```ts
wallet: Address;
```

The account's wallet address.

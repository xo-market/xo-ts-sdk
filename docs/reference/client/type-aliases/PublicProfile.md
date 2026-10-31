# Type Alias: PublicProfile

```ts
type PublicProfile = object;
```

The profile of any user, as others see it. A private profile has `null` for what it hides.

## Properties

### achievements

```ts
achievements: string[] | null;
```

The keys of the badges the user earned. `null` on a private profile.

***

### badges

```ts
badges: ProfileBadge[] | null;
```

The user's badges. `null` on a private profile.

***

### bio

```ts
bio: string | null;
```

The user's biography. `null` on a private profile.

***

### convictionPoints

```ts
convictionPoints: DecimalString | null;
```

The user's conviction points, as an exact decimal.

***

### id

```ts
id: string;
```

XO's id for the user.

***

### isOg

```ts
isOg: boolean;
```

Whether the user holds the OG role (the top 5% of the daily leaderboard).

***

### isPrivate

```ts
isPrivate: boolean;
```

Whether the profile is hidden.

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

### socials

```ts
socials: ProfileSocials | null;
```

The user's connected social handles. `null` on a private profile.

***

### tier

```ts
tier: string | null;
```

The user's tier, such as `Believer`.

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

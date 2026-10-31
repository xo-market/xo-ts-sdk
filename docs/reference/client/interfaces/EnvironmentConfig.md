# Interface: EnvironmentConfig

The typed configuration every client uses: URLs, chain id and contract addresses.

## Properties

### backendSocketUrl

```ts
backendSocketUrl: string;
```

***

### backendUrl

```ts
backendUrl: string;
```

***

### bridge?

```ts
optional bridge?: boolean;
```

Whether this environment has the deposit and withdrawal bridge. Leave it out, or set it to
`false`, when it has none: every deposit and withdrawal member then fails with
`bridge_not_available` before any request. [production](../variables/production.md) has it (`true`). Set it to
`true` on a custom config whose backend serves the bridge routes.

***

### chainId

```ts
chainId: number;
```

***

### contracts

```ts
contracts: object;
```

#### clobMarketManager

```ts
clobMarketManager: `0x${string}`;
```

#### conditionalTokens

```ts
conditionalTokens: `0x${string}`;
```

#### ctfExchange

```ts
ctfExchange: `0x${string}`;
```

#### ecdsaValidator

```ts
ecdsaValidator: `0x${string}`;
```

#### kernelFactory

```ts
kernelFactory: `0x${string}`;
```

#### usdc

```ts
usdc: `0x${string}`;
```

***

### kernelVersion

```ts
kernelVersion: "0.3.1";
```

***

### name

```ts
name: string;
```

***

### orderbookMarketWsUrl

```ts
orderbookMarketWsUrl: string;
```

***

### orderbookUrl

```ts
orderbookUrl: string;
```

***

### orderbookUserWsUrl

```ts
orderbookUserWsUrl: string;
```

***

### rpcUrl

```ts
rpcUrl: string;
```

***

### siweDomain

```ts
siweDomain: string;
```

The `domain` of the SIWE (EIP-4361) message the backend issues for a wallet login,
for example `beta.xo.market`. The SDK signs a login message only if it names this
domain, so a compromised or look-alike server cannot get a signature for another site.

***

### siweUri

```ts
siweUri: string;
```

The `URI` of that message, for example `https://beta.xo.market`. Compared as written.

***

### sponsorUrl?

```ts
optional sponsorUrl?: string;
```

This environment's gas path is the sponsor: the service that pays the gas of sponsored
transactions, for plain wallets and smart wallets alike. [production](../variables/production.md) has one.
Without it, only `rail: 'direct'` (a plain wallet that pays its own gas) can send.

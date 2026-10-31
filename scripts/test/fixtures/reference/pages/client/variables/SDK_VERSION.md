# Variable: SDK\_VERSION

```ts
const SDK_VERSION: string = pkg.version;
```

The package version, sent as `X-XO-SDK: ts/<version>`. The build (tsdown) inlines it from
`package.json`, so a release bump changes it with nothing else to edit.

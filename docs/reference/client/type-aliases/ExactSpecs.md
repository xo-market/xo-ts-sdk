# Type Alias: ExactSpecs\<S\>

```ts
type ExactSpecs<S> = { readonly [I in keyof S]: S[I] & { readonly [K in Exclude<keyof S[I], S[I] extends infer E ? E extends { topic: infer T } ? keyof Extract<SubscriptionSpec, { topic: T }> : never : never>]: never } };
```

The specs as written, with every key their topic does not take typed `never`: a key a topic
does not know does not compile, as an option a call does not take does not.

## Type Parameters

| Type Parameter |
| ------ |
| <a id="type-parameter-s"></a> `S` *extends* readonly `unknown`[] |

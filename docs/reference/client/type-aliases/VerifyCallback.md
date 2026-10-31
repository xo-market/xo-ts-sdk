# Type Alias: VerifyCallback

```ts
type VerifyCallback = (request) => boolean | Promise<boolean>;
```

Decides whether the owner signs what the bridge asks. It gets the decoded request and answers
`true` to approve it; anything else (`false`, `undefined`) means it is not approved. It is
called once per item, in order, and only after every item passed the SDK's own checks. Nothing
is signed until it approved all of them.

**A callback that throws, or returns a rejected promise, has not approved.** The SDK raises an
`AuthRequiredError` with the code `verification_required` and `mayHaveLanded: false`, with the
`paymentId`, and the throw is that error's `cause`; nothing is signed. That holds whatever is
thrown, an error of the SDK included. The payment stays as it was, so it can be finished later
with `verify(paymentId, ...)`.

Show the owner what is being signed (`request.decoded`) before answering `true`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `request` | [`VerificationRequest`](../interfaces/VerificationRequest.md) |

## Returns

`boolean` \| `Promise`\<`boolean`\>

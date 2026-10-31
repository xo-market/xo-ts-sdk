# Function: kernelCreateAccountCalldata()

```ts
function kernelCreateAccountCalldata(
   owner, 
   index, 
   validator
): `0x${string}`;
```

The calldata of `factory.createAccount(...)` for an owner, as the Kernel factory
expects it: `createAccount(initialize(0x01 || validator, address(0), owner, 0x, []), bytes32(index))`.

Sent to the factory as a read-only `eth_call`, the answer is the account address the
owner would get, whether or not it is deployed yet. Sent as a transaction, it deploys
the account.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `owner` | `` `0x${string}` `` | The ECDSA owner (the EOA that signs for the account). |
| `index` | `bigint` | The account number of the owner, a `bigint` in `[0, 2^256)`. It is the salt. |
| `validator` | `` `0x${string}` `` | The ECDSA validator module (`production.contracts.ecdsaValidator`). |

## Returns

`` `0x${string}` ``

## Throws

UserInputError, starting with `owner`, `index` or `validator`, for the first of them that is invalid.

// What the bridge client will sign for the bridge provider, and what it refuses to.
//
// The bridge provider's verification payloads come from a server. The SDK signs only what it can
// check, so each payload is decoded here first: a payload that could hurt the owner (an XO order
// or login, a token permit, a message that is not plain text) is refused outright, and the rest
// is signed only after the caller's own callback approved exactly what was decoded.

import type { TypedDataDefinition } from 'viem';
import { withLanded } from '../account/internal';
import type { EnvironmentConfig } from '../core/env';
import { SigningError } from '../core/errors';
import { CLOB_AUTH_DOMAIN_NAME } from '../signing/clobAuth';
import { KERNEL_DOMAIN_NAME } from '../signing/kernel';
import { ORDER_DOMAIN_NAME } from '../signing/order';
import { isObject } from '../wallet/internal';
import { withPaymentId } from './internal';
import type { BridgeVerificationItem } from './schemas';

/**
 * One thing the bridge asks the owner wallet to sign, decoded so the caller can look at it before
 * anything is signed. It is what a {@link VerifyCallback} receives, and the SDK signs exactly
 * `decoded` if the callback approves it. The object is frozen all the way down: changing it
 * changes nothing that is signed.
 */
export interface VerificationRequest {
  /** The payment the signature is for. */
  paymentId: string;
  /** What the signature is for: `'EVM_OWNER'` or `'EVM_WITHDRAWAL'`. An item with any other reason is refused before the callback is asked. */
  reason: 'EVM_OWNER' | 'EVM_WITHDRAWAL';
  /** How `payload` is signed: `'EIP712'` (typed data) or `'EIP191'` (a message). */
  signatureType: 'EIP712' | 'EIP191';
  /** What the bridge sent, as it sent it. */
  payload: string;
  /**
   * What will be signed, parsed: the typed data of an EIP-712 payload (`signTypedData`), or the
   * text of an EIP-191 payload (`signMessage`).
   */
  decoded:
    | { kind: 'eip712'; typedData: TypedDataDefinition }
    | { kind: 'eip191'; message: string };
}

/**
 * Decides whether the owner signs what the bridge asks. It gets the decoded request and answers
 * `true` to approve it; anything else (`false`, `undefined`) means it is not approved. It is
 * called once per item, in order, and only after every item passed the SDK's own checks. Nothing
 * is signed until it approved all of them.
 *
 * **A callback that throws, or returns a rejected promise, has not approved.** The SDK raises an
 * `AuthRequiredError` with the code `verification_required` and `mayHaveLanded: false`, with the
 * `paymentId`, and the throw is that error's `cause`; nothing is signed. That holds whatever is
 * thrown, an error of the SDK included. The payment stays as it was, so it can be finished later
 * with `verify(paymentId, ...)`.
 *
 * Show the owner what is being signed (`request.decoded`) before answering `true`.
 */
export type VerifyCallback = (
  request: VerificationRequest,
) => boolean | Promise<boolean>;

/** The reasons the bridge provider gives for a signature, and the only ones the SDK signs for. */
const REASONS: readonly string[] = ['EVM_OWNER', 'EVM_WITHDRAWAL'];

/** What `decodeVerification` needs to know about the payment and the environment. */
export interface DecodeContext {
  /** The payment the item belongs to. */
  paymentId: string;
  /** The environment: its contracts and its login domain are XO's own. */
  env: EnvironmentConfig;
  /** The trading wallet (the owner for an EOA, the smart wallet for a smart wallet). */
  tradingAddress: string;
  /** The signer's address: the wallet that would sign. */
  signerAddress: string;
}

/** The most signatures the backend takes in one verification. */
const MAX_VERIFICATION_ITEMS = 4;

/**
 * The EIP-712 types the SDK never signs for a server, matched case-insensitively against every
 * key of `types`, by the name the list gives:
 *
 * - XO's own: `Order` (the exchange, cancels) and `ClobAuth` (the orderbook login);
 * - token permits: `Permit` (EIP-2612), and Permit2's `PermitSingle`, `PermitBatch`,
 *   `PermitTransferFrom`, `PermitBatchTransferFrom`, `PermitWitnessTransferFrom`,
 *   `PermitBatchWitnessTransferFrom`, `PermitDetails` and `TokenPermissions`;
 * - token authorizations (EIP-3009): `TransferWithAuthorization`, `ReceiveWithAuthorization`,
 *   `CancelAuthorization`;
 * - messages that run transactions: Safe's `SafeTx` and `SafeMessage`, ERC-4337's
 *   `UserOperation` and `PackedUserOperation`, `ForwardRequest` and `MetaTransaction`, and
 *   `Delegation`;
 * - smart-account wrappers, which make the signature valid for another message:
 *   `PersonalSign` and `TypedDataSign` (ERC-7739), `CoinbaseSmartWalletMessage` and
 *   `LightAccountMessage`;
 * - orders that move tokens on a signature: Seaport's `OrderComponents` and `BulkOrder`, and
 *   0x's `LimitOrder` and `RfqOrder`; and the NFT permit `PermitForAll`.
 *
 * It is a deny-list. There is no allowlist of chains or contracts: whatever names none of these
 * is the caller's callback to judge.
 */
const FORBIDDEN_TYPES: ReadonlyMap<string, string> = new Map(
  [
    'Order',
    'ClobAuth',
    'Permit',
    'PermitSingle',
    'PermitBatch',
    'PermitTransferFrom',
    'PermitBatchTransferFrom',
    'PermitWitnessTransferFrom',
    'PermitBatchWitnessTransferFrom',
    'PermitDetails',
    'TokenPermissions',
    'TransferWithAuthorization',
    'ReceiveWithAuthorization',
    'CancelAuthorization',
    'SafeTx',
    'SafeMessage',
    'UserOperation',
    'PackedUserOperation',
    'ForwardRequest',
    'MetaTransaction',
    'Delegation',
    'PersonalSign',
    'TypedDataSign',
    'CoinbaseSmartWalletMessage',
    'LightAccountMessage',
    'OrderComponents',
    'BulkOrder',
    'LimitOrder',
    'RfqOrder',
    'PermitForAll',
  ].map((name) => [name.toLowerCase(), name]),
);

/** The EIP-712 domain names XO itself signs with: the exchange (orders, cancels), the login and Kernel. */
const XO_DOMAIN_NAMES: ReadonlySet<string> = new Set([
  ORDER_DOMAIN_NAME,
  CLOB_AUTH_DOMAIN_NAME,
  KERNEL_DOMAIN_NAME,
]);

/** The only fields an EIP-712 domain has, in the standard order, with their standard types. */
const DOMAIN_FIELDS: readonly { name: string; type: string }[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

/** An EIP-191 message: printable ASCII, tab, line feed and carriage return. */
const MESSAGE_PATTERN = /^[\x20-\x7E\t\n\r]+$/;
const MAX_MESSAGE_CHARS = 4000;
/** A message of this many bytes can be a hash: see {@link decodeMessage}. */
const HASH_BYTES = 32;
/** Text that is only hex: a signer may decode it to bytes. */
const HEX_TEXT_PATTERN = /^0x[0-9a-fA-F]*$/;
/** The sentence every EIP-4361 (sign-in with Ethereum) message has. */
const SIGN_IN_SENTENCE = 'wants you to sign in with your ethereum account';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SALT_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** What the SDK reads of an EIP-712 payload, in UTF-8 bytes. */
const MAX_TYPED_DATA_BYTES = 64 * 1024;
/** The deepest a message may nest, structs and arrays together. */
const MAX_DEPTH = 32;
/** A type or field name. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A field type: a name, then array suffixes such as `[]` or `[3]`. */
const FIELD_TYPE = /^([A-Za-z_$][A-Za-z0-9_$]*)((?:\[\d*\])*)$/;
/** `bytesN`, and `uintN` or `intN`: the size is checked apart (1 to 32 bytes; 8 to 256 bits, by 8). */
const BYTES_N_TYPE = /^bytes([1-9]\d?)$/;
const INTEGER_TYPE = /^(u?)int([1-9]\d{0,2})$/;
/** A value of `bytes` or `bytesN`: `0x` and whole bytes of hex. */
const BYTES_VALUE = /^0x(?:[0-9a-fA-F]{2})*$/;
/** An integer as text: decimal with an optional minus, or `0x` and hex digits. */
const DECIMAL_INTEGER = /^-?\d+$/;
const HEX_INTEGER = /^0x[0-9a-fA-F]+$/;
/** The longest integer text read: `-` and the 78 digits of 2^256 fit. */
const MAX_INTEGER_CHARS = 80;

/**
 * The error for a payload (or a set of items) that is never signed. `why` is a fixed text:
 * nothing the server sent is quoted.
 */
export function payloadRefused(paymentId: string, why: string): SigningError {
  return withPaymentId(
    withLanded(
      new SigningError(
        `Payment ${paymentId}: the verification is refused and nothing was signed (${why})`,
        { code: 'verification_payload_refused' },
      ),
      false,
    ),
    paymentId,
  );
}

/** Freezes `value` and everything inside it (the rebuilt typed data). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * The addresses an EIP-712 domain must not be bound to: XO's contracts, the trading wallet and
 * the signer (a domain bound to the signer's own address is a message to the owner's account).
 */
function boundAddresses(ctx: DecodeContext): Set<string> {
  const addresses = Object.values(ctx.env.contracts).map((address) =>
    address.toLowerCase(),
  );
  for (const own of [ctx.tradingAddress, ctx.signerAddress]) {
    if (typeof own === 'string') {
      addresses.push(own.toLowerCase());
    }
  }
  return new Set(addresses);
}

/**
 * The integer a value of `uintN` or `intN` stands for, as the signer reads it (viem's `BigInt`
 * of the value), or `undefined` when the value is not one the SDK can show as it is signed: a
 * number that is not a safe integer, or text that is not plain decimal digits (with an optional
 * minus) or `0x` and hex digits. `BigInt` would also take `' 42'`, `''` (as 0) or `'0b101'`.
 */
function integerOf(value: unknown): bigint | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (
    typeof value === 'string' &&
    value.length <= MAX_INTEGER_CHARS &&
    (DECIMAL_INTEGER.test(value) || HEX_INTEGER.test(value))
  ) {
    return BigInt(value);
  }
  return undefined;
}

/**
 * Whether `value` is a value of the atomic Solidity type `type` that is signed as it is shown:
 *
 * - `string`: text; `bool`: `true` or `false`;
 * - `address`: `0x` and 40 hex digits;
 * - `bytes`: `0x` and an even number of hex digits; `bytesN` (N from 1 to 32): `0x` and exactly
 *   2N hex digits;
 * - `uintN` and `intN` (N from 8 to 256, by 8): a safe integer number, or text of decimal digits
 *   (with an optional minus) or `0x` and hex digits, within the type's range (0 and up for
 *   `uintN`).
 *
 * Any other type (`uint` and `int` without a size, a size the signer does not know, a name that
 * is not one of the payload's structs) has no value that fits.
 */
function fitsAtomic(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'address':
      return typeof value === 'string' && ADDRESS_PATTERN.test(value);
    case 'bytes':
      return typeof value === 'string' && BYTES_VALUE.test(value);
  }
  const bytes = BYTES_N_TYPE.exec(type);
  if (bytes !== null) {
    const size = Number(bytes[1]);
    return (
      size <= 32 &&
      typeof value === 'string' &&
      value.length === 2 + 2 * size &&
      BYTES_VALUE.test(value)
    );
  }
  const integer = INTEGER_TYPE.exec(type);
  if (integer !== null) {
    const bits = Number(integer[2]);
    if (bits > 256 || bits % 8 !== 0) {
      return false;
    }
    const n = integerOf(value);
    if (n === undefined) {
      return false;
    }
    const signed = integer[1] === '';
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
    return n >= min && n <= max;
  }
  return false;
}

/**
 * Whether a parsed JSON value holds, anywhere, a number that is not a safe integer: `JSON.parse`
 * has already rounded it (`9007199254740993` reads as `…992`), so it cannot be shown as the
 * server sent it. Walked with a stack, not recursion: the payload is at most 64 KB, but it can
 * nest deeply.
 */
function hasUnsafeNumber(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        return true;
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) {
        stack.push(child);
      }
    }
  }
  return false;
}

/** The types of the payload as fresh plain objects, holding only a name and a type per field. */
type RebuiltTypes = Record<string, { name: string; type: string }[]>;

/**
 * An EIP-712 payload as typed data, or a refusal. What it returns is not the parsed payload but
 * a copy rebuilt from its values, in fresh plain objects, with only the keys the EIP-712 data
 * model has: the domain's five fields, the fields each type lists, and the message keys those
 * fields name. So the object the callback is shown is the object that is signed, and a key the
 * signer would ignore (an extra message key, a domain field the `EIP712Domain` type leaves out)
 * cannot be shown without being signed, or signed without being shown.
 */
function decodeTypedData(
  payload: string,
  ctx: DecodeContext,
): TypedDataDefinition {
  const refuse = (why: string): never => {
    throw payloadRefused(ctx.paymentId, why);
  };
  // `length` counts UTF-16 units, never more than the bytes: past the limit in units is past it
  // in bytes, and the byte count is made only for what could fit.
  if (
    payload.length > MAX_TYPED_DATA_BYTES ||
    new TextEncoder().encode(payload).byteLength > MAX_TYPED_DATA_BYTES
  ) {
    return refuse('the typed data is larger than 64 KB');
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return refuse('the typed data is not JSON');
  }
  if (hasUnsafeNumber(json)) {
    return refuse(
      'a number in the typed data is not a safe integer, so it cannot be shown as it is signed',
    );
  }
  if (!isObject(json)) {
    return refuse('the typed data is not an object');
  }
  const { domain, types, primaryType, message } = json;
  if (
    !isObject(domain) ||
    !isObject(types) ||
    typeof primaryType !== 'string' ||
    !isObject(message)
  ) {
    return refuse(
      'the typed data needs a domain, types, a primaryType and a message',
    );
  }
  for (const name of Object.keys(types)) {
    const forbidden = FORBIDDEN_TYPES.get(name.toLowerCase());
    if (forbidden !== undefined) {
      return refuse(
        `the typed data has a ${forbidden} type, which XO signs itself, which moves tokens or which runs transactions`,
      );
    }
  }
  if (primaryType === 'EIP712Domain') {
    return refuse('the primaryType is EIP712Domain');
  }
  // `hasOwn`, not `in`: a primaryType of `toString` is not a type.
  if (!Object.hasOwn(types, primaryType)) {
    return refuse('the primaryType is not one of the types');
  }

  // The types: names and fields of the EIP-712 kind, copied without anything else they carry.
  const rebuiltTypes: RebuiltTypes = {};
  for (const name of Object.keys(types)) {
    const fields = types[name];
    if (
      !IDENTIFIER.test(name) ||
      name === '__proto__' ||
      !Array.isArray(fields) ||
      !fields.every(
        (field) =>
          isObject(field) &&
          typeof field.name === 'string' &&
          IDENTIFIER.test(field.name) &&
          field.name !== '__proto__' &&
          typeof field.type === 'string' &&
          FIELD_TYPE.test(field.type),
      )
    ) {
      return refuse('a type of the typed data is malformed');
    }
    rebuiltTypes[name] = fields.map((field: Record<string, unknown>) => ({
      name: field.name as string,
      type: field.type as string,
    }));
  }

  // The domain: the five fields of EIP-712, each of its type, in the standard order.
  const rebuiltDomain: Record<string, string | number> = {};
  for (const key of Object.keys(domain)) {
    if (!DOMAIN_FIELDS.some((field) => field.name === key)) {
      return refuse(
        'the domain has a field other than name, version, chainId, verifyingContract and salt',
      );
    }
  }
  for (const { name } of DOMAIN_FIELDS) {
    if (!Object.hasOwn(domain, name)) {
      continue;
    }
    const value = domain[name];
    const fits =
      name === 'chainId'
        ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        : name === 'verifyingContract'
          ? typeof value === 'string' && ADDRESS_PATTERN.test(value)
          : name === 'salt'
            ? typeof value === 'string' && SALT_PATTERN.test(value)
            : typeof value === 'string';
    if (!fits) {
      return refuse('a domain field has the wrong type');
    }
    if ((name === 'name' || name === 'version') && value === '') {
      return refuse('the domain has an empty name or version');
    }
    rebuiltDomain[name] = value as string | number;
  }

  // The EIP712Domain type, when the payload spells it out, is the one these fields have: the
  // domain separator is hashed over the fields it lists, so a different list is a different
  // domain from the one shown.
  const domainType = Object.hasOwn(rebuiltTypes, 'EIP712Domain')
    ? rebuiltTypes.EIP712Domain
    : undefined;
  if (domainType !== undefined) {
    const expected = DOMAIN_FIELDS.filter((field) =>
      Object.hasOwn(rebuiltDomain, field.name),
    );
    if (
      domainType.length !== expected.length ||
      !expected.every((field) =>
        domainType.some(
          (listed) => listed.name === field.name && listed.type === field.type,
        ),
      )
    ) {
      return refuse('the EIP712Domain type does not match the domain');
    }
  }

  if (
    typeof rebuiltDomain.name === 'string' &&
    XO_DOMAIN_NAMES.has(rebuiltDomain.name)
  ) {
    return refuse("the domain is one XO signs with: it is not the bridge's");
  }
  if (
    typeof rebuiltDomain.verifyingContract === 'string' &&
    boundAddresses(ctx).has(rebuiltDomain.verifyingContract.toLowerCase())
  ) {
    return refuse(
      'the domain is bound to a contract of XO, to the trading wallet or to the signer',
    );
  }

  // The message: only the keys its type lists, down through nested structs and arrays.
  const rebuildValue = (
    type: string,
    value: unknown,
    depth: number,
  ): unknown => {
    if (depth > MAX_DEPTH) {
      return refuse('the message is nested too deeply');
    }
    const [, base = '', suffix = ''] = FIELD_TYPE.exec(type) ?? [];
    if (suffix !== '') {
      if (!Array.isArray(value)) {
        return refuse('a value of the message does not fit its type');
      }
      // The last suffix is the outer array. A fixed size (`[2]`) is signed with the elements the
      // array holds, whatever their number: one of another length is not the type shown.
      const outer = suffix.lastIndexOf('[');
      const size = suffix.slice(outer + 1, -1);
      if (size !== '' && value.length !== Number(size)) {
        return refuse(
          'an array of the message does not have the length its type gives',
        );
      }
      const element = `${base}${suffix.slice(0, outer)}`;
      return value.map((item: unknown) =>
        rebuildValue(element, item, depth + 1),
      );
    }
    if (Object.hasOwn(rebuiltTypes, base)) {
      return rebuildStruct(base, value, depth);
    }
    // An atomic value is signed as the signer reads it: it must be one that reads as shown.
    if (fitsAtomic(base, value)) {
      return value;
    }
    return refuse('a value of the message does not fit its type');
  };
  const rebuildStruct = (
    typeName: string,
    value: unknown,
    depth: number,
  ): Record<string, unknown> => {
    if (depth > MAX_DEPTH) {
      return refuse('the message is nested too deeply');
    }
    if (!isObject(value)) {
      return refuse('a value of the message does not fit its type');
    }
    const fields = rebuiltTypes[typeName] ?? [];
    for (const key of Object.keys(value)) {
      if (!fields.some((field) => field.name === key)) {
        return refuse('the message has a field its type does not have');
      }
    }
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (Object.hasOwn(value, field.name)) {
        out[field.name] = rebuildValue(
          field.type,
          value[field.name],
          depth + 1,
        );
      }
    }
    return out;
  };
  const rebuiltMessage = rebuildStruct(primaryType, message, 0);

  const typedData = {
    domain: rebuiltDomain,
    types: rebuiltTypes,
    primaryType,
    message: rebuiltMessage,
  };
  try {
    deepFreeze(typedData);
  } catch {
    return refuse('the typed data is nested too deeply');
  }
  return typedData as unknown as TypedDataDefinition;
}

/**
 * An EIP-191 payload as the message to sign, or a refusal. Besides the character rules, three
 * kinds of text are refused because signing them is not signing what they say:
 *
 * - a message of exactly 32 bytes: Kernel's ECDSA validator accepts the eth-signed form of a
 *   32-byte hash, and so does Safe's `eth_sign` mode, so it signs an arbitrary hash;
 * - text that is only hex (`0x` and hex digits): a signer that hands a string to
 *   `personal_sign` may decode it to bytes, and 64 digits are 32 bytes;
 * - a sign-in message: any EIP-4361 text (the backend allows several domains), and anything
 *   that names the environment's own login domain or URI.
 */
function decodeMessage(payload: string, ctx: DecodeContext): string {
  const refuse = (why: string): never => {
    throw payloadRefused(ctx.paymentId, why);
  };
  if (
    payload.length < 1 ||
    payload.length > MAX_MESSAGE_CHARS ||
    !MESSAGE_PATTERN.test(payload)
  ) {
    return refuse(
      `a message must be 1 to ${MAX_MESSAGE_CHARS} characters of printable ASCII`,
    );
  }
  if (new TextEncoder().encode(payload).byteLength === HASH_BYTES) {
    return refuse(
      `a ${HASH_BYTES}-byte message would sign a hash that cannot be read`,
    );
  }
  if (HEX_TEXT_PATTERN.test(payload)) {
    return refuse(
      'a message that is only hex would sign bytes that cannot be read',
    );
  }
  const text = payload.toLowerCase();
  if (text.includes(SIGN_IN_SENTENCE)) {
    return refuse('the message is an EIP-4361 sign-in message');
  }
  // A login for XO signed here would hand the server a session on the owner's account.
  for (const login of [ctx.env.siweDomain, ctx.env.siweUri]) {
    if (login.length > 0 && text.includes(login.toLowerCase())) {
      return refuse('the message is a login for XO');
    }
  }
  return payload;
}

/**
 * One item the bridge provider asks the owner to sign, decoded and checked. A payload the SDK
 * never signs for a server is refused here, before the caller's callback is asked anything:
 *
 * - The `reason` must be `'EVM_OWNER'` or `'EVM_WITHDRAWAL'`.
 * - EIP-712 (`'EIP712'`): at most 64 KB of JSON with a `domain`, `types`, a `primaryType` that
 *   is one of the `types` (and not `EIP712Domain`), and a `message`. No number anywhere in it may
 *   be other than a safe integer (`JSON.parse` has rounded it).
 *   - Refused when any type is on the deny-list (see `FORBIDDEN_TYPES`: XO's `Order` and
 *     `ClobAuth`, the permit, authorization, Safe, ERC-4337, meta-transaction, delegation,
 *     smart-account wrapper and token order types), in any letter case. There is no allowlist of
 *     chains or contracts.
 *   - The domain may have only `name`, `version` (text that is not empty), `chainId` (a safe
 *     integer number), `verifyingContract` (an address) and `salt` (32 bytes of hex); an
 *     `EIP712Domain` type, if there is one, must list exactly those with their standard types. It
 *     is refused when its name is one XO signs with (the exchange, the login, Kernel), or its
 *     `verifyingContract` is one of the environment's contracts, the trading wallet or the signer
 *     (in any letter case).
 *   - The message may have only the keys its struct type lists, down through nested structs and
 *     arrays of structs, and every atomic value must fit its Solidity type (see `fitsAtomic`), so
 *     the signer reads each value as the callback is shown it. An array of a fixed size
 *     (`uint256[2]`, at any level of `uint256[2][3]`) must hold exactly that many elements.
 *   - What is returned is rebuilt from the parsed values, not the parsed payload itself.
 * - EIP-191 (`'EIP191'`): 1 to 4000 characters of printable ASCII, tab, line feed and carriage
 *   return; not 32 bytes long, not only hex, and not a sign-in message (EIP-4361, or one that
 *   names the environment's login domain or URI).
 * - Any other `signatureType` is refused.
 *
 * What it returns is frozen all the way down.
 *
 * @throws {SigningError} `verification_payload_refused`, with `mayHaveLanded: false` and the
 *   `paymentId`. The message names the rule, never the payload.
 */
export function decodeVerification(
  item: BridgeVerificationItem,
  ctx: DecodeContext,
): VerificationRequest {
  if (
    !isObject(item) ||
    typeof item.payload !== 'string' ||
    typeof item.reason !== 'string'
  ) {
    throw payloadRefused(ctx.paymentId, 'the item is malformed');
  }
  const { reason, signatureType, payload } = item;
  if (!isReason(reason)) {
    throw payloadRefused(
      ctx.paymentId,
      'the reason is neither EVM_OWNER nor EVM_WITHDRAWAL',
    );
  }
  const request = (
    type: VerificationRequest['signatureType'],
    decoded: VerificationRequest['decoded'],
  ): VerificationRequest =>
    Object.freeze({
      paymentId: ctx.paymentId,
      reason,
      signatureType: type,
      payload,
      decoded: Object.freeze(decoded),
    });
  if (signatureType === 'EIP712') {
    return request('EIP712', {
      kind: 'eip712',
      typedData: decodeTypedData(payload, ctx),
    });
  }
  if (signatureType === 'EIP191') {
    return request('EIP191', {
      kind: 'eip191',
      message: decodeMessage(payload, ctx),
    });
  }
  throw payloadRefused(
    ctx.paymentId,
    'the signature type is neither EIP712 nor EIP191',
  );
}

/** Whether `reason` is one the SDK signs for. */
function isReason(reason: string): reason is VerificationRequest['reason'] {
  return REASONS.includes(reason);
}

/**
 * Every item of a payment's verification, decoded and checked: all of them, before the caller
 * is asked about any. The backend takes 1 to {@link MAX_VERIFICATION_ITEMS} signatures, so a
 * payment with none or with more is refused here.
 *
 * @throws {SigningError} `verification_payload_refused` for the first item that is refused, or
 *   for a number of items the backend cannot take.
 */
export function decodeVerificationItems(
  items: readonly BridgeVerificationItem[] | undefined,
  ctx: DecodeContext,
): VerificationRequest[] {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > MAX_VERIFICATION_ITEMS
  ) {
    throw payloadRefused(
      ctx.paymentId,
      `it needs 1 to ${MAX_VERIFICATION_ITEMS} signatures`,
    );
  }
  return items.map((item) => decodeVerification(item, ctx));
}

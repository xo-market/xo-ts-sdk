// Internal: what every action shares. The actions check their request with a closed schema,
// read their options once, and give a list the cursor rules of its source. No public barrel
// exports this module.

import { z } from 'zod';
import { withLanded } from '../account/internal';
import type { ActionContext, SecureParts } from '../clients/context';
import {
  AuthRequiredError,
  RequestAbortedError,
  TimeoutError,
  UserInputError,
  XoError,
} from '../core/errors';
import type { Paginated } from '../core/paginated';
import type { CallOptions } from '../core/requestOptions';
import { usernameSegment } from '../data/accountParams';
import { slugSegment, UUID_PATTERN } from '../data/params';

/** Whether `check`, which throws on a value it refuses, accepts it. */
function accepts(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/** One past the largest uint256: a token id is below it. */
const UINT256 = 1n << 256n;

/** The field checks of a request. Each refuses with a message that starts at the field's name. */
export const fields = {
  /** A non-empty string; `what` finishes "must be ...". */
  text(what = 'a non-empty string') {
    return z
      .string({ error: `must be ${what}` })
      .min(1, { error: `must be ${what}` });
  },
  bool() {
    return z.boolean({ error: 'must be true or false' });
  },
  /** A valid `Date`. */
  date() {
    return z
      .date({ error: 'must be a valid Date' })
      .refine((value) => !Number.isNaN(value.getTime()), {
        error: 'must be a valid Date',
      });
  },
  /** A whole number from `min` to `max`. */
  whole(min: number, max: number) {
    const message = `must be a whole number from ${min} to ${max}`;
    return z
      .number({ error: message })
      .int({ error: message })
      .min(min, { error: message })
      .max(max, { error: message });
  },
  /** One of the listed strings, exactly. */
  oneOf<const V extends readonly [string, ...string[]]>(values: V) {
    return z.enum(values, { error: `must be one of: ${values.join(', ')}` });
  },
  /** A UUID, such as an event's or a series' id. */
  uuid() {
    return z
      .string({ error: 'must be a UUID' })
      .regex(UUID_PATTERN, { error: 'must be a UUID' });
  },
  /** A URL name: the path-segment rules of the market data (no control character, 300 characters at most). */
  slug() {
    return fields
      .text('a non-empty name of at most 300 characters')
      .refine((value) => accepts(() => slugSegment(value)), {
        error:
          'must be a name of at most 300 characters, without control characters',
      });
  },
  /** A username: 100 characters at most, no control character. */
  username() {
    return fields
      .text('a non-empty name of at most 100 characters')
      .refine((value) => accepts(() => usernameSegment(value)), {
        error:
          'must be a name of at most 100 characters, without control characters',
      });
  },
  /** A condition id: `0x` and 64 hex digits. */
  conditionId() {
    return z
      .string({ error: 'must be 0x followed by 64 hex characters' })
      .regex(/^0[xX][0-9a-fA-F]{64}$/, {
        error: 'must be 0x followed by 64 hex characters',
      });
  },
  /** An outcome token id (`assetId`): a decimal string of digits that fits a uint256. */
  assetId() {
    const message = 'must be an outcome token id: a decimal string of digits';
    return z
      .string({ error: message })
      .refine(
        (value) => /^[0-9]{1,78}$/.test(value) && BigInt(value) < UINT256,
        {
          error: message,
        },
      );
  },
  /** A non-empty list of outcome token ids. */
  assetIds() {
    const message = 'must be a non-empty list of outcome token ids';
    return z
      .array(fields.assetId(), { error: message })
      .min(1, { error: message });
  },
  /** A buy or a sell, as the text of `OrderSide`. */
  side() {
    return fields.oneOf(['BUY', 'SELL']);
  },
  /** A wallet address: `0x` and 40 hex digits, in any case. */
  address() {
    const message = 'must be a 0x-prefixed 20-byte hex address';
    return z
      .string({ error: message })
      .regex(/^0x[0-9a-fA-F]{40}$/, { error: message });
  },
  /** A group id: `0x` and 64 hex digits. */
  groupId() {
    const message =
      'must be 0x followed by 64 hex characters (a 32-byte group id)';
    return z
      .string({ error: message })
      .regex(/^0x[0-9a-fA-F]{64}$/, { error: message });
  },
  /** An id made of digits, such as a market's or a category's. */
  digits() {
    return z
      .string({ error: 'must be a string of digits' })
      .regex(/^[0-9]{1,16}$/, { error: 'must be a string of digits' });
  },
  /** One of XO's own ids, such as a market's or a position's: digits, from 1, without a leading zero. */
  id() {
    const message = 'must be an id: a string of digits, from 1';
    return z
      .string({ error: message })
      .regex(/^[1-9][0-9]{0,14}$/, { error: message });
  },
  /** An amount in whole units: a decimal string, or a number. */
  amount() {
    return z.union([z.string(), z.number()], {
      error: 'must be a decimal string or a number, in whole units',
    });
  },
};

/**
 * The parts only a signed-in client has. The actions that need them are bound on a secure
 * client only; a context without them is a programming error, refused before anything is sent.
 *
 * @throws {AuthRequiredError} `auth_required` when the context has no signed-in parts.
 */
export function secureOf(ctx: ActionContext, label: string): SecureParts {
  const { secure } = ctx;
  if (secure === undefined) {
    throw new AuthRequiredError(
      `${label} needs a client that signed in with a wallet: create it with createSecureClient`,
    );
  }
  return secure;
}

/**
 * Checks the request of a call that sends, before anything is read or sent: its error says so,
 * with `mayHaveLanded: false`.
 *
 * @throws {UserInputError} `invalid_input`, as {@link parseInput}.
 */
export function parseSendInput<S extends z.ZodObject>(
  label: string,
  request: unknown,
  schema: S,
): z.output<S> {
  try {
    return parseInput(label, request, schema);
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
}

/**
 * The signed-in parts of a call that sends, once the client is known to be open: nothing is
 * signed or sent before. Its errors say `mayHaveLanded: false`.
 *
 * @throws {UserInputError} `client_closed` after the client is closed or signed out.
 * @throws {AuthRequiredError} `auth_required` when the context has no signed-in parts.
 */
export function openForSend(ctx: ActionContext, label: string): SecureParts {
  let secure: SecureParts;
  try {
    secure = secureOf(ctx, label);
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
  secure.assertOpen();
  return secure;
}

/**
 * A list whose source rows each hold several items, as one list of the items: every page
 * holds the items of its rows, in order, and keeps the cursor of the source page.
 */
export function flatPages<T>(list: Paginated<T[]>): Paginated<T> {
  const flat = <P extends { items: T[][] }>(page: P) => ({
    ...page,
    items: page.items.flat(),
  });
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of list) {
        yield flat(page);
      }
    },
    async firstPage() {
      return flat(await list.firstPage());
    },
    from(cursor) {
      return flatPages(list.from(cursor));
    },
  };
}

/** The error a read raises when its signal aborts: the signal's reason is its `cause`. */
export function abortedBy(signal: AbortSignal): RequestAbortedError {
  return new RequestAbortedError('The read was cancelled by its signal', {
    cause: signal.reason,
  });
}

/**
 * Runs reads that take no call options of their own (the chain's) under a call's options: an
 * aborted signal rejects with `RequestAbortedError` before anything is read and as soon as it
 * aborts, and the timeout bounds the whole of it with a `TimeoutError`. The reads themselves
 * are not cancelled (a read changes nothing), and their answer is then dropped. Leaves no timer
 * or listener behind.
 */
export async function underCall<T>(
  call: CallOptions,
  run: () => Promise<T>,
): Promise<T> {
  const { signal, timeoutMs } = call;
  if (signal?.aborted) {
    throw abortedBy(signal);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stops: Promise<never>[] = [];
  if (signal !== undefined) {
    stops.push(
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortedBy(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  if (timeoutMs !== false) {
    stops.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TimeoutError(
                `The read took longer than its timeout of ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    );
  }
  try {
    return await Promise.race([run(), ...stops]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** `a, b or c`. */
function listOf(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/**
 * A check for a request that names its subject in exactly one of `keys`: `{ id } | { slug }`.
 * Pass it to `superRefine` on a closed object whose keys are all optional.
 */
export function exactlyOne(keys: readonly string[]) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const given = keys.filter((key) => value[key] !== undefined);
    if (given.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `needs exactly one of ${listOf(keys)}`,
        input: value,
      });
    }
  };
}

/** The most characters of a key the message of an unknown key repeats. */
const MAX_KEY_ECHO = 40;

function describe(issue: z.core.$ZodIssue, allowed: readonly string[]): string {
  const name = issue.path.map(String).join('.');
  // An unknown key is the one issue that lists keys.
  if ('keys' in issue) {
    const key = String(issue.keys[0] ?? '').slice(0, MAX_KEY_ECHO);
    return `unknown key "${key}" (allowed: ${allowed.join(', ')})`;
  }
  // Zod's own wording for a wrong type is "Invalid input: expected ...". The schemas above
  // word it better, so this is only the fallback for a field that has no wording of its own.
  if ('expected' in issue && issue.message.startsWith('Invalid input')) {
    return name === ''
      ? 'the request must be an object'
      : `${name} must be of type ${String(issue.expected)}`;
  }
  return name === '' ? issue.message : `${name} ${issue.message}`;
}

/**
 * Checks a request against its closed schema and returns it, typed. `undefined` is an empty
 * request; anything else must be an object with the schema's keys. A key set to `undefined`
 * counts as left out. The message names the action and the field, and never repeats the value
 * that was refused.
 *
 * @throws {UserInputError} `invalid_input` for an unknown key, a wrong type or range, or a
 *   failed cross-field check.
 */
export function parseInput<S extends z.ZodObject>(
  label: string,
  request: unknown,
  schema: S,
): z.output<S> {
  const result = schema.safeParse(request === undefined ? {} : request);
  if (result.success) {
    return result.data;
  }
  const [issue] = result.error.issues;
  const allowed = Object.keys(schema.shape);
  throw new UserInputError(
    `${label}: ${issue === undefined ? 'the request is not valid' : describe(issue, allowed)}`,
    { code: 'invalid_input' },
  );
}

function invalidCursor(why: string): UserInputError {
  // Never the cursor itself: it is caller input that may end up in logs.
  return new UserInputError(
    `from() needs the nextCursor of a page of this list, exactly as it was given: this cursor ${why}`,
    { code: 'invalid_cursor' },
  );
}

/** A page number as a cursor carries it: digits, no sign and no leading zero. */
const PAGE_NUMBER = /^[1-9][0-9]{0,9}$/;

/**
 * The page a list resumes at: `1` without a cursor, else the cursor's page number. A list
 * addressed by page number gets the page as a decimal string, so any other value is a cursor
 * made by hand.
 *
 * @throws {UserInputError} `invalid_cursor` when the cursor is not a page number.
 */
export function pageNumberOf(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 1;
  }
  if (!PAGE_NUMBER.test(cursor)) {
    throw invalidCursor('is not a page number');
  }
  return Number(cursor);
}

/**
 * Refuses any cursor on a list that is one page and so gives none out.
 *
 * @throws {UserInputError} `invalid_cursor`.
 */
export function noCursor(cursor: string | undefined): void {
  if (cursor !== undefined) {
    throw invalidCursor('is not one this list gave out: it has one page');
  }
}

import { z } from 'zod';
import { toDecimalString } from './decimal';
import { UnexpectedResponseError } from './errors';
import type { DecimalString, RawUnitsString, Service } from './types';

/**
 * A money-like field: a plain decimal string, or a JSON number converted exactly. A value
 * that is neither fails the response. Its message never carries the value.
 */
export const decimalString: z.ZodType<DecimalString> = z
  .union([z.string(), z.number()])
  .transform((value, ctx): DecimalString => {
    try {
      return toDecimalString(value, 'value');
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'expected a plain decimal string or a finite number',
      });
      return z.NEVER;
    }
  });

/**
 * An amount in a token's raw smallest units (`"570000"` for 0.57 of a 6-decimal USDC): the
 * same plain-decimal check and exact number conversion as {@link decimalString}, branded as
 * a {@link RawUnitsString} so it is not mistaken for a whole-unit value. The data client's
 * indexer amounts and the orderbook client's micro-unit amounts use it.
 */
export const rawUnits: z.ZodType<RawUnitsString> = decimalString.transform(
  (value) => value as RawUnitsString,
);

/**
 * Builds an object schema. `defineSchema` hands you the lenient or the strict flavour,
 * so nested objects built with it inherit the strictness of the variant being built.
 *
 * It is typed as `z.object`, so the inferred output is exactly the declared shape. A
 * loose object's own type would add an index signature (`[x: string]: unknown`), which
 * would make a misspelled property read as `unknown` instead of failing to compile.
 */
export type ObjFactory = typeof z.object;

/**
 * Builds an enum schema from its known values. The output type is the same in both
 * variants: the known values, plus any other string.
 */
export type EnumFactory = <const V extends readonly [string, ...string[]]>(
  values: V,
) => z.ZodType<V[number] | (string & {})>;

/**
 * An enum that accepts the listed values and also any other string, so a value the
 * server adds later does not break parsing. It is lenient in every variant. To get an
 * enum that a strict (contract-test) parse rejects, use the `enumOf` that
 * {@link defineSchema} passes to `build`.
 */
export function looseEnum<const T extends readonly [string, ...string[]]>(
  _values: T,
): z.ZodType<T[number] | (string & {})> {
  // At runtime any string is valid; the listed values only shape the TypeScript type,
  // and a plain string schema reports a wrong type as "expected string".
  return z.string();
}

/** The strict counterpart of {@link looseEnum}: rejects values outside the list. */
const strictEnum: EnumFactory = (values) => z.enum(values);

// `ObjFactory` is the static type of `z.object`. At runtime the two variants differ in
// how they treat unknown keys (`z.looseObject` keeps them, `z.strictObject` rejects
// them), and only the static type is unified here: it is what keeps `T` identical in
// both variants and free of an index signature. These two casts are the only place that
// happens, so lenient mode still keeps unknown keys at runtime.
const looseObject = z.looseObject as ObjFactory;
const strictObject = z.strictObject as ObjFactory;

/** A response schema in two flavours that share one output type. */
export interface DualSchema<T> {
  /** Keeps unknown fields and accepts unknown enum values. The default for users. */
  lenient: z.ZodType<T>;
  /** Rejects unknown fields and unknown enum values. Used by contract tests. */
  strict: z.ZodType<T>;
}

/**
 * Defines a response schema once and builds it in both flavours. `build` is called
 * exactly twice, here and now: once with `z.looseObject` and a lenient `enumOf`, once
 * with `z.strictObject` and a strict `enumOf`. Write every object with the `obj` you are
 * given (including nested ones) and every server enum with `enumOf`.
 *
 * Both flavours still throw on a missing or wrong-typed known field, because the
 * TypeScript type cannot describe such data.
 *
 * For an exported response type, write `defineSchema<PublicType>(...)` with an explicit
 * interface: the compiler then checks that the schema produces every field of
 * `PublicType`, and the public type does not depend on how the schema was written.
 */
export function defineSchema<T>(
  build: (obj: ObjFactory, enumOf: EnumFactory) => z.ZodType<T>,
): DualSchema<T> {
  return {
    lenient: build(looseObject, looseEnum),
    strict: build(strictObject, strictEnum),
  };
}

/** How many issues an error message names. */
const MAX_ISSUES = 10;
/** The longest a single formatted issue (and an issue's `message`) may be. */
const MAX_ISSUE_CHARS = 200;
/** The longest the whole issues portion of an error message may be. */
const MAX_ISSUES_CHARS = 1000;

/** Cuts `text` to at most `max` characters, ending with `…` when it was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One issue as it appears on {@link UnexpectedResponseError.issues}. */
export interface ResponseIssue {
  /** The dotted path to the field, or `(root)`. */
  path: string;
  /** The zod issue code, such as `invalid_type` or `unrecognized_keys`. */
  code: string;
  /** The zod message. It names types and keys, never the received value. */
  message: string;
}

/**
 * Checks a decoded response body against `schema`, strictly or leniently, and returns the
 * parsed value (with unknown fields kept in lenient mode).
 *
 * On a mismatch it throws {@link UnexpectedResponseError} naming the service, the request
 * path and the first issues as `<dotted.path>: <zod message>`. The error never holds the
 * response, the values that failed or the `ZodError`: some responses carry credentials,
 * and zod's issues can point at them.
 *
 * Path segments (such as record keys) and the names of unknown keys come from the
 * response, so they can appear in the message. The SDK caps each issue at 200 characters
 * and the whole issues portion at 1000, but it cannot tell a harmless key name from a
 * sensitive one. `ctx.path` is the request path and must not contain a query string.
 */
export function parseResponse<T>(
  schema: DualSchema<T>,
  data: unknown,
  ctx: { strict: boolean; service: Service; path: string },
): T {
  const result = (ctx.strict ? schema.strict : schema.lenient).safeParse(data);
  if (result.success) {
    return result.data;
  }

  const all = result.error.issues;
  const named: ResponseIssue[] = all.slice(0, MAX_ISSUES).map((issue) => ({
    path: truncate(
      issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
      MAX_ISSUE_CHARS,
    ),
    code: issue.code,
    message: truncate(issue.message, MAX_ISSUE_CHARS),
  }));
  const listed = named.map((issue) =>
    truncate(`${issue.path}: ${issue.message}`, MAX_ISSUE_CHARS),
  );
  const more = all.length - named.length;
  const summary = truncate(
    listed.join('; ') + (more > 0 ? ` (and ${more} more)` : ''),
    MAX_ISSUES_CHARS,
  );

  throw new UnexpectedResponseError(
    `Unexpected ${ctx.service} response for ${ctx.path}: ${summary}`,
    { service: ctx.service, issues: named },
  );
}

/** The backend's page metadata of a `{ data, meta }` list. */
export interface PageMeta {
  page: number;
  take: number;
  itemCount: number;
  pageCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export const PageMetaSchema = defineSchema<PageMeta>((obj) =>
  obj({
    page: z.number(),
    take: z.number(),
    itemCount: z.number(),
    pageCount: z.number(),
    hasPreviousPage: z.boolean(),
    hasNextPage: z.boolean(),
  }),
);

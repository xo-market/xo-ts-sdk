import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { z } from 'zod';
import { UnexpectedResponseError, XoError } from '../../src/core/errors';
import {
  type DualSchema,
  defineSchema,
  looseEnum,
  type ObjFactory,
  PageMetaSchema,
  parseResponse,
  type ResponseIssue,
} from '../../src/core/schema';
import type { Service } from '../../src/core/types';

function lenient(
  path = '/things',
  service: Service = 'backend',
): { strict: boolean; service: Service; path: string } {
  return { strict: false, service, path };
}

function strict(
  path = '/things',
  service: Service = 'backend',
): { strict: boolean; service: Service; path: string } {
  return { strict: true, service, path };
}

/** Parses and returns the thrown error, failing the test if nothing is thrown. */
function failure<T>(
  schema: DualSchema<T>,
  data: unknown,
  ctx = strict(),
): UnexpectedResponseError {
  try {
    parseResponse(schema, data, ctx);
  } catch (error) {
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    return error as UnexpectedResponseError;
  }
  throw new Error('expected parseResponse to throw');
}

const ThingSchema = defineSchema((obj) =>
  obj({ id: z.string(), count: z.number() }),
);

const OrderSchema = defineSchema((obj, enumOf) =>
  obj({ id: z.string(), status: enumOf(['LIVE', 'MATCHED']) }),
);

describe('defineSchema', () => {
  test('calls build exactly twice, at definition time', () => {
    const build = vi.fn((obj: ObjFactory) => obj({ id: z.string() }));
    const schema = defineSchema(build);
    expect(build).toHaveBeenCalledTimes(2);

    parseResponse(schema, { id: 'a' }, lenient());
    parseResponse(schema, { id: 'a' }, strict());
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('exposes a lenient and a strict variant', () => {
    expect(ThingSchema.lenient.safeParse({ id: 'a', count: 1 }).success).toBe(
      true,
    );
    expect(ThingSchema.strict.safeParse({ id: 'a', count: 1 }).success).toBe(
      true,
    );
    expect(
      ThingSchema.lenient.safeParse({ id: 'a', count: 1, extra: 1 }).success,
    ).toBe(true);
    expect(
      ThingSchema.strict.safeParse({ id: 'a', count: 1, extra: 1 }).success,
    ).toBe(false);
  });
});

// Type-level tests. `pnpm typecheck` runs `tsc --noEmit` over `test/` too (see
// tsconfig.json), so a `@ts-expect-error` below that stops being an error fails it.
describe('inferred schema types', () => {
  test('the inferred form is exactly the declared shape, so a typo does not compile', () => {
    const Inferred = defineSchema((obj) => obj({ a: z.string() }));
    const value = parseResponse(Inferred, { a: 'x' }, strict());
    expectTypeOf(value).toEqualTypeOf<{ a: string }>();
    // @ts-expect-error `b` is not a property of the inferred type
    expect(value.b).toBeUndefined();
  });

  test('the explicit form rejects a schema that is missing a field', () => {
    interface Foo {
      id: string;
      count: number;
    }
    // @ts-expect-error the schema does not produce `count`
    defineSchema<Foo>((obj) => obj({ id: z.string() }));

    const Explicit = defineSchema<Foo>((obj) =>
      obj({ id: z.string(), count: z.number() }),
    );
    const value = parseResponse(Explicit, { id: 'a', count: 1 }, strict());
    expectTypeOf(value).toEqualTypeOf<Foo>();
    // @ts-expect-error `typo` is not a property of Foo
    expect(value.typo).toBeUndefined();
  });

  test('a nested obj(...) also infers without an index signature', () => {
    const Nested = defineSchema((obj) =>
      obj({
        inner: obj({ n: z.number() }),
        list: z.array(obj({ id: z.string() })),
      }),
    );
    const value = parseResponse(
      Nested,
      { inner: { n: 1 }, list: [{ id: 'a' }] },
      strict(),
    );
    expectTypeOf(value).toEqualTypeOf<{
      inner: { n: number };
      list: Array<{ id: string }>;
    }>();
    // @ts-expect-error `typo` is not a property of the nested object
    expect(value.inner.typo).toBeUndefined();
    // @ts-expect-error `typo` is not a property of an array item
    expect(value.list[0]?.typo).toBeUndefined();
  });

  test('the static type is strip-typed, but lenient mode still keeps unknown keys at runtime', () => {
    const Inferred = defineSchema((obj) =>
      obj({ a: z.string(), inner: obj({ n: z.number() }) }),
    );
    const data = { a: 'x', extra: 1, inner: { n: 1, deep: true } };
    expect(parseResponse(Inferred, data, lenient())).toEqual(data);
    failure(Inferred, data);
  });
});

describe('parseResponse: lenient mode', () => {
  test('returns the parsed output and keeps unknown fields', () => {
    const out = parseResponse(
      ThingSchema,
      { id: 'a', count: 2, extra: { deep: true } },
      lenient(),
    );
    expect(out).toEqual({ id: 'a', count: 2, extra: { deep: true } });
  });

  test('keeps unknown fields of nested objects and array items', () => {
    const schema = defineSchema((obj) =>
      obj({
        inner: obj({ a: z.number() }),
        list: z.array(obj({ b: z.number() })),
      }),
    );
    const data = { inner: { a: 1, x: 'x' }, list: [{ b: 2, y: 'y' }] };
    expect(parseResponse(schema, data, lenient())).toEqual(data);
  });

  test('accepts an unknown enum value', () => {
    const out = parseResponse(
      OrderSchema,
      { id: 'o', status: 'PAUSED' },
      lenient(),
    );
    expect(out.status).toBe('PAUSED');
  });

  test('throws UnexpectedResponseError on a missing required field', () => {
    const error = failure(ThingSchema, { id: 'a' }, lenient());
    expect(error).toBeInstanceOf(XoError);
    expect(error.message).toContain('count');
  });

  test('throws UnexpectedResponseError on a wrong-typed known field', () => {
    const error = failure(ThingSchema, { id: 'a', count: '1' }, lenient());
    expect(error.message).toContain('count');
  });

  test('throws on a non-string enum value, saying a string was expected', () => {
    const error = failure(OrderSchema, { id: 'o', status: 7 }, lenient());
    expect(error.message).toContain(
      'status: Invalid input: expected string, received number',
    );
  });

  test('throws when the payload is not an object', () => {
    failure(ThingSchema, null, lenient());
    failure(ThingSchema, 'nope', lenient());
  });
});

describe('parseResponse: strict mode', () => {
  test('returns the parsed output for a matching payload', () => {
    expect(parseResponse(ThingSchema, { id: 'a', count: 2 }, strict())).toEqual(
      { id: 'a', count: 2 },
    );
  });

  test('throws UnexpectedResponseError on an unknown field', () => {
    const error = failure(ThingSchema, { id: 'a', count: 2, extra: 1 });
    expect(error.message).toContain('extra');
  });

  test('throws UnexpectedResponseError on a type mismatch', () => {
    const error = failure(ThingSchema, { id: 'a', count: '2' });
    expect(error.message).toContain('count');
  });

  test('throws UnexpectedResponseError on a missing required field', () => {
    failure(ThingSchema, { id: 'a' });
  });

  test('throws on an unknown field inside a nested object', () => {
    const schema = defineSchema((obj) =>
      obj({ inner: obj({ a: z.number() }) }),
    );
    expect(parseResponse(schema, { inner: { a: 1 } }, strict())).toEqual({
      inner: { a: 1 },
    });
    const error = failure(schema, { inner: { a: 1, x: 'x' } });
    expect(error.message).toContain('inner: Unrecognized key: "x"');
    expect(error.issues).toEqual([
      {
        path: 'inner',
        code: 'unrecognized_keys',
        message: 'Unrecognized key: "x"',
      },
    ]);
  });

  test('throws on an unknown field inside an array item', () => {
    const schema = defineSchema((obj) =>
      obj({ list: z.array(obj({ b: z.number() })) }),
    );
    const error = failure(schema, { list: [{ b: 1 }, { b: 2, y: 'y' }] });
    expect(error.message).toContain('list.1');
  });
});

describe('looseEnum', () => {
  const Status = looseEnum(['LIVE', 'MATCHED']);

  test('accepts a known value', () => {
    expect(Status.parse('LIVE')).toBe('LIVE');
  });

  test('accepts an unknown string', () => {
    expect(Status.parse('PAUSED')).toBe('PAUSED');
  });

  test('rejects a value that is not a string', () => {
    expect(Status.safeParse(1).success).toBe(false);
    expect(Status.safeParse(null).success).toBe(false);
    expect(Status.safeParse(undefined).success).toBe(false);
  });

  test('reports a number as "expected string"', () => {
    const result = Status.safeParse(1);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Invalid input: expected string, received number',
    ]);
  });

  test('types known values alongside any string', () => {
    expectTypeOf<z.infer<typeof Status>>().toEqualTypeOf<
      'LIVE' | 'MATCHED' | (string & {})
    >();
  });

  test('stays lenient inside a strict variant', () => {
    const schema = defineSchema((obj) =>
      obj({ status: looseEnum(['LIVE', 'MATCHED']) }),
    );
    expect(parseResponse(schema, { status: 'PAUSED' }, strict())).toEqual({
      status: 'PAUSED',
    });
  });
});

describe('enumOf (the enum factory given to defineSchema)', () => {
  test('lenient mode accepts a value outside the list', () => {
    expect(
      parseResponse(OrderSchema, { id: 'o', status: 'LIVE' }, lenient()).status,
    ).toBe('LIVE');
    expect(
      parseResponse(OrderSchema, { id: 'o', status: 'PAUSED' }, lenient())
        .status,
    ).toBe('PAUSED');
  });

  test('strict mode accepts a listed value', () => {
    expect(
      parseResponse(OrderSchema, { id: 'o', status: 'MATCHED' }, strict())
        .status,
    ).toBe('MATCHED');
  });

  test('strict mode rejects a value outside the list', () => {
    const error = failure(OrderSchema, { id: 'o', status: 'PAUSED' });
    expect(error.message).toContain('status');
  });

  test('strict mode rejects a value that is not a string', () => {
    failure(OrderSchema, { id: 'o', status: 7 });
  });

  test('types known values alongside any string in both variants', () => {
    type Order = z.infer<typeof OrderSchema.lenient>;
    expectTypeOf<Order['status']>().toEqualTypeOf<
      'LIVE' | 'MATCHED' | (string & {})
    >();
    expectTypeOf<z.infer<typeof OrderSchema.strict>['status']>().toEqualTypeOf<
      'LIVE' | 'MATCHED' | (string & {})
    >();
  });
});

describe('parseResponse: error', () => {
  test('carries the service from ctx and names the service and path', () => {
    const error = failure(
      ThingSchema,
      { id: 1, count: 1 },
      strict('/markets/live', 'orderbook'),
    );
    expect(error.service).toBe('orderbook');
    expect(error.code).toBe('unexpected_response');
    expect(error.message).toContain('orderbook');
    expect(error.message).toContain('/markets/live');
  });

  test.each(['backend', 'orderbook', 'sponsor'] as const)(
    'sets service %s on the error',
    (service) => {
      expect(failure(ThingSchema, null, strict('/x', service)).service).toBe(
        service,
      );
    },
  );

  test('formats each issue as <dotted.path>: <zod message>', () => {
    const schema = defineSchema((obj) =>
      obj({ items: z.array(obj({ id: z.string() })) }),
    );
    const error = failure(schema, { items: [{ id: 'a' }, { id: 5 }] });
    expect(error.message).toContain(
      'items.1.id: Invalid input: expected string, received number',
    );
  });

  test('uses (root) for an issue with an empty path', () => {
    const error = failure(ThingSchema, 'not an object');
    expect(error.message).toContain('(root): ');
  });

  test('names at most 10 issues', () => {
    const schema = defineSchema((obj) => obj({ items: z.array(z.string()) }));
    const error = failure(schema, {
      items: Array.from({ length: 15 }, () => 0),
    });
    expect(error.message).toContain('items.9: ');
    expect(error.message).not.toContain('items.10: ');
    expect(error.message).toContain('5 more');
    expect(error.issues).toHaveLength(10);
  });

  test('exposes the named issues as plain data', () => {
    const error = failure(ThingSchema, { id: 'a', count: 'x' });
    expect(error.issues).toEqual([
      {
        path: 'count',
        code: 'invalid_type',
        message: 'Invalid input: expected number, received string',
      },
    ]);
  });

  describe('caps on what response keys can put in the message', () => {
    const prefix = 'Unexpected backend response for /things: ';

    test('caps one issue naming 50 long unknown keys at 200 characters', () => {
      const unknown = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`${'k'.repeat(80)}${i}`, 1]),
      );
      const error = failure(ThingSchema, { id: 'a', count: 1, ...unknown });

      const issues = error.issues as ResponseIssue[];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe('unrecognized_keys');
      expect(issues[0]?.message).toHaveLength(200);
      expect(issues[0]?.message.endsWith('…')).toBe(true);

      const portion = error.message.slice(prefix.length);
      expect(portion.length).toBeLessThanOrEqual(200);
      expect(portion.endsWith('…')).toBe(true);
      expect(error.message).not.toContain(`${'k'.repeat(80)}49`);
    });

    test('caps the whole issues portion at 1000 characters', () => {
      const schema = defineSchema((obj) => obj({ list: z.array(obj({})) }));
      // 50 items, each with its own 300-character unknown key: 50 long issues.
      const list = Array.from({ length: 50 }, (_, i) => ({
        [`${String(i).padStart(2, '0')}${'k'.repeat(298)}`]: 1,
      }));
      const error = failure(schema, { list });

      const issues = error.issues as ResponseIssue[];
      expect(issues).toHaveLength(10);
      for (const issue of issues) {
        expect(issue.message.length).toBeLessThanOrEqual(200);
        expect(issue.message.endsWith('…')).toBe(true);
      }

      const portion = error.message.slice(prefix.length);
      expect(portion).toHaveLength(1000);
      expect(portion.endsWith('…')).toBe(true);
      expect(portion.startsWith('list.0: Unrecognized key: "00kkk')).toBe(true);
    });

    test('caps a very long dotted path from a record key', () => {
      const schema = defineSchema(() => z.record(z.string(), z.number()));
      const error = failure(schema, { [`${'p'.repeat(500)}`]: 'not a number' });
      const issues = error.issues as ResponseIssue[];
      expect(issues[0]?.path.length).toBeLessThanOrEqual(200);
      expect(error.message.slice(prefix.length).length).toBeLessThanOrEqual(
        200,
      );
    });

    test('leaves short issues untouched', () => {
      const error = failure(ThingSchema, { id: 'a', count: 'x' });
      expect(error.message).toBe(
        `${prefix}count: Invalid input: expected number, received string`,
      );
    });
  });

  test('never carries the raw response, received values or a ZodError', () => {
    const schema = defineSchema((obj) => obj({ secret: z.number() }));
    const error = failure(schema, { secret: 'S3CRET', apiKey: 'K3Y' });

    expect(error.message).not.toContain('S3CRET');
    expect(error.message).not.toContain('K3Y');

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('S3CRET');
    expect(serialized).not.toContain('K3Y');

    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error.issues)).not.toContain('S3CRET');
    expect(JSON.stringify(error.issues)).not.toContain('K3Y');
  });

  test('never carries received values for an enum mismatch', () => {
    const error = failure(OrderSchema, { id: 'o', status: 'S3CRET' });
    expect(error.message).not.toContain('S3CRET');
    expect(JSON.stringify(error)).not.toContain('S3CRET');
  });
});

describe('PageMetaSchema', () => {
  const meta = {
    page: 1,
    take: 20,
    itemCount: 45,
    pageCount: 3,
    hasPreviousPage: false,
    hasNextPage: true,
  };

  test('parses the backend page meta in both modes', () => {
    expect(parseResponse(PageMetaSchema, meta, lenient())).toEqual(meta);
    expect(parseResponse(PageMetaSchema, meta, strict())).toEqual(meta);
  });

  test('types the fields', () => {
    expectTypeOf(parseResponse(PageMetaSchema, meta, strict())).toEqualTypeOf<{
      page: number;
      take: number;
      itemCount: number;
      pageCount: number;
      hasPreviousPage: boolean;
      hasNextPage: boolean;
    }>();
  });

  test('lenient keeps an unknown field, strict rejects it', () => {
    const withExtra = { ...meta, cursor: 'abc' };
    expect(parseResponse(PageMetaSchema, withExtra, lenient())).toEqual(
      withExtra,
    );
    failure(PageMetaSchema, withExtra);
  });

  test.each([
    ['page'],
    ['take'],
    ['itemCount'],
    ['pageCount'],
    ['hasPreviousPage'],
    ['hasNextPage'],
  ])('requires %s', (field) => {
    const { [field as keyof typeof meta]: _omitted, ...rest } = meta;
    failure(PageMetaSchema, rest, lenient());
    failure(PageMetaSchema, rest, strict());
  });

  test('rejects wrong types', () => {
    failure(PageMetaSchema, { ...meta, page: '1' }, lenient());
    failure(PageMetaSchema, { ...meta, hasNextPage: 'yes' }, lenient());
  });
});

/** Every key at every depth of a plain value. */
export function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...keysOf(child),
    ]);
  }
  return [];
}

/** The keys of a plain value (at any depth) that are snake_case or end in `ID`. */
export function wireStyleKeys(value: unknown): string[] {
  return keysOf(value).filter((key) => /_|ID$/.test(key));
}

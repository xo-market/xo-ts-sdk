// Process-wide state that must stay one per process even when the package is loaded twice:
// an ESM and a CommonJS copy of `@xomarket/client` in one process (the dual-package hazard)
// each have their own module scope, so a module-level variable would exist twice. State kept
// here lives on `globalThis` under a registered symbol, which every copy resolves to the same
// key. Internal: no public barrel exports this module.

/**
 * The state named `name`, created with `create` the first time any copy of the package asks,
 * under `Symbol.for('@xomarket/client/<name>')` on `target` (`globalThis`).
 *
 * - **One key per state, with its own version** in `name` (`'nonce-record.v1'`). Bump it when
 *   that state's shape changes, so two versions of the package never share an incompatible
 *   object. A state whose shape must never split between copies (the executor queue) uses a
 *   stable name that is never bumped.
 * - **Shape check.** An object already under the key that `isShape` refuses (another version,
 *   or something unrelated) is left alone and this copy uses a module-local state of its own.
 * - **Hardened realms.** Where the key cannot be read or defined (a frozen or non-extensible
 *   `globalThis`, a proxy that refuses), it falls back to a module-local state and never
 *   throws, so the package still imports.
 *
 * A module-local state is shared by nothing: that copy then serializes and remembers on its
 * own, as before this module existed.
 */
export function processShared<T extends object>(
  name: string,
  create: () => T,
  isShape: (value: unknown) => value is T,
  target: object = globalThis,
): T {
  const key = Symbol.for(`@xomarket/client/${name}`);
  let existing: unknown;
  try {
    existing = (target as Record<symbol, unknown>)[key];
  } catch {
    return create();
  }
  if (existing !== undefined) {
    return isShape(existing) ? existing : create();
  }
  const created = create();
  try {
    // Not enumerable, so it does not show up when someone lists the globals.
    Object.defineProperty(target, key, {
      value: created,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Frozen or non-extensible: this copy keeps its own state.
  }
  return created;
}

/** Whether `value` is a non-null object (a shape check's first step). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

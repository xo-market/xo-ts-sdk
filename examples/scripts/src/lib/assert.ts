export function never(message = 'Unexpected code path'): never {
  throw new Error(message);
}

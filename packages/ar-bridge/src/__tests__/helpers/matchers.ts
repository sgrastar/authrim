import { expect } from 'vitest';

/** Asymmetric matchers typed as `unknown`, so they can sit inside typed expectations. */
export const anyOf = (constructor: unknown): unknown => expect.any(constructor);
export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const containing = (value: Record<string, unknown>): unknown =>
  expect.objectContaining(value);

/** Throws any value, even one that is not an Error (as a misbehaving dependency may). */
export function throwValue(value: unknown): never {
  throw value as Error;
}

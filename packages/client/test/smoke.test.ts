import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index';

describe('package entry', () => {
  it('resolves the root entry', () => {
    expect(sdk).toBeDefined();
  });
});

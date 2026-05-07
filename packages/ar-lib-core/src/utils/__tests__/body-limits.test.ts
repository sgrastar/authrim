import { describe, expect, it } from 'vitest';
import { readRequestTextWithLimit } from '../body-limits';

describe('body limit utilities', () => {
  it('reads request text within the configured byte limit', async () => {
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: 'hello',
    });

    await expect(readRequestTextWithLimit(request, 5)).resolves.toBe('hello');
  });

  it('rejects request text that exceeds the configured byte limit', async () => {
    const request = new Request('https://auth.example.test/body', {
      method: 'POST',
      body: 'hello!',
    });

    await expect(readRequestTextWithLimit(request, 5)).rejects.toThrow(
      'Body exceeds maximum size'
    );
  });
});

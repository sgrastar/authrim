import { describe, expect, it } from 'vitest';
import { ACCOUNT_PAGE_PRESET_VERSION, DEFAULT_ACCOUNT_PAGE_DEFINITION } from '../types/screens';

describe('default Account Page definition', () => {
  it('shows every built-in widget placement to guest accounts by default', () => {
    expect(ACCOUNT_PAGE_PRESET_VERSION).toBe(3);
    expect(DEFAULT_ACCOUNT_PAGE_DEFINITION.screens).not.toHaveLength(0);
    expect(DEFAULT_ACCOUNT_PAGE_DEFINITION.screens.every((item) => item.show_for_guests)).toBe(
      true
    );
  });
});

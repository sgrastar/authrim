import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../db/adapter';
import { resolveRuntimeScreenRow, type RuntimeScreenRow } from './runtime-screen-resolution';

const row = (key: string): RuntimeScreenRow => ({
  id: `screen-${key}`,
  screen_key: key,
  display_name: key,
  description: null,
  screen_kind: 'login',
  fields_json: '[]',
  localizations_json: null,
  settings_json: null,
});

describe('runtime screen fallback', () => {
  it('uses the immutable template when the default tenant login is editable', async () => {
    const saved = row('login');
    const template = row('login_template');
    const queryOne = vi.fn(async (sql: string, params: unknown[]) => {
      const [tenantId, id, key] = params;
      if (tenantId === 'default' && (id === saved.id || key === saved.screen_key)) {
        return sql.includes('is_system = 1') ? null : saved;
      }
      if (tenantId === 'default' && (id === template.id || key === template.screen_key)) {
        return template;
      }
      return null;
    });
    const db = { queryOne } as unknown as DatabaseAdapter;

    expect(
      await resolveRuntimeScreenRow(db, 'tenant-a', 'login', 'authentication_method_selector')
    ).toEqual({ ...template, screen_key: 'login' });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('is_system = 1'), [
      'default',
      'login_template',
      'login_template',
    ]);
  });
});

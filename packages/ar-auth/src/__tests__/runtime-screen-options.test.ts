import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { applyRuntimeScreenOptions } from '../runtime-screen-options';

/** The choices the run time sends with a screen's select and radio parts. */
function schemaDb(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async () => rows);
  return { db: { query } as unknown as DatabaseAdapter, query };
}

const keyOf = (field: Record<string, unknown>, index: number) =>
  typeof field.block_id === 'string' ? field.block_id : `${String(field.field)}-${index}`;

const department = {
  field_key: 'department',
  field_type: 'enum',
  validation_rules: JSON.stringify({
    enum_values: ['sales', 'eng'],
    enum_options: [
      { value: 'sales', label: 'Sales', labels: { ja: '営業', fr: '' } },
      { value: 'eng', labels: { 'zh-TW': '工程' } },
    ],
  }),
};

describe('applyRuntimeScreenOptions', () => {
  it("gives a part stored to the profile its attribute's choices, in the request's language", async () => {
    const { db, query } = schemaDb([department]);
    const [part] = await applyRuntimeScreenOptions(
      db,
      'tenant-a',
      [{ field: 'field.canonical.department', block_type: 'select', label: 'Department' }],
      {},
      'ja',
      keyOf
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(part.options).toEqual([
      { value: 'sales', label: '営業', default_label: 'Sales', labels: { ja: '営業' } },
      // No default label: the value is shown; an empty translation is not one.
      { value: 'eng', label: 'eng', default_label: 'eng', labels: { 'zh-TW': '工程' } },
    ]);
  });

  it('falls back to the base language, never to English', async () => {
    const { db } = schemaDb([
      {
        ...department,
        validation_rules: JSON.stringify({
          enum_options: [
            { value: 'sales', label: 'Sales', labels: { en: 'Sales (en)', pt: 'Vendas' } },
          ],
        }),
      },
    ]);
    const [inPortugal] = await applyRuntimeScreenOptions(
      db,
      't',
      [{ field: 'department', block_type: 'radio', label: 'D' }],
      {},
      'pt-BR',
      keyOf
    );
    expect((inPortugal.options as Array<{ label: string }>)[0].label).toBe('Vendas');
    const [inFrance] = await applyRuntimeScreenOptions(
      db,
      't',
      [{ field: 'department', block_type: 'radio', label: 'D' }],
      {},
      'fr',
      keyOf
    );
    expect((inFrance.options as Array<{ label: string }>)[0].label).toBe('Sales');
  });

  it('reads the bare values of rules saved before labels', async () => {
    const { db } = schemaDb([
      { field_key: 'department', field_type: 'enum', validation_rules: '{"enum_values":["a"]}' },
    ]);
    const [part] = await applyRuntimeScreenOptions(
      db,
      't',
      [{ field: 'department', block_type: 'select', label: 'D' }],
      {},
      'en',
      keyOf
    );
    expect(part.options).toEqual([{ value: 'a', label: 'a', default_label: 'a', labels: {} }]);
  });

  it('offers nothing for an attribute that is gone or no longer a choice, and ignores a part saved with options of its own', async () => {
    const { db } = schemaDb([
      { field_key: 'department', field_type: 'string', validation_rules: null },
    ]);
    const fields = await applyRuntimeScreenOptions(
      db,
      't',
      [
        {
          field: 'department',
          block_type: 'select',
          label: 'D',
          options: [{ value: 'x', label: 'X' }],
        },
        { field: 'missing', block_type: 'radio', label: 'M' },
      ],
      {},
      'en',
      keyOf
    );
    expect(fields.map((field) => field.options)).toEqual([[], []]);
  });

  it("gives a part's own choices their translations from the screen", async () => {
    const { db, query } = schemaDb([]);
    const [part] = await applyRuntimeScreenOptions(
      db,
      't',
      [
        {
          field: 'heard_from',
          block_id: 'b1',
          block_type: 'radio',
          label: 'Heard from',
          store_to_profile: false,
          options: [
            { value: 'friend', label: 'A friend' },
            { value: 'web', label: 'The web' },
            'junk',
          ],
        },
      ],
      { ja: { fields: { b1: { options: { friend: '友人' } } } }, fr: 'not an object' },
      'ja',
      keyOf
    );
    // No attribute to read: the Identity Schema is not asked.
    expect(query).not.toHaveBeenCalled();
    expect(part.options).toEqual([
      { value: 'friend', label: '友人', default_label: 'A friend', labels: { ja: '友人' } },
      { value: 'web', label: 'The web', default_label: 'The web', labels: {} },
    ]);
  });

  it('leaves the other parts as they are, without asking the Identity Schema', async () => {
    const { db, query } = schemaDb([]);
    const fields = [
      { field: 'given_name', label: 'Given name' },
      { field: 'newsletter', block_type: 'checkbox', label: 'News' },
    ];
    expect(await applyRuntimeScreenOptions(db, 't', fields, {}, 'en', keyOf)).toEqual(fields);
    expect(query).not.toHaveBeenCalled();
  });
});

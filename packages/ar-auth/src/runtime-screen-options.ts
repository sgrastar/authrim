/**
 * The choices of a screen's `select` and `radio` parts, as the run time sends them.
 *
 * - A part stored to the profile takes them from its attribute in the Identity Schema, now (a
 *   screen keeps no copy, so a choice added or relabelled there shows at once).
 * - A part not stored to the profile has its own, with their translations in the screen's
 *   localizations (`fields[key].options[value]`).
 *
 * Each choice is sent as `{ value, label, default_label, labels }`: `label` in the language of the
 * request, and what the Login UI needs to show it in another language without asking again
 * (`labels[language]`, else `default_label`).
 */
import { enumOptionsOf, type DatabaseAdapter } from '@authrim/ar-lib-core';

type JsonObject = Record<string, unknown>;

export interface RuntimeScreenOption {
  value: string;
  label: string;
  default_label: string;
  labels: Record<string, string>;
}

const CHOICE_BLOCK_TYPES = new Set(['select', 'radio']);

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** An attribute key as a part names it (`field.canonical.` names the same one). */
export function runtimeAttributeKey(field: string): string {
  const normalized = field.trim().toLowerCase();
  return normalized.startsWith('field.canonical.')
    ? normalized.slice('field.canonical.'.length)
    : normalized;
}

function option(
  value: string,
  defaultLabel: string,
  labels: Record<string, string>,
  language: string
): RuntimeScreenOption {
  // The language itself, else its base language (as the Login UI picks), never English: the
  // default label is the one for every language without a label of its own.
  const normalized = language.replace('_', '-');
  const own = labels[normalized] ?? labels[normalized.split('-')[0]];
  return { value, label: own ?? defaultLabel, default_label: defaultLabel, labels };
}

/** The labels of a part's own option by language, from the screen's localizations. */
function ownOptionLabels(
  localizations: JsonObject,
  key: string,
  value: string
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [language, localization] of Object.entries(localizations)) {
    if (!isRecord(localization) || !isRecord(localization.fields)) continue;
    const field = localization.fields[key];
    if (!isRecord(field) || !isRecord(field.options)) continue;
    if (!Object.hasOwn(field.options, value)) continue;
    const label = text(field.options[value]);
    if (label) labels[language] = label;
  }
  return labels;
}

/**
 * The parts with their choices. `keyOf` is the key of a part's localization (its block ID, else
 * its field and position), as the screen's other translations use.
 */
export async function applyRuntimeScreenOptions<F extends JsonObject>(
  db: DatabaseAdapter,
  tenantId: string,
  fields: F[],
  localizations: JsonObject,
  language: string,
  keyOf: (field: F, index: number) => string
): Promise<Array<F & { options?: RuntimeScreenOption[] }>> {
  const profileKeys = new Set<string>();
  for (const field of fields) {
    if (!CHOICE_BLOCK_TYPES.has(String(field.block_type)) || field.store_to_profile === false) {
      continue;
    }
    const name = text(field.field);
    if (name) profileKeys.add(runtimeAttributeKey(name));
  }

  const schemaOptions = new Map<string, RuntimeScreenOption[]>();
  if (profileKeys.size > 0) {
    const rows = await db.query<{
      field_key: string;
      field_type: string;
      validation_rules: string | null;
    }>(
      `SELECT field_key, field_type, validation_rules
         FROM custom_claim_schemas
        WHERE tenant_id = ? AND is_active = 1`,
      [tenantId]
    );
    for (const row of rows) {
      const key = runtimeAttributeKey(row.field_key);
      if (!profileKeys.has(key) || row.field_type !== 'enum') continue;
      let rules: unknown = null;
      try {
        rules = row.validation_rules ? JSON.parse(row.validation_rules) : null;
      } catch {
        rules = null;
      }
      schemaOptions.set(
        key,
        enumOptionsOf(rules).map((choice) => {
          const labels: Record<string, string> = {};
          for (const [locale, label] of Object.entries(choice.labels ?? {})) {
            const read = text(label);
            if (read) labels[locale] = read;
          }
          return option(choice.value, text(choice.label) ?? choice.value, labels, language);
        })
      );
    }
  }

  return fields.map((field, index) => {
    if (!CHOICE_BLOCK_TYPES.has(String(field.block_type))) return field;
    if (field.store_to_profile !== false) {
      const name = text(field.field);
      // An attribute that is gone, off or no longer a choice offers none: the part asks nothing.
      return {
        ...field,
        options: name ? (schemaOptions.get(runtimeAttributeKey(name)) ?? []) : [],
      };
    }
    const own = Array.isArray(field.options) ? field.options : [];
    const key = keyOf(field, index);
    return {
      ...field,
      options: own.flatMap((raw: unknown) => {
        if (!isRecord(raw)) return [];
        const value = text(raw.value);
        if (!value) return [];
        return [
          option(
            value,
            text(raw.label) ?? value,
            ownOptionLabels(localizations, key, value),
            language
          ),
        ];
      }),
    };
  });
}

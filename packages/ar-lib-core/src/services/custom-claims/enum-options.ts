/**
 * The choices of an enum attribute, with the labels people see.
 *
 * `validation_rules` of an enum attribute holds `enum_values` (the stored values, which every
 * write is checked against) and, optionally, `enum_options`: the same values in the same order,
 * each with a default `label` and per-language `labels` (Login UI locales). `enum_values` is always
 * derived from `enum_options` when both are given, so the checks that read only `enum_values`
 * (write-validator, registration fields) keep working unchanged. Rules saved before labels
 * existed have `enum_values` only; they read as options without labels.
 *
 * A label is shown as `labels[locale]`, else `label`, else the value itself.
 */
import { isLoginUILocale, type LoginUILocale } from '../../types/login-ui-languages';

export interface EnumOption {
  value: string;
  /** The label in every language that has none of its own. */
  label?: string;
  labels?: Partial<Record<LoginUILocale, string>>;
}

export const MAX_ENUM_OPTIONS = 100;
export const MAX_ENUM_VALUE_LENGTH = 128;
export const MAX_ENUM_LABEL_LENGTH = 100;

export type EnumRulesResult =
  | { ok: true; rules: { enum_values: string[]; enum_options?: EnumOption[] } }
  | { ok: false; error: string };

function readLabel(
  value: unknown,
  where: string
): { ok: true; label?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string') return { ok: false, error: `${where} must be a string` };
  const label = value.trim();
  if (label.length > MAX_ENUM_LABEL_LENGTH) {
    return { ok: false, error: `${where} must be at most ${MAX_ENUM_LABEL_LENGTH} characters` };
  }
  return { ok: true, ...(label ? { label } : {}) };
}

function readValues(
  values: unknown[]
): { ok: true; values: string[] } | { ok: false; error: string } {
  if (values.length === 0) return { ok: false, error: 'enum_values must be a non-empty array' };
  if (values.length > MAX_ENUM_OPTIONS) {
    return { ok: false, error: `enum_values must have at most ${MAX_ENUM_OPTIONS} items` };
  }
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string')
      return { ok: false, error: 'enum_values must contain only strings' };
    // Stored values are compared after trimming (write-validator), so a value is its trimmed form.
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: 'enum_values must not contain empty values' };
    if (trimmed.length > MAX_ENUM_VALUE_LENGTH) {
      return {
        ok: false,
        error: `enum values must be at most ${MAX_ENUM_VALUE_LENGTH} characters`,
      };
    }
    if (out.includes(trimmed))
      return { ok: false, error: `enum value "${trimmed}" is listed twice` };
    out.push(trimmed);
  }
  return { ok: true, values: out };
}

/**
 * Validate the rules of an enum attribute and put them in their stored form: `enum_values` from
 * `enum_options` when options are given (they must agree when both are), labels trimmed, empty
 * labels dropped.
 */
export function normalizeEnumRules(rules: Record<string, unknown>): EnumRulesResult {
  for (const key of Object.keys(rules)) {
    if (key !== 'enum_values' && key !== 'enum_options') {
      return { ok: false, error: `Unknown enum validation key: ${key}` };
    }
  }
  if (rules.enum_options === undefined) {
    if (!Array.isArray(rules.enum_values)) {
      return { ok: false, error: 'enum_values must be a non-empty array' };
    }
    const values = readValues(rules.enum_values);
    return values.ok ? { ok: true, rules: { enum_values: values.values } } : values;
  }
  if (!Array.isArray(rules.enum_options)) {
    return { ok: false, error: 'enum_options must be an array' };
  }
  const options: EnumOption[] = [];
  const rawValues: unknown[] = [];
  for (const [index, raw] of rules.enum_options.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `enum_options[${index}] must be an object` };
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== 'value' && key !== 'label' && key !== 'labels') {
        return { ok: false, error: `Unknown enum option key: ${key}` };
      }
    }
    rawValues.push(entry.value);
    const label = readLabel(entry.label, `enum_options[${index}].label`);
    if (!label.ok) return label;
    const option: EnumOption = { value: '' };
    if (label.label) option.label = label.label;
    if (entry.labels !== undefined && entry.labels !== null) {
      if (typeof entry.labels !== 'object' || Array.isArray(entry.labels)) {
        return { ok: false, error: `enum_options[${index}].labels must be an object` };
      }
      const labels: Partial<Record<LoginUILocale, string>> = {};
      for (const [locale, text] of Object.entries(entry.labels as Record<string, unknown>)) {
        if (!isLoginUILocale(locale)) {
          return {
            ok: false,
            error: `enum_options[${index}].labels has an unknown language: ${locale}`,
          };
        }
        const read = readLabel(text, `enum_options[${index}].labels.${locale}`);
        if (!read.ok) return read;
        if (read.label) labels[locale] = read.label;
      }
      if (Object.keys(labels).length > 0) option.labels = labels;
    }
    options.push(option);
  }
  const values = readValues(rawValues);
  if (!values.ok) return values;
  values.values.forEach((value, index) => (options[index].value = value));
  if (rules.enum_values !== undefined) {
    const given = Array.isArray(rules.enum_values) ? readValues(rules.enum_values) : null;
    if (!given?.ok || given.values.join('\u0000') !== values.values.join('\u0000')) {
      return {
        ok: false,
        error: 'enum_values must list the values of enum_options in the same order',
      };
    }
  }
  return { ok: true, rules: { enum_values: values.values, enum_options: options } };
}

/** The options stored rules describe: their `enum_options`, else their bare `enum_values`. */
export function enumOptionsOf(rules: unknown): EnumOption[] {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return [];
  const record = rules as Record<string, unknown>;
  if (Array.isArray(record.enum_options)) {
    return record.enum_options.filter(
      (option): option is EnumOption =>
        !!option && typeof option === 'object' && typeof (option as EnumOption).value === 'string'
    );
  }
  if (Array.isArray(record.enum_values)) {
    return record.enum_values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => ({ value }));
  }
  return [];
}

/** The label of an option in a language: its own, else the default label, else the value. */
export function enumOptionLabel(option: EnumOption, locale: string): string {
  const own = isLoginUILocale(locale) ? option.labels?.[locale] : undefined;
  return own || option.label || option.value;
}

/** The values rules allow: their options' values, else their bare values; none means any value. */
export function enumValuesOf(rules: unknown): string[] {
  return enumOptionsOf(rules).map((option) => option.value);
}

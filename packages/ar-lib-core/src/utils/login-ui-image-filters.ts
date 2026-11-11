/**
 * Filters on the Login UI's pictures: the page background (login-ui.background_image_filters),
 * the form area (login-ui.login_panel_background_filters) and the split template's brand panel
 * (login-ui.brand_panel_image_filters).
 *
 * The setting is stored as a short text, `name:value` pairs in the order they apply, joined by
 * `;` (for example `hue-rotate:200;blur:4`). Each filter appears at most once, with a whole
 * number within its range. The admin console writes it, the Admin API reads it into a list, and
 * the Login UI builds a CSS `filter` value from that list; all three share this module, so a value
 * that one of them refuses is refused by all.
 *
 * Opacity is left out: the picture has its own slider for it. (Its older grayscale switch,
 * login-ui.background_image_grayscale, still applies; the admin console now writes a grayscale
 * filter instead.) Drop shadow is left out too: it takes several values and does nothing to a full-page picture.
 */

/** The filters on offer, in the order a menu lists them. */
export const LOGIN_UI_IMAGE_FILTER_NAMES = [
  'grayscale',
  'blur',
  'brightness',
  'contrast',
  'saturate',
  'hue-rotate',
  'sepia',
  'invert',
] as const;

export type LoginUIImageFilterName = (typeof LOGIN_UI_IMAGE_FILTER_NAMES)[number];

export interface LoginUIImageFilterSpec {
  min: number;
  max: number;
  /** The value a newly added filter starts at. */
  initial: number;
  /** The CSS unit of the value. */
  unit: 'px' | '%' | 'deg';
}

export const LOGIN_UI_IMAGE_FILTERS: Readonly<
  Record<LoginUIImageFilterName, LoginUIImageFilterSpec>
> = {
  grayscale: { min: 0, max: 100, initial: 100, unit: '%' },
  blur: { min: 0, max: 20, initial: 4, unit: 'px' },
  brightness: { min: 0, max: 200, initial: 100, unit: '%' },
  contrast: { min: 0, max: 200, initial: 100, unit: '%' },
  saturate: { min: 0, max: 300, initial: 100, unit: '%' },
  'hue-rotate': { min: 0, max: 360, initial: 180, unit: 'deg' },
  sepia: { min: 0, max: 100, initial: 100, unit: '%' },
  invert: { min: 0, max: 100, initial: 100, unit: '%' },
};

export interface LoginUIImageFilter {
  name: LoginUIImageFilterName;
  value: number;
}

/** Longer stored text than every filter at its longest value is not a value this module wrote. */
const MAX_STORED_LENGTH = 256;

export function isLoginUIImageFilterName(name: unknown): name is LoginUIImageFilterName {
  return (
    typeof name === 'string' && (LOGIN_UI_IMAGE_FILTER_NAMES as readonly string[]).includes(name)
  );
}

/** Whether one filter is valid: a known name and a whole number within its range. */
export function isValidLoginUIImageFilter(filter: unknown): filter is LoginUIImageFilter {
  if (typeof filter !== 'object' || filter === null) return false;
  const { name, value } = filter as { name?: unknown; value?: unknown };
  if (!isLoginUIImageFilterName(name)) return false;
  const spec = LOGIN_UI_IMAGE_FILTERS[name];
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
  );
}

/**
 * The filters of a stored value. Anything that is not text, or is too long, reads as no filters;
 * an entry that is not valid, or repeats a filter already read, is skipped.
 */
export function parseLoginUIImageFilters(stored: unknown): LoginUIImageFilter[] {
  if (typeof stored !== 'string' || stored.length > MAX_STORED_LENGTH) return [];
  const filters: LoginUIImageFilter[] = [];
  for (const entry of stored.split(';')) {
    const match = /^([a-z-]+):(\d{1,3})$/.exec(entry.trim());
    if (!match) continue;
    const filter = { name: match[1], value: Number(match[2]) };
    if (!isValidLoginUIImageFilter(filter)) continue;
    if (filters.some((known) => known.name === filter.name)) continue;
    filters.push(filter);
  }
  return filters;
}

/** The stored text of a list of filters (its valid entries, each filter once, in order). */
export function formatLoginUIImageFilters(filters: readonly LoginUIImageFilter[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const filter of filters) {
    if (!isValidLoginUIImageFilter(filter) || seen.has(filter.name)) continue;
    seen.add(filter.name);
    parts.push(`${filter.name}:${filter.value}`);
  }
  return parts.join(';');
}

/** The CSS `filter` value of a list of filters, or '' when there is none to apply. */
export function loginUIImageFilterCss(filters: readonly LoginUIImageFilter[]): string {
  return parseLoginUIImageFilters(formatLoginUIImageFilters(filters))
    .map(({ name, value }) => `${name}(${value}${LOGIN_UI_IMAGE_FILTERS[name].unit})`)
    .join(' ');
}

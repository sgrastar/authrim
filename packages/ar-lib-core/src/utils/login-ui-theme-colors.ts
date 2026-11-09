/**
 * The colours a Login UI theme sets, and their dark-mode values (login-ui.dark_colors).
 *
 * Each colour has a light-mode setting of its own, `login-ui.<name>_color` (an empty one follows
 * the palette). The dark-mode values are one setting: a JSON object from colour name to colour,
 * holding only the colours set for dark mode (for example `{"accent":"#93aef2"}`). A colour with no
 * dark value follows the palette's dark colour in dark mode, not its light value.
 *
 * The admin console writes the setting, the Admin API reads it into an object, and the Login UI
 * applies it in dark mode; all three share this module, so a value one of them refuses is refused
 * by all.
 */

/** The colours of a theme, in the order the admin console lists them. */
export const LOGIN_UI_THEME_COLOR_NAMES = [
  'background',
  'form_area',
  'brand_panel_background',
  'accent',
  'link',
  'title',
  'text',
  'copy',
  'field',
  'secondary_button',
  'header_background',
  'header_text',
  'footer_background',
  'footer_text',
] as const;

export type LoginUIThemeColorName = (typeof LOGIN_UI_THEME_COLOR_NAMES)[number];

export type LoginUIThemeColors = Partial<Record<LoginUIThemeColorName, string>>;

/** The light-mode setting of a colour. */
export const loginUIThemeColorKey = (name: LoginUIThemeColorName) => `login-ui.${name}_color`;

/** Longer stored text than every colour at its longest value is not a value this module wrote. */
const MAX_STORED_LENGTH = 2048;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const SOLID_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const RGB =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/iu;

export function isLoginUIThemeColorName(name: unknown): name is LoginUIThemeColorName {
  return (
    typeof name === 'string' && (LOGIN_UI_THEME_COLOR_NAMES as readonly string[]).includes(name)
  );
}

/**
 * Whether a value is a colour the Login UI applies for this colour: `#rgb`, `#rrggbb`,
 * `#rrggbbaa`, or rgb()/rgba() with 0–255 channels. The accent (the main button) takes no
 * `#rrggbbaa`: its label colour is chosen against it, so it must be solid.
 */
export function isValidLoginUIThemeColor(name: LoginUIThemeColorName, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const colour = value.trim();
  if ((name === 'accent' ? SOLID_HEX : HEX).test(colour)) return true;
  const rgb = RGB.exec(colour);
  return Boolean(rgb && [rgb[1], rgb[2], rgb[3]].every((channel) => Number(channel) <= 255));
}

/**
 * The dark-mode colours of a stored value. Anything that is not a JSON object, or is too long,
 * reads as none; a name this module does not know, or a value it refuses, is skipped.
 */
export function parseLoginUIDarkColors(stored: unknown): LoginUIThemeColors {
  if (typeof stored !== 'string' || !stored.trim() || stored.length > MAX_STORED_LENGTH) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const colors: LoginUIThemeColors = {};
  for (const name of LOGIN_UI_THEME_COLOR_NAMES) {
    const value = (parsed as Record<string, unknown>)[name];
    if (isValidLoginUIThemeColor(name, value)) colors[name] = (value as string).trim();
  }
  return colors;
}

/** The stored text of dark-mode colours (the valid ones, in this module's order), '' for none. */
export function formatLoginUIDarkColors(colors: LoginUIThemeColors): string {
  const kept: LoginUIThemeColors = {};
  for (const name of LOGIN_UI_THEME_COLOR_NAMES) {
    const value = colors[name];
    if (isValidLoginUIThemeColor(name, value)) kept[name] = (value as string).trim();
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : '';
}

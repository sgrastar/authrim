/**
 * The shape of `login-ui.custom_blocks`: the tenant's own content around the sign-in screens,
 * a JSON array of blocks. Shared by the Login UI (which draws them) and the admin console (which
 * edits them); each side checks addresses with its own rules.
 *
 *   position — where the block goes: above the header, above or below the form, below the footer
 *   type     — text (a paragraph), html (a paragraph that may hold `<a href="https://…">` links;
 *              everything else is shown as text), image (`content` is the address, `alt` the
 *              description), link (`content` is the label, `url` the address)
 */
export const LOGIN_UI_CUSTOM_BLOCK_POSITIONS = [
  'above-header',
  'above-form',
  'below-form',
  'below-footer',
] as const;

export const LOGIN_UI_CUSTOM_BLOCK_TYPES = ['text', 'html', 'image', 'link'] as const;

export type LoginUICustomBlockPosition = (typeof LOGIN_UI_CUSTOM_BLOCK_POSITIONS)[number];
export type LoginUICustomBlockType = (typeof LOGIN_UI_CUSTOM_BLOCK_TYPES)[number];

export interface LoginUICustomBlock {
  position: LoginUICustomBlockPosition;
  type: LoginUICustomBlockType;
  content: string;
  url?: string;
  alt?: string;
}

/** The most blocks the screens draw. */
export const LOGIN_UI_CUSTOM_BLOCKS_MAX = 8;
/** The most characters of a block's text (a paragraph, a link's label). */
export const LOGIN_UI_CUSTOM_BLOCK_CONTENT_MAX = 2000;
/** The most characters of an address (an image's, which may be a data: URI, or a link's). */
export const LOGIN_UI_CUSTOM_BLOCK_URL_MAX = 4096;

export function isLoginUICustomBlockPosition(value: unknown): value is LoginUICustomBlockPosition {
  return (
    typeof value === 'string' &&
    (LOGIN_UI_CUSTOM_BLOCK_POSITIONS as readonly string[]).includes(value)
  );
}

export function isLoginUICustomBlockType(value: unknown): value is LoginUICustomBlockType {
  return (
    typeof value === 'string' && (LOGIN_UI_CUSTOM_BLOCK_TYPES as readonly string[]).includes(value)
  );
}

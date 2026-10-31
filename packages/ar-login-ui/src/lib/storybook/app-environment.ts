/**
 * Stand-in for SvelteKit's `$app/environment` inside Storybook only (see .storybook/main.ts).
 * `browser` is false so the Login UI stores skip their document, cookie and localStorage writes.
 */
export const browser = false;
export const dev = true;
export const building = false;
export const version = 'storybook';

// The console is an authenticated client app: the session is checked in the browser against
// the Admin API (through the same-origin proxy), so there is nothing useful to render on the
// server. Entry pages (login, join, setup) live outside this group and still render server-side.
export const ssr = false;
export const prerender = false;

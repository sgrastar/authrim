// The lite Login UI runs without client JavaScript: pages are rendered on the server and forms
// are posted natively. No route here is served directly (src/hooks.ts reroutes to them).
export const csr = false;
export const prerender = false;

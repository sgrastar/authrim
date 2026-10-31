# Whole-console mock

The Admin UI as one clickable thing, built from the design system's parts and sample data, with
**no API behind it**. Storybook shows one part or one page at a time; this shows how they sit
together in the real frame (header, categories, left navigation), across pages.

```bash
pnpm --filter @authrim/ar-admin-console dev
# open http://localhost:5173/mock
```

It exists in the dev server only. In a production build `/mock` answers 404 and the code is not
in the bundle (`pnpm run check:dev-mock-guard` fails the build if it is).

## Adding a page

A page is a file. Its place under `pages/` is its URL, and it has to be somewhere the navigation
(`src/lib/shell/nav-data.ts`) has:

| File                                 | Console path                   | Mock URL                      |
| ------------------------------------ | ------------------------------ | ----------------------------- |
| `pages/index.svelte`                 | `/admin`                       | `/mock`                       |
| `pages/users/all.svelte`             | `/admin/users/all`             | `/mock/users/all`             |
| `pages/platform/index.svelte`        | `/admin/platform`              | `/mock/platform`              |
| `pages/platform/tenants/list.svelte` | `/admin/platform/tenants/list` | `/mock/platform/tenants/list` |

Nothing is registered by hand. A navigation item without a file shows the console's placeholder.
A page draws its own `Page` (like the real pages do) from parts under `$lib/ui`, with its sample
data written next to it or in `fixtures/`. `pages/users/all.svelte` is a sample to copy or delete.

Because the URLs follow the navigation data, changing the menu does not move the pages: rename an
item there and the file follows its new path.

## Rules (the linter enforces the first)

- No API: no `$lib/api/*` (except `$lib/api/fake/*`, in-memory), no `$lib/auth`, `$lib/server`,
  `$env`, and no `fetch` or other network calls.
- Same rules as the console: tokens only (colours, type sizes), no styles in routes.
- Sample data is made up. No real names, and no customer names.

## Looking at it as another admin

`/mock?persona=tenant` (also `support`, `viewer`; default `platform`) sets the admin the console
sees, as the Admin toolbar does in Storybook. What it changes is what the console itself changes:
navigation items that state what they `require` (`nav-data.ts`) disappear for an admin who could
not use them, and pages that read `adminAccess` turn view-only. Items without `requires` (pages not
rebuilt yet) show to everyone, so today most of the navigation looks the same for every persona.
The language, theme and display settings are the console's own (display menu in the header).

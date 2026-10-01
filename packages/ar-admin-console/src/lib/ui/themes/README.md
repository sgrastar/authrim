# Themes

A theme is a set of values for the **theme contract** tokens and nothing else. It never
targets a component or page class, and it never changes spacing, sizes or layout. That keeps
information design independent of the look: a page reviewed under one theme is the same page
under every theme.

`<html>` carries two independent axes, set by `$lib/ui/theme/theme.svelte.ts` before first paint:

| Attribute          | Values                              | Meaning                          |
| ------------------ | ----------------------------------- | -------------------------------- |
| `data-admin-theme` | `standard`, `swiss-grid`, `frosted` | the look                         |
| `data-scheme`      | `light`, `dark`                     | resolved brightness (OS or user) |

## Contract

`standard.css` defines every contract token with its default (wrapped in `:where()` so it has
no specificity). A new theme copies the groups it needs:

- **Colour** — surfaces (`--bg-*`), ink (`--primary*`, `--text-*`), lines (`--border*`,
  `--focus-ring`), scope accents (`--accent-*`), status (`--success*`, `--warning*`,
  `--danger*`, `--info*`, `--*-text`), controls (`--on-accent`, `--switch-*`), `--scrim`.
- **Material** — `--surface-bg` (may be a gradient), `--surface-backdrop` (e.g. `blur()`),
  `--surface-highlight` (inset shadow), `--shell-bg`, `--shell-backdrop`, `--shell-rule`,
  `--subnav-bg`, `--page-backdrop`, `--shell-inset`, `--shell-radius`, and the three
  shadows by role: `--shadow-sm` (resting surfaces), `--shadow-md` (a standalone card on the
  page), `--shadow-lg` (anything floating over content). A flat theme may turn them into
  rings (Swiss Grid) or nothing.
- **Shape** — `--radius-control`, `--radius-panel`, `--radius-badge`.
- **Type** — `--font-sans`, `--font-display`, `--font-mono`, `--font-brand`,
  `--heading-weight`, `--heading-tracking`.

Colour tokens are registered with `@property` in `../tokens/properties.css` so a theme switch
interpolates them. Material tokens that can hold gradients are not registered.

`frosted.css` uses translucent surfaces, blur and rounded floating panels through the same
material tokens; it is the check that the contract holds for a translucent look.

## Rules checked by tests

- Text tokens meet WCAG AA (4.5:1) against the surfaces they sit on, in every theme and scheme
  (`theme-contrast.test.ts`).
- Raw colours appear only under `tokens/` and `themes/` (`scripts/check-raw-colors.mjs`).

# Authrim Design System

This document describes the design system used in the Authrim UI application.

## Design Principles

1. **Clarity**: Clear visual hierarchy and intuitive interactions
2. **Trust**: Professional appearance that conveys security
3. **Accessibility**: WCAG 2.1 AA compliant
4. **Performance**: Lightweight and fast-loading
5. **Consistency**: Reusable components and patterns

## Color Palette

### Primary Colors (Blue)

Represents trust, security, and professionalism.

| Token         | Value   | Usage                     |
| ------------- | ------- | ------------------------- |
| `primary-50`  | #EFF6FF | Hover backgrounds         |
| `primary-100` | #DBEAFE | Subtle backgrounds        |
| `primary-200` | #BFDBFE | Light accents             |
| `primary-300` | #93C5FD | Borders                   |
| `primary-400` | #60A5FA | Hover states              |
| `primary-500` | #3B82F6 | **Primary brand color**   |
| `primary-600` | #2563EB | Active states             |
| `primary-700` | #1D4ED8 | Dark mode primary         |
| `primary-800` | #1E40AF | Deep accents              |
| `primary-900` | #1E3A8A | Text on light backgrounds |

### Secondary Colors (Green)

Represents success, safety, and authentication complete.

| Token           | Value   | Usage                 |
| --------------- | ------- | --------------------- |
| `secondary-50`  | #ECFDF5 | Success backgrounds   |
| `secondary-100` | #D1FAE5 | Light success         |
| `secondary-500` | #10B981 | **Success indicator** |
| `secondary-600` | #059669 | Success hover         |
| `secondary-700` | #047857 | Success active        |

### Semantic Colors

#### Success

- Light: #ECFDF5
- Default: #10B981
- Dark: #047857

#### Warning

- Light: #FFFBEB
- Default: #F59E0B
- Dark: #B45309

#### Error

- Light: #FEF2F2
- Default: #EF4444
- Dark: #B91C1C

#### Info

- Light: #EFF6FF
- Default: #3B82F6
- Dark: #1D4ED8

### Neutral Colors (Gray)

Used for text, backgrounds, and borders.

| Shade | Light Mode        | Dark Mode       |
| ----- | ----------------- | --------------- |
| 50    | Background subtle | -               |
| 100   | Background        | -               |
| 200   | Border            | -               |
| 300   | Border strong     | -               |
| 400   | Text muted        | -               |
| 500   | Text secondary    | -               |
| 600   | Text primary      | Text muted      |
| 700   | Text strong       | Text secondary  |
| 800   | -                 | Background      |
| 900   | Headings          | Background dark |

## Typography

### Font Families

```css
--font-sans:
	'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', sans-serif --font-mono: 'Fira Code',
	'Consolas', 'Monaco', 'Courier New', monospace;
```

### Font Sizes

| Token       | Size            | Line Height | Usage                    |
| ----------- | --------------- | ----------- | ------------------------ |
| `text-xs`   | 0.75rem (12px)  | 1rem        | Small labels, badges     |
| `text-sm`   | 0.875rem (14px) | 1.25rem     | Secondary text, captions |
| `text-base` | 1rem (16px)     | 1.5rem      | Body text                |
| `text-lg`   | 1.125rem (18px) | 1.75rem     | Large body text          |
| `text-xl`   | 1.25rem (20px)  | 1.75rem     | Small headings           |
| `text-2xl`  | 1.5rem (24px)   | 2rem        | Section headings         |
| `text-3xl`  | 1.875rem (30px) | 2.25rem     | Page titles              |
| `text-4xl`  | 2.25rem (36px)  | 2.5rem      | Large titles             |
| `text-5xl`  | 3rem (48px)     | 3rem        | Hero headings            |

### Font Weights

- Regular: 400
- Medium: 500
- Semibold: 600
- Bold: 700

## Spacing

Uses a 4px base unit system (0.25rem increments):

| Token        | Value   | Pixels |
| ------------ | ------- | ------ |
| `spacing-1`  | 0.25rem | 4px    |
| `spacing-2`  | 0.5rem  | 8px    |
| `spacing-3`  | 0.75rem | 12px   |
| `spacing-4`  | 1rem    | 16px   |
| `spacing-5`  | 1.25rem | 20px   |
| `spacing-6`  | 1.5rem  | 24px   |
| `spacing-8`  | 2rem    | 32px   |
| `spacing-10` | 2.5rem  | 40px   |
| `spacing-12` | 3rem    | 48px   |

## Border Radius

| Token                    | Value          | Usage          |
| ------------------------ | -------------- | -------------- |
| `rounded-sm`             | 0.25rem (4px)  | Small elements |
| `rounded` / `rounded-md` | 0.5rem (8px)   | **Default**    |
| `rounded-lg`             | 0.75rem (12px) | Cards, modals  |
| `rounded-xl`             | 1rem (16px)    | Large cards    |
| `rounded-full`           | 9999px         | Pills, avatars |

## Shadows

| Token       | Value                         | Usage           |
| ----------- | ----------------------------- | --------------- |
| `shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)`  | Subtle depth    |
| `shadow`    | `0 1px 3px rgba(0,0,0,0.1)`   | **Default**     |
| `shadow-md` | `0 4px 6px rgba(0,0,0,0.1)`   | Raised elements |
| `shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals          |
| `shadow-xl` | `0 20px 25px rgba(0,0,0,0.1)` | Overlays        |

## Components

### Buttons

#### Primary Button

```html
<button class="btn-primary">Click me</button>
```

- Background: `primary-500` (#3B82F6)
- Text: White
- Hover: `primary-600` (#2563EB)
- Focus: Ring with `primary-500`

#### Secondary Button

```html
<button class="btn-secondary">Click me</button>
```

- Background: `gray-200` (#E5E7EB)
- Text: `gray-700` (#374151)
- Hover: `gray-300` (#D1D5DB)

#### Ghost Button

```html
<button class="btn-ghost">Click me</button>
```

- Background: Transparent
- Text: `primary-600` (#2563EB)
- Hover: `primary-50` (#EFF6FF)

### Inputs

#### Default Input

```html
<input class="input-base" type="text" placeholder="Enter text" />
```

- Border: `gray-300` (#D1D5DB)
- Focus: Ring with `primary-500`
- Padding: 0.5rem 0.75rem

#### Error Input

```html
<input class="input-error" type="text" />
```

- Border: `error-500` (#EF4444) - 2px
- Focus: Ring with `error-500`

### Badges

```html
<span class="badge-success">Success</span>
<span class="badge-warning">Warning</span>
<span class="badge-error">Error</span>
<span class="badge-info">Info</span>
```

- **Base**: Inline-flex, px-2.5, py-0.5, rounded-full, text-xs
- **Success**: Green background/text
- **Warning**: Orange background/text
- **Error**: Red background/text
- **Info**: Blue background/text

### Card

```html
<div class="card">
	<!-- content -->
</div>
```

- Background: White (light) / `gray-800` (dark)
- Border: `gray-200` (light) / `gray-700` (dark)
- Border radius: `rounded-lg` (0.75rem)
- Shadow: `shadow-sm`
- Padding: 1.5rem (24px)

## Accessibility

### Focus States

All interactive elements have visible focus indicators:

- Focus ring: 2px solid
- Ring color: Matches component theme
- Ring offset: 2px

### Color Contrast

Minimum contrast ratios (WCAG 2.1 AA):

- Normal text: 4.5:1
- Large text: 3:1
- UI components: 3:1

### Screen Reader Support

- Proper ARIA labels
- Semantic HTML
- Skip links for navigation
- `.sr-only` class for screen reader-only content

### Keyboard Navigation

- Tab order follows visual order
- All interactive elements are keyboard accessible
- Escape key closes modals/dropdowns
- Arrow keys for navigation where appropriate

## Dark Mode

Dark mode is automatically enabled based on user's system preference (`prefers-color-scheme`).

### Color Adaptations

| Element          | Light Mode | Dark Mode  |
| ---------------- | ---------- | ---------- |
| Background       | White      | `gray-900` |
| Text             | `gray-900` | White      |
| Card background  | White      | `gray-800` |
| Card border      | `gray-200` | `gray-700` |
| Input background | White      | `gray-700` |

## Animation

### Transitions

Default transition for interactive elements:

```css
transition: colors 150ms ease;
```

### Reduced Motion

Respects user's motion preferences:

```css
@media (prefers-reduced-motion: reduce) {
	* {
		animation-duration: 0.01ms !important;
		transition-duration: 0.01ms !important;
	}
}
```

## Usage Guidelines

### When to use Primary buttons

- Main call-to-action
- Submit forms
- Confirm actions

### When to use Secondary buttons

- Cancel actions
- Alternative actions
- Less important CTAs

### When to use Ghost buttons

- Tertiary actions
- Inline links styled as buttons
- Menu items

### Input validation

- Show error states immediately on blur
- Show success states after successful validation
- Include helpful error messages
- Use badges for additional context

## Resources

- [UnoCSS Documentation](https://unocss.dev/)
- [Melt UI Components](https://melt-ui.com/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

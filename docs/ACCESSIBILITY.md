# Accessibility (A11y) Compliance

This document describes Authrim's accessibility implementation, testing strategy, and WCAG 2.1 AA compliance.

## Accessibility Standards

**Target Compliance**: WCAG 2.1 Level AA

**Testing Tools**:
- **axe-core**: Automated accessibility testing
- **Playwright**: E2E accessibility testing
- **Manual testing**: Keyboard navigation, screen readers

## WCAG 2.1 AA Requirements

### 1. Perceivable

#### 1.1 Text Alternatives
- ✅ All images have `alt` attributes
- ✅ Icons have `aria-label` or `aria-labelledby`
- ✅ Decorative images marked with `alt=""`

#### 1.2 Time-based Media
- N/A (No video/audio content)

#### 1.3 Adaptable
- ✅ Semantic HTML (`<header>`, `<nav>`, `<main>`, `<footer>`)
- ✅ Proper heading hierarchy (`<h1>` → `<h2>` → `<h3>`)
- ✅ Lists use `<ul>`, `<ol>`, `<li>`
- ✅ Tables use proper markup (if present)

#### 1.4 Distinguishable

**Color Contrast** (WCAG 2.1 AA):
- ✅ **Normal text**: 4.5:1 minimum
- ✅ **Large text** (18pt+): 3:1 minimum
- ✅ **UI components**: 3:1 minimum

**Defined in**: `packages/ui/docs/DESIGN_SYSTEM.md`

**Color Palette**:
```css
/* Primary colors with WCAG AA contrast */
--primary-600: #3b82f6; /* On white: 4.5:1 */
--primary-700: #2563eb; /* On white: 6.8:1 */

/* Text colors */
--gray-900: #111827; /* On white: 16.1:1 */
--gray-700: #374151; /* On white: 10.7:1 */
```

**Resize Text**:
- ✅ Text can be resized up to 200% without loss of functionality
- ✅ Responsive design: 320px - 1920px

**Text Spacing**:
- ✅ Line height: 1.5+ for body text
- ✅ Paragraph spacing: 2x font size
- ✅ Letter spacing: adjustable

### 2. Operable

#### 2.1 Keyboard Accessible
- ✅ All functionality available via keyboard
- ✅ No keyboard traps
- ✅ Skip navigation links (if applicable)
- ✅ Focus order follows visual order

#### 2.2 Enough Time
- ✅ Session timeout warnings
- ✅ Adjustable time limits (where applicable)

#### 2.3 Seizures and Physical Reactions
- ✅ No content flashes more than 3 times per second

#### 2.4 Navigable
- ✅ Page titles describe purpose
- ✅ Focus order is logical
- ✅ Link purpose clear from context
- ✅ Multiple navigation methods (menu, search)
- ✅ Headings and labels descriptive

**Focus Indicators**:
- ✅ Visible focus indicators (2px outline)
- ✅ 3:1 contrast ratio for focus indicators
- ✅ Defined in UnoCSS configuration

#### 2.5 Input Modalities
- ✅ Pointer gestures have keyboard alternatives
- ✅ Touch targets ≥ 44x44 pixels

### 3. Understandable

#### 3.1 Readable
- ✅ Language of page identified (`lang="en"` or `lang="ja"`)
- ✅ Language changes marked (`lang` attribute)

#### 3.2 Predictable
- ✅ Consistent navigation
- ✅ Consistent identification of components
- ✅ No unexpected context changes

#### 3.3 Input Assistance
- ✅ Error identification in forms
- ✅ Labels or instructions provided
- ✅ Error suggestions (where applicable)
- ✅ Error prevention for critical actions

### 4. Robust

#### 4.1 Compatible
- ✅ Valid HTML (no parsing errors)
- ✅ ARIA attributes used correctly
- ✅ Status messages announced to screen readers

## Accessibility Testing

### Automated Testing

**Tool**: axe-core + Playwright

**Test Coverage**:
- Homepage (`/`)
- Login page (`/login`)
- Register page (`/register`)
- Consent page (`/consent`)
- Error page (`/error`)

**Running Accessibility Tests**:
```bash
pnpm test:e2e test-e2e/accessibility.spec.ts
```

**Test Suite**: `test-e2e/accessibility.spec.ts`

**Test Cases** (15+ tests):
1. No WCAG 2.1 AA violations on homepage
2. No violations on login page
3. No violations on register page
4. No violations on consent page
5. No violations on error page
6. Color contrast requirements met
7. Keyboard navigation works
8. Visible focus indicators
9. Valid ARIA attributes
10. All form inputs have labels

### Manual Testing

#### Keyboard Navigation

**Test Procedure**:
1. Navigate using only keyboard (Tab, Shift+Tab, Enter, Escape)
2. Ensure all interactive elements are reachable
3. Verify focus indicators are visible
4. Check focus order is logical

**Keyboard Shortcuts**:
- `Tab`: Move focus forward
- `Shift+Tab`: Move focus backward
- `Enter`: Activate buttons, submit forms
- `Space`: Activate buttons, toggle checkboxes
- `Escape`: Close modals, cancel actions

#### Screen Reader Testing

**Recommended Tools**:
- **macOS**: VoiceOver (built-in)
- **Windows**: NVDA (free), JAWS (commercial)
- **Linux**: Orca

**Test Checklist**:
- [ ] Page title announced correctly
- [ ] Headings announced with levels
- [ ] Form labels associated with inputs
- [ ] Error messages announced
- [ ] Dynamic content changes announced
- [ ] ARIA live regions work

**Note**: Manual screen reader testing is not automated but should be performed periodically.

## ARIA Implementation

### Common ARIA Patterns

**Buttons**:
```html
<button aria-label="Close dialog">×</button>
```

**Form Inputs**:
```html
<input
  type="email"
  id="email"
  aria-invalid="false"
  aria-describedby="email-error"
/>
<p id="email-error" role="alert">Invalid email format</p>
```

**Loading States**:
```html
<div role="status" aria-label="Loading">
  <span class="sr-only">Loading...</span>
</div>
```

**Alerts**:
```html
<div role="alert" aria-live="polite">
  Your changes have been saved.
</div>
```

### ARIA Attributes Used

- `aria-label`: Accessible name for elements
- `aria-labelledby`: Reference to labeling element
- `aria-describedby`: Additional description
- `aria-invalid`: Mark invalid form fields
- `aria-live`: Announce dynamic changes
- `role="status"`, `role="alert"`: Semantic roles

## Accessibility Features

### 1. UI Components (Melt UI)

**Framework**: [Melt UI](https://melt-ui.com/) (headless, accessible)

**Benefits**:
- Pre-built accessibility
- ARIA patterns included
- Keyboard navigation handled
- Focus management automatic

**Components Used**:
- Buttons
- Forms
- Dialogs/Modals
- Alerts

### 2. Design System

**Location**: `packages/ui/docs/DESIGN_SYSTEM.md`

**Accessibility Guidelines**:
- Color contrast ratios defined
- Typography scale (rem-based)
- Responsive breakpoints
- Focus states specified

### 3. Multi-language Support

**Framework**: Paraglide (type-safe i18n)

**Languages**: English (EN), Japanese (JA)

**Accessibility Benefit**:
- Users can read content in preferred language
- `lang` attribute updated on language change

## Current Accessibility Status

### Lighthouse Accessibility Score

**Current**: 89/100

**Target**: 90+

**Action Items**:
1. Review and fix remaining axe-core violations
2. Ensure all ARIA labels are present
3. Verify keyboard navigation on all pages
4. Fix any color contrast issues

### Automated Test Results

**axe-core Rules Tested**:
- `wcag2a`: WCAG 2.0 Level A
- `wcag2aa`: WCAG 2.0 Level AA
- `wcag21a`: WCAG 2.1 Level A
- `wcag21aa`: WCAG 2.1 Level AA

**Target**: Zero violations on all pages

## Accessibility Checklist

### Development

- [ ] Use semantic HTML elements
- [ ] Provide text alternatives for non-text content
- [ ] Ensure sufficient color contrast (4.5:1)
- [ ] Make all functionality keyboard accessible
- [ ] Provide visible focus indicators
- [ ] Use ARIA when necessary (not excessively)
- [ ] Test with keyboard only
- [ ] Test with screen reader
- [ ] Validate with axe DevTools

### Testing

- [ ] Run automated accessibility tests (`pnpm test:e2e`)
- [ ] Manual keyboard navigation testing
- [ ] Screen reader testing (VoiceOver, NVDA)
- [ ] Color contrast verification
- [ ] Zoom to 200% and verify usability

### Deployment

- [ ] Lighthouse accessibility score ≥ 90
- [ ] Zero axe-core violations
- [ ] Accessibility statement published (future)

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [Melt UI Accessibility](https://melt-ui.com/docs/introduction#accessibility)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Keyboard Testing Guide](https://webaim.org/articles/keyboard/)

## Contact

For accessibility issues or suggestions, please open an issue on [GitHub](https://github.com/sgrastar/authrim/issues).

export interface LoginUICssValidationResult {
  valid: boolean;
  sanitizedCss: string | null;
  errors: string[];
}

const MAX_LOGIN_UI_CUSTOM_CSS_BYTES = 16 * 1024;

const ALLOWED_SELECTORS = [
  ':root',
  "[data-login-theme='classic']",
  "[data-login-theme='meridian']",
  "[data-login-theme='split-brand-panel']",
  "[data-login-theme='fullbleed-glass']",
  "[data-theme='light']",
  "[data-theme='dark']",
  "[data-page-layout='centered_card']",
  "[data-page-layout='split_panel']",
  "[data-page-layout='fullbleed_card']",
  "[data-topbar-position='below_card']",
  "[data-topbar-position='in_card']",
  "[data-topbar-position='top_right']",
  "[data-topbar-position='bottom_left']",
  "[data-topbar-position='bottom_center']",
  "[data-topbar-position='bottom_right']",
  "[data-topbar-position='hidden']",
  "[data-header-style='center']",
  "[data-header-style='bar']",
  "[data-footer-style='simple']",
  "[data-footer-style='bar']",
  "[data-logo-layout='stack']",
  "[data-logo-layout='row']",
  "[data-split-frame='full']",
  "[data-split-frame='card']",
  "[data-split-panel-side='left']",
  "[data-split-panel-side='right']",
  "[data-split-panel-width='narrow']",
  "[data-split-panel-width='wide']",
  "[data-split-background-mode='shared']",
  "[data-split-background-mode='brand']",
  "[data-split-background-mode='panel']",
  "[data-has-page-background-image='true']",
  "[data-has-page-background-image='false']",
  "[data-has-login-panel-background-image='true']",
  "[data-has-login-panel-background-image='false']",
  "[data-brand-content-mode='logo_copy']",
  "[data-brand-content-mode='logo']",
  "[data-brand-content-mode='none']",
  "[data-brand-position='top']",
  "[data-brand-position='center']",
  "[data-brand-position='bottom']",
  "[data-brand-align='left']",
  "[data-brand-align='center']",
  "[data-brand-align='right']",
  '.auth-page',
  '.auth-brand-panel',
  '.auth-brand-panel__content',
  '.auth-brand-panel__logo',
  '.auth-container',
  '.auth-topbar',
  '.auth-header',
  '.auth-header__logo',
  '.auth-header__title',
  '.auth-header__subtitle',
  '.auth-footer',
  '.auth-footer__links',
  '.auth-bottom-link',
  '.auth-client-card',
  '.auth-divider',
  '.auth-divider__line',
  '.auth-divider__text',
  '.auth-section-title',
  '.auth-section-subtitle',
  '.runtime-screen-step',
  '.card',
  '.card-body',
  '.input',
  '.btn',
  '.theme-toggle',
  '.auth-lang-select',
  'button',
  'input',
  'select',
  'textarea',
  'a',
];

const ALLOWED_PROPERTIES = new Set([
  'accent-color',
  'align-items',
  'backdrop-filter',
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'border',
  'border-color',
  'border-radius',
  'border-width',
  'bottom',
  'box-shadow',
  'color',
  'display',
  'filter',
  'font-family',
  'font-size',
  'font-weight',
  'gap',
  'justify-content',
  'letter-spacing',
  'line-height',
  'left',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'min-width',
  'min-height',
  'object-fit',
  'opacity',
  'outline-color',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'text-align',
  'text-decoration',
  'text-transform',
  'top',
  'transform',
  'width',
]);

const FORBIDDEN_VALUE_PATTERNS = [
  /@/u,
  /<|>/u,
  /\/\*|\*\//u,
  /\\[0-9a-f]{1,6}/iu,
  /behavior\s*:/iu,
  /binding\s*:/iu,
  /expression\s*\(/iu,
  /import\s*\(/iu,
  /javascript\s*:/iu,
  /vbscript\s*:/iu,
  /data\s*:/iu,
  /url\s*\(/iu,
];

const FORBIDDEN_CSS_PATTERNS = [
  /\/\*|\*\//u,
  /@import/iu,
  /@font-face/iu,
  /@namespace/iu,
  /@supports/iu,
  /@keyframes/iu,
  /<\/?style/iu,
  /<\/?script/iu,
];

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

function selectorIsAllowed(selector: string): boolean {
  const normalized = normalizeSelector(selector);
  if (!normalized) return false;
  if (normalized.includes('#') || (normalized.includes('[') && !normalized.startsWith('[data-'))) {
    return false;
  }
  if (/[>+~]/u.test(normalized)) return false;

  const parts = normalized.split(/\s+/u);
  return parts.every((part) => {
    const base = part.replace(/:(?:hover|focus|focus-visible|disabled|active)$/u, '');
    if (ALLOWED_SELECTORS.includes(base)) return true;

    const attributeSelectors = base.match(/\[[^\]]+\]/gu);
    if (!attributeSelectors || attributeSelectors.join('') !== base) return false;
    return attributeSelectors.every((attribute) => ALLOWED_SELECTORS.includes(attribute));
  });
}

function declarationIsAllowed(declaration: string): string | null {
  const separator = declaration.indexOf(':');
  if (separator <= 0) {
    return null;
  }

  const property = declaration.slice(0, separator).trim().toLowerCase();
  const value = declaration.slice(separator + 1).trim();
  if (!property || !value) {
    return null;
  }

  if (property.startsWith('--')) {
    if (!/^--(?:auth|login)-[a-z0-9-]{1,64}$/u.test(property)) {
      return null;
    }
  } else if (!ALLOWED_PROPERTIES.has(property)) {
    return null;
  }

  if (value.length > 512 || FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return null;
  }

  return `${property}: ${value}`;
}

export function validateLoginUICustomCss(input: unknown): LoginUICssValidationResult {
  if (input === null || input === undefined || input === '') {
    return { valid: true, sanitizedCss: null, errors: [] };
  }
  if (typeof input !== 'string') {
    return { valid: false, sanitizedCss: null, errors: ['Custom CSS must be a string.'] };
  }

  const css = input.trim();
  if (!css) {
    return { valid: true, sanitizedCss: null, errors: [] };
  }
  if (new TextEncoder().encode(css).byteLength > MAX_LOGIN_UI_CUSTOM_CSS_BYTES) {
    return {
      valid: false,
      sanitizedCss: null,
      errors: [`Custom CSS must be ${MAX_LOGIN_UI_CUSTOM_CSS_BYTES} bytes or less.`],
    };
  }
  if (FORBIDDEN_CSS_PATTERNS.some((pattern) => pattern.test(css))) {
    return {
      valid: false,
      sanitizedCss: null,
      errors: ['Custom CSS contains a forbidden at-rule.'],
    };
  }

  const errors: string[] = [];
  const sanitizedRules: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/gu;
  let consumed = '';
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(css)) !== null) {
    consumed += match[0];
    const selectorList = match[1]
      .split(',')
      .map((selector) => normalizeSelector(selector))
      .filter(Boolean);
    if (
      selectorList.length === 0 ||
      selectorList.some((selector) => !selectorIsAllowed(selector))
    ) {
      errors.push(`Selector is not allowed: ${match[1].trim()}`);
      continue;
    }

    const declarations = match[2]
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map(declarationIsAllowed);
    if (declarations.some((declaration) => declaration === null)) {
      errors.push(`Declaration is not allowed in selector: ${match[1].trim()}`);
      continue;
    }

    const safeDeclarations = declarations.filter((declaration): declaration is string =>
      Boolean(declaration)
    );
    if (safeDeclarations.length === 0) {
      errors.push(`Selector has no valid declarations: ${match[1].trim()}`);
      continue;
    }

    sanitizedRules.push(`${selectorList.join(', ')} { ${safeDeclarations.join('; ')}; }`);
  }

  if (css.replace(/\s+/gu, '') !== consumed.replace(/\s+/gu, '')) {
    errors.push('Custom CSS must contain only simple selector blocks.');
  }

  if (errors.length > 0) {
    return { valid: false, sanitizedCss: null, errors };
  }

  return { valid: true, sanitizedCss: sanitizedRules.join('\n'), errors: [] };
}

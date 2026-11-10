import { describe, expect, it } from 'vitest';
import { validateLoginUICustomCss } from '../../../../../ar-lib-core/src/utils/login-ui-css-validator';
import { cssForEditor, cssFromEditor } from './custom-css-scaffold';

describe('custom CSS editor scaffold', () => {
	it('shows real Login UI selectors without saving empty guidance', () => {
		const editor = cssForEditor('');
		expect(editor).toContain('/* Header */');
		expect(editor).toContain('.auth-page .auth-bar__title {}');
		expect(editor).toContain('.auth-page .runtime-screen-heading h2 {}');
		expect(editor).toContain('.auth-page .runtime-screen-text {}');
		expect(editor).toContain('.auth-page .auth-bottom-link a {}');
		expect(editor).toContain('.auth-page .runtime-auth-button:not(.secondary) {}');
		expect(editor).toContain('.auth-page .runtime-auth-button.secondary {}');
		expect(cssFromEditor(editor)).toBe('');
		expect(validateLoginUICustomCss(cssFromEditor(editor)).valid).toBe(true);
	});

	it('saves declarations added to the scaffold and retains existing CSS', () => {
		const existing = '.auth-container .btn:hover { border-radius: 12px; }';
		const editor = cssForEditor(existing).replace(
			'.auth-page .auth-bar__title {}',
			'.auth-page .auth-bar__title { color: #ffffff; }'
		);
		const stored = cssFromEditor(editor);
		expect(stored).toContain('.auth-page .auth-bar__title { color: #ffffff; }');
		expect(stored).toContain(existing);
		expect(stored).not.toContain('/*');
		expect(stored).not.toContain('{}');
		expect(validateLoginUICustomCss(stored).valid).toBe(true);
	});

	it('accepts screen text, link, and button rules added to the scaffold', () => {
		const editor = cssForEditor('')
			.replace(
				'.auth-page .runtime-screen-heading h2 {}',
				'.auth-page .runtime-screen-heading h2 { color: #111111; }'
			)
			.replace(
				'.auth-page .runtime-screen-text {}',
				'.auth-page .runtime-screen-text { color: #333333; }'
			)
			.replace(
				'.auth-page .auth-bottom-link a {}',
				'.auth-page .auth-bottom-link a { color: #224488; }'
			)
			.replace(
				'.auth-page .runtime-auth-button:not(.secondary) {}',
				'.auth-page .runtime-auth-button:not(.secondary) { color: #ffffff; }'
			)
			.replace(
				'.auth-page .runtime-auth-button.secondary:hover {}',
				'.auth-page .runtime-auth-button.secondary:hover { background-color: #eeeeee; }'
			);
		const stored = cssFromEditor(editor);
		expect(validateLoginUICustomCss(stored).valid).toBe(true);
		expect(stored).not.toContain('{}');
	});

	it('does not discard arbitrary comments from the user', () => {
		const stored = cssFromEditor(`${cssForEditor('')}\n/* hidden */`);
		expect(validateLoginUICustomCss(stored).valid).toBe(false);
	});
});

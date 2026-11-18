import { describe, expect, it } from 'vitest';
import { statementDescriptionHtml } from './statement-html';

describe('statementDescriptionHtml', () => {
	it('keeps the tags the sign-in screen keeps and checks links', () => {
		expect(
			statementDescriptionHtml('<p>Read <a href="https://example.com/t">the terms</a></p><br/>')
		).toBe(
			'<p>Read <a href="https://example.com/t" target="_blank" rel="noopener noreferrer">the terms</a></p><br>'
		);
		expect(statementDescriptionHtml('<STRONG>x</STRONG>\ny')).toBe('<strong>x</strong><br>y');
	});

	it('shows every other tag, attribute and link as text', () => {
		expect(statementDescriptionHtml('<script>alert(1)</script>')).toBe(
			'&lt;script&gt;alert(1)&lt;/script&gt;'
		);
		expect(statementDescriptionHtml('<a href="javascript:alert(1)">x</a>')).toBe(
			'&lt;a href=&quot;javascript:alert(1)&quot;&gt;x</a>'
		);
		expect(statementDescriptionHtml('<p onclick="x()">y</p>')).toBe(
			'&lt;p onclick=&quot;x()&quot;&gt;y</p>'
		);
		expect(statementDescriptionHtml('<img src=x onerror=alert(1)>')).toBe(
			'&lt;img src=x onerror=alert(1)&gt;'
		);
		expect(statementDescriptionHtml('a & b')).toBe('a &amp; b');
		expect(statementDescriptionHtml(null)).toBe('');
	});
});

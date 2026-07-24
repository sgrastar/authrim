import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	fileURLToPath(new URL('../lib/components/AccountPage.svelte', import.meta.url)),
	'utf8'
);

describe('Account Page published composition', () => {
	it('uses localized page copy and evaluates allowlisted placement conditions', () => {
		expect(source).toContain('localizedPageCopy().title');
		expect(source).toContain('placementVisible(item.condition)');
		expect(source).toContain("case 'passkey_enabled'");
		expect(source).toContain("case 'consent_records_available'");
	});

	it('renders only validated links and uses the dynamic viewport height', () => {
		expect(source).toContain("field.block_type === 'link' && safeHref(field.href)");
		expect(source).toContain('min-height: 100dvh');
		expect(source).not.toContain('min-height: 100vh');
	});
});

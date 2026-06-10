import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

describe('UI URL sink guards', () => {
	it('guards consent document and deletion links with link URL validation', () => {
		const consentSource = source('routes/consent/+page.svelte');

		expect(consentSource.match(/isValidLinkUrl\(item\.document_url\)/g)).toHaveLength(2);
		expect(consentSource).toContain('isValidLinkUrl(i.deletion_url)');
		expect(consentSource).toContain('href={item.document_url}');
		expect(consentSource).toContain('href={deletionItem.deletion_url}');
	});

	it('does not render discovery candidate login URLs without link validation', () => {
		const discoverSource = source('routes/discover/+page.svelte');

		expect(discoverSource).toContain('isValidLinkUrl(candidate.login_url)');
		expect(discoverSource).toContain('href={rememberedHref}');
		expect(discoverSource).toContain('class="tenant-option" {href}');
		expect(discoverSource).not.toContain('href={candidate.login_url}');
		expect(discoverSource).not.toContain('return candidate.login_url;');
	});

	it('guards external provider image URLs before using them as img src values', () => {
		const sources = [
			source('lib/components/LoginMethodSelector.svelte'),
			source('routes/login/+page.svelte'),
			source('routes/signup/+page.svelte')
		];

		for (const componentSource of sources) {
			expect(componentSource).toContain('provider.iconUrl && isValidImageUrl(provider.iconUrl)');
			expect(componentSource).toContain('src={provider.iconUrl}');
		}
	});
});

import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { t } from '#lib/i18n/i18n.svelte.js';
import { Draft } from '#lib/ui/save/draft.svelte.js';
import { emptyAnswers } from './connection-model';
import SpSteps from './SpSteps.svelte';
import InSteps from './InSteps.svelte';
import ConnectionMetadataImport from './ConnectionMetadataImport.svelte';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('SAML connection detail controls', () => {
	it.each(['sp', 'idp'])('keeps %s metadata import modes out of manual detail editing', (kind) => {
		const root = document.createElement('div');
		document.body.append(root);
		cleanups.push(async () => root.remove());
		const answers = new Draft(emptyAnswers(true)).value;
		answers.sp.entityId = 'urn:stored:sp';
		answers.sp.acsUrl = 'https://sp.example.test/acs';
		answers.idp.entityId = 'urn:stored:idp';
		answers.idp.acsUrl = 'https://idp.example.test/sso';
		answers.idp.certificate = 'stored-public-certificate';
		const detail =
			kind === 'sp'
				? mount(SpSteps, {
						target: root,
						props: { step: 'sp-import', live: true, editing: true, form: answers.sp }
					})
				: mount(InSteps, {
						target: root,
						props: {
							step: 'idp-import',
							live: true,
							editing: true,
							op: answers.op,
							idp: answers.idp
						}
					});
		cleanups.push(() => unmount(detail));
		flushSync();
		expect(root.querySelectorAll('input[type="radio"]')).toHaveLength(0);
		expect(root.textContent).toContain(t('sf.row.entityId'));
		expect(root.textContent).toContain(t(kind === 'sp' ? 'sf.ours.acsUrl' : 'sf.ours.ssoUrl'));
		expect(Array.from(root.querySelectorAll('input'), (input) => input.value)).toContain(
			`urn:stored:${kind}`
		);
		if (kind === 'idp')
			expect(root.querySelector('textarea')?.value).toBe('stored-public-certificate');
		const importer = mount(ConnectionMetadataImport, {
			target: root,
			props: {
				id: 'stored',
				kind: kind === 'sp' ? 'saml_sp' : 'saml_idp',
				updatedAt: '2026-11-18T00:00:00.000Z',
				canPreview: true,
				canImport: true,
				client: {
					preview: async () => {
						throw new Error('Unexpected preview during render');
					},
					importMetadata: async () => {
						throw new Error('Unexpected import during render');
					}
				},
				onimported: () => {}
			}
		});
		cleanups.push(() => unmount(importer));
		flushSync();
		expect(root.querySelectorAll('input[type="radio"][value="url"]')).toHaveLength(1);
		expect(root.querySelectorAll('input[type="radio"][value="xml"]')).toHaveLength(1);
		expect(root.querySelectorAll('input[type="radio"]:disabled')).toHaveLength(0);
	});
});

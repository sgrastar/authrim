<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError, ConflictError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { createFakeIdentifierMaterials } from '#lib/api/fake/identifier-materials-fake.js';
	import type { SaltResult } from '#lib/api/identifier-materials.js';
	import { provideIdentifierMaterials } from '../patterns/identifier-materials-context';
	import SaltImportDialog from '../patterns/SaltImportDialog.svelte';

	/**
	 * Storybook demo: the salt import dialog open, with a salt kept already under "legacy-idp"
	 * (its secret is "legacy salt"), and what it reported.
	 */
	interface Props {
		/** What goes wrong after a 409: the list of salts cannot be read, or the name is not in it. */
		mode?: 'normal' | 'listFails' | 'limit';
	}
	let { mode = 'normal' }: Props = $props();
	let open = $state(true);
	let result = $state<SaltResult | null>(null);

	const fake = createFakeIdentifierMaterials({ salts: { 'legacy-idp': 'legacy salt' } });
	provideIdentifierMaterials(
		untrack(() => mode) === 'normal'
			? fake
			: {
					...fake,
					importSalt: () => Promise.reject(new ConflictError('conflict', {})),
					salts: () =>
						untrack(() => mode) === 'listFails'
							? Promise.reject(new ApiError(503, 'unavailable', 'unavailable'))
							: Promise.resolve([])
				}
	);
</script>

<p data-testid="outcome">
	{#if result}{t(`pid.result.salt.${result.outcome}`, {
			name: result.name,
			fingerprint: result.fingerprint
		})}{:else}{open ? '' : '-'}{/if}
</p>
<button type="button" onclick={() => (open = true)}>Reopen</button>
<SaltImportDialog
	{open}
	name="legacy-idp"
	onimported={(done) => {
		result = done;
		open = false;
	}}
	oncancel={() => (open = false)}
/>

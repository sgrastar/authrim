<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { createFakeIdentifierMaterials } from '#lib/api/fake/identifier-materials-fake.js';
	import type { CsvImportKind } from '#lib/api/identifier-materials.js';
	import CsvImportDialog from '../patterns/CsvImportDialog.svelte';
	import type { CsvImportResult } from '../patterns/identifier-import-model';
	import { provideIdentifierMaterials } from '../patterns/identifier-materials-context';

	/**
	 * Storybook demo: a CSV import dialog open on a source, a store or an exception list that
	 * already holds something (so a different value is a conflict, and the list is replaced).
	 */
	interface Props {
		kind: CsvImportKind;
		name: string;
	}

	let { kind, name }: Props = $props();

	let open = $state(true);
	let result = $state<CsvImportResult | null>(null);

	const client = createFakeIdentifierMaterials({
		salts: { 'legacy-idp': 'legacy salt' },
		sources: { 'employee-number': { usr_01: 'E1001' } },
		stores: { 'legacy-ids': { usr_01: { 'https://sp.example.org': 'abc123' } } },
		exceptions: { 'exception-map': 2 }
	});
	provideIdentifierMaterials(client);
</script>

<p data-testid="outcome">
	{#if result?.kind === 'exceptions'}{result.counts.rows === 0
			? t('pid.result.exceptionsEmptied', { name: result.name })
			: t('pid.result.exceptions', { name: result.name, ...result.counts })}{:else if result}{t(
			'pid.result.pairs',
			{ name: result.name, ...result.counts }
		)}{/if}
</p>
<CsvImportDialog
	{open}
	{kind}
	{name}
	onimported={(done) => {
		result = done;
		open = false;
	}}
	oncancel={() => (open = false)}
/>

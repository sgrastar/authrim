<script lang="ts">
	import type { ScreenKind, ScreenListItem } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ActiveThemeScreenPreview from '#lib/pages/customization/screens/ActiveThemeScreenPreview.svelte';
	import { savedScreenPreview } from '#lib/pages/customization/screens/screen-preview-content.js';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { useFlowResources } from './flow-resources-context';
	import { offeredScreens, screenFieldRows, type ScreenFieldRow } from './screen-fields';

	/**
	 * One screen chosen among the loaded ones, of the kinds given, with a preview of it under the
	 * drop-down and as wide as it (in the applied theme, as on the screens page).
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		screens: readonly ScreenListItem[];
		screenKinds: readonly ScreenKind[];
		value: string;
		onchange: (id: string) => void;
	}

	let { label, hint, required = false, screens, screenKinds, value, onchange }: Props = $props();

	const { loadTheme } = useFlowResources();
	const chosen = $derived(screens.find((screen) => screen.screen_key === value));
	const preview = $derived(chosen ? savedScreenPreview(chosen) : undefined);
	const asked = $derived(chosen ? screenFieldRows(chosen.fields) : []);
	const columns = $derived([
		{ key: 'label', label: t('af.fields.col.label') },
		{ key: 'target', label: t('af.fields.col.target') }
	]);
	const options = $derived(
		offeredScreens(screens, screenKinds).map((screen) => ({
			value: screen.screen_key,
			label: screen.is_active
				? screen.display_name
				: t('af.screen.inactive', { name: screen.display_name })
		}))
	);
</script>

<FieldRow {label} {required} plain>
	<Select
		{label}
		hideLabel
		{required}
		{hint}
		placeholder={t('af.choose')}
		{value}
		onchange={(id) => onchange(id)}
		{options}
	/>
</FieldRow>
{#if preview}
	<!-- What the screen asks for beside it, and the screen itself where the drop-down is. -->
	<div class="pick">
		<section class="pick__fields" aria-labelledby="{preview.id}-fields">
			<h3 class="pick__title" id="{preview.id}-fields">{t('af.fields.title')}</h3>
			<DataTable
				caption={t('af.fields.title')}
				{columns}
				rows={asked}
				rowKey={(row) => row.id}
				dense
			>
				{#snippet cell(row: ScreenFieldRow, column)}
					{#if column.key === 'label'}
						<span class="pick__item">
							<span class="pick__name"
								>{row.label}{#if row.required}<span class="pick__required"
										>{t('af.fields.required')}</span
									>{/if}</span
							>
							<code>{row.key}</code>
						</span>
					{:else}{row.target}{/if}
				{/snippet}
				{#snippet empty()}{t('af.fields.none')}{/snippet}
			</DataTable>
		</section>
		<div class="pick__preview" role="group" aria-label={t('af.screen.preview')}>
			{#key preview.id}
				<ActiveThemeScreenPreview {preview} {loadTheme} />
			{/key}
		</div>
	</div>
{/if}

<style>
	/* The same two columns as the rows above: the table under the name, the preview under the
	   drop-down (a smaller picture of the page, not a page of its own). */
	.pick {
		display: grid;
		grid-template-columns: var(--row-name-col, minmax(0, 2fr)) minmax(0, 3fr);
		gap: 8px var(--space-columns);
		align-items: start;
	}

	.pick__fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
	}

	.pick__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.pick__item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.pick__required {
		margin-inline-start: 6px;
		color: var(--danger);
		font-size: var(--fs-small);
	}

	.pick__item code {
		color: var(--text-muted);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.pick__preview {
		min-width: 0;
		container-type: inline-size;
	}

	@media (max-width: 640px) {
		.pick {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>

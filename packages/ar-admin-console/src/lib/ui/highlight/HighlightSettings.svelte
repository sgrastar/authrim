<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SettingRow from '../patterns/SettingRow.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import Select from '../primitives/Select.svelte';
	import ColorField from '../primitives/ColorField.svelte';
	import {
		HIGHLIGHT_COLORS,
		highlightPreference,
		type HighlightColor
	} from './highlight-preference.svelte';
</script>

<SettingRow title={t('highlight.title')} description={t('highlight.description')}>
	<Toggle
		label={t('highlight.title')}
		checked={highlightPreference.enabled}
		onchange={(enabled) => highlightPreference.setEnabled(enabled)}
	/>
</SettingRow>
<SettingRow title={t('highlight.color')}>
	<div class="highlight-settings">
		<Select
			label={t('highlight.color')}
			hideLabel
			size="sm"
			value={highlightPreference.color}
			options={[...HIGHLIGHT_COLORS, 'custom' as const].map((value) => ({
				value,
				label: t(`highlight.${value}`)
			}))}
			onchange={(value) => highlightPreference.setColor(value as HighlightColor)}
		/>
		{#if highlightPreference.color === 'custom'}
			<ColorField
				label={t('highlight.customColor')}
				bind:value={
					() => highlightPreference.custom, (value) => highlightPreference.setCustom(value)
				}
			/>
		{/if}
	</div>
</SettingRow>

<style>
	.highlight-settings {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
</style>

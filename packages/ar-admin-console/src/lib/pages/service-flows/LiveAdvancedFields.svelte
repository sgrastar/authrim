<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import { PROFILE_DEFAULTS } from './connection-settings';
	import type { AdvancedField } from './advanced-settings';
	let {
		fields,
		values = $bindable(),
		readonly = false,
		publicClient = false,
		locked = [],
		sources = {}
	}: {
		fields: AdvancedField[];
		values: Record<string, unknown>;
		readonly?: boolean;
		publicClient?: boolean;
		locked?: string[];
		sources?: Record<string, string>;
	} = $props();
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	function choose(field: AdvancedField, next: string) {
		values[field.key] = next || null;
		if (
			field.key === 'samlProfile' &&
			(next === 'baseline' ||
				next === 'strict' ||
				next === 'academic_publisher' ||
				next === 'legacy')
		) {
			const profile = PROFILE_DEFAULTS[next];
			Object.assign(values, {
				signResponses: profile.signResponses,
				signAssertions: profile.signAssertions,
				authnRequestSignaturePolicy: profile.authnRequestSignature,
				logoutRequestSignaturePolicy: profile.logoutRequestSignature,
				logoutResponseSignaturePolicy: profile.logoutResponseSignature
			});
		}
	}
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
</script>

{#each fields as field (field.key)}
	{@const value = values[field.key]}
	{@const disabled =
		readonly ||
		locked.includes(field.key) ||
		(publicClient && field.key === 'client_credentials_allowed')}
	<fieldset {disabled}>
		<legend class="sr-only">{t(field.label)}</legend>
		{#if field.type === 'boolean'}
			<SelectRow
				label={t(field.label)}
				value={value === null ? '' : String(value)}
				options={[
					{ value: '', label: t('sf.live.unset'), disabled: value !== null },
					{ value: 'true', label: t('sf.live.enabled') },
					{ value: 'false', label: t('sf.live.disabled') }
				]}
				onchange={(next) => (values[field.key] = next === 'true')}
			/>
		{:else if field.type === 'list' && field.options}
			<CheckboxRow
				label={t(field.label)}
				options={[...new Set([...field.options, ...strings(value)])].map((item) => ({
					value: item,
					label: item,
					disabled: publicClient && item === 'client_credentials'
				}))}
				bind:selected={() => strings(value), (next) => (values[field.key] = next)}
			/>
		{:else if field.type === 'list'}
			{#if field.key === 'profileUpdateFields'}<ToggleRow
					label={t('cs.live.useTenantProfile')}
					bind:checked={() => value === null, (next) => (values[field.key] = next ? null : [])}
				/>{/if}
			{#if field.key !== 'profileUpdateFields' || value !== null}<TextArea
					label={t(field.label)}
					value={strings(value).join('\n')}
					rows={3}
					maxlength={16384}
					hint={t('cs.live.listHint')}
					oninput={(event) =>
						(values[field.key] = event.currentTarget.value
							.split('\n')
							.map((item) => item.trim())
							.filter(Boolean))}
				/>{/if}
		{:else if field.type === 'number'}
			<NumberField
				label={t(field.label)}
				min={field.min}
				max={field.max}
				bind:value={
					() => (typeof value === 'number' ? value : null), (next) => (values[field.key] = next)
				}
			/>
		{:else if field.options}
			<SelectRow
				label={t(field.label)}
				value={text(value)}
				options={[
					{
						value: '',
						label: t('sf.live.unset'),
						disabled:
							value !== null && !['minimum_ial', 'minimumIal', 'minimumAal'].includes(field.key)
					},
					...[...new Set([...field.options, ...(text(value) ? [text(value)] : [])])].map(
						(item) => ({ value: item, label: item })
					)
				]}
				onchange={(next) => choose(field, next)}
			/>
		{:else if field.type === 'certificate'}
			<TextArea
				label={t(field.label)}
				mono
				maxlength={16384}
				value={text(value)}
				oninput={(event) => (values[field.key] = event.currentTarget.value)}
			/>
		{:else}
			<TextRow
				label={t(field.label)}
				value={text(value)}
				maxlength={2048}
				oninput={(event) => (values[field.key] = event.currentTarget.value)}
			/>
		{/if}
		{#if sources[field.key]}<small
				>{sources[field.key]}{locked.includes(field.key) ? ` · ${t('cs.live.locked')}` : ''}</small
			>{/if}
	</fieldset>
{/each}

<style>
	fieldset {
		display: grid;
		gap: var(--space-related);
		min-width: 0;
		border: 0;
		padding: 0;
		margin: 0;
	}
</style>

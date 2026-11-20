<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import {
		FEDERATION_ATTRIBUTE_PRESETS,
		type FederationForm,
		type FederationMappingOption
	} from './federation-model';

	/**
	 * Who of the federation takes part, and how: the SP role (the federation's services sign in
	 * through Authrim), the IdP role (Authrim's people sign in through the federation's
	 * providers), each with the mapping set that turns what is sent or taken into the profile,
	 * and how a person picks their institution. Everyone in the federation takes part unless it
	 * is set aside, so there is nothing to tick per entity. Shared by the wizard and the
	 * federation's own page.
	 */
	interface Props {
		form: FederationForm;
		mappingSets: FederationMappingOption[];
		/** The sets could not be read. */
		mappingFailed?: boolean;
		mappingLoading?: boolean;
		onreloadmappings?: () => void;
		disabled?: boolean;
	}
	let {
		form = $bindable(),
		mappingSets,
		mappingFailed = false,
		mappingLoading = false,
		onreloadmappings,
		disabled = false
	}: Props = $props();

	const presetOptions = $derived(
		FEDERATION_ATTRIBUTE_PRESETS.map((value) => ({
			value,
			label: t(`sf.fed.preset.${value}`)
		}))
	);
	const selectionOptions = $derived([
		{ value: 'authrim_search', label: t('sf.fed.idpSelection.authrim') },
		{ value: 'external_ds', label: t('sf.fed.idpSelection.external') }
	]);
	const noSets = $derived(!mappingLoading && !mappingFailed && mappingSets.length === 0);
</script>

<ToggleRow
	label={t('sf.fed.role.sp')}
	description={t('sf.fed.role.spDesc')}
	bind:checked={form.spRole}
	{disabled}
/>
{#if form.spRole}
	<SelectRow
		label={t('sf.fed.mappingSet.sp')}
		placeholder={t('mc.ro.choose')}
		required
		options={mappingSets}
		bind:value={form.spMappingSetId}
		disabled={disabled || mappingLoading}
	/>
	<SelectRow
		label={t('sf.fed.preset.label')}
		options={presetOptions}
		bind:value={form.attributePreset}
		hint={t('sf.fed.preset.hint')}
		{disabled}
	/>
{/if}
<ToggleRow
	label={t('sf.fed.role.idp')}
	description={t('sf.fed.role.idpDesc')}
	bind:checked={form.idpRole}
	{disabled}
/>
{#if form.idpRole}
	<SelectRow
		label={t('sf.fed.mappingSet.idp')}
		placeholder={t('mc.ro.choose')}
		required
		options={mappingSets}
		bind:value={form.idpMappingSetId}
		disabled={disabled || mappingLoading}
	/>
	<SelectRow
		label={t('sf.fed.idpSelection.label')}
		options={selectionOptions}
		value={form.idpSelectionMode}
		onchange={(value) =>
			(form.idpSelectionMode = value === 'external_ds' ? 'external_ds' : 'authrim_search')}
		hint={t(
			form.idpSelectionMode === 'external_ds'
				? 'sf.fed.idpSelection.externalHint'
				: 'sf.fed.idpSelection.authrimHint'
		)}
		{disabled}
	/>
	{#if form.idpSelectionMode === 'external_ds'}
		<TextRow
			label={t('sf.fed.idpSelection.dsUrl')}
			placeholder="https://ds.federation.example/discovery"
			required
			error={form.discoveryServiceUrl && !/^https:\/\/[^/\s]+/.test(form.discoveryServiceUrl.trim())
				? t('sf.fed.error.dsUrl')
				: undefined}
			bind:value={form.discoveryServiceUrl}
			{disabled}
		/>
	{/if}
{/if}
{#if mappingFailed}
	<Callout tone="warning" live>
		{t('sf.fed.mappingSet.failed')}
		{#if onreloadmappings}<Button size="sm" onclick={onreloadmappings}>{t('common.retry')}</Button
			>{/if}
	</Callout>
{:else if noSets && (form.spRole || form.idpRole)}
	<Callout tone="info">{t('sf.fed.mappingSet.none')}</Callout>
{/if}

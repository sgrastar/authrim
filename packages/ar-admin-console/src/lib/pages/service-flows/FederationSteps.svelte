<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import FederationCertificateInput from './FederationCertificateInput.svelte';
	import FederationParticipationFields from './FederationParticipationFields.svelte';
	import {
		federationProblems,
		type FederationForm,
		type FederationMappingOption
	} from './federation-model';

	/**
	 * The two steps of adding a SAML federation: where its metadata is and what it is signed
	 * with, then who takes part. The wizard asks only what a federation cannot start without;
	 * exceptions and the list of entities are on its own page once it exists.
	 */
	interface Props {
		step: string;
		form: FederationForm;
		mappingSets?: FederationMappingOption[];
		mappingFailed?: boolean;
		mappingLoading?: boolean;
		onreloadmappings?: () => void;
	}
	let {
		step,
		form = $bindable(),
		mappingSets = [],
		mappingFailed = false,
		mappingLoading = false,
		onreloadmappings
	}: Props = $props();

	const problems = $derived(
		federationProblems(form).filter((p) => p.field !== 'discoveryServiceUrl')
	);
	const urlError = $derived(
		form.metadataUrl.trim() && problems.some((p) => p.field === 'metadataUrl')
			? t('sf.fed.error.metadataUrl')
			: undefined
	);
</script>

{#if step === 'federation-source'}
	<TextRow label={t('sf.fed.name')} required bind:value={form.name} />
	<TextRow
		label={t('sf.fed.metadataUrl')}
		required
		placeholder="https://metadata.federation.example/aggregate.xml"
		hint={t('sf.fed.metadataUrlHint')}
		error={urlError}
		bind:value={form.metadataUrl}
	/>
	<TextRow label={t('sf.fed.description')} bind:value={form.description} />
	<FederationCertificateInput bind:certificates={form.certificates} />
	<Callout tone="info">{t('sf.fed.trustNote')}</Callout>
{:else if step === 'federation-participation'}
	<FederationParticipationFields
		bind:form
		{mappingSets}
		{mappingFailed}
		{mappingLoading}
		{onreloadmappings}
	/>
	{#if problems.length > 0}
		<Callout tone="info" title={t('sf.fed.remaining')}>
			<ul class="remaining">
				{#each problems as problem (problem.field)}<li>{problem.message}</li>{/each}
			</ul>
		</Callout>
	{/if}
{/if}

<style>
	.remaining {
		margin: 0;
		padding-inline-start: 1.2em;
	}
</style>

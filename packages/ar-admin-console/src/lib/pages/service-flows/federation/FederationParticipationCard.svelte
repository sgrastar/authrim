<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import FederationParticipationFields from '../FederationParticipationFields.svelte';
	import {
		federationProblems,
		type FederationForm,
		type FederationMappingOption
	} from '../federation-model';

	/**
	 * Who of the federation takes part and with which mapping set: the same fields as when it was
	 * added, plus, folded away, the registration authorities that narrow who takes part.
	 */
	interface Props {
		form: FederationForm;
		mappingSets: FederationMappingOption[];
		mappingFailed?: boolean;
		mappingLoading?: boolean;
		onreloadmappings?: () => void;
		disabled?: boolean;
		spMappingManaged?: boolean;
		/** Taking part (with the registration authorities that narrow it), or the mappings the roles use. */
		section?: 'participation' | 'mapping';
	}
	let {
		form = $bindable(),
		mappingSets,
		mappingFailed = false,
		mappingLoading = false,
		onreloadmappings,
		disabled = false,
		spMappingManaged = false,
		section = 'participation'
	}: Props = $props();
	/** What still stops the page from being saved, in the words of the wizard. */
	const MAPPING_FIELDS = ['spMappingSet', 'idpMappingSet'];
	const problems = $derived(
		federationProblems(form).filter((problem) =>
			section === 'mapping'
				? MAPPING_FIELDS.includes(problem.field)
				: !MAPPING_FIELDS.includes(problem.field)
		)
	);
	/** The mapping section has something to show only where a mapping is chosen on this card. */
	const mappingHere = $derived(
		(form.spRole && !spMappingManaged) || form.idpRole || mappingFailed || problems.length > 0
	);
</script>

{#if section === 'participation'}
	<Card title={t('sf.fed.participation.title')} description={t('sf.fed.participation.description')}>
		<FederationParticipationFields
			bind:form
			{mappingSets}
			{mappingFailed}
			{mappingLoading}
			{onreloadmappings}
			{disabled}
			{spMappingManaged}
			section="participation"
		/>
		{#if problems.length > 0}
			<Callout tone="warning" title={t('sf.fed.remaining')}>
				<ul class="problems">
					{#each problems as problem (problem.field)}<li>{problem.message}</li>{/each}
				</ul>
			</Callout>
		{/if}
		<Disclosure title={t('sf.fed.advanced')}>
			<TextArea
				label={t('sf.fed.ra.label')}
				hint={t('sf.fed.ra.hint')}
				mono
				rows={3}
				{disabled}
				bind:value={form.registrationAuthorities}
			/>
		</Disclosure>
	</Card>
{:else if mappingHere}
	<Card title={t('sf.group.mapping')}>
		<FederationParticipationFields
			bind:form
			{mappingSets}
			{mappingFailed}
			{mappingLoading}
			{onreloadmappings}
			{disabled}
			{spMappingManaged}
			section="mapping"
		/>
		{#if problems.length > 0}
			<Callout tone="warning" title={t('sf.fed.remaining')}>
				<ul class="problems">
					{#each problems as problem (problem.field)}<li>{problem.message}</li>{/each}
				</ul>
			</Callout>
		{/if}
	</Card>
{/if}

<style>
	.problems {
		margin: 0;
		padding-inline-start: 1.2em;
	}
</style>

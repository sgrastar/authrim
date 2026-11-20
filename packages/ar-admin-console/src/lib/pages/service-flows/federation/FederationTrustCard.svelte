<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import FederationCertificateInput from '../FederationCertificateInput.svelte';
	import { federationProblems, type FederationForm } from '../federation-model';

	/**
	 * What the federation is trusted on: the one address its metadata is fetched from and the
	 * certificates its signature is checked against, each with the fingerprint worked out here to
	 * compare with the one the federation publishes.
	 */
	interface Props {
		form: FederationForm;
		disabled?: boolean;
	}
	let { form = $bindable(), disabled = false }: Props = $props();
	const urlProblem = $derived(
		federationProblems(form).find((problem) => problem.field === 'metadataUrl')?.message
	);
	const certificateProblem = $derived(
		federationProblems(form).find((problem) => problem.field === 'certificates')?.message
	);
</script>

<Card title={t('sf.fed.trust.title')} description={t('sf.fed.trust.description')}>
	<TextRow
		label={t('sf.fed.metadataUrl')}
		required
		error={urlProblem}
		{disabled}
		bind:value={form.metadataUrl}
	/>
	<FederationCertificateInput bind:certificates={form.certificates} {disabled} />
	{#if certificateProblem}<p class="problem" role="alert">{certificateProblem}</p>{/if}
</Card>

<style>
	.problem {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
</style>

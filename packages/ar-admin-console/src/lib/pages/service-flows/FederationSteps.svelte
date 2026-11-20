<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import FederationCertificateInput from './FederationCertificateInput.svelte';
	import { metadataUrlProblem, type FederationForm } from './federation-model';

	/**
	 * The step of adding a SAML federation: where its metadata is and what it is signed with.
	 * The wizard ends here. Who takes part, with which mapping set (made there when missing),
	 * the exceptions and the list of entities are on the federation's own page.
	 */
	interface Props {
		step: string;
		form: FederationForm;
		/** Reads a certificate from an https address (PEM back); absent: no such field. */
		readCertificateUrl?: (url: string) => Promise<string>;
	}
	let { step, form = $bindable(), readCertificateUrl }: Props = $props();

	const urlError = $derived(metadataUrlProblem(form.metadataUrl));
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
	<FederationCertificateInput bind:certificates={form.certificates} readUrl={readCertificateUrl} />
	<Callout tone="info">{t('sf.fed.trustNote')}</Callout>
{/if}

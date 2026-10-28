<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import Toggle from '$lib/ui/primitives/Toggle.svelte';
	import ConnectionTest from './ConnectionTest.svelte';
	import type { SpForm } from './connection-model';
	import MetadataImport from './MetadataImport.svelte';
	import OurDetails from './OurDetails.svelte';

	/**
	 * The parts of a SAML service (service provider) that signs in through Authrim: its details,
	 * what Authrim gives it, the attributes sent, and the test. Dummy copy and dummy results.
	 */
	interface Props {
		step: string;
		form: SpForm;
		/** What Authrim gives the service to register on its side (default: the sample values). */
		ours?: { label: string; value: string }[];
	}

	let { step, form = $bindable(), ours }: Props = $props();

	// Looked up when shown, so the labels follow a change of language.
	const ourItems = $derived(
		ours ?? [
			{ label: t('sf.row.entityId'), value: 'https://acme.authrim.example/saml/idp' },
			{ label: t('sf.ours.metadataUrl'), value: 'https://acme.authrim.example/saml/idp/metadata' },
			{ label: t('sf.ours.ssoUrl'), value: 'https://acme.authrim.example/saml/idp/sso' },
			{ label: t('sf.ours.sloUrl'), value: 'https://acme.authrim.example/saml/idp/slo' },
			{ label: t('sf.ours.signingCert'), value: 'SHA-256 3F:90:A1:5C:E7:21:BB:08 …' }
		]
	);
</script>

{#if step === 'sp-import'}
	<MetadataImport bind:form partner="service" />
{:else if step === 'sp-share'}
	<OurDetails items={ourItems} partner="service" download />
{:else if step === 'sp-attrs'}
	<Select
		label={t('sf.sp.nameIdLabel')}
		value={form.nameIdFormat}
		onchange={(value) => (form.nameIdFormat = value)}
		hint={t('sf.sp.nameIdHint')}
		options={[
			{ value: 'persistent', label: t('sf.sp.nameId.persistent') },
			{ value: 'transient', label: t('sf.sp.nameId.transient') },
			{ value: 'email', label: t('sf.sp.nameId.email') },
			{ value: 'unspecified', label: t('sf.sp.nameId.unspecified') }
		]}
	/>
	<Select
		label={t('sf.sp.attrsLabel')}
		value={form.attributePreset}
		onchange={(value) => (form.attributePreset = value)}
		options={[
			{ value: 'minimal', label: t('sf.set.minimal') },
			{ value: 'standard', label: t('sf.sp.attrs.standard') },
			{ value: 'academic', label: t('sf.sp.attrs.academic') },
			{ value: 'custom', label: t('sf.sp.attrs.custom') }
		]}
	/>
	<Select
		label={t('sf.row.minAuth')}
		value={form.minAuth}
		onchange={(value) => (form.minAuth = value)}
		options={[
			{ value: 'none', label: t('sf.sp.minAuth.none') },
			{ value: 'password', label: t('sf.sp.minAuth.password') },
			{ value: 'aal2', label: t('sf.sp.minAuth.aal2') }
		]}
	/>
	<div class="row">
		<Toggle label={t('sf.sp.consent')} bind:checked={form.consent} />
		<span>{t('sf.sp.consent')}</span>
	</div>
{:else if step === 'sp-test'}
	<ConnectionTest
		lead={t('sf.sp.testLead')}
		checks={[t('sf.test.metadataRead'), t('sf.sp.check.signed'), t('sf.sp.check.answered')]}
		note={t('sf.sp.certNote', { days: 29 })}
		bind:tested={form.tested}
	/>
{/if}

<style>
	.row {
		display: flex;
		gap: var(--space-grid);
		align-items: center;
	}
</style>

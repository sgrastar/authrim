<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import ChoiceCards from '$lib/ui/patterns/ChoiceCards.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import SecretField from '$lib/ui/primitives/SecretField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import ConnectionTest from './ConnectionTest.svelte';
	import { httpsUrlProblem, type IdpForm, type LinkRule, type OpForm } from './connection-model';
	import MetadataImport from './MetadataImport.svelte';
	import OurDetails from './OurDetails.svelte';

	/**
	 * The parts of a provider that Authrim signs people in through: an OpenID Connect provider
	 * (OP) or a SAML identity provider (IdP). Authrim is the relying party here, so what it gives
	 * the provider is a callback address or its own SAML details, and what it takes back are
	 * attributes. Dummy copy and dummy results.
	 */
	interface Props {
		step: string;
		op: OpForm;
		idp: IdpForm;
	}

	let { step, op = $bindable(), idp = $bindable() }: Props = $props();

	let reading = $state(false);

	/** Which read is the current one: a read for an issuer that has since changed is dropped. */
	let reads = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function discover() {
		const read = ++reads;
		const issuer = op.issuer;
		reading = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (read !== reads || op.issuer !== issuer) return;
			op.discovered = true;
			reading = false;
		}, 500);
	}

	// Moving the issuer means the configuration read before no longer applies. It runs on a
	// change, not when the step is built again.
	let lastIssuer = op.issuer;
	$effect(() => {
		const issuer = op.issuer;
		if (issuer === lastIssuer) return;
		lastIssuer = issuer;
		// Whatever was being read belongs to the old issuer.
		reads++;
		clearTimeout(timer);
		reading = false;
		op.discovered = false;
	});

	// A read that is still waiting when this goes away is dropped with it.
	$effect(() => () => clearTimeout(timer));

	// The test passed for this provider and these credentials: others need a new one.
	let lastCredentials = untrack(() => credentials());
	function credentials() {
		return [op.issuer, op.clientId, op.clientSecret].join('|');
	}
	$effect(() => {
		const now = credentials();
		if (now === lastCredentials) return;
		lastCredentials = now;
		op.tested = false;
	});

	// Built when shown, so a change of language reaches every label.
	const linkOptions = $derived([
		{
			value: 'verified-email',
			label: t('sf.link.option.verified-email'),
			description: t('sf.link.option.verified-email.desc')
		},
		{
			value: 'ask',
			label: t('sf.link.option.ask'),
			description: t('sf.link.option.ask.desc')
		},
		{
			value: 'new',
			label: t('sf.link.option.new'),
			description: t('sf.link.option.new.desc')
		}
	]);

	const opOurs = $derived([
		{
			label: t('sf.ours.redirectUri'),
			value: 'https://acme.authrim.example/callback/acme-directory'
		},
		{ label: t('sf.ours.signOutRedirectUri'), value: 'https://acme.authrim.example/signed-out' }
	]);
	const idpOurs = $derived([
		{ label: t('sf.row.entityId'), value: 'https://acme.authrim.example/saml/sp' },
		{ label: t('sf.ours.acsUrl'), value: 'https://acme.authrim.example/saml/sp/acs' },
		{ label: t('sf.ours.metadataUrl'), value: 'https://acme.authrim.example/saml/sp/metadata' },
		{ label: t('sf.ours.signingCert'), value: 'SHA-256 B4:12:7E:90:3C:AA:51:0F …' }
	]);
	const attributeOptions = $derived([
		{ value: 'minimal', label: t('sf.in.attrs.minimal') },
		{ value: 'standard', label: t('sf.in.attrs.standard') },
		{ value: 'custom', label: t('sf.in.attrs.custom') }
	]);
</script>

{#snippet matching(value: LinkRule, change: (rule: LinkRule) => void)}
	<ChoiceCards
		label={t('sf.link.label')}
		columns={3}
		{value}
		onchange={(rule) => change(rule as LinkRule)}
		options={linkOptions}
	/>
{/snippet}

{#if step === 'op-details'}
	<TextField
		label={t('sf.row.name')}
		hint={t('sf.in.nameHint')}
		placeholder="Acme Directory"
		bind:value={op.name}
	/>
	<TextField
		label={t('sf.in.issuer')}
		placeholder="https://login.provider.example"
		hint={t('sf.in.issuerHint')}
		error={op.issuer ? httpsUrlProblem(op.issuer) : undefined}
		bind:value={op.issuer}
	/>
	<div>
		<Button
			variant="secondary"
			disabled={!op.issuer || !!httpsUrlProblem(op.issuer)}
			loading={reading}
			onclick={discover}>{t('sf.in.readConfig')}</Button
		>
	</div>
	{#if op.discovered}
		<Callout tone="info" title={t('sf.import.found')}>
			<DetailList columns={1} size="sm">
				<DetailItem label={t('sf.ours.authorizeUrl')}>{op.issuer}/authorize</DetailItem>
				<DetailItem label={t('sf.ours.tokenUrl')}>{op.issuer}/token</DetailItem>
				<DetailItem label={t('sf.ours.keys')}>{op.issuer}/jwks</DetailItem>
			</DetailList>
		</Callout>
	{/if}
	<TextField label={t('sf.row.clientId')} hint={t('sf.in.clientIdHint')} bind:value={op.clientId} />
	<SecretField label={t('sf.in.clientSecret')} mode="enter" bind:value={op.clientSecret} />
{:else if step === 'op-share'}
	<OurDetails items={opOurs} partner="provider" />
{:else if step === 'op-attrs'}
	<Select
		label={t('sf.in.attrsLabel')}
		value={op.attributePreset}
		onchange={(value) => (op.attributePreset = value)}
		hint={t('sf.in.attrsHint.op')}
		options={attributeOptions}
	/>
{:else if step === 'op-link'}
	{@render matching(op.link, (rule) => (op.link = rule))}
{:else if step === 'op-test'}
	<ConnectionTest
		lead={t('sf.in.testLead')}
		checks={[t('sf.op.check.config'), t('sf.op.check.answered'), t('sf.op.check.token')]}
		bind:tested={op.tested}
	/>
{:else if step === 'idp-import'}
	<TextField
		label={t('sf.row.name')}
		hint={t('sf.in.nameHint')}
		placeholder="Corporate sign-in"
		bind:value={idp.name}
	/>
	<MetadataImport bind:form={idp} partner="provider" />
{:else if step === 'idp-share'}
	<OurDetails items={idpOurs} partner="provider" download />
{:else if step === 'idp-attrs'}
	<Select
		label={t('sf.in.attrsLabel')}
		value={idp.attributePreset}
		onchange={(value) => (idp.attributePreset = value)}
		hint={t('sf.in.attrsHint.idp')}
		options={attributeOptions}
	/>
{:else if step === 'idp-link'}
	{@render matching(idp.link, (rule) => (idp.link = rule))}
{:else if step === 'idp-test'}
	<ConnectionTest
		lead={t('sf.in.testLead')}
		checks={[t('sf.test.metadataRead'), t('sf.idp.check.response'), t('sf.idp.check.matched')]}
		note={t('sf.idp.certNote', { days: 12 })}
		bind:tested={idp.tested}
	/>
{/if}

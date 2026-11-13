<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import CertificateList from '#lib/ui/patterns/CertificateList.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import { httpsUrlProblem, type OpForm } from './connection-model';
	import {
		sampleCertificates,
		TEMPLATES,
		type IdpSettings,
		type OpSettings,
		type OpTemplate
	} from './connection-settings';
	import MetadataRefresh from './MetadataRefresh.svelte';
	import SignaturePolicyRow from './SignaturePolicyRow.svelte';

	/**
	 * The connection settings of a provider people sign in through: an OpenID provider (endpoints,
	 * how Authrim asks, accounts, its button) or a SAML identity provider (addresses, certificates,
	 * the assertion, accounts, metadata). Dummy.
	 */
	interface Props {
		part: string;
		op: OpSettings;
		idp: IdpSettings;
		/** The provider's own form (name, issuer): a template fills them in. */
		opForm: OpForm;
	}

	let { part, op = $bindable(), idp = $bindable(), opForm = $bindable() }: Props = $props();

	const optionalHttps = (value: string) => (value === '' ? undefined : httpsUrlProblem(value));
	const PROFILE_UPDATE = $derived([
		{ value: 'tenant', label: t('cs.profileUpdate.tenant') },
		{ value: 'all', label: t('cs.profileUpdate.all') },
		{ value: 'none', label: t('cs.profileUpdate.none') }
	]);
	const TEMPLATE_IDS: OpTemplate[] = [
		'custom',
		'google',
		'microsoft',
		'github',
		'apple',
		'linkedin',
		'facebook',
		'twitter'
	];

	function chooseTemplate(value: string) {
		const template = value as OpTemplate;
		op.template = template;
		if (template === 'custom') return;
		const preset = TEMPLATES[template];
		op.protocol = preset.protocol;
		op.scopes = preset.scopes;
		if (!opForm.name) opForm.name = preset.name;
		if (!op.buttonText) op.buttonText = t('cs.button.continueWith', { name: preset.name });
		// Another issuer has not been read yet: its configuration has to be read again.
		if (preset.issuer && preset.issuer !== opForm.issuer) {
			opForm.issuer = preset.issuer;
			opForm.discovered = false;
		}
		// The addresses belong to the template: another provider's never stay behind.
		op.authorizationEndpoint = preset.endpoints?.authorization ?? '';
		op.tokenEndpoint = preset.endpoints?.token ?? '';
		op.userinfoEndpoint = preset.endpoints?.userinfo ?? '';
		op.jwksUri = '';
	}
</script>

{#if part === 'op-endpoints'}
	<SelectRow
		label={t('cs.row.template')}
		hint={t('cs.hint.template')}
		value={op.template}
		onchange={chooseTemplate}
		options={TEMPLATE_IDS.map((id) => ({
			value: id,
			label: id === 'custom' ? t('cs.template.custom') : TEMPLATES[id].name
		}))}
	/>
	<SelectRow
		label={t('cs.row.protocol')}
		value={op.protocol}
		onchange={(value) => (op.protocol = value as OpSettings['protocol'])}
		options={[
			{ value: 'oidc', label: 'OpenID Connect' },
			{ value: 'oauth2', label: t('cs.protocol.oauth2') }
		]}
	/>
	{#if op.protocol === 'oauth2'}
		<Callout tone="info">{t('cs.note.oauth2')}</Callout>
	{/if}
	<p class="lead">{t('cs.note.endpointOverride')}</p>
	<TextRow
		label={t('cs.row.authorizationEndpoint')}
		required={op.protocol === 'oauth2'}
		placeholder={opForm.issuer ? `${opForm.issuer}/authorize` : ''}
		error={optionalHttps(op.authorizationEndpoint)}
		bind:value={op.authorizationEndpoint}
	/>
	<TextRow
		label={t('cs.row.tokenEndpoint')}
		required={op.protocol === 'oauth2'}
		placeholder={opForm.issuer ? `${opForm.issuer}/token` : ''}
		error={optionalHttps(op.tokenEndpoint)}
		bind:value={op.tokenEndpoint}
	/>
	<TextRow
		label={t('cs.row.userinfoEndpoint')}
		placeholder={opForm.issuer ? `${opForm.issuer}/userinfo` : ''}
		error={optionalHttps(op.userinfoEndpoint)}
		bind:value={op.userinfoEndpoint}
	/>
	<TextRow
		label={t('cs.row.jwksUri')}
		placeholder={opForm.issuer ? `${opForm.issuer}/jwks` : ''}
		error={optionalHttps(op.jwksUri)}
		bind:value={op.jwksUri}
	/>
{:else if part === 'op-request'}
	<ToggleRow label={t('cs.row.fapi2')} description={t('cs.desc.fapi2')} bind:checked={op.fapi2} />
	<SelectRow
		label={t('cs.row.tokenAuth')}
		value={op.fapi2 ? 'private_key_jwt' : op.tokenAuth}
		disabled={op.fapi2}
		onchange={(value) => (op.tokenAuth = value as OpSettings['tokenAuth'])}
		options={[
			{ value: 'client_secret_post', label: t('sf.rp.auth.post') },
			{ value: 'client_secret_basic', label: t('sf.rp.auth.basic') },
			...(op.fapi2 ? [{ value: 'private_key_jwt', label: t('sf.rp.auth.jwt') }] : [])
		]}
	/>
	{#if !op.fapi2}
		<ToggleRow
			label={t('cs.row.requestObject')}
			description={t('cs.desc.requestObject')}
			bind:checked={op.requestObject}
		/>
		{#if op.requestObject}
			<SelectRow
				label={t('cs.row.requestObjectAlg')}
				value={op.requestObjectAlg}
				onchange={(value) => (op.requestObjectAlg = value)}
				options={['RS256', 'ES256', 'PS256'].map((alg) => ({ value: alg, label: alg }))}
			/>
		{/if}
	{/if}
	<TextRow label={t('cs.row.scopes')} hint={t('cs.hint.opScopes')} bind:value={op.scopes} />
	{#if op.protocol === 'oidc' && !op.scopes.split(/\s+/).includes('openid')}
		{@const [before, after] = t('sf.rp.openidRequired').split('{scope}')}
		<Callout tone="warning" live>{before}<code>openid</code>{after}</Callout>
	{/if}
	<SelectRow
		label={t('cs.row.responseType')}
		value={op.responseType}
		onchange={(value) => (op.responseType = value as OpSettings['responseType'])}
		options={[
			{ value: 'code', label: 'code' },
			{ value: 'code id_token', label: 'code id_token' }
		]}
	/>
	<SelectRow
		label={t('cs.row.expectedIdTokenAlg')}
		value={op.idTokenAlg}
		onchange={(value) => (op.idTokenAlg = value)}
		options={['RS256', 'ES256', 'PS256'].map((alg) => ({ value: alg, label: alg }))}
	/>
	<ToggleRow
		label={t('cs.row.alwaysUserinfo')}
		description={t('cs.desc.alwaysUserinfo')}
		bind:checked={op.alwaysUserinfo}
	/>
{:else if part === 'op-accounts'}
	<ToggleRow label={t('cs.row.jit')} description={t('cs.desc.jit')} bind:checked={op.jit} />
	<ToggleRow
		label={t('cs.row.trustEmail')}
		description={t('cs.desc.trustEmail')}
		bind:checked={op.trustEmail}
	/>
	{#if op.trustEmail && opForm.link === 'verified-email'}
		<Callout tone="warning" live>{t('cs.warn.trustUnverified')}</Callout>
	{/if}
	<SelectRow
		label={t('cs.row.profileUpdate')}
		value={op.profileUpdate}
		onchange={(value) => (op.profileUpdate = value as OpSettings['profileUpdate'])}
		options={PROFILE_UPDATE}
	/>
	<ToggleRow
		label={t('cs.row.handoffSso')}
		description={t('cs.desc.handoffSso')}
		bind:checked={op.handoffSso}
	/>
{:else if part === 'op-button'}
	<TextRow
		label={t('cs.row.buttonText')}
		placeholder={t('cs.button.continueWith', { name: opForm.name || 'Acme' })}
		bind:value={op.buttonText}
	/>
	<ColorField label={t('cs.row.buttonColor')} bind:value={op.buttonColor} />
	<FieldRow label={t('cs.row.priority')} plain>
		<NumberField
			label={t('cs.row.priority')}
			hideLabel
			min={0}
			hint={t('cs.hint.priority')}
			bind:value={op.priority}
		/>
	</FieldRow>
{:else if part === 'idp-endpoints'}
	<TextRow
		label={t('cs.row.ssoUrl')}
		placeholder="https://idp.corp.example/saml/sso"
		error={optionalHttps(idp.ssoUrl)}
		bind:value={idp.ssoUrl}
	/>
	<TextRow
		label={t('cs.row.sloUrl')}
		placeholder="https://idp.corp.example/saml/slo"
		error={optionalHttps(idp.sloUrl)}
		bind:value={idp.sloUrl}
	/>
	<CheckboxRow
		label={t('cs.row.bindings')}
		required
		bind:selected={idp.bindings}
		options={[
			{ value: 'post', label: 'HTTP-POST' },
			{ value: 'redirect', label: 'HTTP-Redirect' }
		]}
	/>
	<TextRow
		label={t('cs.row.providerName')}
		hint={t('cs.hint.providerName')}
		bind:value={idp.providerName}
	/>
{:else if part === 'idp-certs'}
	<CertificateList
		label={t('cs.part.idp-certs')}
		items={idp.certificates}
		onremove={(index) => (idp.certificates = idp.certificates.filter((_, i) => i !== index))}
		onpromote={(index) =>
			(idp.certificates = idp.certificates
				.map((cert, i) => ({ ...cert, use: i === index ? ('active' as const) : cert.use }))
				.filter((cert, i) => i === index || cert.use !== 'active'))}
	/>
	{#if idp.certificates.length === 0}
		<div>
			<Button size="sm" onclick={() => (idp.certificates = sampleCertificates())}
				>{t('cs.cert.add')}</Button
			>
		</div>
	{/if}
	<SignaturePolicyRow
		label={t('cs.row.logoutRequestSignature')}
		value={idp.logoutRequestSignature}
		onchange={(value) => (idp.logoutRequestSignature = value)}
	/>
	<ToggleRow
		label={t('cs.row.legacyAlgorithms')}
		description={t('cs.desc.legacyAlgorithms')}
		bind:checked={idp.legacyAlgorithms}
	/>
{:else if part === 'idp-assertion'}
	<SelectRow
		label={t('sf.sp.nameIdLabel')}
		value={idp.nameIdFormat}
		onchange={(value) => (idp.nameIdFormat = value)}
		options={[
			{ value: 'persistent', label: t('sf.sp.nameId.persistent') },
			{ value: 'transient', label: t('sf.sp.nameId.transient') },
			{ value: 'email', label: t('sf.sp.nameId.email') },
			{ value: 'unspecified', label: t('sf.sp.nameId.unspecified') }
		]}
	/>
	<SelectRow
		label={t('cs.row.authnContextPolicy')}
		value={idp.authnContextMode}
		onchange={(value) => (idp.authnContextMode = value as IdpSettings['authnContextMode'])}
		options={[
			{ value: 'observe', label: t('cs.acrPolicy.observe') },
			{ value: 'require_any', label: t('cs.acrPolicy.requireAny') }
		]}
	/>
	{#if idp.authnContextMode === 'require_any'}
		<ListField
			label={t('cs.row.authnContexts')}
			required
			placeholder="urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
			addLabel={t('cs.add.classRef')}
			mono
			bind:values={idp.authnContexts}
		/>
	{/if}
{:else if part === 'idp-accounts'}
	<ToggleRow
		label={t('cs.row.syntheticEmail')}
		description={t('cs.desc.syntheticEmail')}
		bind:checked={idp.syntheticEmail}
	/>
	<SelectRow
		label={t('cs.row.profileUpdate')}
		value={idp.profileUpdate}
		onchange={(value) => (idp.profileUpdate = value as IdpSettings['profileUpdate'])}
		options={PROFILE_UPDATE}
	/>
{:else if part === 'idp-metadata'}
	<MetadataRefresh bind:mode={idp.metadataRefresh} bind:interval={idp.metadataInterval} />
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}
</style>

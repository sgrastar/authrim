<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import DurationField from '#lib/ui/primitives/DurationField.svelte';
	import { httpsUrlProblem } from './connection-model';
	import {
		applyProfile,
		PROFILE_NAME_ID,
		type SamlProfile,
		type SignaturePolicy,
		type SpSettings
	} from './connection-settings';
	import InheritRow from './InheritRow.svelte';
	import MetadataRefresh from './MetadataRefresh.svelte';
	import SignaturePolicyRow from './SignaturePolicyRow.svelte';

	/**
	 * The connection settings of a SAML service (Authrim is its IdP): addresses and bindings, the
	 * profile and signing, encryption, the assertion, and metadata refresh. Dummy.
	 */
	interface Props {
		part: string;
		settings: SpSettings;
		/** The service's NameID format, kept on its form; a profile proposes one. */
		nameIdFormat: string;
	}

	let { part, settings = $bindable(), nameIdFormat = $bindable() }: Props = $props();

	function chooseProfile(value: string) {
		applyProfile(settings, value as SamlProfile);
		nameIdFormat = PROFILE_NAME_ID[value as SamlProfile];
	}
	const CONTENT_ALGS = $derived([
		{ value: 'aes256-gcm', label: 'AES-256-GCM' },
		{ value: 'aes256-cbc', label: t('cs.alg.aesCbc') }
	]);
	const KEY_ALGS = $derived([
		{ value: 'rsa-oaep-256', label: 'RSA-OAEP-256' },
		{ value: 'rsa-oaep-sha1', label: t('cs.alg.oaepSha1') }
	]);
	const ACR_MODES = $derived([
		{ value: 'legacy_static', label: t('cs.acr.static') },
		{ value: 'session', label: t('cs.acr.session') },
		{ value: 'assurance', label: t('cs.acr.assurance') }
	]);
	const minimum = (prefix: string) => [
		{ value: '', label: t('cs.value.noMinimum') },
		...[1, 2, 3].map((level) => ({ value: `${prefix}${level}`, label: `${prefix}${level}` }))
	];
	/** A default as people read it: the option's name, a duration, on or off. */
	const labelFrom =
		(options: { value: string; label: string }[]) => (value: string | number | boolean | null) =>
			options.find((option) => option.value === value)?.label ?? String(value);
	const seconds = (value: string | number | boolean | null) =>
		typeof value === 'number' && value % 60 === 0
			? t('cs.value.minutes', { count: value / 60 })
			: t('cs.value.seconds', { count: Number(value) });
	const onOff = (value: string | number | boolean | null) =>
		t(value ? 'cs.value.on' : 'cs.value.off');
	const optionalHttps = (value: string) => (value === '' ? undefined : httpsUrlProblem(value));
	const legacyOn = $derived(
		settings.legacyAlgorithms ||
			settings.contentAlg === 'aes256-cbc' ||
			settings.keyAlg === 'rsa-oaep-sha1'
	);
</script>

{#if part === 'sp-endpoints'}
	<ListField
		label={t('cs.row.acsUrls')}
		hint={t('cs.hint.acsUrls')}
		placeholder="https://service.example/saml/acs/2"
		addLabel={t('cs.add.uri')}
		mono
		validate={httpsUrlProblem}
		bind:values={settings.acsUrls}
	/>
	<TextRow
		label={t('cs.row.sloUrl')}
		placeholder="https://service.example/saml/slo"
		error={optionalHttps(settings.sloUrl)}
		bind:value={settings.sloUrl}
	/>
	{#if settings.sloUrl}
		<SelectRow
			label={t('cs.row.sloBinding')}
			value={settings.sloBinding}
			onchange={(value) => (settings.sloBinding = value as SpSettings['sloBinding'])}
			options={[
				{ value: 'post', label: 'HTTP-POST' },
				{ value: 'redirect', label: 'HTTP-Redirect' }
			]}
		/>
	{/if}
	<CheckboxRow
		label={t('cs.row.bindings')}
		required
		bind:selected={settings.bindings}
		options={[
			{ value: 'post', label: 'HTTP-POST' },
			{ value: 'redirect', label: 'HTTP-Redirect' },
			{ value: 'artifact', label: 'HTTP-Artifact' }
		]}
	/>
{:else if part === 'sp-signing'}
	<SelectRow
		label={t('cs.row.samlProfile')}
		hint={t('cs.hint.samlProfile')}
		value={settings.profile}
		onchange={chooseProfile}
		options={[
			{ value: 'baseline', label: t('cs.profile.baseline') },
			{ value: 'strict', label: t('cs.profile.strict') },
			{ value: 'academic_publisher', label: t('cs.profile.academic') },
			{ value: 'legacy', label: t('cs.profile.legacy') }
		]}
	/>
	<ToggleRow label={t('cs.row.signResponses')} bind:checked={settings.signResponses} />
	<ToggleRow label={t('cs.row.signAssertions')} bind:checked={settings.signAssertions} />
	{#if !settings.signResponses && !settings.signAssertions}
		<Callout tone="warning" live>{t('cs.warn.unsigned')}</Callout>
	{/if}
	<SignaturePolicyRow
		label={t('cs.row.authnRequestSignature')}
		value={settings.authnRequestSignature}
		onchange={(value: SignaturePolicy) => (settings.authnRequestSignature = value)}
	/>
	<SignaturePolicyRow
		label={t('cs.row.logoutRequestSignature')}
		value={settings.logoutRequestSignature}
		onchange={(value: SignaturePolicy) => (settings.logoutRequestSignature = value)}
	/>
	<SignaturePolicyRow
		label={t('cs.row.logoutResponseSignature')}
		value={settings.logoutResponseSignature}
		onchange={(value: SignaturePolicy) => (settings.logoutResponseSignature = value)}
	/>
	<InheritRow bind:settings key="legacyAlgorithms" format={onOff}>
		{#snippet children({ inherited })}
			<ToggleRow
				label={t('cs.row.legacyAlgorithms')}
				description={t('cs.desc.legacyAlgorithms')}
				disabled={inherited}
				bind:checked={settings.legacyAlgorithms}
			/>
		{/snippet}
	</InheritRow>
{:else if part === 'sp-encryption'}
	<ToggleRow
		label={t('cs.row.encryptAssertions')}
		description={t('cs.desc.encryptAssertions')}
		bind:checked={settings.encryptAssertions}
	/>
	<ToggleRow
		label={t('cs.row.encryptNameId')}
		description={t('cs.desc.encryptNameId')}
		bind:checked={settings.encryptNameId}
	/>
	{#if settings.encryptAssertions || settings.encryptNameId}
		<TextAreaRow
			label={t('cs.row.encryptionCert')}
			required
			hint={t('cs.hint.encryptionCert')}
			placeholder="-----BEGIN CERTIFICATE-----"
			bind:value={settings.encryptionCert}
		/>
		<InheritRow bind:settings key="contentAlg" format={labelFrom(CONTENT_ALGS)}>
			{#snippet children({ inherited })}
				<SelectRow
					label={t('cs.row.contentAlg')}
					value={settings.contentAlg}
					disabled={inherited}
					onchange={(value) => (settings.contentAlg = value as SpSettings['contentAlg'])}
					options={CONTENT_ALGS}
				/>
			{/snippet}
		</InheritRow>
		<InheritRow bind:settings key="keyAlg" format={labelFrom(KEY_ALGS)}>
			{#snippet children({ inherited })}
				<SelectRow
					label={t('cs.row.keyAlg')}
					value={settings.keyAlg}
					disabled={inherited}
					onchange={(value) => (settings.keyAlg = value as SpSettings['keyAlg'])}
					options={KEY_ALGS}
				/>
			{/snippet}
		</InheritRow>
		{#if legacyOn}
			<Callout tone="warning" live>{t('cs.warn.legacyEncryption')}</Callout>
		{/if}
	{/if}
{:else if part === 'sp-assertion'}
	<InheritRow bind:settings key="assertionLifetime" format={seconds}>
		{#snippet children({ inherited })}
			<FieldRow label={t('cs.row.assertionLifetime')} plain>
				<DurationField
					label={t('cs.row.assertionLifetime')}
					hideLabel
					min={60}
					max={3600}
					units={['seconds', 'minutes']}
					disabled={inherited}
					bind:value={settings.assertionLifetime}
				/>
			</FieldRow>
		{/snippet}
	</InheritRow>
	<InheritRow bind:settings key="authnContextMode" format={labelFrom(ACR_MODES)}>
		{#snippet children({ inherited })}
			<SelectRow
				label={t('cs.row.authnContextMode')}
				hint={t('cs.hint.authnContextMode')}
				value={settings.authnContextMode}
				disabled={inherited}
				onchange={(value) => (settings.authnContextMode = value as SpSettings['authnContextMode'])}
				options={ACR_MODES}
			/>
		{/snippet}
	</InheritRow>
	<InheritRow bind:settings key="minimumIal" format={labelFrom(minimum('IAL'))}>
		{#snippet children({ inherited })}
			<SelectRow
				label={t('cs.row.minimumIal')}
				value={settings.minimumIal}
				disabled={inherited}
				onchange={(value) => (settings.minimumIal = value)}
				options={minimum('IAL')}
			/>
		{/snippet}
	</InheritRow>
	<InheritRow bind:settings key="minimumAal" format={labelFrom(minimum('AAL'))}>
		{#snippet children({ inherited })}
			<SelectRow
				label={t('cs.row.minimumAal')}
				hint={t('cs.hint.minimumAal')}
				value={settings.minimumAal}
				disabled={inherited}
				onchange={(value) => (settings.minimumAal = value)}
				options={minimum('AAL')}
			/>
		{/snippet}
	</InheritRow>
{:else if part === 'sp-metadata'}
	<MetadataRefresh bind:mode={settings.metadataRefresh} bind:interval={settings.metadataInterval} />
{/if}

<script lang="ts">
	import type {
		SamlCertificateSubject,
		SamlLocalSigningRequest,
		SamlRole,
		SamlSettings
	} from '#lib/api/saml-settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Toggle from '#lib/ui/primitives/Toggle.svelte';
	import {
		defaultValidTo,
		fromDateTimeLocal,
		generatedDnsNames,
		parseDnsNamesInput,
		parseSubject,
		subjectAlternativeNamesForm,
		subjectForm,
		toDateTimeLocal
	} from './local-signing-model';

	/**
	 * Issue the next signing certificate of a role: its subject (started from the tenant's saved
	 * subject, or copied from the certificate in use), validity, key size and DNS names. Submits
	 * the `publish_next` request; the caller runs it and closes the dialog.
	 */
	interface Props {
		open: boolean;
		role: SamlRole;
		settings: SamlSettings;
		/** The subject of the certificate in use, offered as a starting point. */
		currentSubject?: string;
		busy?: boolean;
		error?: string;
		onsubmit: (request: Omit<SamlLocalSigningRequest, 'role' | 'action'>) => void;
		oncancel: () => void;
	}

	let {
		open,
		role,
		settings,
		currentSubject,
		busy = false,
		error = '',
		onsubmit,
		oncancel
	}: Props = $props();

	const roleName = $derived(t(role === 'idp' ? 'sl.role.idp' : 'sl.role.sp'));

	let subject = $state<SamlCertificateSubject>(subjectForm());
	let validFrom = $state('');
	let validTo = $state('');
	let bits = $state('2048');
	let includeGenerated = $state(true);
	let extraDns = $state('');
	let validityError = $state('');

	// Each opening starts from what the tenant saved last.
	$effect(() => {
		if (!open) return;
		const saved = settings.localSigning;
		subject = subjectForm(saved?.certificateSubject);
		const names = subjectAlternativeNamesForm(saved?.certificateSubjectAlternativeNames);
		includeGenerated = names.includeGeneratedDnsNames;
		extraDns = names.dnsNames.join(', ');
		validFrom = '';
		validTo = toDateTimeLocal(defaultValidTo());
		bits = '2048';
		validityError = '';
	});

	const generated = $derived(generatedDnsNames(settings, role));
	const KEY_SIZES = ['2048', '3072', '4096'].map((value) => ({ value, label: `${value} bit` }));

	function useCurrent() {
		const parsed = parseSubject(currentSubject);
		if (parsed) subject = parsed;
	}

	function submit() {
		const from = fromDateTimeLocal(validFrom);
		// An empty end means a year, as the form says: sent explicitly, since the server's own
		// default for a missing end is ten years.
		const to =
			fromDateTimeLocal(validTo) ??
			defaultValidTo(from ? new Date(from) : new Date()).toISOString();
		if (from && Date.parse(to) <= Date.parse(from)) {
			validityError = t('sl.new.validity.error');
			return;
		}
		validityError = '';
		onsubmit({
			certificateSubject: subject,
			certificateSubjectAlternativeNames: {
				includeGeneratedDnsNames: includeGenerated,
				dnsNames: parseDnsNamesInput(extraDns)
			},
			validFrom: from,
			validTo: to,
			publicKeyAlgorithm: 'RSA',
			publicKeySizeBits: Number(bits) as 2048 | 3072 | 4096
		});
	}
</script>

<FormDialog
	{open}
	title={t('sl.new.title', { role: roleName })}
	description={t('sl.new.desc')}
	submitLabel={t('sl.new.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	{#if currentSubject}
		<div class="row-end">
			<Button size="sm" variant="ghost" onclick={useCurrent}>{t('sl.new.useCurrent')}</Button>
		</div>
	{/if}
	<div class="grid">
		<TextField label={t('sl.new.country')} bind:value={subject.countryName} placeholder="JP" />
		<TextField
			label={t('sl.new.state')}
			bind:value={subject.stateOrProvinceName}
			placeholder="Tokyo"
		/>
		<TextField
			label={t('sl.new.locality')}
			bind:value={subject.localityName}
			placeholder="Chiyoda"
		/>
		<TextField label={t('sl.new.organization')} bind:value={subject.organizationName} />
		<TextField label={t('sl.new.unit')} bind:value={subject.organizationalUnitName} />
		<TextField label={t('sl.new.commonName')} bind:value={subject.commonName} />
	</div>
	<div class="grid">
		<TextField
			label={t('sl.new.validFrom')}
			type="datetime-local"
			bind:value={validFrom}
			hint={t('sl.new.validity.hint')}
		/>
		<TextField
			label={t('sl.new.validTo')}
			type="datetime-local"
			bind:value={validTo}
			error={validityError}
		/>
		<Select label={t('sl.new.keySize')} options={KEY_SIZES} bind:value={bits} />
	</div>
	<div class="san">
		<div class="san__row">
			<Toggle
				label={t('sl.new.san')}
				checked={includeGenerated}
				onchange={(checked) => (includeGenerated = checked)}
			/>
			<span>{t('sl.new.san')}</span>
		</div>
		<p class="san__hint">
			{t('sl.new.san.desc')}
			{#if includeGenerated && generated.length > 0}
				{#each generated as name (name)}<code class="mono">{name}</code>{/each}
			{:else}
				{t('sl.new.san.none')}
			{/if}
		</p>
		<TextField
			label={t('sl.new.san.extra')}
			bind:value={extraDns}
			hint={t('sl.new.san.extra.hint')}
			placeholder="sso.example.ac.jp"
		/>
	</div>
</FormDialog>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-field);
		margin-bottom: var(--space-field);
	}

	.row-end {
		display: flex;
		justify-content: flex-end;
		margin-bottom: var(--space-field);
	}

	.san {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.san__row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.san__hint {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.mono {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}
</style>

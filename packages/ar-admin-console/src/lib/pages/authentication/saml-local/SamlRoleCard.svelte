<script lang="ts">
	import type {
		SamlCertificatePreview,
		SamlLocalSigningAction,
		SamlRole,
		SamlSettings,
		SamlSettingsClient
	} from '#lib/api/saml-settings.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import CopyButton from '#lib/ui/primitives/CopyButton.svelte';
	import { formatTime } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import {
		certificateFingerprints,
		downloadText,
		signingPolicy,
		signingSlotRows,
		type SigningSlotRow
	} from './local-signing-model';
	import NextCertificateDialog from './NextCertificateDialog.svelte';

	/**
	 * One role of the tenant's SAML identity (IdP or SP): what a partner registers (entity ID,
	 * metadata) and the signing certificates of the role as slots — in use, next, backup — with
	 * the rollover actions on them. Each action is confirmed, then run through the client (which
	 * meets the step-up the Admin API asks for) and the new settings handed up.
	 */
	interface Props {
		settings: SamlSettings;
		role: SamlRole;
		client: SamlSettingsClient;
		canEdit: boolean;
		/** May ask the server what a certificate says (the preview needs the create permission). */
		canPreview: boolean;
		/** Another operation of the page is running. */
		busy: boolean;
		onbusy: (busy: boolean) => void;
		onchanged: (settings: SamlSettings) => void;
		/** A failed action, in words for the page's error callout. */
		onerror: (message: string) => void;
	}

	let { settings, role, client, canEdit, canPreview, busy, onbusy, onchanged, onerror }: Props =
		$props();

	const uid = $props.id();
	const roleName = $derived(t(role === 'idp' ? 'sl.role.idp' : 'sl.role.sp'));
	const entityId = $derived(
		role === 'idp' ? settings.generated.idpEntityId : settings.generated.spEntityId
	);
	const metadataUrl = $derived(
		role === 'idp' ? settings.generated.idpMetadataUrl : settings.generated.spMetadataUrl
	);
	const policy = $derived(signingPolicy(settings, role));
	const rows = $derived(signingSlotRows(policy));

	/** What each certificate says, read once per PEM ('loading' while it is being read). */
	let previews = $state<Record<string, SamlCertificatePreview | 'loading' | 'failed'>>({});
	/** Fingerprints computed here, so every reader sees them without the preview. */
	let prints = $state<Record<string, { sha1: string; sha256: string } | null>>({});
	$effect(() => {
		for (const row of rows) {
			const pem = row.reference?.certificate;
			if (!pem || pem in prints) continue;
			prints[pem] = null;
			void certificateFingerprints(pem).then((value) => (prints[pem] = value));
			if (!canPreview) continue;
			previews[pem] = 'loading';
			client
				.previewCertificate(pem)
				.then((preview) => (previews[pem] = preview))
				.catch(() => (previews[pem] = 'failed'));
		}
	});

	/** The preview of a PEM once read; undefined while loading or when it failed. */
	function previewOf(pem: string | undefined): SamlCertificatePreview | undefined {
		const preview = pem ? previews[pem] : undefined;
		return preview && preview !== 'loading' && preview !== 'failed' ? preview : undefined;
	}

	const ACTION_KEY = {
		promote_next: 'promoteNext',
		retire_backup: 'retireBackup',
		delete_next: 'deleteNext',
		recreate_active: 'recreateActive',
		publish_next: 'publishNext'
	} as const;

	let running = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let confirming = $state<{ action: SamlLocalSigningAction; row?: SigningSlotRow } | null>(null);

	const when = (value: number | string | undefined) => {
		if (value === undefined) return '';
		return formatTime(value, { locale: i18n.locale, zone: timePreference.zone })?.text ?? '';
	};

	function slotLabel(row: SigningSlotRow): string {
		if (row.slot === 'active') return t('sl.slot.active');
		if (row.slot === 'backup') return t('sl.slot.backup');
		return row.index === undefined ? t('sl.slot.next') : t('sl.slot.nextN', { index: row.index });
	}

	function daysLeft(validTo: number | string | undefined): number | null {
		if (validTo === undefined) return null;
		const end = typeof validTo === 'number' ? validTo : Date.parse(validTo);
		return Number.isNaN(end) ? null : Math.floor((end - Date.now()) / 86_400_000);
	}

	function expiryTone(days: number): 'danger' | 'warning' | 'success' {
		return days < 0 ? 'danger' : days <= 30 ? 'warning' : 'success';
	}

	function cancelled(error: unknown): boolean {
		return error instanceof Error && error.name === 'NotAllowedError';
	}

	async function run(
		action: SamlLocalSigningAction,
		row?: SigningSlotRow,
		extra: Record<string, unknown> = {}
	): Promise<boolean> {
		running = true;
		onbusy(true);
		try {
			const next = await client.localSigning({
				role,
				action,
				keepPreviousAsBackup: action === 'promote_next' ? true : undefined,
				targetKid: row?.reference?.kid,
				targetKeyRef: row?.reference?.keyRef,
				...extra
			});
			onchanged(next);
			return true;
		} catch (error) {
			if (!cancelled(error)) onerror(error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			running = false;
			onbusy(false);
		}
	}

	async function confirmAction() {
		if (!confirming) return;
		const { action, row } = confirming;
		await run(action, row);
		confirming = null;
	}

	async function createNext(request: Record<string, unknown>) {
		createError = '';
		running = true;
		onbusy(true);
		try {
			onchanged(await client.localSigning({ role, action: 'publish_next', ...request }));
			creating = false;
		} catch (error) {
			if (!cancelled(error)) createError = error instanceof Error ? error.message : String(error);
		} finally {
			running = false;
			onbusy(false);
		}
	}

	const activePreview = $derived(previewOf(policy.active?.certificate));

	const confirmText = $derived.by(() => {
		if (!confirming) return { title: '', body: '', label: '' };
		const key = ACTION_KEY[confirming.action] as Exclude<
			(typeof ACTION_KEY)[keyof typeof ACTION_KEY],
			'publishNext'
		>;
		return {
			title: t(`sl.action.${key}.confirm.title`, { role: roleName }),
			body: t(`sl.action.${key}.confirm.body`, { role: roleName }),
			label: t(`sl.action.${key}`)
		};
	});
</script>

<Card
	title={t(role === 'idp' ? 'sl.role.idp.title' : 'sl.role.sp.title')}
	description={t(role === 'idp' ? 'sl.role.idp.hint' : 'sl.role.sp.hint')}
>
	{#snippet actions()}
		<!-- A link, not a fetch: the metadata lives at the tenant's issuer, which the console's
		     connect-src does not allow in proxy deployments; the browser shows or saves the XML. -->
		<Button size="sm" variant="secondary" icon="file" href={metadataUrl} external
			>{t('sl.openMetadata')}</Button
		>
	{/snippet}

	<DetailList ruled>
		<DetailItem label={t('sl.entityId')}>
			<code class="mono">{entityId}</code>
			{#snippet end()}
				<CopyButton
					variant="icon"
					text={entityId}
					label={t('sl.copy', { name: t('sl.entityId') })}
				/>
			{/snippet}
		</DetailItem>
		<DetailItem label={t('sl.metadataUrl')}>
			<a class="mono" href={metadataUrl} target="_blank" rel="noopener noreferrer">{metadataUrl}</a>
			{#snippet end()}
				<CopyButton
					variant="icon"
					text={metadataUrl}
					label={t('sl.copy', { name: t('sl.metadataUrl') })}
				/>
			{/snippet}
		</DetailItem>
	</DetailList>

	<section class="certs" aria-label={t('sl.certs.title', { role: roleName })}>
		<div class="certs__head">
			<div>
				<h3 class="certs__title">{t('sl.certs.title', { role: roleName })}</h3>
				<p class="certs__desc">{t('sl.certs.desc')}</p>
			</div>
			{#if canEdit}
				<Button
					size="sm"
					icon="plus"
					disabled={busy}
					onclick={() => {
						createError = '';
						creating = true;
					}}>{t('sl.action.publishNext')}</Button
				>
			{/if}
		</div>

		<ul class="slots">
			{#each rows as row (row.id)}
				{@const pem = row.reference?.certificate}
				{@const preview = previewOf(pem)}
				{@const failed = pem !== undefined && previews[pem] === 'failed'}
				{@const print = pem ? prints[pem] : null}
				{@const validTo = row.reference?.validTo ?? preview?.validTo}
				{@const days = daysLeft(validTo)}
				<li class="slot" class:is-empty={!row.stored}>
					<div class="slot__head">
						<Badge tone={row.slot === 'active' ? 'info' : 'neutral'}>{slotLabel(row)}</Badge>
						{#if row.stored && days !== null}
							<Badge tone={expiryTone(days)} dot
								>{days < 0 ? t('sl.cert.expired') : t('sl.cert.daysLeft', { days })}</Badge
							>
						{/if}
						{#if row.stored && row.slot !== 'active'}
							<span title={row.publication === 'withheld' ? t('sl.slot.withheld.hint') : undefined}>
								<Badge tone={row.publication === 'published' ? 'success' : 'warning'}
									>{row.publication === 'published'
										? t('sl.slot.published')
										: row.publication === 'scheduled'
											? t('sl.slot.scheduled', {
													date: when(row.reference?.metadataPublishFrom)
												})
											: t('sl.slot.withheld')}</Badge
								>
							</span>
						{/if}
						<span class="slot__desc">{t(`sl.slot.${row.slot}.desc`)}</span>
					</div>

					{#if !row.stored}
						<p class="slot__empty">
							{row.slot === 'active' ? t('sl.slot.defaultKey') : t('sl.slot.empty')}
						</p>
					{:else}
						{#if preview}
							<p class="slot__subject">{preview.subject}</p>
						{:else if failed}
							<p class="slot__subject">{t('sl.cert.previewFailed')}</p>
						{/if}
						{#if print}<code class="mono">{print.sha256}</code>{/if}
						<span class="slot__meta">
							{#if row.reference?.kid}<code class="mono">{row.reference.kid}</code>{/if}
							{#if validTo}· {t('sl.cert.validTo')}: {when(validTo)}{/if}
						</span>

						{#if pem}
							<Disclosure title={t('sl.cert.show')}>
								{#if !preview && print}
									<DetailList size="sm">
										<DetailItem label={t('sl.cert.sha1')}
											><code class="mono">{print.sha1}</code></DetailItem
										>
										<DetailItem label={t('sl.cert.sha256')}
											><code class="mono">{print.sha256}</code></DetailItem
										>
									</DetailList>
								{/if}
								{#if preview}
									<DetailList size="sm" columns={2}>
										<DetailItem label={t('sl.cert.subject')}>{preview.subject}</DetailItem>
										<DetailItem label={t('sl.cert.issuer')}>{preview.issuer}</DetailItem>
										<DetailItem label={t('sl.cert.validFrom')}>{when(preview.validFrom)}</DetailItem
										>
										<DetailItem label={t('sl.cert.validTo')}>{when(preview.validTo)}</DetailItem>
										<DetailItem label={t('sl.cert.signature')}
											>{preview.signatureAlgorithm}</DetailItem
										>
										<DetailItem label={t('sl.cert.publicKey')}
											>{preview.publicKeyAlgorithm}{preview.publicKeySizeBits
												? ` ${preview.publicKeySizeBits} bit`
												: ''}</DetailItem
										>
										<DetailItem label={t('sl.cert.sha1')}
											><code class="mono">{preview.fingerprintSha1}</code></DetailItem
										>
										<DetailItem label={t('sl.cert.sha256')}
											><code class="mono">{preview.fingerprintSha256}</code></DetailItem
										>
									</DetailList>
									{#if preview.warnings.length > 0}
										<Callout tone="warning">
											{#each preview.warnings as warning (warning)}<div>{warning}</div>{/each}
										</Callout>
									{/if}
								{/if}
								<div class="pem">
									<label class="pem__label" for="{uid}-pem-{row.id}">{t('sl.cert.pem')}</label>
									<textarea
										id="{uid}-pem-{row.id}"
										class="pem__text mono"
										readonly
										rows="6"
										value={pem}
									></textarea>
									<div class="pem__actions">
										<CopyButton
											variant="button"
											size="sm"
											text={pem}
											label={t('sl.cert.copyPem')}
										/>
										<Button
											size="sm"
											variant="ghost"
											onclick={() =>
												downloadText(
													`authrim-saml-${role}-${row.slot}.pem`,
													pem,
													'application/x-pem-file'
												)}>{t('sl.cert.downloadPem')}</Button
										>
									</div>
								</div>
							</Disclosure>
						{/if}

						{#if canEdit && row.slot !== 'active'}
							{@const targeted = !!(row.reference?.kid || row.reference?.keyRef)}
							<!-- Without a key ID the server would act on whichever candidate comes first. -->
							<div class="slot__actions">
								{#if row.slot === 'next'}
									<Button
										size="sm"
										disabled={busy || !targeted}
										onclick={() => (confirming = { action: 'promote_next', row })}
										>{t('sl.action.promoteNext')}</Button
									>
									<Button
										size="sm"
										variant="ghost"
										disabled={busy || !targeted}
										onclick={() => (confirming = { action: 'delete_next', row })}
										>{t('sl.action.deleteNext')}</Button
									>
								{:else}
									<Button
										size="sm"
										variant="ghost"
										disabled={busy || !targeted}
										onclick={() => (confirming = { action: 'retire_backup', row })}
										>{t('sl.action.retireBackup')}</Button
									>
								{/if}
							</div>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	</section>
</Card>

<NextCertificateDialog
	open={creating}
	{role}
	{settings}
	currentSubject={activePreview?.subject}
	busy={running}
	error={createError}
	onsubmit={createNext}
	oncancel={() => (creating = false)}
/>

<ConfirmDialog
	open={confirming !== null}
	title={confirmText.title}
	body={confirmText.body}
	confirmLabel={confirmText.label}
	tone={confirming?.action === 'promote_next' ? 'default' : 'danger'}
	busy={running}
	onconfirm={confirmAction}
	oncancel={() => (confirming = null)}
/>

<style>
	.mono {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.certs {
		margin-top: var(--space-section);
	}

	.certs__head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-related);
		margin-bottom: var(--space-related);
	}

	.certs__title {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	.certs__desc {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.slots {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.slot {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: var(--space-related);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}

	.slot.is-empty {
		border-style: dashed;
		background: transparent;
	}

	.slot__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.slot__desc,
	.slot__meta,
	.slot__empty {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.slot__empty,
	.slot__subject {
		margin: 0;
	}

	.slot__subject {
		font-weight: var(--fw-medium);
	}

	.slot__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 4px;
	}

	.pem {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: var(--space-related);
	}

	.pem__label {
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-medium);
	}

	.pem__text {
		width: 100%;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		resize: vertical;
	}

	.pem__actions {
		display: flex;
		gap: 8px;
	}
</style>

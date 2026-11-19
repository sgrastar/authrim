<script lang="ts">
	import type {
		SamlEntityIdStyle,
		SamlInteractiveLoginUrlPolicy,
		SamlSettings,
		SamlSettingsClient
	} from '#lib/api/saml-settings.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import { formatTime } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { entityIdForStyle } from './local-signing-model';

	/**
	 * How the tenant's SAML identity is published: the form of its entity IDs (with the IDs the
	 * other form would give, before saving), where an interactive sign-in goes, and the
	 * environment's metadata publication settings as they stand (read-only here).
	 */
	interface Props {
		settings: SamlSettings;
		client: SamlSettingsClient;
		canEdit: boolean;
		busy: boolean;
		onbusy: (busy: boolean) => void;
		onchanged: (settings: SamlSettings) => void;
		onerror: (message: string) => void;
		/** Whether a choice is unsaved, for the page's leave guard. */
		onstate?: (state: { dirty: boolean }) => void;
	}

	let { settings, client, canEdit, busy, onbusy, onchanged, onerror, onstate }: Props = $props();

	let style = $state<SamlEntityIdStyle>('metadata_url');
	let login = $state<SamlInteractiveLoginUrlPolicy>('tenant_host');
	let saving = $state(false);

	// The form follows the saved values only when they change (a save here, a load): an unrelated
	// operation of the page hands down new settings too, and must not discard an unsaved choice.
	let savedStyle: SamlEntityIdStyle | undefined;
	let savedLogin: SamlInteractiveLoginUrlPolicy | undefined;
	$effect(() => {
		if (settings.entityIdStyle !== savedStyle) {
			savedStyle = settings.entityIdStyle;
			style = settings.entityIdStyle;
		}
		if (settings.interactiveLoginUrlPolicy !== savedLogin) {
			savedLogin = settings.interactiveLoginUrlPolicy;
			login = settings.interactiveLoginUrlPolicy;
		}
	});

	const dirty = $derived(
		style !== settings.entityIdStyle || login !== settings.interactiveLoginUrlPolicy
	);

	$effect(() => {
		onstate?.({ dirty });
	});

	const STYLES = $derived([
		{
			value: 'metadata_url',
			label: t('sl.pub.style.metadataUrl'),
			description: t('sl.pub.style.metadataUrl.desc')
		},
		{
			value: 'role_url',
			label: t('sl.pub.style.roleUrl'),
			description: t('sl.pub.style.roleUrl.desc')
		}
	]);
	const LOGINS = $derived([
		{
			value: 'tenant_host',
			label: t('sl.pub.login.tenantHost'),
			description: t('sl.pub.login.tenantHost.desc')
		},
		{
			value: 'ui_base_url',
			label: t('sl.pub.login.uiBaseUrl'),
			description: t('sl.pub.login.uiBaseUrl.desc')
		}
	]);

	const when = (value: string) =>
		formatTime(value, { locale: i18n.locale, zone: timePreference.zone })?.text ?? value;

	async function save() {
		saving = true;
		onbusy(true);
		try {
			onchanged(await client.update({ entityIdStyle: style, interactiveLoginUrlPolicy: login }));
			toast.success(t('sl.pub.saved'));
		} catch (error) {
			onerror(error instanceof Error ? error.message : String(error));
		} finally {
			saving = false;
			onbusy(false);
		}
	}
</script>

<Card title={t('sl.pub.title')} description={t('sl.pub.desc')}>
	<FieldRow label={t('sl.pub.style')} align="text">
		<RadioGroup
			label={t('sl.pub.style')}
			hideLabel
			options={STYLES}
			value={style}
			disabled={!canEdit || busy}
			onchange={(value) => (style = value as SamlEntityIdStyle)}
		/>
	</FieldRow>
	<div class="ids">
		<DetailList size="sm" ruled>
			<DetailItem label={t('sl.pub.idpEntityId')}>
				<code class="mono">{settings.generated.idpEntityId}</code>
				{#if style !== settings.entityIdStyle}
					<span class="next"
						><Badge tone="changed" size="sm">{t('sl.pub.afterSave')}</Badge>
						<code class="mono">{entityIdForStyle(settings, 'idp', style)}</code></span
					>
				{/if}
			</DetailItem>
			<DetailItem label={t('sl.pub.spEntityId')}>
				<code class="mono">{settings.generated.spEntityId}</code>
				{#if style !== settings.entityIdStyle}
					<span class="next"
						><Badge tone="changed" size="sm">{t('sl.pub.afterSave')}</Badge>
						<code class="mono">{entityIdForStyle(settings, 'sp', style)}</code></span
					>
				{/if}
			</DetailItem>
		</DetailList>
	</div>

	<FieldRow label={t('sl.pub.login')} align="text">
		<RadioGroup
			label={t('sl.pub.login')}
			hideLabel
			options={LOGINS}
			value={login}
			disabled={!canEdit || busy}
			onchange={(value) => (login = value as SamlInteractiveLoginUrlPolicy)}
		/>
	</FieldRow>

	<section class="meta" aria-label={t('sl.pub.metadata.title')}>
		<h3 class="meta__title">{t('sl.pub.metadata.title')}</h3>
		<DetailList size="sm" columns={2}>
			<DetailItem label={t('sl.pub.metadata.signing')}>
				<Badge tone={settings.metadata.signingEnabled ? 'success' : 'neutral'}
					>{t(
						settings.metadata.signingEnabled
							? 'sl.pub.metadata.signing.on'
							: 'sl.pub.metadata.signing.off'
					)}</Badge
				>
			</DetailItem>
			<DetailItem label={t('sl.pub.metadata.validUntil')}>
				{#if settings.metadata.validUntilEnabled}
					{t('sl.pub.metadata.validityDays', { days: settings.metadata.validityDays })}
					<span class="muted"
						>(IdP {when(settings.metadata.idpValidUntil)} · SP {when(
							settings.metadata.spValidUntil
						)})</span
					>
				{:else}
					{t('sl.pub.metadata.validUntil.off')}
				{/if}
			</DetailItem>
			<DetailItem label={t('sl.pub.metadata.cacheDuration')}
				><code class="mono">{settings.metadata.cacheDuration}</code></DetailItem
			>
		</DetailList>
		<p class="muted">{t('sl.pub.metadata.hint')}</p>
	</section>

	{#if canEdit}
		<Callout tone="warning">{t('sl.pub.warning')}</Callout>
		<div class="save">
			<Button variant="primary" disabled={!dirty || busy} loading={saving} onclick={save}
				>{t('sl.pub.save')}</Button
			>
		</div>
	{/if}
</Card>

<style>
	.mono {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.ids {
		margin: var(--space-related) 0 var(--space-section);
	}

	.next {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}

	.meta {
		margin-top: var(--space-section);
	}

	.meta__title {
		margin: 0 0 var(--space-related);
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	.muted {
		margin: var(--space-related) 0 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.save {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-related);
	}
</style>

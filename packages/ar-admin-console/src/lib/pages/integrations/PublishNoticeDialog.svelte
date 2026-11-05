<script lang="ts">
	import {
		BODY_MAX,
		TITLE_MAX,
		isConsolePath,
		type NoticeScope,
		type PublishNoticeInput
	} from '#lib/api/admin-notices.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { NotificationSeverity } from '#lib/shell/notifications.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { SEVERITY_LABEL } from './notice-labels';

	/** "お知らせを出す": an announcement to the admins of a tenant, an app, one admin or the platform. */
	interface Props {
		open: boolean;
		/** Platform announcements are offered only to admins with platform authority. */
		platform: boolean;
		busy?: boolean;
		/** Why the last try failed, from the API. */
		error?: string;
		onpublish: (input: PublishNoticeInput) => void;
		oncancel: () => void;
	}

	let { open, platform, busy = false, error, onpublish, oncancel }: Props = $props();

	let scope = $state<NoticeScope>('tenant');
	let clientId = $state('');
	let adminUserId = $state('');
	let severity = $state<NotificationSeverity>('info');
	let title = $state('');
	let body = $state('');
	let link = $state('');
	let expires = $state('');
	let formError = $state<string>();

	// A fresh form each time the dialog opens.
	$effect(() => {
		if (!open) return;
		scope = 'tenant';
		clientId = adminUserId = title = body = link = expires = '';
		severity = 'info';
		formError = undefined;
	});

	const scopes = $derived<{ value: NoticeScope; label: string }[]>([
		{ value: 'tenant', label: t('nt.pub.scope.tenant') },
		{ value: 'client', label: t('nt.pub.scope.client') },
		{ value: 'admin_user', label: t('nt.pub.scope.admin_user') },
		...(platform ? [{ value: 'platform' as const, label: t('nt.pub.scope.platform') }] : [])
	]);

	function submit() {
		const headline = title.trim();
		const expiresAt = expires ? new Date(expires).getTime() : undefined;
		if (
			!headline ||
			(scope === 'client' && !clientId.trim()) ||
			(scope === 'admin_user' && !adminUserId.trim()) ||
			(link.trim() && !isConsolePath(link.trim()))
		) {
			formError = t('nt.pub.err.invalid');
			return;
		}
		if (expiresAt !== undefined && !(expiresAt > Date.now())) {
			formError = t('nt.pub.err.expiry');
			return;
		}
		formError = undefined;
		onpublish({
			scope_type: scope,
			...(scope === 'client' ? { client_id: clientId.trim() } : {}),
			...(scope === 'admin_user' ? { admin_user_id: adminUserId.trim() } : {}),
			severity,
			title: headline,
			...(body.trim() ? { body: body.trim() } : {}),
			...(link.trim() ? { link: link.trim() } : {}),
			...(expiresAt !== undefined ? { expires_at: expiresAt } : {})
		});
	}
</script>

<FormDialog
	{open}
	title={t('nt.pub.title')}
	description={t('nt.pub.desc')}
	submitLabel={t('nt.pub.submit')}
	{busy}
	error={formError ?? error}
	onsubmit={submit}
	{oncancel}
>
	<Select
		label={t('nt.pub.scope')}
		options={scopes}
		value={scope}
		onchange={(value) => (scope = value as NoticeScope)}
	/>
	{#if scope === 'client'}
		<TextField label={t('nt.pub.clientId')} required autocomplete="off" bind:value={clientId} />
	{:else if scope === 'admin_user'}
		<TextField
			label={t('nt.pub.adminUserId')}
			required
			autocomplete="off"
			bind:value={adminUserId}
		/>
	{/if}
	<Select
		label={t('nt.pub.severity')}
		options={(['info', 'caution', 'high', 'critical'] as const).map((value) => ({
			value,
			label: t(SEVERITY_LABEL[value])
		}))}
		value={severity}
		onchange={(value) => (severity = value as NotificationSeverity)}
	/>
	<TextField
		label={t('nt.pub.title.label')}
		hint={t('nt.pub.title.hint', { max: TITLE_MAX })}
		required
		maxlength={TITLE_MAX}
		autocomplete="off"
		bind:value={title}
	/>
	<TextArea label={t('nt.pub.body')} rows={4} maxlength={BODY_MAX} counter bind:value={body} />
	<TextField
		label={t('nt.pub.link')}
		hint={t('nt.pub.link.hint')}
		autocomplete="off"
		bind:value={link}
	/>
	<TextField
		label={t('nt.pub.expires')}
		hint={t('nt.pub.expires.hint')}
		type="datetime-local"
		bind:value={expires}
	/>
</FormDialog>

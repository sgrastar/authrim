<script lang="ts">
	import {
		CHANNEL_NAME_MAX,
		SEVERITIES,
		isSlackWebhookUrl,
		type CreateNoticeChannelInput,
		type NoticeChannelScope
	} from '#lib/api/notice-delivery.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { NotificationSeverity } from '#lib/shell/notifications.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import SecretField from '#lib/ui/primitives/SecretField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { MIN_SEVERITY_LABEL } from './notice-labels';

	/** "Add a Slack channel": a name, the webhook URL (typed once, never shown again), what to post. */
	interface Props {
		open: boolean;
		/** The platform's own channels are offered only to admins with platform authority. */
		platform: boolean;
		busy?: boolean;
		/** Why the last try failed, from the API. */
		error?: string;
		onadd: (input: CreateNoticeChannelInput) => void;
		oncancel: () => void;
	}

	let { open, platform, busy = false, error, onadd, oncancel }: Props = $props();

	let name = $state('');
	let url = $state('');
	let min = $state<NotificationSeverity>('high');
	let scope = $state<NoticeChannelScope>('tenant');
	let formError = $state<string>();

	// A fresh form each time the dialog opens.
	$effect(() => {
		if (!open) return;
		name = url = '';
		min = 'high';
		scope = 'tenant';
		formError = undefined;
	});

	function submit() {
		if (!name.trim() || name.trim().length > CHANNEL_NAME_MAX) {
			formError = t('nt.slack.err.name', { max: CHANNEL_NAME_MAX });
			return;
		}
		if (!isSlackWebhookUrl(url.trim())) {
			formError = t('nt.slack.err.url');
			return;
		}
		formError = undefined;
		onadd({
			scope_type: scope,
			name: name.trim(),
			webhook_url: url.trim(),
			min_severity: min
		});
	}
</script>

<FormDialog
	{open}
	title={t('nt.slack.add.title')}
	description={t('nt.slack.add.desc')}
	submitLabel={t('nt.slack.add.submit')}
	{busy}
	error={formError ?? error}
	onsubmit={submit}
	{oncancel}
>
	<TextField
		label={t('nt.slack.name')}
		hint={t('nt.slack.name.hint', { max: CHANNEL_NAME_MAX })}
		required
		maxlength={CHANNEL_NAME_MAX}
		autocomplete="off"
		bind:value={name}
	/>
	<SecretField label={t('nt.slack.url')} hint={t('nt.slack.url.hint')} required bind:value={url} />
	<Select
		label={t('nt.slack.min')}
		options={SEVERITIES.map((value) => ({ value, label: t(MIN_SEVERITY_LABEL[value]) }))}
		value={min}
		onchange={(value) => (min = value as NotificationSeverity)}
	/>
	{#if platform}
		<Select
			label={t('nt.slack.scope')}
			options={[
				{ value: 'tenant', label: t('nt.slack.scope.tenant') },
				{ value: 'platform', label: t('nt.slack.scope.platform') }
			]}
			value={scope}
			onchange={(value) => (scope = value as NoticeChannelScope)}
		/>
	{/if}
</FormDialog>

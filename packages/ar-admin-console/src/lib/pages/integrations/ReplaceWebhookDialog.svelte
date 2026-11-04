<script lang="ts">
	import { isSlackWebhookUrl, type NoticeChannel } from '#lib/api/notice-delivery.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import SecretField from '#lib/ui/primitives/SecretField.svelte';

	/** "Replace the webhook URL" of one channel. The current URL is never shown, only its end. */
	interface Props {
		channel: NoticeChannel | null;
		busy?: boolean;
		error?: string;
		onreplace: (webhookUrl: string) => void;
		oncancel: () => void;
	}

	let { channel, busy = false, error, onreplace, oncancel }: Props = $props();

	let url = $state('');
	let formError = $state<string>();

	$effect(() => {
		if (!channel) return;
		url = '';
		formError = undefined;
	});

	function submit() {
		if (!isSlackWebhookUrl(url.trim())) {
			formError = t('nt.slack.err.url');
			return;
		}
		formError = undefined;
		onreplace(url.trim());
	}
</script>

<FormDialog
	open={channel !== null}
	title={t('nt.slack.replace.title', { name: channel?.name ?? '' })}
	description={t('nt.slack.replace.desc')}
	submitLabel={t('nt.slack.replace.submit')}
	{busy}
	error={formError ?? error}
	onsubmit={submit}
	{oncancel}
>
	<SecretField
		label={t('nt.slack.url')}
		hint="{t('nt.slack.url.hint')} {t('nt.slack.replace.hint', {
			hint: channel?.webhook_url_hint ?? ''
		})}"
		required
		bind:value={url}
	/>
</FormDialog>

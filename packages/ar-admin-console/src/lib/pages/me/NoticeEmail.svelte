<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SEVERITIES,
		type NoticeDeliveryClient,
		type NoticePreferencesInput
	} from '#lib/api/notice-delivery.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { NotificationSeverity } from '#lib/shell/notifications.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { MIN_SEVERITY_LABEL } from '../integrations/notice-labels';

	/**
	 * My account → "Notice emails": whether the notices addressed to this admin are also sent to
	 * the email address of the account, and from which severity. Saved with the card's own button.
	 */
	interface Props {
		client: NoticeDeliveryClient;
	}

	let { client }: Props = $props();

	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let draft = $state<Draft<NoticePreferencesInput>>();

	async function load() {
		phase = 'loading';
		try {
			const preferences = await client.getPreferences();
			draft = new Draft({
				email_enabled: preferences.email_enabled,
				email_min_severity: preferences.email_min_severity
			});
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void load();
	});

	async function save(value: NoticePreferencesInput) {
		try {
			await client.setPreferences(value);
		} catch {
			throw new Error(t('nt.mail.saveFailed'));
		}
		toast.success(t('nt.mail.saved'));
	}
</script>

{#if phase === 'loading'}
	<Card title={t('nt.mail.title')}><LoadingState label={t('common.loading')} /></Card>
{:else if phase === 'forbidden'}
	<Card title={t('nt.mail.title')}>
		<EmptyState icon="lock" title={t('nt.mail.noAccess')} />
	</Card>
{:else if phase === 'failed' || !draft}
	<Card title={t('nt.mail.title')}>
		<EmptyState icon="warningCircle" title={t('nt.mail.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	</Card>
{:else}
	<SaveScope {draft} onsave={save} bar={false}>
		{#snippet children(controls)}
			<Card title={t('nt.mail.title')} description={t('nt.mail.desc')}>
				<RowStack>
					<CheckRow
						label={t('nt.mail.enabled')}
						text={t('nt.mail.enabled.text')}
						field="email_enabled"
						bind:checked={draft!.value.email_enabled}
					/>
					<SelectRow
						label={t('nt.mail.minSeverity')}
						field="email_min_severity"
						disabled={!draft!.value.email_enabled}
						options={SEVERITIES.map((value) => ({ value, label: t(MIN_SEVERITY_LABEL[value]) }))}
						value={draft!.value.email_min_severity}
						onchange={(value) => (draft!.value.email_min_severity = value as NotificationSeverity)}
					/>
				</RowStack>
				{#snippet footer()}
					<Button
						variant="primary"
						size="sm"
						disabled={!controls.dirty}
						loading={controls.saving}
						onclick={controls.save}
					>
						{t('nt.mail.save')}
					</Button>
				{/snippet}
			</Card>
		{/snippet}
	</SaveScope>
{/if}

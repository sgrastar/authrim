<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { failureOf, type Schema, type SchemaSettingClient } from '$lib/api/schema-setting';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import { FAILURE_KEY, isStuck, statusText } from './labels';

	/**
	 * What an attribute that is not at rest needs. A failed operation (a rename or a delete that
	 * stopped half-way) says what it was doing and offers Retry; one that is still running, or
	 * stuck as running, cannot be recovered from here and says so. Nothing about the attribute can
	 * be changed meanwhile.
	 */
	interface Props {
		schema: Schema;
		client: SchemaSettingClient;
		tenantId: string;
		canWrite?: boolean;
		/** The attribute changed (a retry ran): read it again. */
		onchanged: () => void;
	}

	let { schema, client, tenantId, canWrite = false, onchanged }: Props = $props();

	let busy = $state(false);

	const operation = $derived(schema.operation);
	const what = $derived(
		operation?.operation === 'rename'
			? t('ss.op.rename', { old: operation.old_key ?? '', new: operation.new_key ?? '' })
			: operation?.operation === 'delete'
				? t('ss.op.delete')
				: t('ss.op.other')
	);

	async function retry() {
		busy = true;
		try {
			const result = await client.retry(tenantId, schema.id);
			toast.success(
				t(result.action === 'rename_completed' ? 'ss.retry.renameDone' : 'ss.retry.reset')
			);
			onchanged();
		} catch (failure) {
			toast.error(t(FAILURE_KEY[failureOf(failure).kind]));
		} finally {
			busy = false;
		}
	}
</script>

{#if schema.status === 'error'}
	<Callout tone="danger" title={t('ss.op.failedTitle')} live>
		<p class="line">{what}</p>
		{#if operation?.error}<p class="line"><code>{operation.error}</code></p>{/if}
		{#if operation?.failed_users !== undefined}
			<p class="line">
				{t('ss.op.progress', {
					failed: operation.failed_users,
					total: operation.total_processed ?? 0
				})}
			</p>
		{/if}
		{#if operation?.operation === 'delete'}<p class="line">{t('ss.op.deleteNote')}</p>{/if}
		{#if canWrite}
			<Button size="sm" variant="secondary" loading={busy} onclick={retry}
				>{t('ss.op.retry')}</Button
			>
		{/if}
	</Callout>
{:else if isStuck(schema)}
	<Callout tone="warning" title={t('ss.op.stuckTitle')}>
		{t('ss.op.stuckBody', { status: t(statusText(schema.status)) })}
	</Callout>
{/if}

<style>
	.line {
		margin: 0 0 8px;
	}

	code {
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}
</style>

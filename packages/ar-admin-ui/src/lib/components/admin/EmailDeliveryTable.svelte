<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { EmailDeliveryRecord } from '$lib/api/admin-email-deliveries';
	import AdminDataTable from './AdminDataTable.svelte';

	interface Props {
		items: EmailDeliveryRecord[];
		showUser?: boolean;
	}

	let { items, showUser = true }: Props = $props();

	function dateTime(value: number | null): string {
		return value ? new Date(value * 1000).toLocaleString() : '-';
	}

	function statusLabel(value: string): string {
		switch (value) {
			case 'requested':
				return $LL.admin_email_deliveries_status_requested();
			case 'retrying':
				return $LL.admin_email_deliveries_status_retrying();
			case 'provider_accepted':
				return $LL.admin_email_deliveries_status_provider_accepted();
			case 'delivered':
				return $LL.admin_email_deliveries_status_delivered();
			case 'deferred':
				return $LL.admin_email_deliveries_status_deferred();
			case 'bounced':
				return $LL.admin_email_deliveries_status_bounced();
			case 'failed':
				return $LL.admin_email_deliveries_status_failed();
			case 'rejected':
				return $LL.admin_email_deliveries_status_rejected();
			case 'complained':
				return $LL.admin_email_deliveries_status_complained();
			case 'unknown':
				return $LL.admin_email_deliveries_status_unknown();
			case 'expired':
				return $LL.admin_email_deliveries_status_expired();
			case 'canceled':
				return $LL.admin_email_deliveries_status_canceled();
			default:
				return value;
		}
	}

	function badge(value: string): string {
		if (value === 'failed' || value === 'expired') return 'badge badge-danger';
		if (value === 'provider_accepted' || value === 'delivered') return 'badge badge-success';
		if (value === 'retrying') return 'badge badge-warning';
		return 'badge badge-neutral';
	}
</script>

{#if items.length === 0}
	<div class="empty-state"><p>{$LL.admin_email_deliveries_empty()}</p></div>
{:else}
	<AdminDataTable width="xwide">
		<thead>
			<tr>
				<th>{$LL.admin_email_deliveries_requested_at()}</th>
				{#if showUser}<th>{$LL.admin_email_deliveries_user()}</th>{/if}
				<th>{$LL.admin_email_deliveries_recipient()}</th>
				<th>{$LL.admin_email_deliveries_purpose()}</th>
				<th>{$LL.admin_email_deliveries_api()}</th>
				<th>{$LL.admin_email_deliveries_provider()}</th>
				<th>{$LL.admin_email_deliveries_final_delivery()}</th>
				<th>{$LL.admin_email_deliveries_attempts()}</th>
				<th>{$LL.admin_email_deliveries_evidence()}</th>
			</tr>
		</thead>
		<tbody>
			{#each items as item (item.intent_id)}
				<tr>
					<td class="nowrap">{dateTime(item.requested_at)}</td>
					{#if showUser}
						<td
							>{#if item.account_id}<a
									class="admin-link mono"
									href={`/admin/users/${item.account_id}`}>{item.account_id}</a
								>{:else}-{/if}</td
						>
					{/if}
					<td>{item.recipient ?? $LL.admin_email_deliveries_recipient_hidden()}</td>
					<td class="mono">{item.notification_kind}</td>
					<td
						><span class="badge badge-success">{$LL.admin_email_deliveries_api_recorded()}</span
						></td
					>
					<td>
						<span class={badge(item.status)}>{statusLabel(item.status)}</span>
						<div class="cell-secondary mono">{item.provider_installation_id}</div>
					</td>
					<td
						>{item.final_delivery_tracked
							? statusLabel(item.status)
							: $LL.admin_email_deliveries_not_tracked()}</td
					>
					<td>{item.attempts}</td>
					<td>
						{#if item.provider_message_id}<div class="mono">{item.provider_message_id}</div>{/if}
						{#if item.last_error_code}<div class="text-danger mono">
								{item.last_error_code}
							</div>{/if}
						{#if !item.provider_message_id && !item.last_error_code}-{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</AdminDataTable>
{/if}

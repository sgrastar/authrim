<script lang="ts">
	import { Skeleton } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let {
		variant = 'list',
		rows = 2,
		showAction = false,
		showIcon = false
	} = $props<{
		variant?: 'profile' | 'list' | 'form-list' | 'activity';
		rows?: number;
		showAction?: boolean;
		showIcon?: boolean;
	}>();
</script>

<div class="account-section-skeleton" data-variant={variant} role="status">
	<span class="sr-only">{$LL.common_loading()}</span>

	{#if variant === 'profile'}
		<div class="skeleton-profile-list">
			{#each Array.from({ length: 2 }) as _, index (index)}
				<div class="skeleton-field">
					<Skeleton width="28%" height="0.625rem" radius="0.25rem" />
					<Skeleton width="58%" height="0.9375rem" radius="0.3rem" />
				</div>
			{/each}
		</div>
		<div class="skeleton-form">
			<Skeleton width="28%" height="1.125rem" radius="0.25rem" />
			<Skeleton height="3.125rem" radius="0.75rem" />
			<Skeleton height="2.75rem" radius="0.75rem" />
		</div>
	{:else}
		{#if variant === 'list'}
			<Skeleton width="72%" height="0.75rem" radius="0.3rem" />
		{/if}
		{#if variant === 'form-list'}
			<Skeleton width="30%" height="0.75rem" radius="0.25rem" />
			<Skeleton height="2.75rem" radius="0.75rem" />
			<Skeleton height="2.75rem" radius="0.75rem" />
		{/if}
		<div class="skeleton-rows">
			{#each Array.from({ length: rows }) as _, index (index)}
				<div class="skeleton-row">
					{#if showIcon}
						<Skeleton width="2.25rem" height="2.25rem" radius="0.5rem" />
					{/if}
					<div class="skeleton-row__copy">
						<Skeleton width={index % 2 === 0 ? '46%' : '58%'} height="0.8125rem" />
						<Skeleton width={index % 2 === 0 ? '68%' : '52%'} height="0.6875rem" />
					</div>
					{#if showAction}
						<Skeleton width="4.5rem" height="2rem" radius="0.625rem" />
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.account-section-skeleton,
	.skeleton-profile-list,
	.skeleton-field,
	.skeleton-form,
	.skeleton-rows,
	.skeleton-row__copy {
		display: grid;
	}

	.account-section-skeleton {
		gap: 12px;
	}

	.account-section-skeleton[data-variant='profile'] {
		gap: 16px;
	}

	.skeleton-profile-list {
		gap: 12px;
	}

	.skeleton-field {
		gap: 6px;
	}

	.skeleton-field:first-child {
		min-height: 3rem;
	}

	.skeleton-field:last-child {
		min-height: 3.75rem;
	}

	.skeleton-form {
		display: grid;
		gap: 12px;
		margin-top: 4px;
	}

	.skeleton-rows {
		gap: 8px;
	}

	.skeleton-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 52px;
		padding-top: 10px;
		border-top: 1px solid var(--border);
	}

	.skeleton-row__copy {
		flex: 1;
		gap: 7px;
		min-width: 0;
	}
</style>

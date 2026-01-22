<script lang="ts">
	interface Breadcrumb {
		label: string;
		href?: string;
		icon?: string;
		level?: 'system' | 'tenant' | 'client';
	}

	interface Props {
		breadcrumbs?: Breadcrumb[];
		tenants?: { id: string; name: string }[];
		selectedTenantId?: string;
		onTenantChange?: (tenantId: string) => void;
		onMobileMenuClick?: () => void;
	}

	let {
		breadcrumbs = [],
		tenants = [],
		selectedTenantId,
		onTenantChange,
		onMobileMenuClick
	}: Props = $props();

	function handleTenantChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		onTenantChange?.(select.value);
	}
</script>

<header class="header">
	<div class="header-left">
		<button class="mobile-menu-btn" onclick={onMobileMenuClick} aria-label="Toggle menu">
			<i class="i-ph-list"></i>
		</button>

		{#if breadcrumbs.length > 0}
			<div class="hierarchy-breadcrumb" role="navigation" aria-label="Breadcrumb">
				{#each breadcrumbs as crumb, i (crumb.label)}
					{#if i > 0}
						<span class="hierarchy-sep" aria-hidden="true">/</span>
					{/if}
					{#if crumb.href}
						<a href={crumb.href} class="hierarchy-item" data-level={crumb.level || 'tenant'}>
							{#if crumb.icon}
								<i class={crumb.icon}></i>
							{/if}
							{crumb.label}
						</a>
					{:else}
						<span class="hierarchy-item current" data-level={crumb.level || 'tenant'}>
							{#if crumb.icon}
								<i class={crumb.icon}></i>
							{/if}
							{crumb.label}
						</span>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<div class="header-right">
		{#if tenants.length > 0}
			<div class="header-tenant-selector">
				<span class="tenant-selector-label">Tenant:</span>
				<select
					class="tenant-selector-dropdown"
					value={selectedTenantId}
					onchange={handleTenantChange}
				>
					{#each tenants as tenant (tenant.id)}
						<option value={tenant.id}>{tenant.name}</option>
					{/each}
				</select>
			</div>
		{/if}

		<div class="header-actions">
			<button class="header-icon-btn" aria-label="Notifications">
				<i class="i-ph-bell"></i>
				<span class="notification-dot"></span>
			</button>
		</div>
	</div>
</header>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 32px;
		padding: 16px 24px;
		background: var(--bg-glass);
		backdrop-filter: var(--blur-md);
		-webkit-backdrop-filter: var(--blur-md);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-glass);
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 20px;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	/* Mobile menu button */
	.mobile-menu-btn {
		display: none;
		width: 40px;
		height: 40px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: var(--radius-md);
		align-items: center;
		justify-content: center;
	}

	.mobile-menu-btn :global(i) {
		width: 24px;
		height: 24px;
		font-size: 24px;
	}

	/* Breadcrumb */
	.hierarchy-breadcrumb {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.hierarchy-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		font-weight: 500;
		text-decoration: none;
		transition: all var(--transition-fast);
	}

	.hierarchy-item :global(i) {
		width: 14px;
		height: 14px;
		font-size: 14px;
	}

	.hierarchy-item[data-level='system'] {
		background: var(--system-bg);
		color: var(--system-color);
	}

	.hierarchy-item[data-level='tenant'] {
		background: var(--tenant-bg);
		color: var(--tenant-color);
	}

	.hierarchy-item[data-level='client'] {
		background: var(--client-bg);
		color: var(--client-color);
	}

	.hierarchy-item:hover:not(.current) {
		filter: brightness(0.95);
	}

	.hierarchy-item.current {
		font-weight: 600;
	}

	.hierarchy-sep {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	/* Tenant selector */
	.header-tenant-selector {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--bg-subtle);
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
	}

	.tenant-selector-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.tenant-selector-dropdown {
		padding: 6px 32px 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background-color: var(--bg-card);
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		cursor: pointer;
		transition: all var(--transition-fast);
		outline: none;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
		min-width: 160px;
		max-width: 250px;
	}

	.tenant-selector-dropdown:hover,
	.tenant-selector-dropdown:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.tenant-selector-dropdown option {
		background-color: var(--bg-card);
		color: var(--text-primary);
	}

	/* Header actions */
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.header-icon-btn {
		width: 44px;
		height: 44px;
		border: none;
		background: transparent;
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all var(--transition-fast);
		position: relative;
		cursor: pointer;
	}

	.header-icon-btn:hover {
		background: var(--primary-light);
		color: var(--primary);
		transform: translateY(-2px);
	}

	.header-icon-btn :global(i) {
		width: 22px;
		height: 22px;
		font-size: 22px;
	}

	.notification-dot {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 10px;
		height: 10px;
		background: var(--accent);
		border-radius: 50%;
		border: 2px solid var(--bg-page);
	}

	/* Responsive */
	@media (max-width: 768px) {
		.header {
			flex-direction: column;
			gap: 16px;
			align-items: stretch;
		}

		.mobile-menu-btn {
			display: flex;
		}

		.hierarchy-breadcrumb {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.header-tenant-selector {
			display: none;
		}

		.header {
			padding: 10px 16px;
			margin-bottom: 16px;
		}
	}
</style>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import IconButton from '$lib/ui/primitives/IconButton.svelte';
	import LanguageSwitch from './LanguageSwitch.svelte';
	import type { DrawerSection } from './shell-model';

	/**
	 * Phone navigation. Horizontal scrolling fights the swipe-back gesture, so categories are
	 * stacked in one panel and expand in place. Built on <dialog> for focus trapping and Esc.
	 */
	interface Props {
		open: boolean;
		sections: readonly DrawerSection[];
		activeSectionId: string;
		onclose: () => void;
	}

	let { open, sections, activeSectionId, onclose }: Props = $props();

	let dialog = $state<HTMLDialogElement>();
	let expanded = $state<string | null>(null);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			expanded = activeSectionId;
			dialog.showModal();
		}
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	class="drawer"
	aria-label={t('app.menu')}
	{onclose}
	onclick={(event) => {
		// A click on the backdrop lands on the <dialog> element itself.
		if (event.target === dialog) onclose();
	}}
>
	<div class="drawer__panel">
		<div class="drawer__head">
			<span>{t('app.menu')}</span>
			<IconButton icon="close" label={t('app.close')} onclick={onclose} />
		</div>
		<nav aria-label={t('app.menu')}>
			{#each sections as section (section.id)}
				<div class="section" class:is-open={expanded === section.id}>
					{#if section.rows.length === 0}
						<a class="lead" href={section.href} onclick={onclose}>
							<Icon name={section.icon} /><span>{section.label}</span>
						</a>
					{:else}
						<button
							type="button"
							class="lead"
							aria-expanded={expanded === section.id}
							onclick={() => (expanded = expanded === section.id ? null : section.id)}
						>
							<Icon name={section.icon} /><span>{section.label}</span>
							<span class="lead__chevron"><Icon name="caret" /></span>
						</button>
						{#if expanded === section.id}
							<div class="items">
								{#each section.rows as row (row.key)}
									{#if row.type === 'group'}
										<p class="group">{row.label}</p>
									{:else if row.type === 'item'}
										<a
											class="item"
											class:is-active={row.active}
											href={row.href}
											aria-current={row.active ? 'page' : undefined}
											onclick={onclose}
										>
											<Icon name={row.icon} /><span>{row.label}</span>
										</a>
									{/if}
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{/each}
		</nav>
		<div class="drawer__foot">
			<span>{t('app.language')}</span>
			<LanguageSwitch />
		</div>
	</div>
</dialog>

<style>
	.drawer {
		width: 100%;
		max-width: none;
		height: 100%;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
	}

	.drawer::backdrop {
		background: var(--scrim);
	}

	.drawer__panel {
		width: min(310px, 86vw);
		height: 100%;
		overflow-y: auto;
		padding-bottom: 24px;
		border-inline-end: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-primary);
		box-shadow: var(--shadow-lg);
		animation: drawer-in 190ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
	}

	.drawer__head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--header-h);
		padding-block: 0;
		padding-inline: 16px 10px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
	}

	.lead {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 13px 16px;
		border: 0;
		border-bottom: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--text-primary);
		font-size: var(--fs-control);
		font-weight: var(--fw-semibold);
		text-align: start;
		--icon-size: var(--icon-md);
	}

	.lead__chevron {
		display: inline-flex;
		margin-inline-start: auto;
		transition: transform 160ms ease;
		--icon-size: var(--icon-sm);
	}

	.is-open .lead__chevron {
		transform: rotate(180deg);
	}

	.items {
		padding: 6px 0 10px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
	}

	.group {
		margin: 0;
		padding: 9px 16px 4px;
		color: var(--text-muted);
		font-size: var(--fs-overline);
		font-weight: var(--fw-bold);
		letter-spacing: 0.06em;
	}

	/* Finger-sized rows: never below 44px. */
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding-block: 10px;
		padding-inline: 30px 16px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		--icon-size: var(--icon-md);
	}

	.item > span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.item:active {
		background: var(--bg-press);
		filter: brightness(0.93);
	}

	.item.is-active {
		background: var(--bg-hover);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.drawer__foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 18px;
		padding: 14px 16px 0;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	@keyframes drawer-in {
		from {
			transform: translateX(calc(-100% * var(--dir)));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.drawer__panel {
			animation: none;
		}
		.lead__chevron {
			transition: none;
		}
	}
</style>

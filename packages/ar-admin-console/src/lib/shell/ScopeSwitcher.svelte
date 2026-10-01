<script lang="ts" module>
	import type { ScopeKind } from './nav-types';

	export interface ScopeOption {
		id: string;
		kind: ScopeKind;
		name: string;
		mark: string;
	}
</script>

<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Popover from '$lib/ui/patterns/Popover.svelte';

	/**
	 * "What am I operating on" — the only place the scope is chosen. Options come from the
	 * administrator's role assignments, so an administrator with a single scope sees no menu.
	 */

	interface Props {
		options: readonly ScopeOption[];
		currentId: string;
		onselect: (option: ScopeOption) => void;
	}

	let { options, currentId, onselect }: Props = $props();

	const current = $derived(options.find((o) => o.id === currentId) ?? options[0]);
	const single = $derived(options.length < 2);
	const metaKey = (kind: ScopeKind) =>
		kind === 'platform' ? 'scope.meta.platform' : 'scope.meta.tenant';
	const hintKey = (kind: ScopeKind) =>
		kind === 'platform' ? 'scope.hint.platform' : 'scope.hint.tenant';
</script>

{#snippet face(option: ScopeOption)}
	<span class="switcher__mark switcher__mark--{option.kind}" aria-hidden="true">{option.mark}</span>
	<span class="switcher__body">
		<span class="switcher__name">{option.name}</span>
		<span class="switcher__meta">{t(metaKey(option.kind))}</span>
	</span>
{/snippet}

{#if current}
	{#if single}
		<div class="switcher switcher--static">{@render face(current)}</div>
	{:else}
		<Popover label={t('scope.switch.title')}>
			{#snippet trigger()}
				<span class="switcher">
					{@render face(current)}
					<span class="switcher__caret"><Icon name="caret" /></span>
				</span>
			{/snippet}
			{#snippet children({ close })}
				<p class="menu-label">{t('scope.switch.title')}</p>
				<ul class="options">
					{#each options as option, index (option.id)}
						{#if index > 0 && options[index - 1].kind !== option.kind}
							<li class="sep" role="presentation"></li>
						{/if}
						<li>
							<button
								type="button"
								class="option"
								class:is-current={option.id === current.id}
								aria-current={option.id === current.id ? 'true' : undefined}
								onclick={() => {
									close();
									if (option.id !== current.id) onselect(option);
								}}
							>
								<span class="switcher__mark switcher__mark--{option.kind}" aria-hidden="true"
									>{option.mark}</span
								>
								<span class="option__body">
									<span class="option__name">{option.name}</span>
									<span class="option__hint">{t(hintKey(option.kind))}</span>
								</span>
								{#if option.id === current.id}
									<span class="option__check"><Icon name="check" /></span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/snippet}
		</Popover>
	{/if}
{/if}

<style>
	.switcher {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 230px;
		padding: 5px 9px 5px 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.switcher:hover {
		background: var(--bg-subtle);
	}

	.switcher--static:hover {
		background: var(--bg-card);
	}

	.switcher__mark {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: min(5px, var(--radius-control));
		background: var(--accent-tenant);
		color: var(--on-accent);
		font-size: var(--fs-small);
		font-weight: var(--fw-bold);
	}

	.switcher__mark--platform {
		background: var(--accent-platform);
	}

	.switcher__body {
		display: flex;
		min-width: 0;
		flex-direction: column;
		line-height: var(--lh-tight);
		text-align: start;
	}

	.switcher__name {
		overflow: hidden;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.switcher__meta {
		font-size: var(--fs-overline);
		color: var(--text-muted);
	}

	.switcher__caret {
		display: inline-flex;
		margin-inline-start: auto;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.menu-label {
		margin: 0;
		padding: 6px 8px 7px;
		font-size: var(--fs-overline);
		font-weight: var(--fw-bold);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.options {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sep {
		height: 1px;
		margin: 5px 8px;
		background: var(--border-subtle);
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		width: 100%;
		padding: 8px;
		border: 0;
		border-radius: var(--radius-control);
		background: none;
		text-align: start;
	}

	.option:hover {
		background: var(--bg-hover);
	}

	.option.is-current {
		background: var(--bg-subtle);
	}

	.option .switcher__mark {
		width: 24px;
		height: 24px;
	}

	.option__body {
		min-width: 0;
	}

	.option__name {
		display: block;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.option__hint {
		display: block;
		margin-top: 2px;
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
		color: var(--text-muted);
	}

	.option__check {
		display: inline-flex;
		margin-inline-start: auto;
		color: var(--primary);
		--icon-size: var(--icon-md);
	}

	@media (max-width: 640px) {
		.switcher {
			max-width: 132px;
		}
		.switcher__meta {
			display: none;
		}
	}
</style>

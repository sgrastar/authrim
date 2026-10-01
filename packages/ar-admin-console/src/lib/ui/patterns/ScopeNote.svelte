<script lang="ts">
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	/**
	 * States what an item does at the current scope. Shown at the top of the page body in
	 * platform scope, one variant per treatment:
	 *   inherit  — values set here become every tenant's default
	 *   lookup   — cross-tenant search, not a setting
	 *   tenant   — cannot be set here; switch to a tenant
	 *   template — shares a definition; tenant-specific values stay in each tenant
	 */
	interface Props {
		kind: 'inherit' | 'lookup' | 'tenant' | 'template';
		title: string;
		body: string;
		pill: string;
	}

	let { kind, title, body, pill }: Props = $props();

	const ICONS: Record<Props['kind'], IconName> = {
		inherit: 'shield',
		lookup: 'search',
		tenant: 'lock',
		template: 'file'
	};
</script>

<div class="scope-note scope-note--{kind}" role="note">
	<span class="scope-note__icon"><Icon name={ICONS[kind]} /></span>
	<div class="scope-note__text">
		<p class="scope-note__title">{title}</p>
		<p class="scope-note__body">{body}</p>
	</div>
	<span class="scope-note__pill">{pill}</span>
</div>

<style>
	.scope-note {
		--note-accent: var(--accent-platform);
		--note-ink: var(--platform-text);
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 10px 12px;
		padding: var(--note-pad-y) var(--note-pad-x);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
	}

	.scope-note--lookup {
		--note-accent: var(--info);
		--note-ink: var(--info);
	}

	.scope-note--tenant {
		--note-accent: var(--border-strong);
		--note-ink: var(--text-secondary);
		background: var(--bg-subtle);
	}

	.scope-note--template {
		--note-accent: var(--accent-client);
		--note-ink: var(--text-secondary);
	}

	.scope-note__icon {
		margin-top: 1px;
		color: var(--note-accent);
		--icon-size: var(--icon-lg);
	}

	.scope-note__text {
		min-width: 0;
		flex: 1 1 280px;
	}

	.scope-note__title {
		margin: 0;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.scope-note__body {
		margin: 4px 0 0;
		font-size: var(--fs-label);
		line-height: var(--lh-relaxed);
		color: var(--text-secondary);
	}

	.scope-note__pill {
		align-self: center;
		padding: 3px 10px;
		border: 1px solid var(--note-accent);
		border-radius: var(--radius-badge);
		color: var(--note-ink);
		font-size: var(--fs-small);
		font-weight: var(--fw-bold);
		white-space: nowrap;
	}
</style>

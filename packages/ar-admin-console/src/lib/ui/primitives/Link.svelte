<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';

	/**
	 * Text link. Same-tab links navigate inside the console; `newTab` opens elsewhere, adds the
	 * external mark (mirrored in RTL), `rel="noopener noreferrer"`, and tells screen readers it
	 * opens a new tab. Use `standalone` for a link on its own line ("View audit log →").
	 * Inside a busy scope it stops navigating (no href) and reads as unavailable.
	 */
	interface Props {
		href: string;
		newTab?: boolean;
		standalone?: boolean;
		/** Subdued colour for links inside secondary text. */
		quiet?: boolean;
		children: Snippet;
	}

	let { href, newTab = false, standalone = false, quiet = false, children }: Props = $props();

	const busy = useBusy();
</script>

<a
	class="link"
	class:link--standalone={standalone}
	class:link--quiet={quiet}
	class:is-busy={busy()}
	href={busy() ? undefined : href}
	role={busy() ? 'link' : undefined}
	aria-disabled={busy() || undefined}
	target={newTab ? '_blank' : undefined}
	rel={newTab ? 'noopener noreferrer' : undefined}
>
	{@render children()}
	{#if newTab}
		<Icon name="external" /><span class="sr-only">{t('link.newTab')}</span>
	{:else if standalone}
		<Icon name="caretRight" />
	{/if}
</a>

<style>
	.link {
		display: inline;
		color: var(--info);
		font-weight: var(--fw-name);
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
		--icon-size: 0.85em;
	}

	.link :global(svg) {
		margin-inline-start: 0.2em;
		vertical-align: -0.08em;
	}

	.link:hover {
		text-decoration-color: currentColor;
	}

	.link.is-busy {
		opacity: 0.55;
		cursor: progress;
	}

	.link--quiet {
		color: inherit;
		font-weight: inherit;
	}

	.link--standalone {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: var(--fs-body);
		text-decoration: none;
	}

	.link--standalone:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>

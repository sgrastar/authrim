<script lang="ts" module>
	export interface CertificateItem {
		/** The certificate's fingerprint, shown in a monospace line. */
		fingerprint: string;
		subject: string;
		/** The last day it is valid, as a date (YYYY-MM-DD). */
		notAfter: string;
		/** Days until it expires; below zero it has expired. */
		daysLeft: number;
		/** In use now, or published for the next rollover. */
		use: 'active' | 'next';
	}
</script>

<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '../primitives/Badge.svelte';
	import Button from '../primitives/Button.svelte';
	import EmptyState from './EmptyState.svelte';

	/**
	 * The certificates of a partner (a SAML provider's signing certificates), one under another:
	 * which is in use and which is next, when each expires, and a warning tone when that is close.
	 * A rollover is two entries: the active one and the next one, so the switch can be planned.
	 */
	interface Props {
		label: string;
		items: CertificateItem[];
		/** Days before the end at which the expiry turns into a warning (default 30). */
		warnDays?: number;
		/** Remove one; with it, each entry has a remove button. */
		onremove?: (index: number) => void;
		/** Make the next one the active one; offered on the next entry. */
		onpromote?: (index: number) => void;
	}

	let { label, items, warnDays = 30, onremove, onpromote }: Props = $props();

	function tone(days: number): 'danger' | 'warning' | 'success' {
		return days < 0 ? 'danger' : days <= warnDays ? 'warning' : 'success';
	}
	function expiry(days: number): string {
		return days < 0 ? t('cert.expired') : t('cert.daysLeft', { days });
	}
</script>

{#if items.length === 0}
	<EmptyState title={t('cert.none')} />
{:else}
	<ul class="certs" aria-label={label}>
		{#each items as item, index (item.fingerprint)}
			<li class="cert">
				<div class="cert__head">
					<Badge tone={item.use === 'active' ? 'info' : 'neutral'}
						>{t(item.use === 'active' ? 'cert.active' : 'cert.next')}</Badge
					>
					<Badge tone={tone(item.daysLeft)} dot>{expiry(item.daysLeft)}</Badge>
				</div>
				<code class="cert__print">{item.fingerprint}</code>
				<span class="cert__meta">{item.subject} · {t('cert.until', { date: item.notAfter })}</span>
				{#if onremove || (onpromote && item.use === 'next')}
					<div class="cert__actions">
						{#if onpromote && item.use === 'next'}
							<Button size="sm" onclick={() => onpromote(index)}>{t('cert.promote')}</Button>
						{/if}
						{#if onremove}
							<Button size="sm" variant="ghost" onclick={() => onremove(index)}
								>{t('cert.remove')}</Button
							>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.certs {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.cert {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
	}

	.cert__head,
	.cert__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
		align-items: center;
	}

	.cert__print {
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-label);
		overflow-wrap: anywhere;
	}

	.cert__meta {
		color: var(--text-secondary);
		font-size: var(--fs-label);
	}
</style>

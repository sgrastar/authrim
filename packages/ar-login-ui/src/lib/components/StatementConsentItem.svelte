<script lang="ts">
	/**
	 * One consent statement on the consent step (statement-display.ts): a text kept in Authrim is
	 * its statement page in a scrolling frame, with a link to open the page; an external document is
	 * a link to it. Then "I agree to <title>" (or nothing to answer, when it is only shown).
	 */
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import SanitizedHtml from './SanitizedHtml.svelte';
	import { sanitizeRuntimeConsentHtml } from '#lib/consent/runtime-consent-html.js';
	import {
		statementPresentation,
		type StatementDisplaySource
	} from '#lib/consent/statement-display.js';

	type Props = {
		item: StatementDisplaySource & { statement_id: string; description: string };
		/** Whether the person answers it (a checkbox); false: shown only. */
		asks: boolean;
		checked?: boolean;
		required?: boolean;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	};

	let {
		item,
		asks,
		checked = false,
		required = false,
		disabled = false,
		onchange
	}: Props = $props();

	// In the language the screen is drawn in ($LL follows the locale).
	const presentation = $derived.by(() => {
		void $LL;
		return statementPresentation(item, getLocale());
	});
</script>

<div class="statement-consent" data-display={presentation.kind}>
	{#if presentation.kind !== 'external' || !asks}
		<p class="statement-consent-title">{item.title}</p>
	{/if}
	{#if item.description}
		<SanitizedHtml
			tag="div"
			class="statement-consent-description"
			sanitizedHtml={sanitizeRuntimeConsentHtml(item.description)}
		/>
	{/if}
	{#if presentation.kind === 'embedded'}
		<!-- The statement page's text, on this origin; its links open outside the frame. -->
		<iframe
			class="statement-consent-frame"
			src={presentation.src}
			title={item.title}
			loading="lazy"
			referrerpolicy="same-origin"
			sandbox="allow-popups allow-popups-to-escape-sandbox"
		></iframe>
		<a class="statement-consent-link" href={presentation.pageHref} target="_blank" rel="noopener">
			{$LL.consent_statement_read({ title: item.title })}
			<span class="sr-only">{$LL.consent_statement_newTab()}</span>
		</a>
	{:else if presentation.kind === 'inline'}
		<SanitizedHtml
			tag="div"
			class="statement-consent-text"
			sanitizedHtml={sanitizeRuntimeConsentHtml(presentation.content)}
		/>
	{:else if presentation.kind === 'external'}
		<a
			class="statement-consent-link"
			href={presentation.href}
			target="_blank"
			rel="noopener noreferrer"
		>
			{$LL.consent_statement_read({ title: item.title })}
			<span class="sr-only">{$LL.consent_statement_newTab()}</span>
		</a>
	{/if}
	{#if asks}
		<label class="statement-consent-choice">
			<input
				type="checkbox"
				{checked}
				{required}
				{disabled}
				onchange={(event) => onchange?.((event.currentTarget as HTMLInputElement).checked)}
			/>
			<span>{$LL.consent_statement_agree({ title: item.title })}</span>
		</label>
	{/if}
</div>

<style>
	.statement-consent {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}

	.statement-consent-title {
		margin: 0;
		color: var(--text-primary);
		font-weight: 600;
		font-size: var(--auth-copy-size, 0.9rem);
	}

	.statement-consent :global(.statement-consent-description) {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--auth-copy-size, 0.9rem);
		line-height: 1.5;
	}

	.statement-consent-frame {
		display: block;
		width: 100%;
		height: 12rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 0.5rem);
	}

	.statement-consent :global(.statement-consent-text) {
		max-height: 12rem;
		overflow-y: auto;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 0.5rem);
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.statement-consent-link {
		color: var(--accent-color, var(--primary));
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}

	.statement-consent-link {
		justify-self: start;
		font-size: 0.85rem;
	}

	.statement-consent-choice {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		color: var(--text-primary);
		font-weight: 500;
		line-height: 1.45;
	}

	.statement-consent-choice input {
		margin-top: 0.1875rem;
		flex: 0 0 auto;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>

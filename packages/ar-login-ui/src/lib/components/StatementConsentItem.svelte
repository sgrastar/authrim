<script lang="ts">
	/**
	 * One consent statement on the consent step (statement-display.ts): a text kept in Authrim is
	 * its statement page in a scrolling frame, with a link to open the page. An external document is
	 * linked from its description (HTML) only, as the admin writes it: no link is added for it,
	 * except for a choice of options drawn here (`linkDocument`), whose description is not its
	 * text. Then
	 * "I agree to <title>" (or nothing to answer, when it is only shown).
	 *
	 * A statement with a text of its own may be drawn by the widget in one of two ways
	 * (`display`), each with an option to make the text be scrolled to its end first
	 * (`requireScroll`). Both draw the text as sanitized HTML, never as a script-running frame, so
	 * the scroll can be seen from here:
	 *
	 * - `inline`: the text in a scrolling box in place, the checkbox below it. With `requireScroll`
	 *   the box cannot be ticked until the end of the text has been reached.
	 * - `modal`: a button opens the text in a dialog; its agree button (enabled at the end of the
	 *   text, with `requireScroll`) ticks the box and closes it. The box itself does not tick
	 *   without the dialog, so the text is always put in front of the person first; it can be
	 *   unticked directly.
	 *
	 * A link to an external document and a statement with no text have nothing to scroll or open:
	 * they are drawn as before, whatever the widget says. The scroll requirement is the UI's: the
	 * server records the answer, not whether the text was read.
	 */
	import { tick } from 'svelte';
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
		/** Add a link to an external document (a choice of options shown as a checkbox here). */
		linkDocument?: boolean;
		/** How a text kept in Authrim is shown: in place (the default) or in a dialog. */
		display?: 'inline' | 'modal';
		/** The box can be ticked only once the text has been scrolled to its end. */
		requireScroll?: boolean;
	};

	let {
		item,
		asks,
		checked = false,
		required = false,
		disabled = false,
		onchange,
		linkDocument = false,
		display = 'inline',
		requireScroll = false
	}: Props = $props();

	// In the language the screen is drawn in ($LL follows the locale).
	const presentation = $derived.by(() => {
		void $LL;
		return statementPresentation(item, getLocale());
	});

	/** The text, when this statement has one to scroll through or open. */
	const text = $derived(
		presentation.kind === 'embedded' || presentation.kind === 'inline' ? item.inline_content : null
	);
	const asModal = $derived(display === 'modal' && Boolean(text));
	/** Drawn as a scroll box (not the statement page's frame) so its end can be told. */
	const inScrollBox = $derived(!asModal && requireScroll && Boolean(text));
	const sanitizedText = $derived(text ? sanitizeRuntimeConsentHtml(text) : '');

	let reachedEnd = $state(false);
	let box = $state<HTMLElement | null>(null);
	let dialog = $state<HTMLDialogElement | null>(null);
	let modalBody = $state<HTMLElement | null>(null);

	/** The end of the text is in view (a text that fits has no more to scroll to). */
	function endReached(element: HTMLElement): boolean {
		return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
	}

	function measure(element: HTMLElement | null) {
		if (element && endReached(element)) reachedEnd = true;
	}

	$effect(() => {
		// Redrawn text starts unread.
		void sanitizedText;
		reachedEnd = false;
		if (!box) return;
		const frame = requestAnimationFrame(() => measure(box));
		return () => cancelAnimationFrame(frame);
	});

	// A rotated screen or a wider window can make the whole text fit: no scroll event follows.
	function watchSize(element: HTMLElement | null) {
		if (!element || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => measure(element));
		observer.observe(element);
		return () => observer.disconnect();
	}
	$effect(() => watchSize(box));
	$effect(() => watchSize(modalBody));

	async function openDialog() {
		if (!dialog || disabled) return;
		dialog.showModal();
		await tick();
		measure(modalBody);
	}

	function agree() {
		dialog?.close();
		onchange?.(true);
	}

	/** Ticking opens the text first (a dialog) or waits for its end (a box). */
	const gated = $derived(asModal ? !checked : inScrollBox ? !reachedEnd && !checked : false);

	function onBoxClick(event: MouseEvent) {
		if (asModal && !checked) {
			event.preventDefault();
			void openDialog();
		}
	}
</script>

<div class="statement-consent" data-display={asModal ? 'modal' : presentation.kind}>
	<p class="statement-consent-title">{item.title}</p>
	{#if item.description}
		<SanitizedHtml
			tag="div"
			class="statement-consent-description"
			sanitizedHtml={sanitizeRuntimeConsentHtml(item.description)}
		/>
	{/if}
	{#if asModal}
		<button
			type="button"
			class="statement-consent-open"
			{disabled}
			aria-label={$LL.consent_statement_openLabel({ title: item.title })}
			onclick={openDialog}
		>
			{$LL.consent_statement_open()}
		</button>
	{:else if inScrollBox}
		<!-- A region the keyboard can scroll; the end of the text is what unlocks the box below. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="statement-consent-text"
			role="region"
			aria-label={item.title}
			tabindex="0"
			bind:this={box}
			onscroll={() => measure(box)}
		>
			<SanitizedHtml tag="div" sanitizedHtml={sanitizedText} />
		</div>
	{:else if presentation.kind === 'embedded'}
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
	{:else if presentation.kind === 'external' && linkDocument}
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
				disabled={disabled || (inScrollBox && gated)}
				onclick={onBoxClick}
				onchange={(event) => onchange?.((event.currentTarget as HTMLInputElement).checked)}
			/>
			<span>{$LL.consent_statement_agree({ title: item.title })}</span>
		</label>
		{#if inScrollBox && gated}
			<p class="statement-consent-hint">{$LL.consent_statement_scrollHint()}</p>
		{/if}
	{/if}
</div>

{#if asModal}
	<dialog
		class="statement-consent-dialog"
		bind:this={dialog}
		aria-labelledby={`statement-dialog-${item.statement_id}`}
	>
		<h2 id={`statement-dialog-${item.statement_id}`} class="statement-consent-dialog-title">
			{item.title}
		</h2>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="statement-consent-dialog-body"
			role="region"
			aria-label={item.title}
			tabindex="0"
			bind:this={modalBody}
			onscroll={() => measure(modalBody)}
		>
			<SanitizedHtml tag="div" sanitizedHtml={sanitizedText} />
		</div>
		<div class="statement-consent-dialog-footer">
			{#if requireScroll && !reachedEnd}
				<p class="statement-consent-hint">{$LL.consent_statement_scrollHint()}</p>
			{/if}
			{#if asks}
				<button
					type="button"
					class="statement-consent-agree"
					disabled={disabled || (requireScroll && !reachedEnd)}
					onclick={agree}
				>
					{$LL.consent_statement_agreeButton()}
				</button>
			{/if}
			<button type="button" class="statement-consent-close" onclick={() => dialog?.close()}>
				{$LL.consent_statement_close()}
			</button>
		</div>
	</dialog>
{/if}

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

	.statement-consent :global(.statement-consent-text),
	.statement-consent-text {
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

	.statement-consent-hint {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.statement-consent-open,
	.statement-consent-agree,
	.statement-consent-close {
		min-height: 2.5rem;
		padding: 0 1rem;
		border: 1px solid var(--button-secondary-border, var(--border));
		border-radius: var(--button-radius, var(--radius-md, 0.5rem));
		background: var(--button-secondary-bg, var(--bg-glass, transparent));
		color: var(--button-secondary-text, var(--text-primary));
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.statement-consent-open {
		justify-self: start;
	}

	.statement-consent-agree {
		border: 0;
		background: var(--button-primary-bg, var(--gradient-primary));
		color: var(--button-primary-text, white);
	}

	.statement-consent-open:disabled,
	.statement-consent-agree:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.statement-consent-dialog {
		display: none;
		width: min(32rem, calc(100vw - 2rem));
		max-height: min(40rem, calc(100vh - 2rem));
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg, 0.75rem);
		background: var(--bg-card, white);
		color: var(--text-primary);
	}

	.statement-consent-dialog[open] {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
	}

	.statement-consent-dialog::backdrop {
		background: rgb(0 0 0 / 0.5);
	}

	.statement-consent-dialog-title {
		margin: 0;
		padding: 1rem 1.25rem 0.75rem;
		border-bottom: 1px solid var(--border);
		font-size: 1rem;
		text-align: center;
	}

	.statement-consent-dialog-body {
		overflow-y: auto;
		padding: 1rem 1.25rem;
		font-size: 0.875rem;
		line-height: 1.7;
		overflow-wrap: anywhere;
	}

	.statement-consent-dialog-footer {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem 1rem;
		border-top: 1px solid var(--border);
		text-align: center;
	}

	.statement-consent-dialog-footer .statement-consent-close {
		border-color: transparent;
		background: transparent;
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

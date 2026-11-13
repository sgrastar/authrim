<script lang="ts">
	/**
	 * The public statement page (`/statements/<slug>`): one consent statement's text, the version
	 * shown, and the other published versions. Drawn from the page's state; the route reads it.
	 */
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { Alert, Card, SanitizedHtml, Skeleton } from '#lib/components/index.js';
	import AuthPageShell from '#lib/components/AuthPageShell.svelte';
	import { sanitizeRuntimeConsentHtml } from '#lib/consent/runtime-consent-html.js';
	import { formatStatementVersion, statementPageHref } from '#lib/consent/statement-display.js';
	import type { StatementPageResult } from '#lib/api/statement-page.js';
	import { useLoginUIStores } from '#lib/stores/login-ui-context.js';

	type Props = {
		/** null while it is read. */
		result: StatementPageResult | null;
	};

	let { result }: Props = $props();
	const { brandingStore } = useLoginUIStores();

	const statement = $derived(result?.ok ? result.statement : null);
	const pageTitle = $derived(
		statement?.title ??
			(result && !result.ok && result.reason === 'not_found'
				? $LL.statement_pageNotFound()
				: $LL.app_title())
	);
	const versionLabel = (version: string) =>
		$LL.statement_pageVersion({ date: formatStatementVersion(version, getLocale()) });
</script>

<svelte:head>
	<title>{pageTitle} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell wide>
	<Card>
		{#if result === null}
			<div aria-busy="true" class="space-y-3">
				<Skeleton class="h-7 w-1/2" />
				<Skeleton class="h-4 w-1/3" />
				<Skeleton class="h-40 w-full" />
			</div>
		{:else if !result.ok}
			<h1 class="auth-section-title">
				{result.reason === 'not_found' ? $LL.statement_pageNotFound() : $LL.error_title()}
			</h1>
			{#if result.reason === 'unavailable'}
				<Alert variant="error">{$LL.statement_pageUnavailable()}</Alert>
			{/if}
		{:else if statement}
			<article class="statement-page" lang={statement.language}>
				<h1 class="auth-section-title">{statement.title}</h1>
				<p class="statement-page-version">
					{versionLabel(statement.version.version)}
					{#if statement.version.isCurrent}
						<span class="statement-page-badge">{$LL.statement_pageCurrent()}</span>
					{/if}
				</p>
				{#if !statement.version.isCurrent}
					<p class="statement-page-older">
						{$LL.statement_pageOlder()}
						<a href={statementPageHref(statement.slug)}>{$LL.statement_pageShowCurrent()}</a>
					</p>
				{/if}
				{#if statement.description}
					<p class="statement-page-description">{statement.description}</p>
				{/if}
				{#if statement.inlineContent}
					<SanitizedHtml
						tag="div"
						class="statement-page-body"
						sanitizedHtml={sanitizeRuntimeConsentHtml(statement.inlineContent)}
					/>
				{:else if statement.documentUrl}
					<p class="statement-page-description">{$LL.statement_pageExternal()}</p>
					<a
						class="statement-page-external"
						href={statement.documentUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						{$LL.consent_item_view_document()}
						<span class="sr-only">{$LL.consent_statement_newTab()}</span>
					</a>
				{/if}
				{#if statement.versions.length > 1}
					<nav class="statement-page-versions" aria-labelledby="statement-page-versions-title">
						<h2 id="statement-page-versions-title">{$LL.statement_pageVersions()}</h2>
						<ul>
							{#each statement.versions as version (version.version)}
								<li>
									{#if version.version === statement.version.version}
										<span aria-current="page">{versionLabel(version.version)}</span>
									{:else}
										<a
											href={statementPageHref(
												statement.slug,
												version.isCurrent ? null : version.version
											)}>{versionLabel(version.version)}</a
										>
									{/if}
									{#if version.isCurrent}
										<span class="statement-page-badge">{$LL.statement_pageCurrent()}</span>
									{/if}
								</li>
							{/each}
						</ul>
					</nav>
				{/if}
			</article>
		{/if}
	</Card>
</AuthPageShell>

<style>
	.statement-page {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}

	.statement-page h1 {
		margin: 0;
	}

	.statement-page-version {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.statement-page-badge {
		padding: 0.0625rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-primary);
		font-size: 0.75rem;
	}

	.statement-page-description {
		margin: 0;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.statement-page :global(.statement-page-body) {
		color: var(--text-primary);
		line-height: 1.75;
		overflow-wrap: anywhere;
	}

	.statement-page :global(.statement-page-body p) {
		margin: 0 0 1em;
	}

	.statement-page :global(.statement-page-body a),
	.statement-page-external,
	.statement-page-versions a,
	.statement-page-older a {
		color: var(--accent-color, var(--primary));
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.statement-page-external {
		justify-self: start;
	}

	.statement-page-older {
		margin: 0;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 0.5rem);
		background: var(--bg-subtle, transparent);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.statement-page-versions {
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}

	.statement-page-versions h2 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	.statement-page-versions ul {
		display: grid;
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.875rem;
	}

	.statement-page-versions li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
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

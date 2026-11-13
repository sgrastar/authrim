<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import LiteRelay from '#lib/lite/LiteRelay.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** A form's action: the page's own query, then SvelteKit's action key. */
	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}

	const formError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);
</script>

{#if data.page === 'relay'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<LiteRelay target={data.relay} continueLabel={data.continueLabel} />
	</LiteShell>
{:else if data.page === 'error'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.title}</h1>
		<p>{data.message}</p>
		<p><a href="/login">{data.back}</a></p>
	</LiteShell>
{:else}
	{@const consent = data.consent}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.title}</h1>
		<p>{data.text.subtitle}</p>
		{#if consent.clientTrusted}<p class="muted">{data.text.trusted}</p>{/if}
		{#if consent.clientUri}<p><a href={consent.clientUri}>{consent.clientUri}</a></p>{/if}
		{#if formError === 'blocked'}
			<p role="alert">{data.text.blocked}</p>
		{:else if formError === 'expired'}
			<p role="alert">{data.text.expired}</p>
		{:else if formError}
			<p role="alert">{data.text.retry}</p>
		{/if}
		<form method="post" action={actionOf(data.search, 'allow')}>
			<input type="hidden" name="txn" value={data.txnId} />
			<input type="hidden" name="csrf" value={data.csrfToken} />
			<input type="hidden" name="op" value={data.op} />
			{#if consent.requiredItems.length > 0}
				<h2>{data.text.requiredTitle}</h2>
				{#each consent.requiredItems as item (item.statementId)}
					{#if item.checkboxMode === 'none'}
						<p><strong>{item.title}</strong></p>
					{:else}
						<label class="check">
							<input
								type="checkbox"
								name={`item:${item.statementId}`}
								value="granted"
								checked={item.defaultChecked}
								required={item.blocks}
							/>
							{item.title}
						</label>
					{/if}
					{#if item.description}<p class="muted">{item.description}</p>{/if}
					{#if item.processingPurpose}
						<p class="muted">{data.text.processingPurpose}: {item.processingPurpose}</p>
					{/if}
					{#if item.withdrawalImpact}
						<p class="muted">{data.text.withdrawalImpact}: {item.withdrawalImpact}</p>
					{/if}
					{#if item.documentUrl}<p><a href={item.documentUrl}>{data.text.viewDocument}</a></p>{/if}
				{/each}
			{/if}
			{#if consent.optionalItems.length > 0}
				<h2>{data.text.optionalTitle}</h2>
				{#each consent.optionalItems as item (item.statementId)}
					{#if item.checkboxMode === 'none'}
						<p><strong>{item.title}</strong></p>
					{:else}
						<label class="check">
							<input
								type="checkbox"
								name={`item:${item.statementId}`}
								value="granted"
								checked={item.defaultChecked}
							/>
							{item.title}
						</label>
					{/if}
					{#if item.description}<p class="muted">{item.description}</p>{/if}
					{#if item.processingPurpose}
						<p class="muted">{data.text.processingPurpose}: {item.processingPurpose}</p>
					{/if}
					{#if item.withdrawalImpact}
						<p class="muted">{data.text.withdrawalImpact}: {item.withdrawalImpact}</p>
					{/if}
					{#if item.documentUrl}<p><a href={item.documentUrl}>{data.text.viewDocument}</a></p>{/if}
				{/each}
			{/if}
			{#if consent.release}
				<fieldset data-testid="information-release">
					<legend>{data.text.releaseTitle}</legend>
					<p class="muted">{data.text.releaseHint}</p>
					{#each consent.release.required as item (item.name)}
						<p data-required="true">
							<strong>{item.label}</strong>
							<span class="muted">({data.text.requiredBadge})</span>
							{#if item.valueText}<br /><span class="muted">{item.valueText}</span>{/if}
						</p>
					{/each}
					{#each consent.release.optional as item (item.name)}
						<label class="check">
							<input
								type="checkbox"
								name={`release:${item.name}`}
								value="granted"
								checked={item.defaultChecked}
							/>
							<span>
								{item.label}
								<span class="muted">({data.text.optionalBadge})</span>
								{#if item.valueText}<br /><span class="muted">{item.valueText}</span>{/if}
							</span>
						</label>
					{/each}
					{#if consent.release.purpose}
						{@const purpose = consent.release.purpose}
						<p class="muted">{data.text.releasePurpose}: {purpose.title}</p>
						{#if purpose.description}<p class="muted">{purpose.description}</p>{/if}
						{#if purpose.inlineContent}<p class="muted" style="white-space: pre-wrap;">
								{purpose.inlineContent}
							</p>{/if}
						{#if purpose.documentUrl}<p>
								<a href={purpose.documentUrl}>{data.text.viewDocument}</a>
							</p>{/if}
					{/if}
				</fieldset>
			{/if}
			{#if consent.scopes.length > 0}
				<h2>{data.text.scopesTitle}</h2>
				<ul>
					{#each consent.scopes as scope, index (`${scope}:${index}`)}
						<li>{scope}</li>
					{/each}
				</ul>
			{/if}
			{#if consent.organizations.length <= 1 && consent.targetOrg}
				<p>{data.text.currentOrganization}: {consent.targetOrg.name}</p>
			{/if}
			{#if consent.organizations.length > 1}
				<label>
					{data.text.organization}
					<select name="org">
						{#each consent.organizations as org (org.id)}
							<option value={org.id} selected={org.id === consent.defaultOrgId}>{org.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if consent.actingAs}<p>{data.text.actingAs}</p>{/if}
			<p class="muted">{data.text.userInfo} <strong>{consent.userEmail}</strong></p>
			{#if consent.policyUri || consent.tosUri}
				<p class="muted">
					{#if consent.policyUri}<a href={consent.policyUri}>{data.text.privacyPolicy}</a>{/if}
					{#if consent.tosUri}<a href={consent.tosUri}>{data.text.termsOfService}</a>{/if}
				</p>
			{/if}
			<button type="submit">{data.text.allow}</button>
			<button type="submit" formnovalidate formaction={actionOf(data.search, 'deny')}
				>{data.text.deny}</button
			>
		</form>
	</LiteShell>
{/if}

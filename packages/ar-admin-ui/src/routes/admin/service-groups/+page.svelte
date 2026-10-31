<script lang="ts">
	import { onMount } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		serviceGroupsRequest as request,
		type ServiceGroupCatalog,
		type ServiceGroup,
		type Expression,
		type GroupSnapshot
	} from '$lib/api/service-groups';
	import { groupText, groupFieldLabel } from '$lib/admin/service-groups-i18n';
	import ConditionEditor from '$lib/components/admin/service-groups/ConditionEditor.svelte';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	let text = $derived.by(() => {
		const marker = $LL.dialog_cancel();
		return marker && getLocale() === 'ja' ? groupText.ja : groupText.en;
	});
	let catalog = $state<ServiceGroupCatalog>({
		revision: 0,
		groups: [],
		fields: {},
		dependencies: {},
		scans: []
	});
	let search = $state('');
	let notice = $state('');
	let membersLoaded = $state(false);
	let selected = $state<string | null>(null);
	let key = $state('');
	let name = $state('');
	let description = $state('');
	let enabled = $state(true);
	let scimRoleId = $state('');
	let condition = $state<Expression>({
		op: 'attribute',
		field: 'country',
		compare: 'eq',
		value: 'JP'
	});
	let hasRule = $state(true);
	let subject = $state('');
	let output = $state<
		| (Partial<GroupSnapshot> & {
				valid?: boolean;
				unsettledWrites?: { id: string; operation: string; status: string }[];
		  })
		| null
	>(null);
	let members = $state<{ userId: string; freshness: string; reason: unknown }[]>([]);
	let cursor = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');
	let loadedTenant = $state('');
	onMount(() => {
		settingsContext.initialize();
	});
	$effect(() => {
		const tenant = settingsContext.tenantId;
		if (tenant && tenant !== loadedTenant) {
			loadedTenant = tenant;
			edit(null);
			subject = '';
			catalog = { revision: 0, groups: [], fields: {}, dependencies: {}, scans: [] };
			load();
		}
	});
	async function action(fn: () => Promise<void>) {
		busy = true;
		error = '';
		notice = '';
		try {
			await fn();
		} catch (e) {
			const code = e instanceof Error ? e.message : String(e);
			error = code === 'group_version_conflict' ? text.versionConflict : code;
		} finally {
			busy = false;
		}
	}
	async function load() {
		await action(async () => {
			catalog = await request<ServiceGroupCatalog>();
		});
	}
	function edit(group: ServiceGroup | null) {
		notice = '';
		membersLoaded = false;
		selected = group?.id ?? null;
		key = group?.key ?? '';
		name = group?.displayName ?? '';
		description = group?.description ?? '';
		enabled = group?.enabled ?? true;
		scimRoleId = group?.scimRoleId ?? '';
		hasRule = group ? group.condition !== null : true;
		condition = $state.snapshot(
			group?.condition ?? { op: 'attribute', field: 'country', compare: 'eq', value: 'JP' }
		);
		output = null;
		members = [];
		cursor = null;
	}
	const draft = () => ({
		id: selected ?? undefined,
		key,
		displayName: name,
		description,
		enabled,
		scimRoleId: scimRoleId || undefined,
		condition: hasRule ? condition : null,
		ifMatch: catalog.revision
	});
	async function save() {
		await action(async () => {
			await request(selected ? `/${selected}` : '', selected ? 'PUT' : 'POST', draft());
			catalog = await request<ServiceGroupCatalog>();
			edit(catalog.groups.find((g) => g.key === key) ?? null);
			notice = text.saved;
		});
	}
	async function preview() {
		await action(async () => {
			output = await request('/validate', 'POST', { ...draft(), userId: subject || undefined });
		});
	}
	async function explain(reconcile = false) {
		await action(async () => {
			output = await request<GroupSnapshot>(
				`/subjects/${encodeURIComponent(subject)}${reconcile ? '/reconcile' : ''}`,
				reconcile ? 'POST' : 'GET'
			);
		});
	}
	async function listMembers(after = '') {
		if (!selected) return;
		await action(async () => {
			const page = await request<{ members: typeof members; nextCursor: string | null }>(
				`/${selected}/members?after=${encodeURIComponent(after)}`
			);
			members = page.members;
			membersLoaded = true;
			cursor = page.nextCursor;
		});
	}
	async function remove() {
		if (!selected || !confirm(text.confirmDelete)) return;
		await action(async () => {
			await request(`/${selected}`, 'DELETE', { ifMatch: catalog.revision });
			catalog = await request<ServiceGroupCatalog>();
			edit(null);
		});
	}
	async function manual(present: boolean) {
		if (!selected || !subject) return;
		await action(async () => {
			output = await request(`/${selected}/members/${encodeURIComponent(subject)}`, 'PUT', {
				present
			});
		});
	}
	async function recover() {
		const ids =
			output?.unsettledWrites?.filter((row) => row.status === 'failed').map((row) => row.id) ?? [];
		if (!ids.length || !confirm(text.confirmRecovery)) return;
		await action(async () => {
			output = await request(`/subjects/${encodeURIComponent(subject)}/recover`, 'POST', {
				boundaryIds: ids,
				acceptSavedAttributes: true
			});
		});
	}
	function truth(value: boolean | 'unknown') {
		return value === 'unknown' ? text.unknown : value ? text.match : text.noMatch;
	}
</script>

<svelte:head><title>{text.title}</title></svelte:head>
<AdminPageShell>
	<AdminPageHeader title={text.title} description={text.intro} />
	{#if notice}<div role="status" class="notice">{notice}</div>{/if}
	{#if error}<div role="alert" class="alert alert-error">{error}</div>{/if}
	<div class="toolbar">
		<button class="primary" onclick={() => edit(null)} disabled={busy}>{text.create}</button><button
			onclick={load}
			disabled={busy}>{text.refresh}</button
		><span>{text.revision}: {catalog.revision}</span>
	</div>
	<div class="layout">
		<nav aria-label={text.title}>
			<input
				class="search"
				aria-label={text.search}
				placeholder={text.search}
				bind:value={search}
			/>
			{#each catalog.groups.filter((g) => `${g.displayName} ${g.key}`
					.toLowerCase()
					.includes(search.toLowerCase())) as group (group.id)}<button
					class:active={selected === group.id}
					aria-current={selected === group.id ? 'true' : undefined}
					disabled={busy}
					onclick={() => edit(group)}>{group.displayName}<small>{group.key}</small></button
				>{:else}<p>{text.empty}</p>{/each}
		</nav>
		<AdminSection title={selected ? name : text.create}>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				<h3>{text.basics}</h3>
				<label
					>{text.key}<input
						bind:value={key}
						required
						pattern="[a-z][a-z0-9_-]*"
						maxlength="64"
					/></label
				>
				<p class="hint">{text.keyHint}</p>
				<label>{text.name}<input bind:value={name} required maxlength="200" /></label>
				<label
					>{text.description}<textarea bind:value={description} maxlength="2000"></textarea></label
				>
				<label><input type="checkbox" bind:checked={enabled} />{text.enabled}</label>
				<h3>{text.rules}</h3>
				<p class="hint">{text.ruleHint}</p>
				<label><input type="checkbox" bind:checked={hasRule} />{text.condition}</label>
				{#if hasRule}
					<div class="templates" role="group" aria-label={text.templates}>
						<span>{text.templates}</span>
						<button
							type="button"
							onclick={() => {
								condition = {
									op: 'attribute',
									field: 'email_domain',
									compare: 'eq',
									value: 'example.com'
								};
							}}>{text.domainTemplate}</button
						>
						<button
							type="button"
							onclick={() => {
								condition = { op: 'attribute', field: 'country', compare: 'eq', value: 'JP' };
							}}>{text.countryTemplate}</button
						>
						<button
							type="button"
							disabled={!catalog.groups.some((g) => g.enabled && g.id !== selected)}
							onclick={() => {
								condition = {
									op: 'member',
									groupId: catalog.groups.find((g) => g.enabled && g.id !== selected)?.id ?? ''
								};
							}}>{text.groupTemplate}</button
						>
					</div>
					<ConditionEditor
						bind:value={condition}
						fields={catalog.fields}
						groups={catalog.groups.filter((g) => g.id !== selected && g.enabled)}
						{text}
					/>{:else}<p>{text.noRule}</p>{/if}
				<div class="toolbar">
					<button class="primary" type="submit" disabled={busy}>{text.save}</button><button
						type="button"
						onclick={preview}
						disabled={busy}>{text.validate}</button
					>{#if selected}<button class="danger" type="button" onclick={remove} disabled={busy}
							>{text.delete}</button
						>{/if}
				</div>
				<details>
					<summary>{text.advanced}</summary>
					<label>{text.scim}<input bind:value={scimRoleId} maxlength="128" /></label>
					<p class="hint">{text.scimHint}</p>
				</details>
			</form>
			{#if selected}<p>
					{text.dependencies}: {(catalog.dependencies[selected] ?? [])
						.map((id) => catalog.groups.find((g) => g.id === id)?.displayName ?? id)
						.join(', ') || '—'}
				</p>{/if}
		</AdminSection>
	</div>
	<AdminSection title={text.explanation}>
		<p class="hint">{text.testHint}</p>
		<label>{text.user}<input bind:value={subject} /></label>
		<div class="toolbar">
			<button onclick={() => explain()} disabled={busy || !subject}>{text.published}</button><button
				onclick={() => explain(true)}
				disabled={busy || !subject}>{text.evaluate}</button
			><button onclick={preview} disabled={busy || !subject}>{text.preview}</button><button
				onclick={() => manual(true)}
				disabled={busy || !subject || !selected}>{text.manual}</button
			><button onclick={() => manual(false)} disabled={busy || !subject || !selected}
				>{text.unmanual}</button
			>
		</div>
		{#if output}
			<div class="results" aria-live="polite">
				{#if output.valid}<p>{text.valid}</p>{/if}
				{#if output.freshness}<p>
						{text[output.freshness]} · {text.revision}: {output.ruleVersion}
					</p>{/if}
				{#if output.error}<p role="alert">{output.error}</p>{/if}
				{#if output.evaluation}
					<AdminDataTable compact --table-header-color="var(--color-text)">
						<caption>{text.explanation}</caption><thead
							><tr><th>{text.group}</th><th>{text.members}</th><th>{text.sources}</th></tr></thead
						><tbody>
							{#each Object.entries(output.evaluation.groups) as [id, result] (id)}<tr
									><td>{catalog.groups.find((g) => g.id === id)?.displayName ?? name}</td><td
										>{truth(result.member)}</td
									><td
										>{result.sources
											.map((source) =>
												source === 'dynamic'
													? text.dynamicSource
													: source === 'manual'
														? text.manualSource
														: source === 'scim'
															? 'SCIM'
															: source
											)
											.join(', ') || '—'}</td
									></tr
								>{/each}
						</tbody>
					</AdminDataTable>
				{/if}
				{#if output.explanation}
					<AdminDataTable compact --table-header-color="var(--color-text)">
						<caption>{text.truth}</caption><thead
							><tr><th>{text.condition}</th><th>{text.value}</th></tr></thead
						><tbody>
							{#each output.explanation as node (node.node)}<tr
									><td
										>{node.field
											? groupFieldLabel(node.field, text)
											: (catalog.groups.find((g) => g.id === node.groupId)?.displayName ??
												node.operator)}
										{#if node.compare}
											{node.compare === 'eq'
												? text.eq
												: node.compare === 'in'
													? text.in
													: node.compare === 'contains'
														? text.contains
														: node.compare}
											{JSON.stringify(node.expected)}
										{/if}</td
									><td>{truth(node.result)}</td></tr
								>{/each}
						</tbody>
					</AdminDataTable>
				{/if}
				{#if output.unsettledWrites?.length}
					<p>{text.unsettled}</p>
					{#each output.unsettledWrites as row (row.id)}<p>{row.operation}: {row.status}</p>{/each}
					<button
						onclick={recover}
						disabled={busy || !output.unsettledWrites.some((row) => row.status === 'failed')}
						>{text.recover}</button
					>
				{/if}
			</div>
		{/if}
	</AdminSection>
	<AdminSection title={text.members}>
		<p class="hint">{text.memberHint}</p>
		<button onclick={() => listMembers()} disabled={busy || !selected}>{text.refresh}</button>
		{#if membersLoaded && !members.length}<p>{text.noMembers}</p>{/if}
		{#if members.length}
			<AdminDataTable compact --table-header-color="var(--color-text)">
				<caption>{name} · {text.members}</caption>
				<thead><tr><th>{text.user}</th><th>{text.published}</th></tr></thead>
				<tbody
					>{#each members as item (item.userId)}<tr
							><td
								><button
									onclick={() => {
										subject = item.userId;
										explain();
									}}>{item.userId}</button
								></td
							><td>{text[item.freshness as 'fresh'] ?? item.freshness}</td></tr
						>{/each}</tbody
				>
			</AdminDataTable>
		{/if}
		{#if cursor}<button onclick={() => listMembers(cursor!)} disabled={busy}>{text.more}</button
			>{/if}
	</AdminSection>
	<AdminSection title={text.progress}>
		<p class="hint">{text.progressHint}</p>
		<button
			disabled={busy}
			onclick={() =>
				action(async () => {
					await request('/reconcile', 'POST', { ifMatch: catalog.revision });
					catalog = await request<ServiceGroupCatalog>();
				})}>{text.retry}</button
		>
		{#if !catalog.scans.length}<p>{text.noScans}</p>{/if}
		{#each catalog.scans as scan (scan.binding_ref)}
			<div class="scan">
				<strong
					>{scan.status === 'processing'
						? text.processing
						: scan.status === 'completed'
							? text.completed
							: scan.status === 'failed'
								? text.failed
								: scan.status}</strong
				><span>{text.processed}: {scan.processed}</span><span>{text.failures}: {scan.failures}</span
				><small>{text.revision}: {scan.rule_version} · {scan.binding_ref}</small>
			</div>
		{/each}
	</AdminSection>
</AdminPageShell>

<style>
	.results :global(.admin-data-table) {
		min-width: 100%;
		table-layout: fixed;
	}
	.results :global(th),
	.results :global(td) {
		white-space: normal;
		overflow-wrap: anywhere;
	}

	form {
		display: block;
	}
	label:has(input[type='checkbox']) {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(180px, 1fr) minmax(0, 3fr);
		gap: 24px;
	}
	nav button {
		display: block;
		width: 100%;
		text-align: start;
		margin: 4px 0;
		padding: 12px;
	}
	small {
		display: block;
	}
	.active {
		background: var(--color-bg-secondary, #f4f5f7);
		outline: 2px solid var(--color-primary, #3660aa);
	}
	label {
		display: block;
		margin: 12px 0;
	}
	label > input:not([type='checkbox']),
	textarea {
		display: block;
		width: 100%;
	}
	input,
	textarea,
	button {
		padding: 10px 12px;
		border: 1px solid var(--color-border, #b7bdc7);
		border-radius: 6px;
		background: var(--color-bg-primary, white);
		color: var(--color-text);
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 12px 0;
		align-items: center;
	}
	@media (max-width: 720px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	button {
		cursor: pointer;
		font-weight: 500;
	}
	button:disabled {
		opacity: 0.55;
		cursor: default;
	}
	button.primary {
		background: var(--color-primary, #315cac);
		color: white;
		border-color: transparent;
	}
	button.danger {
		color: var(--color-danger, #b42318);
		margin-inline-start: auto;
	}
	.hint {
		font-size: 0.875rem;
		line-height: 1.6;
		margin: 8px 0 16px;
	}
	h3 {
		margin: 24px 0 12px;
		font-size: 1rem;
	}
	h3:first-child {
		margin-top: 0;
	}
	.search {
		width: 100%;
		margin-bottom: 12px;
	}
	.templates {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 16px 0;
	}
	.templates span {
		width: 100%;
		font-size: 0.875rem;
	}
	details {
		border-top: 1px solid var(--color-border, #ddd);
		padding: 16px 0 0;
		margin-top: 20px;
	}
	summary {
		cursor: pointer;
		font-weight: 500;
	}
	.notice {
		border: 1px solid var(--color-border, #ddd);
		border-inline-start: 4px solid #32804a;
		border-radius: 6px;
		padding: 14px 16px;
	}
	.scan {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		padding: 16px 0;
		border-bottom: 1px solid var(--color-border, #ddd);
	}
	.scan small {
		width: 100%;
		overflow-wrap: anywhere;
	}
</style>

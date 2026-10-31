<script lang="ts">
	import type { ApiRow } from './api-inventory';
	import type { ApiMethod, ApiOperation } from './api-operations';

	interface Props {
		apis: readonly ApiRow[];
	}

	let { apis }: Props = $props();

	/** Groups whose operation list is open: the lists are drawn only when opened (1000+ rows). */
	let opened = $state<Record<string, boolean>>({});

	const METHODS: readonly ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

	/** "GET 5 · POST 2": how many operations of each method the group has. */
	function methodCounts(operations: readonly ApiOperation[]): string {
		return METHODS.map((method) => [method, operations.filter((op) => op.method === method).length])
			.filter(([, n]) => n)
			.map(([method, n]) => `${method} ${n}`)
			.join(' · ');
	}
</script>

<table class="apis">
	<colgroup>
		<col class="apis__col-no" />
		<col class="apis__col-api" />
		<col class="apis__col-kind" />
		<col />
	</colgroup>
	<thead>
		<tr>
			<th scope="col">#</th>
			<th scope="col">API</th>
			<th scope="col">Kind</th>
			<th scope="col">Note</th>
		</tr>
	</thead>
	<tbody>
		{#each apis as api (api.group.id)}
			<tr>
				<td class="apis__no">A{api.no}</td>
				<td>
					<span class="apis__name">{api.group.name}</span>
					<details
						class="apis__ops"
						ontoggle={(event) => (opened[api.group.id] = event.currentTarget.open)}
					>
						<summary>{methodCounts(api.operations)}</summary>
						{#if opened[api.group.id]}
							<ul>
								{#each api.operations as op (`${op.method} ${op.path}`)}
									<li>
										<code dir="ltr"><span class="apis__method">{op.method}</span> {op.path}</code>
										{#if op.summary}<span class="apis__summary">{op.summary}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</details>
				</td>
				<td><span class="apis__kind apis__kind--{api.group.kind}">{api.group.kind}</span></td>
				<td class="apis__note">
					{#if api.group.overlaps}
						<span>Same values as <code dir="ltr">{api.group.overlaps}</code>.</span>
					{/if}
					{#if api.group.note}<span>{api.group.note}</span>{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.apis {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-body);
	}

	.apis th,
	.apis td {
		padding: 8px var(--box-pad);
		border-top: 1px solid var(--border-subtle);
		text-align: start;
		vertical-align: top;
	}

	.apis thead th {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.apis__col-no {
		width: 4rem;
	}

	.apis__col-api {
		width: 45%;
	}

	.apis__col-kind {
		width: 8rem;
	}

	.apis__no {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.apis__name {
		display: block;
		color: var(--text-primary);
	}

	.apis__ops summary {
		cursor: pointer;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
	}

	.apis__ops ul {
		display: grid;
		gap: 4px;
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
	}

	.apis__ops li {
		display: grid;
		gap: 1px;
		font-size: var(--fs-small);
	}

	.apis__method {
		font-weight: var(--fw-semibold);
	}

	.apis__summary {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.apis__kind {
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.apis__kind--settings,
	.apis__kind--settings-api {
		color: var(--info);
	}

	.apis__kind--outside,
	.apis__kind--account {
		color: var(--text-muted);
	}

	.apis__note {
		display: grid;
		gap: 2px;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>

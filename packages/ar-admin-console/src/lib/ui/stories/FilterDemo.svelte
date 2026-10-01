<script lang="ts">
	import Badge from '../primitives/Badge.svelte';
	import SearchField from '../primitives/SearchField.svelte';
	import Select from '../primitives/Select.svelte';
	import Card from '../patterns/Card.svelte';
	import DataTable from '../patterns/DataTable.svelte';
	import DateRangeField from '../patterns/DateRangeField.svelte';
	import FilterBar from '../patterns/FilterBar.svelte';
	import EmptyState from '../patterns/EmptyState.svelte';
	import type { DateRange } from '../patterns/date-range';
	import { resolveRange } from '../patterns/date-range';
	import { localized } from './sample';

	/** Storybook demo: a user list narrowed by search, status and sign-up period. */
	const NOW = new Date('2026-09-28T12:00:00Z');
	const day = 86_400_000;
	const people = [
		['Aiko Tanaka', 'aiko@example.com', 'active', 0.2],
		['Ben Carter', 'ben@example.com', 'active', 2],
		['Chloé Martin', 'chloe@example.com', 'suspended', 5],
		['Daniel Weber', 'daniel@example.com', 'active', 12],
		['Emi Sato', 'emi@example.com', 'invited', 20],
		['Farah Haddad', 'farah@example.com', 'active', 40]
	].map(([name, email, status, daysAgo]) => ({
		id: String(email),
		name: String(name),
		email: String(email),
		status: String(status),
		joined: new Date(NOW.getTime() - Number(daysAgo) * day)
	}));

	const copy = {
		search: ['ユーザーを検索', 'Search users', 'Benutzer suchen', 'البحث عن المستخدمين'],
		searchHint: ['名前・メールアドレス', 'Name or email', 'Name oder E-Mail', 'الاسم أو البريد'],
		status: ['状態', 'Status', 'Status', 'الحالة'],
		all: ['すべての状態', 'All statuses', 'Alle Status', 'كل الحالات'],
		active: ['有効', 'Active', 'Aktiv', 'نشط'],
		suspended: ['停止中', 'Suspended', 'Gesperrt', 'موقوف'],
		invited: ['招待中', 'Invited', 'Eingeladen', 'مدعو'],
		joined: ['登録日', 'Signed up', 'Registriert', 'تاريخ التسجيل'],
		name: ['名前', 'Name', 'Name', 'الاسم'],
		email: ['メールアドレス', 'Email', 'E-Mail', 'البريد'],
		users: ['ユーザー', 'Users', 'Benutzer', 'المستخدمون'],
		none: [
			'条件に合うユーザーはいません',
			'No users match',
			'Keine passenden Benutzer',
			'لا يوجد مستخدمون مطابقون'
		]
	} as const;
	const c = (key: keyof typeof copy) => localized(copy[key]);

	let query = $state('');
	let status = $state('all');
	let period = $state<DateRange>({ preset: '30d' });

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const { from, to } = resolveRange(period, NOW);
		return people.filter(
			(p) =>
				(!q || p.name.toLowerCase().includes(q) || p.email.includes(q)) &&
				(status === 'all' || p.status === status) &&
				(!from || p.joined >= from) &&
				(!to || p.joined <= to)
		);
	});
	const active = $derived(query !== '' || status !== 'all' || period.preset !== '30d');

	function clear() {
		query = '';
		status = 'all';
		period = { preset: '30d' };
	}
</script>

<div style="display:grid;gap:12px;max-width:900px">
	<FilterBar results={shown.length} {active} onclear={clear}>
		{#snippet search()}
			<SearchField label={c('search')} placeholder={c('searchHint')} size="sm" bind:value={query} />
		{/snippet}
		<Select
			label={c('status')}
			hideLabel
			size="sm"
			bind:value={status}
			options={[
				{ value: 'all', label: c('all') },
				{ value: 'active', label: c('active') },
				{ value: 'suspended', label: c('suspended') },
				{ value: 'invited', label: c('invited') }
			]}
		/>
		<DateRangeField label={c('joined')} hideLabel size="sm" zone="utc" bind:value={period} />
	</FilterBar>
	<Card title={c('users')} flush>
		<DataTable
			caption={c('users')}
			columns={[
				{ key: 'name', label: c('name'), width: '34%' },
				{ key: 'email', label: c('email') },
				{ key: 'status', label: c('status'), width: '120px' }
			]}
			rows={shown}
			rowKey={(row) => row.id}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'status'}
					<Badge tone={row.status === 'active' ? 'success' : 'neutral'}
						>{c(row.status as 'active')}</Badge
					>
				{:else}
					{row[column.key as 'name' | 'email']}
				{/if}
			{/snippet}
			{#snippet empty()}<EmptyState icon="users" title={c('none')} />{/snippet}
		</DataTable>
	</Card>
</div>

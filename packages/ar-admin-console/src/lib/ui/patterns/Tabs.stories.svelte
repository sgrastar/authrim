<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '../primitives/Badge.svelte';
	import { sample } from '../stories/sample';
	import DateTime from '../time/DateTime.svelte';
	import DetailItem from './DetailItem.svelte';
	import DetailList from './DetailList.svelte';
	import EmptyState from './EmptyState.svelte';
	import Tabs, { type TabItem } from './Tabs.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Tabs',
		component: Tabs,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Sections of one record — a user’s overview, sessions, audit log. An underline slides to the current tab; records should have few tabs; if they still do not fit (long translations, narrow screens), the ones that do not fit go under **More** at the end of the row, and the current tab always stays in the row.\n\n- **Links** (every item has `href`): one URL per tab, so a section can be bookmarked, shared and reached with the back button. Use this for record pages.\n- **In place** (no `href`): `panel` renders the current tab. Arrow keys move between tabs (mirrored in RTL), Home/End jump to the ends.\n\nKeep labels short (one or two words); counts go in `count`, not in the label.'
				}
			}
		}
	});

	const userTabs = (): TabItem[] => [
		{ id: 'overview', label: sample('tabOverview'), icon: 'users' },
		{ id: 'auth', label: sample('tabAuthMethods'), icon: 'fingerprint' },
		{ id: 'sessions', label: sample('tabSessions'), icon: 'clock', count: 3 },
		{ id: 'audit', label: sample('tabAudit'), icon: 'file' },
		{ id: 'emails', label: sample('tabEmails'), icon: 'mail' },
		{ id: 'support', label: sample('tabSupport'), icon: 'info' },
		{ id: 'roles', label: sample('tabRoles'), icon: 'shield' },
		{ id: 'consents', label: sample('tabConsents'), icon: 'checkCircle' },
		{ id: 'settings', label: sample('settings'), icon: 'gear' }
	];
</script>

<Story
	name="In place"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const sessions = canvas.getByRole('tab', { name: new RegExp(sample('tabSessions')) });
		await userEvent.click(sessions);
		await expect(sessions).toHaveAttribute('aria-selected', 'true');
		await userEvent.keyboard('{ArrowRight}');
		await expect(canvas.getByRole('tab', { name: sample('tabAudit') })).toHaveFocus();
		await expect(canvas.getByRole('tabpanel')).toHaveTextContent(sample('tabAudit'));
	}}
>
	{#snippet template()}
		<div style="max-width:760px">
			<Tabs label="Aiko Tanaka" items={userTabs().slice(0, 5)}>
				{#snippet panel(id)}
					{#if id === 'overview'}
						<DetailList columns={2}>
							<DetailItem label={sample('userId')}>2poWRxkpN9Ki9xX3Wb0Zf</DetailItem>
							<DetailItem label={sample('state')}
								><Badge tone="success" dot>{sample('enabled')}</Badge></DetailItem
							>
							<DetailItem label={sample('createdAt')}
								><DateTime value="2026-02-06T00:00:00Z" /></DetailItem
							>
							<DetailItem label={sample('lastSignInAt')}
								><DateTime value="2026-09-25T19:00:00Z" /></DetailItem
							>
						</DetailList>
					{:else}
						<EmptyState icon="stack" title={userTabs().find((tab) => tab.id === id)?.label ?? ''} />
					{/if}
				{/snippet}
			</Tabs>
		</div>
	{/snippet}
</Story>

<Story name="Links">
	{#snippet template()}
		<div style="max-width:760px">
			<Tabs
				label="Aiko Tanaka"
				value="overview"
				items={userTabs()
					.slice(0, 5)
					.map((tab) => ({ ...tab, href: `#${tab.id}` }))}
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="More tabs than fit"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// The row holds what fits; the rest waits under "More".
		await waitFor(() => expect(canvas.getByRole('button', { name: t('tabs.more') })).toBeVisible());
		await expect(canvas.queryByRole('tab', { name: sample('tabRoles') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('tabs.more') }));
		await userEvent.click(await body.findByRole('button', { name: sample('tabRoles') }));
		// The chosen tab comes into the row and is current.
		const roles = await canvas.findByRole('tab', { name: sample('tabRoles') });
		await expect(roles).toHaveAttribute('aria-selected', 'true');
		await expect(canvas.getByRole('tabpanel')).toHaveTextContent(sample('tabRoles'));
	}}
>
	{#snippet template()}
		<div style="max-width:520px">
			<Tabs label="Aiko Tanaka" items={userTabs()}>
				{#snippet panel(id)}
					<EmptyState icon="stack" title={userTabs().find((tab) => tab.id === id)?.label ?? ''} />
				{/snippet}
			</Tabs>
		</div>
	{/snippet}
</Story>

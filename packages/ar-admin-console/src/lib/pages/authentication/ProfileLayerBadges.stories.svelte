<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { fakeLayer } from '#lib/api/fake/profile-fake-core.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ProfileLayerBadges from './ProfileLayerBadges.svelte';
	import ProfileLayerNotice from './ProfileLayerNotice.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Profile platform layer',
		component: ProfileLayerBadges,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'How a method or session profile shows the platform layer: the badges of a list row and of the page header (platform, locked, overridden, override set aside, platform updated), and the note on its page, with “Use the platform’s values” where the tenant keeps a copy. Default carries the same states without the platform badge.'
				}
			}
		}
	});

	const states = [
		['A platform profile', fakeLayer()],
		[
			'Overridden, platform updated',
			fakeLayer({ overridden: true, platformUpdated: true, copyVersion: 1 })
		],
		[
			'Locked, copy set aside',
			fakeLayer({
				locked: true,
				editable: false,
				overrideInactive: true,
				overrideInactiveReason: 'locked',
				copyVersion: 2
			})
		],
		[
			'Changes not allowed',
			fakeLayer({ editable: false, overrideInactiveReason: 'changes_not_allowed' })
		],
		['Default, overridden', fakeLayer({ scope: 'tenant', overridden: true })]
	] as const;
</script>

<Story
	name="All states"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getAllByText(t('pl.platform'))).toHaveLength(4);
		await expect(canvas.getByText(t('pl.locked'))).toBeInTheDocument();
		await expect(canvas.getByText(t('pl.inactive'))).toBeInTheDocument();
		await expect(canvas.getByText(t('pl.updated'))).toBeInTheDocument();
		await expect(canvas.getAllByText(t('pl.overridden'))).toHaveLength(2);
	}}
>
	{#snippet template()}
		<div style="display: grid; gap: 20px; max-width: 720px;">
			{#each states as [title, layer] (title)}
				<section style="display: grid; gap: 8px;">
					<p style="margin: 0; font-weight: var(--fw-semibold);">
						{title}
						<ProfileLayerBadges {layer} size="md" />
					</p>
					<ProfileLayerNotice {layer} canWrite onrevert={() => {}} />
				</section>
			{/each}
		</div>
	{/snippet}
</Story>

<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PersistentIdentifierDemo from '../stories/PersistentIdentifierDemo.svelte';
	import PersistentIdentifierEditorDemo from '../stories/PersistentIdentifierEditorDemo.svelte';
	import PersistentIdentifierParams from './PersistentIdentifierParams.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Persistent identifier step',
		component: PersistentIdentifierParams,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The settings of the attribute mapping’s **persistent identifier** step (group “Identifiers”). The step makes the identifier from the account’s ID, or from a value imported for the account (an identifier source), and reads no source attribute.\n\nEach setting is shown only while it applies: the digest and encoding for Shibboleth, the scope for the identifiers that are the same for every recipient, the source while the identifier is made from an imported value, the store while stored identifiers are used. A setting that does not apply is not sent (the box under the settings in these stories shows what the runtime would receive).\n\nWhat a setting names (the identifier source, the salt, the store, the exception list) is chosen from what was imported, with the import beside it: the salt in a dialog of its own, the rest as CSV (see _Salt import_ and _CSV import_).'
				}
			}
		}
	});

	const labelled = (canvas: ReturnType<typeof within>, key: string) =>
		canvas.queryByLabelText(t(`pid.p.${key}` as never));
</script>

<Story
	name="Account ID, defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByLabelText(t('pid.p.algorithm'))).toBeVisible();
		// Nothing that does not apply is shown, or sent.
		for (const key of ['source', 'digest', 'encoding', 'scope', 'store'])
			await expect(labelled(canvas, key)).toBeNull();
		const sent = JSON.parse(canvas.getByTestId('sent').textContent ?? '{}');
		await expect(sent).toEqual({
			input: 'account',
			format: 'plain',
			algorithm: 'authrim_sha256',
			audience: 'auto',
			stored: 'off'
		});
	}}
>
	{#snippet template()}<PersistentIdentifierDemo />{/snippet}
</Story>

<Story
	name="Shibboleth: digest and encoding"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByLabelText(t('pid.p.digest'))).toBeVisible();
		await expect(canvas.getByLabelText(t('pid.p.encoding'))).toBeVisible();
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.digest')), 'SHA-256');
		await waitFor(() => expect(canvas.getByTestId('sent').textContent).toContain('"SHA-256"'));
		// Another algorithm has neither, and does not send what was set.
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.algorithm')), 'authrim_sha256');
		await waitFor(() => expect(labelled(canvas, 'digest')).toBeNull());
		await expect(labelled(canvas, 'encoding')).toBeNull();
		await expect(canvas.getByTestId('sent').textContent).not.toContain('digest');
	}}
>
	{#snippet template()}
		<PersistentIdentifierDemo params={{ algorithm: 'shibboleth', format: 'saml_targeted_id' }} />
	{/snippet}
</Story>

<Story
	name="Scope for pairwise and subject IDs"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText(t('pid.p.scope')), 'example.edu');
		await waitFor(() => expect(canvas.getByTestId('sent').textContent).toContain('example.edu'));
		// A format that needs no scope takes the field away.
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.format')), 'plain');
		await waitFor(() => expect(labelled(canvas, 'scope')).toBeNull());
		await expect(canvas.getByTestId('sent').textContent).not.toContain('scope');
		// The algorithm that makes pairwise IDs needs it too.
		await userEvent.selectOptions(
			canvas.getByLabelText(t('pid.p.algorithm')),
			'simplesamlphp_pairwise_id'
		);
		await expect(await canvas.findByLabelText(t('pid.p.scope'))).toBeVisible();
	}}
>
	{#snippet template()}
		<PersistentIdentifierDemo params={{ format: 'saml_pairwise_id' }} />
	{/snippet}
</Story>

<Story
	name="From an identifier source"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const source = await canvas.findByLabelText(t('pid.p.source'));
		await waitFor(() =>
			expect(within(source).getByRole('option', { name: /employee-number/ })).toBeVisible()
		);
		await userEvent.selectOptions(source, 'employee-number');
		await waitFor(() =>
			expect(canvas.getByTestId('sent').textContent).toContain('"source": "employee-number"')
		);
		// Back to the account's ID: the source is neither shown nor sent.
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.input')), 'account');
		await waitFor(() => expect(labelled(canvas, 'source')).toBeNull());
		await expect(canvas.getByTestId('sent').textContent).not.toContain('source');
	}}
>
	{#snippet template()}<PersistentIdentifierDemo params={{ input: 'source' }} />{/snippet}
</Story>

<Story
	name="Stored identifiers, salt and exceptions"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// A store is asked for only while stored identifiers are used.
		await expect(labelled(canvas, 'store')).toBeNull();
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.stored')), 'prefer');
		const store = await canvas.findByLabelText(t('pid.p.store'));
		await waitFor(() =>
			expect(within(store).getByRole('option', { name: /legacy-ids/ })).toBeVisible()
		);
		await userEvent.selectOptions(store, 'legacy-ids');
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.salt')), 'legacy-idp');
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.exceptions')), 'exception-map');
		await waitFor(() => {
			const sent = JSON.parse(canvas.getByTestId('sent').textContent ?? '{}');
			expect(sent).toMatchObject({
				stored: 'prefer',
				store: 'legacy-ids',
				salt: 'legacy-idp',
				exceptions: 'exception-map'
			});
		});
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.stored')), 'off');
		await waitFor(() => expect(labelled(canvas, 'store')).toBeNull());
		await expect(canvas.getByTestId('sent').textContent).not.toContain('"store"');
	}}
>
	{#snippet template()}<PersistentIdentifierDemo />{/snippet}
</Story>

<Story
	name="Picked in the mapping editor"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /^persistent_id/ }));
		await userEvent.click(await canvas.findByRole('button', { name: t('map.addStep') }));
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await userEvent.type(picker.getByRole('searchbox'), 'persistent');
		await userEvent.click(
			await picker.findByRole('button', {
				name: new RegExp(`^${t('map.t.persistent_identifier')}`)
			})
		);
		// The preview names its settings in the step's own words, never as raw keys.
		await expect((await picker.findAllByText(t('pid.p.algorithm'))).length).toBeGreaterThan(0);
		await expect(picker.queryByText('map.p.algorithm')).toBeNull();
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
		// The step reads no source attribute, so the mapping is complete as it is.
		await expect(await canvas.findByLabelText(t('pid.p.algorithm'))).toBeVisible();
		await expect(canvas.queryByText(t('map.x.noSource'))).toBeNull();
		// A format its algorithm cannot make is a problem, in words.
		await userEvent.selectOptions(
			canvas.getByLabelText(t('pid.p.algorithm')),
			'simplesamlphp_pairwise_id'
		);
		await userEvent.type(await canvas.findByLabelText(t('pid.p.scope')), 'example.edu');
		// Said on the line, and again in its list of what needs attention.
		const said = await canvas.findAllByText(t('map.x.pid.formatAlgorithm', { n: 1 }));
		await expect(said.length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}<PersistentIdentifierEditorDemo />{/snippet}
</Story>

<Story
	name="Switching a mapping that has a source"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /^persistent_id/ }));
		await userEvent.click(await canvas.findByRole('button', { name: t('map.addStep') }));
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await userEvent.type(picker.getByRole('searchbox'), 'persistent');
		await userEvent.click(
			await picker.findByRole('button', {
				name: new RegExp(`^${t('map.t.persistent_identifier')}`)
			})
		);
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
		// The leftover source is a problem; taking it away keeps the step and its settings.
		await expect(
			(await canvas.findAllByText(t('map.x.pid.withSource', { n: 1 }))).length
		).toBeGreaterThan(0);
		await userEvent.selectOptions(canvas.getByLabelText(t('pid.p.algorithm')), 'shibboleth');
		await userEvent.click(canvas.getByRole('button', { name: t('map.unassign') }));
		await waitFor(() => expect(canvas.queryByText(t('map.x.pid.withSource', { n: 1 }))).toBeNull());
		await expect(canvas.getByLabelText(t('pid.p.algorithm'))).toHaveValue('shibboleth');
	}}
>
	{#snippet template()}<PersistentIdentifierEditorDemo withSource />{/snippet}
</Story>

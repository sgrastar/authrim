<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { authzAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAdminUsers } from '#lib/api/fake/admin-users-fake.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import {
		createFakeRebac,
		definition,
		sampleDefinitions,
		sampleTuples,
		tuple
	} from '#lib/api/fake/end-user-rebac-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import RelationDefinitionPage from './RelationDefinitionPage.svelte';
	import RelationshipsPage from './RelationshipsPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Access/Relationships',
		component: RelationshipsPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Access → Relationships (`/admin/access/relationships`, `/api/admin/rebac`): three areas. **Tuples** are the facts (a user, every member of a group, or an object edge has a relation on an object); **Definitions** say how a relation is computed (direct, any of, all of, this but not that, or “follow a relation to another object”), built from parts with a JSON fallback for shapes the builder cannot draw, and a definition the API could not read is marked unusable; **Check** asks the engine one question and says how it was answered, including when the answer is “no” because the user’s group memberships could not be read. Lists show members of a group as the group, and a check follows the declared paths only. Relationships count while “Relationships” is on in Settings → Authorization. Reading needs `admin:roles:read`; changing and checking `admin:roles:write` (and a tenant administrator), deleting `admin:roles:delete`.'
				}
			}
		}
	});

	const tenant = authzAccess(persona('tenant').access);
	const readOnly = { ...tenant, rebacWrite: false, rebacDelete: false };
	const users = createFakeAdminUsers();
	const onopen = fn();
	const oncreated = fn();
	const ondeleted = fn();
	const body = (element: HTMLElement) => within(element.ownerDocument.body);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/** Types into a picker inside `scope` and picks the first option found. */
	async function pickIn(
		canvasElement: HTMLElement,
		scope: HTMLElement,
		label: string,
		text: string,
		option: RegExp
	) {
		const box = within(scope).getByRole('combobox', {
			name: new RegExp(`^${escape(label)}(?![’\\w])`)
		});
		await userEvent.click(box);
		await userEvent.type(box, text);
		const options = await body(canvasElement).findAllByRole('option', { name: option });
		await userEvent.click(options[0]);
	}

	const dialogOf = async (canvasElement: HTMLElement) =>
		within(await body(canvasElement).findByRole('dialog'));
	const labelled = (scope: ReturnType<typeof within>, label: string) =>
		scope.getByLabelText(new RegExp(`^${escape(label)}(?![’\\w])`));
	/** Chooses an object type once the page has read the list of them. */
	async function choose(scope: ReturnType<typeof within>, label: string, value: string) {
		const field = labelled(scope, label);
		await waitFor(() => expect(within(field).getByRole('option', { name: value })).toBeTruthy());
		await userEvent.selectOptions(field, value);
	}
</script>

{#snippet page(
	client = createFakeRebac({ delay: 50 }),
	access = tenant,
	tab: 'tuples' | 'definitions' | 'check' = 'tuples'
)}
	<Toaster />
	<RelationshipsPage
		{client}
		{users}
		groups={createFakeAuthz().groups}
		{access}
		{tab}
		newDefinitionHref="#new"
		onopendefinition={onopen}
	/>
{/snippet}

<Story
	name="Tuples"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		// Members of a group are shown as the group, with the page’s plain-text note about it.
		await expect(canvas.getByText('grp_eng')).toBeVisible();
		await expect(canvas.getAllByText(t('rb.tuple.kind.groupMembers')).length).toBeGreaterThan(0);
		await expect(canvas.getByText(new RegExp(escape('list operations omit')))).toBeVisible();
		await expect(canvas.getAllByText('folder:folder_a').length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Tuples, filtered by object type"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		const filter = canvas.getByLabelText(t('rb.filter.objectType'));
		await waitFor(() =>
			expect(within(filter).getByRole('option', { name: 'folder' })).toBeTruthy()
		);
		await userEvent.selectOptions(filter, 'folder');
		await waitFor(() => expect(canvas.queryByText('usr_aiko')).toBeNull());
		await expect(await canvas.findByText('grp_eng')).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Tuples, the API says it left subjects out"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await expect(canvas.getByText(new RegExp(escape(t('rb.tuple.omitted'))))).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac({ usersetOmitted: true }))}
	{/snippet}
</Story>

<Story
	name="Tuples, the API says computed relations are left out"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await expect(canvas.getByText(new RegExp(escape(t('rb.tuple.computedOmitted'))))).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac({ computedOmitted: true }))}
	{/snippet}
</Story>

<Story
	name="Tuples, a legacy group tuple is inactive"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('grp_legacy');
		await expect(canvas.getByText(t('rb.tuple.inactiveLegacy'))).toBeVisible();
		// Only that tuple is marked.
		await expect(canvas.getAllByText(t('rb.tuple.inactiveLegacy'))).toHaveLength(1);
	}}
>
	{#snippet template()}
		{@render page(
			createFakeRebac({
				tuples: [
					...sampleTuples(),
					tuple(
						'rt_legacy',
						'viewer',
						{ type: 'group', id: 'grp_legacy' },
						{ type: 'folder', id: 'folder_a' },
						{ inactiveLegacy: true }
					)
				]
			})
		)}
	{/snippet}
</Story>

<Story name="Tuples, empty">
	{#snippet template()}
		{@render page(createFakeRebac({ tuples: [] }))}
	{/snippet}
</Story>

<Story
	name="Tuples, failed to load"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('rb.tuple.loadFailed'));
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac({ failOn: { listTuples: 500 } }))}
	{/snippet}
</Story>

<Story
	name="Tuples, read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await expect(canvas.queryByRole('button', { name: t('rb.tuple.add') })).toBeNull();
		await expect(canvas.getByText(t('rb.readOnly'))).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac(), readOnly)}
	{/snippet}
</Story>

<Story
	name="Add a tuple for a group's members"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.tuple.add') }));
		const dialog = await dialogOf(canvasElement);
		await userEvent.click(dialog.getByRole('radio', { name: t('rb.tuple.kind.group') }));
		await pickIn(
			canvasElement,
			await body(canvasElement).findByRole('dialog'),
			t('rb.tuple.group'),
			'Engineering',
			/^Engineering/
		);
		await userEvent.type(labelled(dialog, t('rb.tuple.relation')), 'editor');
		await choose(dialog, t('rb.tuple.toType'), 'document');
		await userEvent.type(labelled(dialog, t('rb.tuple.toId')), 'doc_9');
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.new.submit') }));
		await body(canvasElement).findByText(t('rb.tuple.toast.added'));
		await canvas.findByText('document:doc_9');
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Add a tuple, a relation with a space"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.tuple.add') }));
		const dialog = await dialogOf(canvasElement);
		await pickIn(
			canvasElement,
			await body(canvasElement).findByRole('dialog'),
			t('rb.tuple.user'),
			'usr_aiko',
			/usr_aiko/
		);
		await userEvent.type(labelled(dialog, t('rb.tuple.relation')), 'can view');
		await choose(dialog, t('rb.tuple.toType'), 'document');
		await userEvent.type(labelled(dialog, t('rb.tuple.toId')), 'doc_1');
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.new.submit') }));
		// Nothing is sent: the form says what is wrong.
		await dialog.findByText(t('rb.tuple.relationRequired'));
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Add a tuple, kind refused by the API"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.tuple.add') }));
		const dialog = await dialogOf(canvasElement);
		await userEvent.click(dialog.getByRole('radio', { name: t('rb.tuple.kind.object') }));
		await choose(dialog, t('rb.tuple.sourceType'), 'document');
		await userEvent.type(labelled(dialog, t('rb.tuple.sourceId')), 'doc_2');
		// “owner” is not a relation the document’s definitions follow to another object.
		await userEvent.type(labelled(dialog, t('rb.tuple.relation')), 'owner');
		await choose(dialog, t('rb.tuple.toType'), 'folder');
		await userEvent.type(labelled(dialog, t('rb.tuple.toId')), 'folder_a');
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.new.submit') }));
		await dialog.findByText(t('rb.error.tupleTypeNotAllowed'));
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Add an object edge, the child points at its parent"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.tuple.add') }));
		const dialog = await dialogOf(canvasElement);
		await userEvent.click(dialog.getByRole('radio', { name: t('rb.tuple.kind.object') }));
		await choose(dialog, t('rb.tuple.sourceType'), 'document');
		await userEvent.type(labelled(dialog, t('rb.tuple.sourceId')), 'doc_2');
		await userEvent.type(labelled(dialog, t('rb.tuple.relation')), 'parent');
		await choose(dialog, t('rb.tuple.toType'), 'folder');
		await userEvent.type(labelled(dialog, t('rb.tuple.toId')), 'folder_a');
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.new.submit') }));
		await body(canvasElement).findByText(t('rb.tuple.toast.added'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Add a tuple that exists"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('usr_aiko');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.tuple.add') }));
		const dialog = await dialogOf(canvasElement);
		await userEvent.click(dialog.getByRole('radio', { name: t('rb.tuple.kind.object') }));
		await choose(dialog, t('rb.tuple.sourceType'), 'document');
		await userEvent.type(labelled(dialog, t('rb.tuple.sourceId')), 'doc_1');
		await userEvent.type(labelled(dialog, t('rb.tuple.relation')), 'parent');
		await choose(dialog, t('rb.tuple.toType'), 'folder');
		await userEvent.type(labelled(dialog, t('rb.tuple.toId')), 'folder_a');
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.new.submit') }));
		await dialog.findByText(t('rb.error.tupleExists'));
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Delete a tuple"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		await canvas.findByText('usr_ben');
		await userEvent.click(
			canvas.getByRole('button', {
				name: t('rb.tuple.actions', {
					name: t('rb.tuple.rowLabel', { subject: 'usr_ben', relation: 'viewer' })
				})
			})
		);
		await userEvent.click(
			await body(canvasElement).findByRole('menuitem', { name: t('rb.tuple.remove') })
		);
		const dialog = await dialogOf(canvasElement);
		await dialog.findByText(t('rb.tuple.remove.title'));
		await userEvent.click(dialog.getByRole('button', { name: t('rb.tuple.remove') }));
		await body(canvasElement).findByText(t('rb.tuple.toast.removed'));
		await waitFor(() => expect(canvas.queryByText('usr_ben')).toBeNull());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		{@render page()}
	{/snippet}
</Story>

<Story
	name="Definitions"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('document#viewer');
		// The expression as one line, parts of a union separated by “or”.
		await expect(canvas.getByText('viewer or editor or parent → viewer')).toBeVisible();
		await expect(canvas.getByText('viewer but not blocked')).toBeVisible();
		await expect(canvas.getByRole('link', { name: t('rb.def.create') })).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac(), tenant, 'definitions')}
	{/snippet}
</Story>

<Story
	name="Definitions, one cannot be read"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('document#viewer');
		await expect(canvas.getAllByText(t('rb.def.unusable')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		{@render page(
			createFakeRebac({
				definitions: [
					...sampleDefinitions(),
					definition('rd_broken', 'document', 'reviewer', null, { unusable: true })
				]
			}),
			tenant,
			'definitions'
		)}
	{/snippet}
</Story>

<Story
	name="Check, allowed through a computed relation"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const panel = canvasElement;
		await canvas.findByRole('button', { name: t('rb.check.run') });
		await pickIn(canvasElement, panel, t('rb.check.user'), 'usr_aiko', /usr_aiko/);
		await userEvent.type(labelled(canvas, t('rb.check.relation')), 'viewer');
		await choose(canvas, t('rb.check.objectType'), 'document');
		await userEvent.type(labelled(canvas, t('rb.check.objectId')), 'doc_1');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.check.run') }));
		await canvas.findByText(t('rb.check.allowed'));
		await expect(canvas.getByText('computed')).toBeVisible();
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac({ withDebug: true }), tenant, 'check')}
	{/snippet}
</Story>

<Story
	name="Check, denied because memberships are unknown"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('rb.check.run') });
		await pickIn(canvasElement, canvasElement, t('rb.check.user'), 'usr_unknown', /usr_unknown/);
		await userEvent.type(labelled(canvas, t('rb.check.relation')), 'viewer');
		await choose(canvas, t('rb.check.objectType'), 'folder');
		await userEvent.type(labelled(canvas, t('rb.check.objectId')), 'folder_a');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.check.run') }));
		await canvas.findByText(t('rb.check.denied'));
		await expect(canvas.getAllByText(t('rb.via.unknown_membership')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac(), tenant, 'check')}
	{/snippet}
</Story>

<Story
	name="Check, missing fields"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('rb.check.run') }));
		await canvas.findByText(t('rb.check.userRequired'));
		await canvas.findByText(t('rb.tuple.relationRequired'));
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac(), tenant, 'check')}
	{/snippet}
</Story>

<Story
	name="Check, failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('rb.check.run') });
		await pickIn(canvasElement, canvasElement, t('rb.check.user'), 'usr_aiko', /usr_aiko/);
		await userEvent.type(labelled(canvas, t('rb.check.relation')), 'viewer');
		await choose(canvas, t('rb.check.objectType'), 'document');
		await userEvent.type(labelled(canvas, t('rb.check.objectId')), 'doc_1');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.check.run') }));
		await canvas.findByText(t('rb.error.forbidden'));
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac({ failOn: { check: 403 } }), tenant, 'check')}
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('rb.noAccess'));
	}}
>
	{#snippet template()}
		{@render page(createFakeRebac(), { ...tenant, rebacRead: false, rebacWrite: false })}
	{/snippet}
</Story>

<Story
	name="Definition, edit"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		// The builder shows the union with its three parts, one of them a path to another object.
		await canvas.findByDisplayValue('editor');
		await expect(canvas.getByDisplayValue('parent')).toBeVisible();
		const description = labelled(canvas, t('rb.def.description'));
		await userEvent.type(description, ' Edited.');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.def.save') }));
		await body(canvasElement).findByText(t('rb.def.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<RelationDefinitionPage
			client={createFakeRebac()}
			definitionId="rd_doc_viewer"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, create"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		oncreated.mockClear();
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('rb.def.new.submit') });
		// Nothing is sent while a part is empty.
		await userEvent.click(canvas.getByRole('button', { name: t('rb.def.new.submit') }));
		await canvas.findByText(t('rb.def.objectTypeRequired'));
		await canvas.findByText(t('rb.expr.nameRequired'));
		await choose(canvas, t('rb.def.objectType'), 'folder');
		await userEvent.type(labelled(canvas, t('rb.def.relationName')), 'editor');
		await userEvent.selectOptions(labelled(canvas, t('rb.expr.kind')), 'union');
		const relations = canvas.getAllByLabelText(t('rb.expr.relation'));
		await userEvent.type(relations[0], 'editor');
		await userEvent.type(relations[1], 'owner');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.def.new.submit') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<RelationDefinitionPage
			client={createFakeRebac()}
			definitionId="new"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, create one that exists"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('rb.def.new.submit') });
		await choose(canvas, t('rb.def.objectType'), 'document');
		await userEvent.type(labelled(canvas, t('rb.def.relationName')), 'viewer');
		await userEvent.type(canvas.getByLabelText(t('rb.expr.relation')), 'viewer');
		await userEvent.click(canvas.getByRole('button', { name: t('rb.def.new.submit') }));
		await canvas.findByText(t('rb.error.definitionExists'));
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac()}
			definitionId="new"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, a shape the builder cannot draw (JSON)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('rb.def.jsonMode'));
		await expect(await canvas.findByText(/"weighted"/)).toBeVisible();
		// The builder is not offered back for it.
		await expect(canvas.getByRole('button', { name: t('rb.def.asBuilder') })).toBeDisabled();
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac({
				definitions: [
					definition('rd_odd', 'document', 'reviewer', {
						type: 'union',
						children: [{ type: 'direct', relation: 'reviewer' }],
						weighted: true
					})
				]
			})}
			definitionId="rd_odd"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, stored one cannot be read"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('rb.def.unusableBody'));
		await expect(canvas.getAllByText(t('rb.def.unusable')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac({
				definitions: [definition('rd_broken', 'document', 'reviewer', null, { unusable: true })]
			})}
			definitionId="rd_broken"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, malformed JSON is refused before sending"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('rb.def.jsonMode'));
		const box = canvas.getByRole('textbox', { name: t('rb.def.jsonLabel') });
		await userEvent.clear(box);
		await userEvent.type(box, 'not json', { delay: 0 });
		await userEvent.click(canvas.getByRole('button', { name: t('rb.def.save') }));
		await canvas.findByText(t('rb.def.jsonInvalid'));
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac({
				definitions: [definition('rd_broken', 'document', 'reviewer', null, { unusable: true })]
			})}
			definitionId="rd_broken"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('rb.def.readOnly'));
		await expect(canvas.queryByRole('button', { name: t('rb.def.save') })).toBeNull();
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac()}
			definitionId="rd_doc_viewer"
			access={readOnly}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Definition, not found"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('rb.def.notFound'));
	}}
>
	{#snippet template()}
		<RelationDefinitionPage
			client={createFakeRebac()}
			definitionId="rd_gone"
			access={tenant}
			listHref="#definitions"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import type { CsvImportKind } from '#lib/api/identifier-materials.js';
	import CsvImportDemo from '../stories/CsvImportDemo.svelte';
	import CsvImportDialog from './CsvImportDialog.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/CSV import',
		component: CsvImportDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Imports a CSV into what the persistent identifier step names: an **identifier source** (`account,value`), a **store of identifiers** (`audience,account,identifier`) or an **exception list** (`account,audience,action,salt`). The file is chosen (FileDrop) or pasted; a chosen file’s text goes into the field, so it can be looked at.\n\nAll rows are written or none. Rows the server refuses are listed by line, column and reason (never the value). Another value for accounts already in a source or store asks before replacing them (their identifiers change); a value another account holds is never replaced. An exception list is **always replaced as a whole**, so that is asked first when the list exists, and a file with only its header line empties it (the dialog says so).'
				}
			}
		}
	});

	const dialogOf = (canvasElement: HTMLElement, kind: CsvImportKind) =>
		within(canvasElement.ownerDocument.body).getByRole('dialog', {
			name: t(`pid.csv.title.${kind}` as MessageKey)
		});

	/** Paste a file's content and send it. */
	async function importCsv(canvasElement: HTMLElement, kind: CsvImportKind, csv: string) {
		const dialog = dialogOf(canvasElement, kind);
		await waitFor(() => expect(dialog).toBeVisible());
		await userEvent.click(within(dialog).getByRole('textbox', { name: t('pid.csv.paste') }));
		await userEvent.paste(csv);
		await userEvent.click(within(dialog).getByRole('button', { name: t('pid.csv.submit') }));
	}

	const outcome = (canvasElement: HTMLElement) => within(canvasElement).getByTestId('outcome');
	const confirmDialog = (canvasElement: HTMLElement, title: string) =>
		within(canvasElement.ownerDocument.body).findByRole('dialog', { name: title });
</script>

<Story
	name="Identifier source"
	play={async ({ canvasElement }) => {
		await importCsv(canvasElement, 'source', 'account,value\nusr_02,E1002\nusr_03,E1003');
		await waitFor(() =>
			expect(outcome(canvasElement)).toHaveTextContent(
				t('pid.result.pairs', { name: 'employee-number', created: 2, replaced: 0, unchanged: 0 })
			)
		);
	}}
>
	{#snippet template()}<CsvImportDemo kind="source" name="employee-number" />{/snippet}
</Story>

<Story
	name="Rows with errors"
	play={async ({ canvasElement }) => {
		await importCsv(canvasElement, 'source', 'account,value\nunknown_9,E9\nusr_03');
		const dialog = dialogOf(canvasElement, 'source');
		// Nothing is saved: the dialog stays open and lists each refused row.
		await expect(
			await within(dialog).findByText(t('pid.csv.rowsTitle', { count: 2 }))
		).toBeVisible();
		await expect(
			within(dialog).getByText(
				t('pid.csv.rowItem', {
					row: 2,
					column: 'account',
					reason: t('pid.rowError.unknown_account')
				})
			)
		).toBeVisible();
		await expect(
			within(dialog).getByText(
				t('pid.csv.rowItemWhole', { row: 3, reason: t('pid.rowError.field_count') })
			)
		).toBeVisible();
		await expect(outcome(canvasElement)).toHaveTextContent('');
	}}
>
	{#snippet template()}<CsvImportDemo kind="source" name="employee-number" />{/snippet}
</Story>

<Story
	name="Another value for an account: replace"
	play={async ({ canvasElement }) => {
		await importCsv(canvasElement, 'source', 'account,value\nusr_01,E9999');
		const confirm = await confirmDialog(
			canvasElement,
			t('pid.csv.replaceTitle.source', { count: 1 })
		);
		await userEvent.click(
			within(confirm).getByRole('button', { name: t('pid.csv.replaceConfirm') })
		);
		await waitFor(() =>
			expect(outcome(canvasElement)).toHaveTextContent(
				t('pid.result.pairs', { name: 'employee-number', created: 0, replaced: 1, unchanged: 0 })
			)
		);
	}}
>
	{#snippet template()}<CsvImportDemo kind="source" name="employee-number" />{/snippet}
</Story>

<Story
	name="Store: an identifier another account holds"
	play={async ({ canvasElement }) => {
		await importCsv(
			canvasElement,
			'store',
			'audience,account,identifier\nhttps://sp.example.org,usr_02,abc123'
		);
		const dialog = dialogOf(canvasElement, 'store');
		// Never replaced, so no question is asked: the file has to change.
		await expect(
			await within(dialog).findByText(t('pid.csv.error.othersValues', { count: 1 }))
		).toBeVisible();
	}}
>
	{#snippet template()}<CsvImportDemo kind="store" name="legacy-ids" />{/snippet}
</Story>

<Story
	name="Exceptions: replaces the whole list"
	play={async ({ canvasElement }) => {
		await importCsv(
			canvasElement,
			'exceptions',
			'account,audience,action,salt\n*,https://sp.example.org,salt,legacy-idp\nusr_01,*,block,'
		);
		const confirm = await confirmDialog(
			canvasElement,
			t('pid.csv.listReplaceTitle', { name: 'exception-map' })
		);
		await expect(confirm).toHaveTextContent(t('pid.csv.listReplaceBody'));
		await userEvent.click(
			within(confirm).getByRole('button', { name: t('pid.csv.replaceConfirm') })
		);
		await waitFor(() =>
			expect(outcome(canvasElement)).toHaveTextContent(
				t('pid.result.exceptions', { name: 'exception-map', rows: 2, salts: 1, blocks: 1 })
			)
		);
	}}
>
	{#snippet template()}<CsvImportDemo kind="exceptions" name="exception-map" />{/snippet}
</Story>

<Story
	name="Exceptions: only the header empties the list"
	play={async ({ canvasElement }) => {
		const dialog = dialogOf(canvasElement, 'exceptions');
		// The dialog says so before anything is sent.
		await expect(dialog).toHaveTextContent(t('pid.csv.replacesList'));
		await importCsv(canvasElement, 'exceptions', 'account,audience,action,salt\n');
		const confirm = await confirmDialog(
			canvasElement,
			t('pid.csv.listReplaceTitle', { name: 'exception-map' })
		);
		await expect(confirm).toHaveTextContent(t('pid.csv.listEmptyBody'));
		await userEvent.click(
			within(confirm).getByRole('button', { name: t('pid.csv.listEmptyConfirm') })
		);
		await waitFor(() =>
			expect(outcome(canvasElement)).toHaveTextContent(
				t('pid.result.exceptionsEmptied', { name: 'exception-map' })
			)
		);
	}}
>
	{#snippet template()}<CsvImportDemo kind="exceptions" name="exception-map" />{/snippet}
</Story>

<Story
	name="Exceptions: asks even when the lists are not known"
	play={async ({ canvasElement }) => {
		// The page may still be loading its lists, or have failed to: the dialog does not depend
		// on them, so a header-only file never empties a list without the question.
		await importCsv(canvasElement, 'exceptions', 'account,audience,action,salt');
		const confirm = await confirmDialog(
			canvasElement,
			t('pid.csv.listReplaceTitle', { name: 'unseen-list' })
		);
		await expect(confirm).toHaveTextContent(t('pid.csv.listEmptyBody'));
		await userEvent.click(
			within(confirm).getByRole('button', { name: t('pid.csv.listEmptyConfirm') })
		);
		await waitFor(() =>
			expect(outcome(canvasElement)).toHaveTextContent(
				t('pid.result.exceptionsEmptied', { name: 'unseen-list' })
			)
		);
	}}
>
	{#snippet template()}<CsvImportDemo kind="exceptions" name="unseen-list" />{/snippet}
</Story>

<Story
	name="A file that cannot be read sends nothing"
	play={async ({ canvasElement }) => {
		const dialog = dialogOf(canvasElement, 'source');
		await waitFor(() => expect(dialog).toBeVisible());
		const good = new File(['account,value\nusr_02,E1002'], 'good.csv', { type: 'text/csv' });
		const bad = new File(['x'], 'bad.csv', { type: 'text/csv' });
		Object.defineProperty(bad, 'text', { value: () => Promise.reject(new Error('unreadable')) });
		const input = dialog.querySelector<HTMLInputElement>('input[type=file]')!;
		await userEvent.upload(input, good);
		const field = within(dialog).getByRole('textbox', { name: t('pid.csv.paste') });
		await waitFor(() => expect(field).toHaveValue('account,value\nusr_02,E1002'));
		// The next file fails to read: the first file's content is gone, not sent under its name.
		await userEvent.upload(input, bad);
		await waitFor(() => expect(field).toHaveValue(''));
		await expect(await within(dialog).findByText(t('pid.csv.error.readFailed'))).toBeVisible();
		await userEvent.click(within(dialog).getByRole('button', { name: t('pid.csv.submit') }));
		await expect(await within(dialog).findByText(t('pid.csv.error.empty'))).toBeVisible();
		await expect(outcome(canvasElement)).toHaveTextContent('');
	}}
>
	{#snippet template()}<CsvImportDemo kind="source" name="employee-number" />{/snippet}
</Story>

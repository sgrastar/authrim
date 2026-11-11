import { screenLinkExits } from '@authrim/ar-lib-core/types/screens';
import type { ScreenField } from '#lib/api/screens.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { groupLabel, partDef, partTitle, visibleGroups } from './account-flow-model';
import type { AccountFlowState, FlowId } from './flow-spec';

/**
 * Where a screen step's ways out lead. A screen only says what its buttons and links do (go on,
 * skip, leave by an exit of its own name, go back); the flow says where each way out leads, so the
 * same screen can be used in another flow, with other destinations. Dummy, like the rest of the
 * flow page: nothing is saved anywhere.
 */

/** A way out of a screen: its handle (`submitted`, `skipped` or an exit's name) and its name. */
export interface ScreenExit {
	exit: string;
	label: string;
}

/** The ways out of a screen, in order: its submit first, then those its link parts add. */
export function screenExitsOf(fields: readonly ScreenField[]): ScreenExit[] {
	const exits: ScreenExit[] = [{ exit: 'submitted', label: t('af.exit.submitted') }];
	for (const exit of screenLinkExits(fields)) {
		// The words of the first part that leaves by it.
		const label =
			fields.find((field) =>
				exit === 'skipped' ? field.link_action === 'skip' : field.link_exit === exit
			)?.label ?? exit;
		exits.push({
			exit,
			label:
				exit === 'skipped'
					? t('af.exit.skipped', { label })
					: t('af.exit.named', { label, name: exit })
		});
	}
	return exits;
}

/** The link parts of a screen that go back (to the screen before): by their words. */
export function backLinksOf(fields: readonly ScreenField[]): string[] {
	return fields
		.filter(
			(field) =>
				field.block_type === 'link' &&
				field.link_action === 'back' &&
				field.display_condition?.mode !== 'hidden'
		)
		.map((field) => field.label);
}

/** Where a way out's destination is kept among the flow's values (beside the screen's own key). */
export function exitKey(fieldKey: string, exit: string): string {
	return `${fieldKey}>${exit}`;
}

/** Whether a value of the flow is a destination of one of the ways out of a screen field. */
export function isExitKeyOf(fieldKey: string, key: string): boolean {
	return key.startsWith(`${fieldKey}>`);
}

/**
 * The places a way out of the step `fromGroup` can lead: on to the next step (the default; for a
 * way out other than the submit, wherever the submit goes), or any other step the flow has now.
 */
export function exitDestinations(
	flow: FlowId,
	state: AccountFlowState,
	fromGroup: string | undefined,
	exit: string
): { value: string; label: string }[] {
	return [
		{
			value: '',
			label: exit === 'submitted' ? t('af.exit.dest.next') : t('af.exit.dest.asSubmitted')
		},
		...visibleGroups(flow, state)
			.filter((group) => group.id !== fromGroup)
			.map((group) => {
				// A screen step by its own title: every screen step has the same name.
				const own = group.parts.length === 1 && partDef(group.parts[0]).renamable;
				return {
					value: group.id,
					label: own ? partTitle(group.parts[0], state) : groupLabel(group)
				};
			})
	];
}

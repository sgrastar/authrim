/**
 * The consent statements a flow asks, as the console holds them: an ordered list of
 * `<statement id>:required` / `<statement id>:optional` entries (a flow value is a list of
 * strings), and the spec's `{ statement_id, required }` it is saved as. An entry may carry how
 * its text is shown, after a `|` (an id may hold `:` but never `|`): `|inline` or `|modal`, and
 * `|scroll` or `|noscroll` (the text has to be scrolled to its end, or has not). Without them the
 * entry follows the screen's consent widget.
 */
import type { ConsentStatementListItem } from '#lib/api/consent-statements.js';
import {
	statementName,
	statementStatus
} from '#lib/pages/customization/statements/statement-model.js';
import { screenShowsConsentWidget } from '@authrim/ar-lib-core/types/screens';
import type { FlowConsentStatement } from '@authrim/ar-lib-core/services/flow-consent-statements';
import type { FlowConsentStep } from '@authrim/ar-lib-core/types/flow-step-condition';
import type { AccountFlowState, AccountValue } from './flow-spec';
import { valueOfWhen, whenOf } from './step-condition-model';

/** The most statements one step can ask (`MAX_FLOW_CONSENT_STATEMENTS` in ar-lib-core). */
export const MAX_CONSENT_STATEMENTS = 50;

export type ConsentTextDisplay = 'inline' | 'modal';

export interface ConsentEntry {
	statementId: string;
	required: boolean;
	/** How its text is shown; absent: as the screen's consent widget says. */
	display?: ConsentTextDisplay;
	/** Whether its text has to be scrolled to its end first; absent: as the widget says. */
	requireScroll?: boolean;
}

export function encodeConsent(entry: ConsentEntry): string {
	const head = `${entry.statementId}:${entry.required ? 'required' : 'optional'}`;
	const flags = [
		...(entry.display ? [entry.display] : []),
		...(entry.requireScroll === undefined ? [] : [entry.requireScroll ? 'scroll' : 'noscroll'])
	];
	return [head, ...flags].join('|');
}

export function decodeConsent(value: string): ConsentEntry | null {
	const [head, ...flags] = value.split('|');
	const at = head.lastIndexOf(':');
	if (at <= 0) return null;
	const flag = head.slice(at + 1);
	if (flag !== 'required' && flag !== 'optional') return null;
	const entry: ConsentEntry = { statementId: head.slice(0, at), required: flag === 'required' };
	for (const token of flags) {
		if (token === 'inline' || token === 'modal') entry.display = token;
		else if (token === 'scroll') entry.requireScroll = true;
		else if (token === 'noscroll') entry.requireScroll = false;
		else return null;
	}
	return entry;
}

/** The entries of a flow value, in order (anything unreadable is dropped). */
export function consentEntries(value: AccountValue | undefined): ConsentEntry[] {
	return (Array.isArray(value) ? value : []).flatMap((item) => decodeConsent(item) ?? []);
}

export function consentValue(entries: readonly ConsentEntry[]): string[] {
	return entries.map(encodeConsent);
}

/** The spec's statements for a flow value (each statement once). */
export function consentSpecOf(value: AccountValue | undefined): FlowConsentStatement[] {
	const seen = new Set<string>();
	return consentEntries(value).flatMap((entry) => {
		if (seen.has(entry.statementId)) return [];
		seen.add(entry.statementId);
		return [specOf(entry)];
	});
}

function specOf(entry: ConsentEntry): FlowConsentStatement {
	return {
		statement_id: entry.statementId,
		required: entry.required,
		...(entry.display ? { display: entry.display } : {}),
		...(entry.requireScroll === undefined ? {} : { require_scroll: entry.requireScroll })
	};
}

const CONSENT_STEP = /^consent:([1-9][0-9]*)$/u;

/** The consent steps a flow has (`consent:<n>`), in order of their number. */
export function consentStepNumbers(added: readonly string[]): number[] {
	return added
		.flatMap((id) => {
			const match = CONSENT_STEP.exec(id);
			return match ? [Number(match[1])] : [];
		})
		.sort((a, b) => a - b);
}

/**
 * The consent steps a flow asks, in order: each added step with the statements chosen in it and
 * who it is shown to (a step with nothing chosen asks nothing, and is left out).
 */
export function consentStepsOf(
	state: AccountFlowState,
	prefix: 'reg' | 'login'
): FlowConsentStep[] {
	return consentStepNumbers(state.added).flatMap((n) => {
		const statements = consentSpecOf(state.values[`${prefix}.statements:${n}`]);
		if (statements.length === 0) return [];
		const when = whenOf(state.values[`${prefix}.statementsWhen:${n}`]);
		return [when.length > 0 ? { statements, when } : { statements }];
	});
}

/**
 * Sets a spec's consent steps in the flow (`consent:1`, `consent:2`, …); false when one is shown
 * on conditions the form cannot show (the flow is then shown, not saved).
 */
export function setConsentSteps(
	state: AccountFlowState,
	prefix: 'reg' | 'login',
	steps: readonly FlowConsentStep[]
): boolean {
	let fits = true;
	steps.forEach((step, index) => {
		const n = index + 1;
		state.added.push(`consent:${n}`);
		state.values[`${prefix}.statements:${n}`] = consentValueOf(step.statements);
		const when = valueOfWhen(step.when);
		if (when === null) fits = false;
		else if (when.length > 0) state.values[`${prefix}.statementsWhen:${n}`] = when;
	});
	return fits;
}

/** The flow value for a spec's statements. */
export function consentValueOf(statements: readonly FlowConsentStatement[]): string[] {
	return consentValue(
		statements.map((entry) => ({
			statementId: entry.statement_id,
			required: entry.required,
			...(entry.display ? { display: entry.display } : {}),
			...(entry.require_scroll === undefined ? {} : { requireScroll: entry.require_scroll })
		}))
	);
}

/** Moves the entry at `index` by `by` places (no change at either end). */
export function moveEntry<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
	const target = index + by;
	if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
	const next = [...list];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

/** Whether a statement can be asked now: turned on, with a published current version. */
export function isChoosable(item: ConsentStatementListItem): boolean {
	return statementStatus(item.statement, item.current) === 'active';
}

/** What to call a chosen statement: its name, or its id when it is not among the tenant's. */
export function consentLabel(
	statementId: string,
	items: readonly ConsentStatementListItem[],
	locale: string
): { name: string; known: boolean; choosable: boolean } {
	const item = items.find((candidate) => candidate.statement.id === statementId);
	if (!item) return { name: statementId, known: false, choosable: false };
	return {
		name: statementName(item.titles, locale, item.statement.slug),
		known: true,
		choosable: isChoosable(item)
	};
}

/** Whether a screen draws a consent box that is shown (the rule the publish check applies). */
export function screenHasConsentWidget(
	fields: Parameters<typeof screenShowsConsentWidget>[0]
): boolean {
	return screenShowsConsentWidget(fields);
}

/** The key holding the statements the first sign-up screen asks itself (it has a consent box). */
export const FIRST_SCREEN_STATEMENTS_KEY = 'reg.screenStatements';

/**
 * Where the statements a sign-up screen step asks on the screen itself are kept: the first screen
 * (`reg-screen`) and each more screen (`reg-extra-screen:<n>`) hold their own. These are stored
 * on the screen's own node, apart from the flow's consent steps; null for any other part.
 */
export function screenStatementsKey(part: string): string | null {
	if (part === 'reg-screen') return FIRST_SCREEN_STATEMENTS_KEY;
	const match = /^reg-extra-screen:(\d+)$/u.exec(part);
	return match ? `reg.extraScreenStatements:${match[1]}` : null;
}

/** The statement ids two lists both ask (what a person would be asked twice). */
export function sharedStatementIds(
	a: AccountValue | undefined,
	b: AccountValue | undefined
): string[] {
	const ids = new Set(consentEntries(a).map((entry) => entry.statementId));
	return [...new Set(consentEntries(b).map((entry) => entry.statementId))].filter((id) =>
		ids.has(id)
	);
}

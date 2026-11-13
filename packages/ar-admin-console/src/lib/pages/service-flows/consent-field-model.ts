/**
 * The consent statements a flow asks, as the console holds them: an ordered list of
 * `<statement id>:required` / `<statement id>:optional` entries (a flow value is a list of
 * strings), and the spec's `{ statement_id, required }` it is saved as.
 */
import type { ConsentStatementListItem } from '#lib/api/consent-statements.js';
import {
	statementName,
	statementStatus
} from '#lib/pages/customization/statements/statement-model.js';
import type { AccountValue } from './flow-spec';

/** The most statements one step can ask (`MAX_FLOW_CONSENT_STATEMENTS` in ar-lib-core). */
export const MAX_CONSENT_STATEMENTS = 50;

export interface ConsentEntry {
	statementId: string;
	required: boolean;
}

export function encodeConsent(entry: ConsentEntry): string {
	return `${entry.statementId}:${entry.required ? 'required' : 'optional'}`;
}

export function decodeConsent(value: string): ConsentEntry | null {
	const at = value.lastIndexOf(':');
	if (at <= 0) return null;
	const flag = value.slice(at + 1);
	if (flag !== 'required' && flag !== 'optional') return null;
	return { statementId: value.slice(0, at), required: flag === 'required' };
}

/** The entries of a flow value, in order (anything unreadable is dropped). */
export function consentEntries(value: AccountValue | undefined): ConsentEntry[] {
	return (Array.isArray(value) ? value : []).flatMap((item) => decodeConsent(item) ?? []);
}

export function consentValue(entries: readonly ConsentEntry[]): string[] {
	return entries.map(encodeConsent);
}

/** The spec's statements for a flow value (each statement once). */
export function consentSpecOf(
	value: AccountValue | undefined
): { statement_id: string; required: boolean }[] {
	const seen = new Set<string>();
	return consentEntries(value).flatMap((entry) => {
		if (seen.has(entry.statementId)) return [];
		seen.add(entry.statementId);
		return [{ statement_id: entry.statementId, required: entry.required }];
	});
}

/** The flow value for a spec's statements. */
export function consentValueOf(
	statements: readonly { statement_id: string; required: boolean }[]
): string[] {
	return consentValue(
		statements.map((entry) => ({ statementId: entry.statement_id, required: entry.required }))
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

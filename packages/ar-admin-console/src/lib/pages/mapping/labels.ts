/**
 * Words the mapping pages share. The source is always one of four fixed words (クライアント指定／
 * テナント既定／プラットフォーム既定／なし), and "not set" and "not used" are never the same
 * text. Everything here only names what the API returned; nothing works out a selection.
 */
import type {
	ChainEntry,
	ClaimChange,
	EffectiveSelection,
	LevelValue,
	MappingTier,
	SetFacts
} from '$lib/api/identity-mapping';
import { hasMessage, t } from '$lib/i18n/i18n.svelte';

/** The message for `key`, or the raw value when there is none (a code the API adds later). */
export function label(prefix: string, value: string): string {
	const key = `${prefix}${value}`;
	return hasMessage(key) ? t(key) : value;
}

export const tierLabel = (tier: MappingTier): string => label('mc.tier.', tier);

/** A set's name, with its state when it cannot be used. */
export function setText(setId: string | undefined, facts: SetFacts = {}): string {
	const name = facts.setName ?? setId ?? t('mc.set.unnamed');
	if (facts.setFound === false)
		return t('mc.set.withState', { set: name, state: t('mc.set.missing') });
	if (facts.setLifecycleState && facts.setLifecycleState !== 'active') {
		return t('mc.set.withState', { set: name, state: t('mc.set.inactive') });
	}
	return name;
}

/** True when the set a level names is there and switched on (as far as the API says). */
export const setUsable = (facts: SetFacts): boolean =>
	facts.setFound !== false &&
	(facts.setLifecycleState === undefined || facts.setLifecycleState === 'active');

/** The source word of a selection: one of the four, or the failure. */
export function sourceText(selection: EffectiveSelection): string {
	if (selection.kind === 'bound') return tierLabel(selection.tier);
	if (selection.kind === 'none') return t('mc.tier.none');
	return t('mc.failed', { tier: selection.tier ? tierLabel(selection.tier) : '' });
}

/** What is in effect: the set, or the kind of "none". */
export function effectText(selection: EffectiveSelection): string {
	if (selection.kind === 'bound') return setText(selection.setId, selection);
	if (selection.kind === 'none') return label('mc.none.', selection.reason);
	return t('mc.failed', { tier: selection.tier ? tierLabel(selection.tier) : '' });
}

/** The value one level of the chain holds. */
export function chainValueText(entry: ChainEntry): string {
	if (entry.state === 'set') return setText(entry.setId, entry);
	return label('mc.state.', entry.state);
}

export function levelValueText(value: LevelValue): string {
	if (value.state === 'set') return value.setName ?? value.setId ?? t('mc.set.unnamed');
	return label('mc.state.', value.state);
}

export function changeText(change: ClaimChange): string {
	return t(`mc.ch.kind.${change.kind}`, {
		claim: change.claim,
		from: change.previous_claim ?? change.type_before ?? '',
		to: change.type_after ?? ''
	});
}

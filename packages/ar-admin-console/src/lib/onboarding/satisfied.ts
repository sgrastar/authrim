/**
 * Items an admin may already have done before the checklist ever showed them. The checklist asks
 * the environment once, and checks such an item itself (and keeps it, like any finished item) so
 * nobody is asked to practise what they have set up. Items not listed here are never checked for
 * the admin: they are done by walking through them, or checked by hand.
 *
 * To add one: key it by the item's `id` in `checklist.ts` and answer true only when the thing is
 * certainly in place. A probe that fails or answers false leaves the item as it is.
 */
import { httpSecondFactors } from '#lib/api/second-factors.js';

export type Probe = () => Promise<boolean>;

export const SATISFIED_BY: Readonly<Record<string, Probe>> = {
	// Any second factor that is in use: a security key, a Keyring holder key or an authenticator app.
	'second-factor': async () => (await httpSecondFactors.list()).active_count > 0
};

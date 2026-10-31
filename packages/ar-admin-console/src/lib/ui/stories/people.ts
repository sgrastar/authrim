import type { PickerItem } from '../patterns/EntityPicker.svelte';

/** Storybook sample directory for EntityPicker: people found by name or email. */
export const PEOPLE: readonly PickerItem[] = [
	['u-aiko', 'Aiko Tanaka', 'aiko@example.com'],
	['u-ben', 'Ben Carter', 'ben@example.com'],
	['u-chloe', 'Chloé Martin', 'chloe@example.com'],
	['u-daniel', 'Daniel Weber', 'daniel@example.com'],
	['u-emi', 'Emi Sato', 'emi@example.com'],
	['u-farah', 'Farah Haddad', 'farah@example.com'],
	['u-alex', 'Alex Kim', 'alex@example.com']
].map(([value, label, description]) => ({ value, label, description, icon: 'userCircle' }));

/** Answers after a short delay, like the Admin API would; stops when aborted. */
export function searchPeople(query: string, signal: AbortSignal): Promise<PickerItem[]> {
	const q = query.toLowerCase();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			resolve(
				PEOPLE.filter(
					(person) =>
						!q || person.label.toLowerCase().includes(q) || (person.description ?? '').includes(q)
				).slice(0, 6)
			);
		}, 150);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		});
	});
}

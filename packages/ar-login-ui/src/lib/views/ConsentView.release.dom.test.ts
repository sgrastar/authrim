// @vitest-environment jsdom
import { render, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import { consentBase, informationRelease } from './consent-fixtures';
import ConsentView from './ConsentView.svelte';

function mount(release = informationRelease, locale: 'en' | 'ja' = 'en') {
	setLocale(locale);
	return render(ConsentView, {
		props: { consentData: { ...consentBase, information_release: release } }
	});
}

describe('the information release section of the consent view (real DOM)', () => {
	beforeEach(() => setLocale('en'));

	it('lists the information shared with the app, in the standard claims labels', () => {
		const { getByRole } = mount();
		const section = getByRole('group', { name: 'Information shared with Acme Dashboard' });
		expect(within(section).getByText('Email address')).toBeTruthy();
		expect(within(section).getByText('Phone number')).toBeTruthy();
		// A claim without a label of its own is shown by its name.
		expect(within(section).getByText('employee_number')).toBeTruthy();
	});

	it('shows required items as rows that cannot be unticked, marked Required', () => {
		const { container } = mount();
		const row = container.querySelector('[data-release-item="email"]') as HTMLElement;
		expect(row.dataset.required).toBe('true');
		expect(row.querySelector('input')).toBeNull();
		expect(within(row).getByText('Required')).toBeTruthy();
	});

	it('shows optional items as labelled checkboxes, checked only when approved before', async () => {
		const { getByRole } = mount();
		const phone = getByRole('checkbox', { name: 'Phone number' }) as HTMLInputElement;
		const birthdate = getByRole('checkbox', { name: 'Date of birth' }) as HTMLInputElement;
		const unset = getByRole('checkbox', { name: 'employee_number' }) as HTMLInputElement;
		expect(phone.checked).toBe(true);
		expect(birthdate.checked).toBe(false);
		expect(unset.checked).toBe(false);
		await userEvent.click(phone);
		await userEvent.click(birthdate);
		expect(phone.checked).toBe(false);
		expect(birthdate.checked).toBe(true);
	});

	it('shows values only when the app shows them, as plain text', () => {
		const shown = mount();
		expect(shown.queryByText('ada.release@example.com')).toBeTruthy();
		expect(shown.queryByText('street: 1 Main St; locality: Tokyo')).toBeTruthy();
		// Markup in a value is text, never an element.
		expect(shown.container.querySelector('b')).toBeNull();
		shown.unmount();
		const hidden = mount({ ...informationRelease, show_values: false });
		expect(hidden.queryByText('ada.release@example.com')).toBeNull();
	});

	it('shows the purpose as text with a validated link', () => {
		const { getByTestId } = mount();
		const purpose = getByTestId('release-purpose');
		expect(within(purpose).getByText('Sign-in and account notices')).toBeTruthy();
		expect(purpose.textContent).toContain('<b>not bold</b>');
		expect(purpose.querySelector('b')).toBeNull();
		expect(purpose.querySelector('a')?.getAttribute('href')).toBe('https://example.com/purpose');
	});

	it('does not link a purpose document that is not a web link', () => {
		const { getByTestId } = mount({
			...informationRelease,
			purpose: { ...informationRelease.purpose!, document_url: 'javascript:alert(1)' }
		});
		expect(getByTestId('release-purpose').querySelector('a')).toBeNull();
	});

	it('draws nothing when there is no information release, as before', () => {
		setLocale('en');
		const { queryByTestId } = render(ConsentView, { props: { consentData: consentBase } });
		expect(queryByTestId('information-release')).toBeNull();
	});

	it('uses the page language for labels', () => {
		const { getByRole } = mount(informationRelease, 'ja');
		expect(getByRole('checkbox', { name: '電話番号' })).toBeTruthy();
	});
});

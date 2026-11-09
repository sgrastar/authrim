import { createFakeLoginUiThemes } from '#lib/api/fake/login-ui-themes-fake.js';
import type { LoginUiThemesClient, ThemeValues } from '#lib/api/login-ui-themes.js';

/**
 * The mock's saved themes: none at first, as for a new tenant. What is created, saved, applied or
 * deleted stays while the mock is open.
 */
const themes = createFakeLoginUiThemes({ delay: 150 });
let appliedValues: ThemeValues = {};

export const mockThemes: LoginUiThemesClient = {
	...themes,
	async apply(id, version) {
		const active = await themes.apply(id, version);
		appliedValues = structuredClone((await themes.get(id)).theme.values);
		return active;
	}
};

/** The mock keeps the version applied even when the saved theme is edited again. */
export async function mockAppliedThemeValues(): Promise<ThemeValues> {
	return structuredClone(appliedValues);
}

/** The mock has no asset store: a chosen image is shown from the browser's own copy. */
export async function mockUploadAsset(_kind: string, file: File): Promise<string> {
	return URL.createObjectURL(file);
}

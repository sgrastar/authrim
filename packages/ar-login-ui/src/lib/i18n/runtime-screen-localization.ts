type RuntimeScreenRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuntimeScreenRecord {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function localizationKey(field: RuntimeScreenRecord, index: number): string {
	return readText(field.block_id) ?? `${readText(field.field) ?? 'field'}-${index}`;
}

function localeCandidates(locale: string): string[] {
	const normalized = locale.replace('_', '-');
	const base = normalized.split('-')[0];
	return [...new Set([normalized, base, 'en'])];
}

function selectLocalization(
	localizations: RuntimeScreenRecord,
	locale: string
): RuntimeScreenRecord | null {
	for (const candidate of localeCandidates(locale)) {
		const localization = localizations[candidate];
		if (isRecord(localization)) return localization;
	}
	return null;
}

function localizedFieldValue(
	localizedField: RuntimeScreenRecord | null,
	englishField: RuntimeScreenRecord | null,
	property: 'label' | 'text' | 'help_text' | 'placeholder',
	fallback: unknown
): unknown {
	return readText(localizedField?.[property]) ?? readText(englishField?.[property]) ?? fallback;
}

/**
 * Reapplies the selected localization to a hydrated runtime screen.
 *
 * The runtime API localizes `fields` for the language used when an interaction starts, while also
 * returning the complete `localizations` map. Applying that map again in the browser keeps every
 * screen block in sync when the user changes language without restarting the interaction.
 */
export function localizeRuntimeScreen(
	screen: RuntimeScreenRecord | null,
	locale: string
): RuntimeScreenRecord | null {
	if (!screen || !Array.isArray(screen.fields) || !isRecord(screen.localizations)) return screen;

	const localization = selectLocalization(screen.localizations, locale);
	const englishLocalization = isRecord(screen.localizations.en) ? screen.localizations.en : null;
	const localizedFields = isRecord(localization?.fields) ? localization.fields : {};
	const englishFields = isRecord(englishLocalization?.fields) ? englishLocalization.fields : {};

	return {
		...screen,
		display_name:
			readText(localization?.display_name) ??
			readText(englishLocalization?.display_name) ??
			screen.display_name,
		description:
			readText(localization?.description) ??
			readText(englishLocalization?.description) ??
			screen.description,
		fields: screen.fields.map((value, index) => {
			if (!isRecord(value)) return value;
			const key = localizationKey(value, index);
			const localizedField = isRecord(localizedFields[key]) ? localizedFields[key] : null;
			const englishField = isRecord(englishFields[key]) ? englishFields[key] : null;
			return {
				...value,
				label: localizedFieldValue(localizedField, englishField, 'label', value.label),
				text: localizedFieldValue(localizedField, englishField, 'text', value.text),
				help_text: localizedFieldValue(localizedField, englishField, 'help_text', value.help_text),
				placeholder: localizedFieldValue(
					localizedField,
					englishField,
					'placeholder',
					value.placeholder
				)
			};
		})
	};
}

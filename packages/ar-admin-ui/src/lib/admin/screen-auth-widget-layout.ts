type ScreenFieldLike = {
	field?: string | null;
	block_type?: string | null;
};

export function isEmailIdentityField(field: ScreenFieldLike): boolean {
	if ((field.block_type ?? 'identity_field') !== 'identity_field') return false;
	const fieldName = field.field?.trim().toLowerCase() ?? '';
	return fieldName === 'email' || fieldName.endsWith('.email');
}

export function shouldShowAuthWidgetEmailInput(
	screenKind: string,
	fields: ScreenFieldLike[]
): boolean {
	return screenKind !== 'registration' || !fields.some(isEmailIdentityField);
}

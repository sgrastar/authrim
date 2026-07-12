export function buildExternalIdPCallbackUrl(
	issuer: string | null | undefined,
	identifier: string | null | undefined
): string | null {
	const normalizedIssuer = issuer?.trim().replace(/\/+$/, '');
	const normalizedIdentifier = identifier?.trim();
	if (!normalizedIssuer || !normalizedIdentifier) {
		return null;
	}
	return `${normalizedIssuer}/auth/external/${normalizedIdentifier}/callback`;
}

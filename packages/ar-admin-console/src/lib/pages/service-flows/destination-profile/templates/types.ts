/** The kinds of destination profile a service flow makes (what Authrim sends to an app or service). */
export type DestinationProtocol = 'saml' | 'oidc';

/** A ready-made output source: its schema is copied into the editor, where it can be changed. */
export interface DestinationTemplate {
	id: string;
	destinationType: DestinationProtocol;
	category: string;
	profileKey: string;
	displayName: string;
	version: string;
	updatedAt: string;
	description: string;
	schema: Record<string, unknown>;
}

import { csvDestinationTemplates } from './csv';
import { oidcDestinationTemplates } from './oidc';
import { samlDestinationTemplates } from './saml';

export type { DestinationTemplate } from './types';

export const destinationTemplates = [
	...oidcDestinationTemplates,
	...samlDestinationTemplates,
	...csvDestinationTemplates
];

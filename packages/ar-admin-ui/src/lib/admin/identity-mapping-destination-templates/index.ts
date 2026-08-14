import { csvDestinationTemplates } from './csv';
import { oidcDestinationTemplates } from './oidc';
import { samlDestinationTemplates } from './saml';
import { resourceServerDestinationTemplates } from './resource-server';

export type { DestinationTemplate } from './types';

export const destinationTemplates = [
	...oidcDestinationTemplates,
	...resourceServerDestinationTemplates,
	...samlDestinationTemplates,
	...csvDestinationTemplates
];

import { oidcDestinationTemplates } from './oidc';
import { samlDestinationTemplates } from './saml';
import type { DestinationProtocol, DestinationTemplate } from './types';

export type { DestinationProtocol, DestinationTemplate };

export const destinationTemplates: readonly DestinationTemplate[] = [
	...samlDestinationTemplates,
	...oidcDestinationTemplates
];

/** The templates of one kind, in catalogue order. */
export function templatesFor(protocol: DestinationProtocol): DestinationTemplate[] {
	return destinationTemplates.filter((template) => template.destinationType === protocol);
}

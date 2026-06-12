import { csvSourceTemplates } from './csv';
import { samlSourceTemplates } from './saml';

export type { SourceTemplate } from './types';

export const sourceTemplates = [...csvSourceTemplates, ...samlSourceTemplates];

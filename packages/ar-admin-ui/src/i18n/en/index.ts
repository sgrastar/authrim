import type { BaseTranslation } from '../i18n-types';
import core from './core';
import auth from './auth';
import adminShell from './admin-shell';
import adminDashboard from './admin-dashboard';
import adminAccount from './admin-account';
import adminUsers from './admin-users';
import adminClients from './admin-clients';
import adminExternalIdp from './admin-external-idp';
import adminSaml from './admin-saml';
import adminDrBackup from './admin-dr-backup';
import adminOther from './admin-other';

const en: BaseTranslation = {
	...core,
	...auth,
	...adminShell,
	...adminDashboard,
	...adminAccount,
	...adminUsers,
	...adminClients,
	...adminExternalIdp,
	...adminSaml,
	...adminDrBackup,
	...adminOther
} satisfies BaseTranslation;

export default en;

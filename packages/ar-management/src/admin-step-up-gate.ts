/**
 * The admin step-up gate lives in ar-lib-core, shared by every worker that serves the Admin API;
 * this module keeps the management routes' import path.
 */
export { refuseAdminFreshAuth, requireAdminStepUp } from '@authrim/ar-lib-core';

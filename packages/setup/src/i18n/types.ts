/**
 * i18n Type Definitions for Authrim Setup Tool
 */

// Supported locales
export type Locale =
  | 'en'
  | 'ja'
  | 'zh-CN'
  | 'zh-TW'
  | 'es'
  | 'pt'
  | 'fr'
  | 'de'
  | 'ko'
  | 'ru'
  | 'id';

// Locale metadata for display
export interface LocaleInfo {
  code: Locale;
  name: string; // English name
  nativeName: string; // Native name for display
}

// All supported locales with their metadata
// Note: Flags intentionally omitted - languages ≠ countries (e.g., English spoken in US, UK, AU, etc.)
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
];

// Default locale
export const DEFAULT_LOCALE: Locale = 'en';

// Translation keys interface - flat structure for simplicity
export interface Translations {
  // Language selection
  'language.select': string;
  'language.selected': string;

  // Banner
  'banner.title': string;
  'banner.subtitle': string;
  'banner.exitHint': string;

  // Mode selection
  'mode.prompt': string;
  'mode.quick': string;
  'mode.quickDesc': string;
  'mode.advanced': string;
  'mode.advancedDesc': string;

  // Update check
  'update.checking': string;
  'update.available': string;
  'update.prompt': string;
  'update.continue': string;
  'update.continueDesc': string;
  'update.update': string;
  'update.updateDesc': string;
  'update.cancel': string;
  'update.cancelled': string;
  'update.current': string;

  // Source download
  'source.downloading': string;
  'source.downloaded': string;
  'source.extracting': string;
  'source.installing': string;
  'source.notInSourceDir': string;
  'source.downloadPrompt': string;
  'source.downloadOption': string;
  'source.downloadOptionDesc': string;
  'source.exitOption': string;
  'source.exitOptionDesc': string;

  // WSL Environment
  'wsl.detected': string;
  'wsl.explanation': string;
  'wsl.explanationCont': string;
  'wsl.securityNote': string;
  'wsl.securityWarning': string;
  'wsl.trustedNetworkOnly': string;
  'wsl.bindPrompt': string;
  'wsl.bindingToAll': string;
  'wsl.usingLocalhost': string;

  // Prerequisites
  'prereq.checking': string;
  'prereq.wranglerNotInstalled': string;
  'prereq.wranglerInstallHint': string;
  'prereq.notLoggedIn': string;
  'prereq.loginHint': string;
  'prereq.loggedInAs': string;
  'prereq.accountId': string;

  // Environment
  'env.prompt': string;
  'env.prod': string;
  'env.prodDesc': string;
  'env.staging': string;
  'env.stagingDesc': string;
  'env.dev': string;
  'env.devDesc': string;
  'env.custom': string;
  'env.customDesc': string;
  'env.customPrompt': string;
  'env.customValidation': string;
  'env.detected': string;
  'env.selectExisting': string;
  'env.createNew': string;
  'env.createNewDesc': string;

  // Region
  'region.prompt': string;
  'region.auto': string;
  'region.autoDesc': string;
  'region.wnam': string;
  'region.wnamDesc': string;
  'region.enam': string;
  'region.enamDesc': string;
  'region.weur': string;
  'region.weurDesc': string;
  'region.eeur': string;
  'region.eeurDesc': string;
  'region.apac': string;
  'region.apacDesc': string;

  // Domain
  'domain.prompt': string;
  'domain.workersDevOption': string;
  'domain.workersDevDesc': string;
  'domain.customOption': string;
  'domain.customDesc': string;
  'domain.customPrompt': string;
  'domain.customValidation': string;
  'domain.issuerUrl': string;

  // UI deployment
  'ui.prompt': string;
  'ui.pagesOption': string;
  'ui.pagesDesc': string;
  'ui.customOption': string;
  'ui.customDesc': string;
  'ui.skipOption': string;
  'ui.skipDesc': string;
  'ui.customPrompt': string;

  // Database
  'db.creating': string;
  'db.created': string;
  'db.existing': string;
  'db.error': string;

  // KV
  'kv.creating': string;
  'kv.created': string;
  'kv.existing': string;
  'kv.error': string;

  // Queue
  'queue.creating': string;
  'queue.created': string;
  'queue.existing': string;
  'queue.error': string;

  // R2
  'r2.creating': string;
  'r2.created': string;
  'r2.existing': string;
  'r2.error': string;

  // Keys
  'keys.generating': string;
  'keys.generated': string;
  'keys.existing': string;
  'keys.error': string;
  'keys.regeneratePrompt': string;
  'keys.regenerateWarning': string;

  // Config
  'config.saving': string;
  'config.saved': string;
  'config.error': string;
  'config.path': string;

  // Deploy
  'deploy.prompt': string;
  'deploy.starting': string;
  'deploy.building': string;
  'deploy.deploying': string;
  'deploy.success': string;
  'deploy.error': string;
  'deploy.skipped': string;
  'deploy.component': string;
  'deploy.uploadingSecrets': string;
  'deploy.secretsUploaded': string;
  'deploy.runningMigrations': string;
  'deploy.migrationsComplete': string;
  'deploy.deployingWorker': string;
  'deploy.workerDeployed': string;
  'deploy.deployingUI': string;
  'deploy.uiDeployed': string;

  // Email provider
  'email.prompt': string;
  'email.resendOption': string;
  'email.resendDesc': string;
  'email.sesOption': string;
  'email.sesDesc': string;
  'email.smtpOption': string;
  'email.smtpDesc': string;
  'email.skipOption': string;
  'email.skipDesc': string;
  'email.apiKeyPrompt': string;
  'email.fromAddressPrompt': string;
  'email.fromAddressValidation': string;

  // SMS provider
  'sms.prompt': string;
  'sms.twilioOption': string;
  'sms.twilioDesc': string;
  'sms.skipOption': string;
  'sms.skipDesc': string;
  'sms.accountSidPrompt': string;
  'sms.authTokenPrompt': string;
  'sms.fromNumberPrompt': string;

  // Social providers
  'social.prompt': string;
  'social.googleOption': string;
  'social.googleDesc': string;
  'social.githubOption': string;
  'social.githubDesc': string;
  'social.appleOption': string;
  'social.appleDesc': string;
  'social.microsoftOption': string;
  'social.microsoftDesc': string;
  'social.skipOption': string;
  'social.skipDesc': string;
  'social.clientIdPrompt': string;
  'social.clientSecretPrompt': string;

  // Completion
  'complete.title': string;
  'complete.summary': string;
  'complete.issuerUrl': string;
  'complete.adminUrl': string;
  'complete.uiUrl': string;
  'complete.nextSteps': string;
  'complete.nextStep1': string;
  'complete.nextStep2': string;
  'complete.nextStep3': string;
  'complete.warning': string;

  // Resource provisioning
  'resource.provisioning': string;
  'resource.provisioned': string;
  'resource.failed': string;
  'resource.skipped': string;

  // Common
  'common.yes': string;
  'common.no': string;
  'common.continue': string;
  'common.cancel': string;
  'common.skip': string;
  'common.back': string;
  'common.confirm': string;
  'common.error': string;
  'common.warning': string;
  'common.success': string;
  'common.info': string;
  'common.loading': string;
  'common.saving': string;
  'common.processing': string;
  'common.done': string;
  'common.required': string;
  'common.optional': string;

  // Errors
  'error.generic': string;
  'error.network': string;
  'error.timeout': string;
  'error.invalidInput': string;
  'error.fileNotFound': string;
  'error.permissionDenied': string;
  'error.configNotFound': string;
  'error.configInvalid': string;
  'error.deployFailed': string;
  'error.resourceCreationFailed': string;

  // Validation
  'validation.required': string;
  'validation.invalidFormat': string;
  'validation.tooShort': string;
  'validation.tooLong': string;
  'validation.invalidDomain': string;
  'validation.invalidEmail': string;
  'validation.invalidUrl': string;

  // Delete command
  'delete.title': string;
  'delete.prompt': string;
  'delete.confirm': string;
  'delete.confirmWarning': string;
  'delete.deleting': string;
  'delete.deleted': string;
  'delete.error': string;
  'delete.cancelled': string;
  'delete.noEnvFound': string;
  'delete.selectEnv': string;
  'delete.workers': string;
  'delete.databases': string;
  'delete.kvNamespaces': string;
  'delete.queues': string;
  'delete.r2Buckets': string;

  // Info command
  'info.title': string;
  'info.loading': string;
  'info.noResources': string;
  'info.environment': string;
  'info.issuer': string;
  'info.workers': string;
  'info.databases': string;
  'info.kvNamespaces': string;
  'info.queues': string;
  'info.r2Buckets': string;
  'info.status': string;
  'info.deployed': string;
  'info.notDeployed': string;

  // Config command
  'configCmd.title': string;
  'configCmd.showing': string;
  'configCmd.validating': string;
  'configCmd.valid': string;
  'configCmd.invalid': string;
  'configCmd.notFound': string;
  'configCmd.error': string;

  // Migrate command
  'migrate.title': string;
  'migrate.checking': string;
  'migrate.noLegacyFound': string;
  'migrate.legacyFound': string;
  'migrate.prompt': string;
  'migrate.migrating': string;
  'migrate.success': string;
  'migrate.error': string;
  'migrate.dryRun': string;
  'migrate.backup': string;
  'migrate.backupCreated': string;

  // Security configuration
  'security.title': string;
  'security.description': string;
  'security.piiEncryption': string;
  'security.piiEncryptionEnabled': string;
  'security.piiEncryptionEnabledDesc': string;
  'security.piiEncryptionDisabled': string;
  'security.piiEncryptionDisabledDesc': string;
  'security.domainHash': string;
  'security.domainHashEnabled': string;
  'security.domainHashEnabledDesc': string;
  'security.domainHashDisabled': string;
  'security.domainHashDisabledDesc': string;
  'security.warning': string;

  // Manage command
  'manage.title': string;
  'manage.loading': string;

  // Web UI specific
  'web.title': string;
  'web.subtitle': string;
  'web.loading': string;
  'web.error': string;
  'web.retry': string;
  'web.languageSelector': string;
  'web.darkMode': string;
  'web.lightMode': string;
  'web.systemMode': string;

  // Web UI steps
  'web.step.environment': string;
  'web.step.region': string;
  'web.step.domain': string;
  'web.step.email': string;
  'web.step.sms': string;
  'web.step.social': string;
  'web.step.advanced': string;
  'web.step.review': string;
  'web.step.deploy': string;

  // Web UI forms
  'web.form.submit': string;
  'web.form.next': string;
  'web.form.previous': string;
  'web.form.reset': string;
  'web.form.validation': string;

  // Web UI progress
  'web.progress.preparing': string;
  'web.progress.creatingResources': string;
  'web.progress.generatingKeys': string;
  'web.progress.configuringWorkers': string;
  'web.progress.deployingWorkers': string;
  'web.progress.deployingUI': string;
  'web.progress.runningMigrations': string;
  'web.progress.complete': string;
  'web.progress.failed': string;

  // Index parameters for type safety
  [key: string]: string;
}

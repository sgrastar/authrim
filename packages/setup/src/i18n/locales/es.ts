/**
 * Spanish Translations for Authrim Setup Tool
 * Traducciones en español
 */

import type { Translations } from '../types.js';

const es: Translations = {
  // Language selection
  'language.select': 'Select language / 言語を選択 / 选择语言',
  'language.selected': 'Idioma: {{language}}',

  // Banner
  'banner.title': 'Configuración de Authrim',
  'banner.subtitle': 'Proveedor OIDC en Cloudflare Workers',
  'banner.exitHint': 'Presiona Ctrl+C en cualquier momento para salir',

  // Mode selection
  'mode.prompt': 'Elige el método de configuración',
  'mode.quick': 'Web UI (Recomendado)',
  'mode.quickDesc': 'Configuración interactiva en tu navegador',
  'mode.advanced': 'Modo CLI',
  'mode.advancedDesc': 'Configuración interactiva en terminal',

  // Startup menu
  'startup.description': 'Configura el Proveedor OIDC de Authrim en Cloudflare Workers.',
  'startup.cancel': 'Cancelar',
  'startup.cancelDesc': 'Salir de la configuración',
  'startup.cancelled': 'Configuración cancelada.',
  'startup.resumeLater': 'Para continuar después:',

  // Main menu
  'menu.prompt': '¿Qué te gustaría hacer?',
  'menu.quick': 'Configuración Rápida (5 minutos)',
  'menu.quickDesc': 'Despliega Authrim con configuración mínima',
  'menu.custom': 'Configuración Personalizada',
  'menu.customDesc': 'Configura todas las opciones paso a paso',

  // Setup titles
  'quick.title': '⚡ Configuración Rápida',
  'custom.title': '🔧 Configuración Personalizada',
  'menu.manage': 'Ver Entornos Existentes',
  'menu.manageDesc': 'Ver, inspeccionar o eliminar entornos existentes',
  'menu.load': 'Cargar Configuración Existente',
  'menu.loadDesc': 'Reanudar configuración desde authrim-config.json',
  'menu.exit': 'Salir',
  'menu.exitDesc': 'Salir de la configuración',
  'menu.goodbye': '¡Adiós!',

  // Update check
  'update.checking': 'Buscando actualizaciones...',
  'update.available': 'Actualización disponible: {{localVersion}} → {{remoteVersion}}',
  'update.prompt': '¿Qué te gustaría hacer?',
  'update.continue': 'Continuar con la versión actual ({{version}})',
  'update.continueDesc': 'Usar el código fuente existente',
  'update.update': 'Actualizar a la última versión ({{version}})',
  'update.updateDesc': 'Descargar y reemplazar con la nueva versión',
  'update.cancel': 'Cancelar',
  'update.cancelled': 'Cancelado.',
  'update.current': 'Usando código fuente de Authrim (v{{version}})',

  // Source download
  'source.downloading': 'Descargando código fuente...',
  'source.downloaded': 'Código fuente descargado ({{version}})',
  'source.extracting': 'Extrayendo código fuente...',
  'source.installing': 'Instalando dependencias (esto puede tomar unos minutos)...',
  'source.installed': 'Dependencias instaladas',
  'source.installFailed': 'Error al instalar dependencias',
  'source.installManually': 'Puedes intentar instalarlo manualmente:',
  'source.notInSourceDir': 'Código fuente de Authrim no encontrado',
  'source.downloadPrompt': '¿Descargar código fuente en {{path}}?',
  'source.downloadOption': 'Descargar código fuente',
  'source.downloadOptionDesc': 'Descargar última versión',
  'source.exitOption': 'Salir',
  'source.exitOptionDesc': 'Salir de la configuración',
  'source.cloneManually': 'Para clonar manualmente:',
  'source.directoryExists':
    'El directorio {{path}} existe pero no es un código fuente válido de Authrim',
  'source.replaceOption': 'Reemplazar con descarga nueva',
  'source.replaceOptionDesc': 'Eliminar {{path}} y descargar la última versión',
  'source.differentOption': 'Usar un directorio diferente',
  'source.differentOptionDesc': 'Especificar otra ubicación',
  'source.enterPath': 'Ingresa la ruta del directorio:',
  'source.updateFailed': 'Error en la actualización',
  'source.downloadFailed': 'Error en la descarga',
  'source.verificationWarnings': 'Advertencias de verificación de estructura del código:',

  // WSL Environment
  'wsl.detected': 'Entorno WSL detectado',
  'wsl.cliOnly': 'La Web UI no está disponible en WSL. Usando modo CLI.',
  'wsl.explanation': 'Para acceder a la Web UI desde el navegador de Windows, el servidor necesita',
  'wsl.explanationCont': 'vincularse a 0.0.0.0 en lugar de localhost.',
  'wsl.securityNote': 'Nota de seguridad:',
  'wsl.securityWarning':
    'Esto hará que el servidor sea accesible desde otros dispositivos en tu red.',
  'wsl.trustedNetworkOnly': 'Solo úsalo en redes de confianza.',
  'wsl.bindPrompt': '¿Vincular a 0.0.0.0 para acceso desde Windows? (y/N):',
  'wsl.bindingToAll': 'Vinculando a 0.0.0.0',
  'wsl.usingLocalhost': 'Usando localhost (solo interno de WSL)',

  // Prerequisites
  'prereq.checking': 'Verificando estado de wrangler...',
  'prereq.wranglerNotInstalled': 'wrangler no está instalado',
  'prereq.wranglerInstallHint': 'Ejecuta el siguiente comando para instalar:',
  'prereq.notLoggedIn': 'No has iniciado sesión en Cloudflare',
  'prereq.loginHint': 'Ejecuta el siguiente comando para autenticarte:',
  'prereq.loggedInAs': 'Conectado a Cloudflare ({{email}})',
  'prereq.accountId': 'ID de cuenta: {{accountId}}',

  // Environment
  'env.prompt': 'Ingresa el nombre del entorno',
  'env.prod': 'Producción',
  'env.prodDesc': 'Para uso en producción',
  'env.staging': 'Staging',
  'env.stagingDesc': 'Para pruebas antes de producción',
  'env.dev': 'Desarrollo',
  'env.devDesc': 'Para desarrollo local',
  'env.custom': 'Personalizado',
  'env.customDesc': 'Ingresa un nombre de entorno personalizado',
  'env.customPrompt': 'Ingresa nombre de entorno personalizado',
  'env.customValidation':
    'Solo se permiten letras minúsculas, números y guiones (ej: prod, main, tokyo, acme-dev)',
  'env.detected': 'Entornos Detectados:',
  'env.selectExisting': 'Seleccionar entorno existente',
  'env.createNew': 'Crear nuevo entorno',
  'env.createNewDesc': 'Configurar un nuevo entorno',
  'env.checking': 'Verificando entornos existentes...',
  'env.alreadyExists': 'El entorno "{{env}}" ya existe',
  'env.existingResources': 'Recursos existentes:',
  'env.workers': 'Workers: {{count}}',
  'env.d1Databases': 'Bases de datos D1: {{count}}',
  'env.kvNamespaces': 'Namespaces KV: {{count}}',
  'env.chooseAnother':
    'Por favor elige otro nombre o usa "{{command}} manage" para eliminarlo primero.',
  'env.available': 'Nombre de entorno disponible',
  'env.checkFailed': 'No se pudo verificar entornos existentes (continuando de todas formas)',
  'env.noEnvFound': 'No se encontraron entornos de Authrim.',

  // Region
  'region.prompt': 'Selecciona la región',
  'region.auto': 'Automático (el más cercano)',
  'region.autoDesc': 'Dejar que Cloudflare elija la región más cercana',
  'region.wnam': 'Norteamérica (Oeste)',
  'region.wnamDesc': 'Oeste de Norteamérica',
  'region.enam': 'Norteamérica (Este)',
  'region.enamDesc': 'Este de Norteamérica',
  'region.weur': 'Europa (Oeste)',
  'region.weurDesc': 'Europa Occidental',
  'region.eeur': 'Europa (Este)',
  'region.eeurDesc': 'Europa Oriental',
  'region.apac': 'Asia Pacífico',
  'region.apacDesc': 'Región Asia Pacífico',
  'region.oceania': 'Oceanía',
  'region.oceaniaDesc': 'Australia e Islas del Pacífico',
  'region.euJurisdiction': 'Jurisdicción UE (cumplimiento GDPR)',
  'region.euJurisdictionDesc': 'Datos almacenados dentro de la UE',

  // UI deployment
  'ui.prompt': 'Método de despliegue de UI',
  'ui.pagesOption': 'Cloudflare Workers',
  'ui.pagesDesc': 'Desplegar en Cloudflare Workers (recomendado)',
  'ui.customOption': 'Dominio personalizado',
  'ui.customDesc': 'Usar tu propio hosting',
  'ui.skipOption': 'Omitir',
  'ui.skipDesc': 'Omitir despliegue de UI',
  'ui.customPrompt': 'Ingresa URL personalizada de UI',

  // Domain
  'domain.prompt': '¿Configurar dominio personalizado?',
  'domain.workersDevOption': 'Usar dominio workers.dev',
  'domain.workersDevDesc': 'Usar dominio predeterminado de Cloudflare',
  'domain.customOption': 'Configurar dominio personalizado',
  'domain.customDesc': 'Usar tu propio dominio',
  'domain.customPrompt': 'Ingresa dominio personalizado (ej: auth.ejemplo.com)',
  'domain.customValidation': 'Por favor ingresa un dominio válido (ej: auth.ejemplo.com)',
  'domain.checkZoneButton': 'Verificar zona',
  'domain.checkingZone': 'Verificando zona de Cloudflare para {{domain}}...',
  'domain.zoneFound': "Zona '{{zone}}' encontrada (estado: {{status}})",
  'domain.zoneNotFound': "Zona '{{zone}}' no encontrada en su cuenta de Cloudflare",
  'domain.zoneNotFoundHint':
    'El enrutamiento de dominio personalizado requiere que la zona se agregue primero a Cloudflare.',
  'domain.zoneCheckFailed': 'No se pudo verificar la zona',
  'domain.zoneCheckSkipped': 'Verificación de zona omitida, continuando con la configuración...',
  'domain.continueWithoutZone': '¿Continuar sin verificación de zona?',
  'domain.configureBinding': 'Configurar enlace de dominio personalizado para Workers',
  'domain.action.retryCheck': 'Volver a comprobar',
  'domain.action.reloadPage': 'Recargar página',
  'domain.action.openCloudflareDashboard': 'Abrir panel de Cloudflare',
  'domain.prereq.reviewTitle': 'La comprobación de dominio personalizado necesita revisión',
  'domain.prereq.reviewBody':
    'Si piensa usar un dominio personalizado, vuelva a comprobarlo después de recargar la página o renovar el inicio de sesión de Cloudflare.',
  'domain.diagnostic.zone_found.title': 'La zona de Cloudflare está lista',
  'domain.diagnostic.zone_found.body':
    'La zona "{{zone}}" está disponible en su cuenta de Cloudflare.',
  'domain.diagnostic.zone_found.next':
    'Puede continuar con la configuración del binding de dominio personalizado.',
  'domain.diagnostic.not_logged_in.title': 'Se requiere iniciar sesión en Cloudflare',
  'domain.diagnostic.not_logged_in.body':
    'Authrim no pudo confirmar una sesión de Cloudflare para esta verificación de zona.',
  'domain.diagnostic.not_logged_in.next':
    '1. Ejecute `wrangler login` en su terminal.\n2. Recargue esta página.\n3. Vuelva a comprobar la zona.',
  'domain.diagnostic.token_unavailable.title': 'No se pudo cargar el token de Cloudflare',
  'domain.diagnostic.token_unavailable.body':
    'Parece que existe una sesión de Wrangler, pero el token de API necesario para acceder a la zona aún no está disponible.',
  'domain.diagnostic.token_unavailable.next':
    '1. Recargue esta página y vuelva a comprobar.\n2. Si sigue fallando, ejecute `wrangler login` otra vez.\n3. Luego repita la verificación de zona.',
  'domain.diagnostic.zone_read_forbidden.title': 'El acceso a la lista de zonas está limitado',
  'domain.diagnostic.zone_read_forbidden.body':
    'El token actual de Cloudflare no puede leer la lista de zonas. Las zonas existentes pueden seguir funcionando, pero la verificación automática y la ayuda de DNS estarán limitadas.',
  'domain.diagnostic.zone_read_forbidden.next':
    '1. Vuelva a comprobar primero.\n2. Si sigue fallando, ejecute `wrangler login` otra vez.\n3. Verifique que el token tenga permiso Zone:Read.\n4. Si la zona ya existe, puede continuar manualmente.',
  'domain.diagnostic.zone_not_found.title': 'No se encontró la zona en esta cuenta',
  'domain.diagnostic.zone_not_found.body':
    'Cloudflare respondió, pero la zona "{{zone}}" no es visible en la cuenta actual.',
  'domain.diagnostic.zone_not_found.next':
    '1. Confirme que la zona exista en la cuenta de Cloudflare que está usando.\n2. Si hace falta, cambie de cuenta o abra el panel de Cloudflare.\n3. Luego vuelva a comprobar la zona.',
  'domain.diagnostic.api_error.title': 'Falló la comprobación de la API de Cloudflare',
  'domain.diagnostic.api_error.body':
    'Cloudflare devolvió una respuesta inesperada al comprobar esta zona.',
  'domain.diagnostic.api_error.next':
    'Primero vuelva a comprobar. Si sigue fallando, recargue esta página y pruebe de nuevo.',
  'domain.diagnostic.network_error.title': 'Falló la comprobación de red hacia Cloudflare',
  'domain.diagnostic.network_error.body':
    'La verificación de zona no pudo completarse porque Cloudflare o la red no respondieron como se esperaba.',
  'domain.diagnostic.network_error.next':
    'Primero vuelva a comprobar. Si sigue fallando, recargue esta página y pruebe de nuevo.',
  'domain.issuerUrl': 'URL del emisor: {{url}}',
  'domain.apiDomain': 'Dominio API / Emisor (ej: auth.ejemplo.com)',
  'domain.loginUiDomain': 'Dominio UI de inicio de sesión (Enter para omitir)',
  'domain.adminUiDomain': 'Dominio UI de administración (Enter para omitir)',
  'domain.enterDomains':
    'Ingresa dominios personalizados (dejar vacío para usar predeterminados de Cloudflare)',
  'domain.singleTenantNote': 'En modo single-tenant, URL del emisor = dominio API',
  'domain.usingWorkersDev': '(usando dominio workers.dev de Cloudflare)',
  'web.form.multiTenantEnable': 'Habilitar modo multi-tenant',
  'web.form.multiTenantHint': 'Crear subdominios de tenant bajo su dominio personalizado',
  'web.form.multiTenantExamples': 'Ejemplos de URL de tenant',
  'web.form.multiTenantExampleDefaultOmitted': 'Tenant predeterminado con nombre omitido: {{url}}',
  'web.form.multiTenantExampleDefaultIncluded':
    'Tenant predeterminado con nombre explícito: {{url}}',
  'web.form.multiTenantExampleOther': 'Tenant no predeterminado: {{url}}',

  // Database
  'db.title': 'Configuración de Base de Datos',
  'db.regionWarning': 'La región de la base de datos no puede cambiarse después de la creación.',
  'db.coreDescription': 'BD Core: Almacena clientes OAuth, tokens, sesiones, logs de auditoría',
  'db.coreRegion': 'Región de Base de Datos Core',
  'db.piiDescription': 'BD PII: Almacena perfiles de usuario, credenciales, datos personales',
  'db.piiNote': 'Considera tus requisitos de protección de datos.',
  'db.piiRegion': 'Región de Base de Datos PII',
  'db.creating': 'Creando base de datos...',
  'db.created': 'Base de datos creada: {{name}}',
  'db.existing': 'Usando base de datos existente: {{name}}',
  'db.error': 'Error al crear base de datos',
  'db.locationHints': 'Sugerencias de Ubicación',
  'db.jurisdictionCompliance': 'Jurisdicción (Cumplimiento)',

  // KV
  'kv.creating': 'Creando namespace KV...',
  'kv.created': 'Namespace KV creado: {{name}}',
  'kv.existing': 'Usando namespace KV existente: {{name}}',
  'kv.error': 'Error al crear namespace KV',

  // Queue
  'queue.creating': 'Creando cola...',
  'queue.created': 'Cola creada: {{name}}',
  'queue.existing': 'Usando cola existente: {{name}}',
  'queue.error': 'Error al crear cola',

  // R2
  'r2.creating': 'Creando bucket R2...',
  'r2.created': 'Bucket R2 creado: {{name}}',
  'r2.existing': 'Usando bucket R2 existente: {{name}}',
  'r2.error': 'Error al crear bucket R2',

  // Keys
  'keys.generating': 'Generando claves criptográficas...',
  'keys.generated': 'Claves generadas ({{path}})',
  'keys.existing': 'Ya existen claves para el entorno "{{env}}"',
  'keys.existingWarning': 'Las claves existentes serán sobrescritas.',
  'keys.error': 'Error al generar claves',
  'keys.regeneratePrompt': '¿Regenerar claves?',
  'keys.regenerateWarning': '¡Esto invalidará todos los tokens existentes!',

  // Config
  'config.saving': 'Guardando configuración...',
  'config.saved': 'Configuración guardada en {{path}}',
  'config.error': 'Error al guardar configuración',
  'config.path': 'Ruta de configuración',
  'config.summary': 'Resumen de Configuración',
  'config.infrastructure': 'Infraestructura:',
  'config.environment': 'Entorno:',
  'config.workerPrefix': 'Prefijo de Worker:',
  'config.profile': 'Perfil:',
  'config.tenantIssuer': 'Tenant y Emisor:',
  'config.mode': 'Modo:',
  'config.multiTenant': 'Multi-tenant',
  'config.singleTenant': 'Single-tenant',
  'config.baseDomain': 'Dominio Base:',
  'config.issuerFormat': 'Formato del Emisor:',
  'config.issuerUrl': 'URL del Emisor:',
  'config.defaultTenant': 'Tenant Predeterminado:',
  'config.displayName': 'Nombre para Mostrar:',
  'config.publicUrls': 'URLs Públicas:',
  'config.apiRouter': 'Router API:',
  'config.loginUi': 'UI de Inicio de Sesión:',
  'config.adminUi': 'UI de Administración:',
  'config.components': 'Componentes:',
  'config.featureFlags': 'Flags de Características:',
  'config.emailSettings': 'Email:',
  'config.oidcSettings': 'Configuración OIDC:',
  'config.accessTtl': 'TTL de Access Token:',
  'config.refreshTtl': 'TTL de Refresh Token:',
  'config.authCodeTtl': 'TTL de Auth Code:',
  'config.pkceRequired': 'PKCE Requerido:',
  'config.sharding': 'Sharding:',
  'config.authCodeShards': 'Auth Code:',
  'config.refreshTokenShards': 'Refresh Token:',
  'config.database': 'Base de Datos:',
  'config.coreDb': 'BD Core:',
  'config.piiDb': 'BD PII:',
  'config.enabled': 'Habilitado',
  'config.disabled': 'Deshabilitado',
  'config.standard': '(estándar)',
  'config.notConfigured': 'No configurado (configurar después)',
  'config.yes': 'Sí',
  'config.no': 'No',
  'config.shards': 'shards',
  'config.sec': 'seg',
  'config.automatic': 'Automático',

  // Deploy
  'deploy.prompt': '¿Iniciar configuración con esta configuración?',
  'deploy.starting': 'Ejecutando Configuración...',
  'deploy.building': 'Compilando paquetes...',
  'deploy.deploying': 'Desplegando en Cloudflare...',
  'deploy.success': '¡Configuración completa!',
  'deploy.error': 'Error en el despliegue',
  'deploy.skipped': 'Despliegue omitido',
  'deploy.component': 'Desplegando {{component}}...',
  'deploy.uploadingSecrets': 'Subiendo secretos...',
  'deploy.secretsUploaded': 'Secretos subidos',
  'deploy.runningMigrations': 'Ejecutando migraciones de base de datos...',
  'deploy.migrationsComplete': 'Migraciones completadas',
  'deploy.deployingWorker': 'Desplegando worker {{name}}...',
  'deploy.workerDeployed': 'Worker desplegado: {{name}}',
  'deploy.deployingUI': 'Desplegando UI...',
  'deploy.uiDeployed': 'UI desplegada',
  'deploy.creatingResources': 'Creando recursos de Cloudflare...',
  'deploy.resourcesFailed': 'Error al crear recursos',
  'deploy.continueWithout':
    '¿Continuar sin aprovisionamiento? (necesitarás crear recursos manualmente)',
  'deploy.emailSecretsSaved': 'Secretos de email guardados en {{path}}',
  'deploy.confirmStart': '¿Iniciar despliegue?',
  'deploy.confirmDryRun': '¿Ejecutar despliegue en modo de prueba?',
  'deploy.cancelled': 'Despliegue cancelado.',
  'deploy.wranglerChanged': '¿Cómo quieres manejar estos cambios?',
  'deploy.wranglerKeep': '📝 Mantener cambios manuales (desplegar tal cual)',
  'deploy.wranglerBackup': '💾 Respaldar y sobrescribir con master',
  'deploy.wranglerOverwrite': '⚠️ Sobrescribir con master (perder cambios)',

  // Email provider
  'email.title': 'Proveedor de Email',
  'email.description':
    'Configura el envío de email para enlaces mágicos y códigos de verificación.',
  'email.prompt': '¿Configurar proveedor de email ahora?',
  'email.resendOption': 'Resend',
  'email.resendDesc': 'API de email moderna para desarrolladores',
  'email.sesOption': 'AWS SES',
  'email.sesDesc': 'Amazon Simple Email Service',
  'email.smtpOption': 'SMTP',
  'email.smtpDesc': 'Servidor SMTP genérico',
  'email.skipOption': 'Ninguno (configurar después)',
  'email.skipDesc': 'Omitir configuración de email',
  'email.apiKeyPrompt': 'Clave API de Resend',
  'email.apiKeyHint': 'Obtén tu clave API en: https://resend.com/api-keys',
  'email.domainHint': 'Configura el dominio en: https://resend.com/domains',
  'email.apiKeyRequired': 'La clave API es requerida',
  'email.apiKeyWarning': 'Advertencia: Las claves API de Resend típicamente comienzan con "re_"',
  'email.fromAddressPrompt': 'Dirección de email del remitente',
  'email.fromAddressValidation': 'Por favor ingresa una dirección de email válida',
  'email.fromNamePrompt': 'Nombre del remitente (opcional)',
  'email.domainVerificationRequired':
    'Se requiere verificación de dominio para enviar desde tu propio dominio.',
  'email.seeDocumentation': 'Ver: https://resend.com/docs/dashboard/domains/introduction',
  'email.provider': 'Proveedor:',
  'email.fromAddress': 'Dirección del Remitente:',
  'email.fromName': 'Nombre del Remitente:',

  // SMS provider
  'sms.prompt': '¿Configurar proveedor de SMS?',
  'sms.twilioOption': 'Twilio',
  'sms.twilioDesc': 'SMS vía Twilio',
  'sms.skipOption': 'Ninguno (configurar después)',
  'sms.skipDesc': 'Omitir configuración de SMS',
  'sms.accountSidPrompt': 'Account SID de Twilio',
  'sms.authTokenPrompt': 'Auth Token de Twilio',
  'sms.fromNumberPrompt': 'Número de teléfono del remitente',

  // Social providers
  'social.prompt': '¿Configurar proveedores de inicio de sesión social?',
  'social.googleOption': 'Google',
  'social.googleDesc': 'Iniciar sesión con Google',
  'social.githubOption': 'GitHub',
  'social.githubDesc': 'Iniciar sesión con GitHub',
  'social.appleOption': 'Apple',
  'social.appleDesc': 'Iniciar sesión con Apple',
  'social.microsoftOption': 'Microsoft',
  'social.microsoftDesc': 'Iniciar sesión con Microsoft',
  'social.skipOption': 'Ninguno (configurar después)',
  'social.skipDesc': 'Omitir configuración de inicio de sesión social',
  'social.clientIdPrompt': 'Client ID',
  'social.clientSecretPrompt': 'Client Secret',

  // Cloudflare API Token
  'cf.apiTokenPrompt': 'Ingresa el Token API de Cloudflare',
  'cf.apiTokenValidation': 'Por favor ingresa un Token API válido',

  // OIDC Profile
  'profile.prompt': 'Selecciona el perfil OIDC',
  'profile.basicOp': 'OP Básico (Proveedor OIDC Estándar)',
  'profile.basicOpDesc': 'Características OIDC estándar',
  'profile.fapiRw': 'FAPI Read-Write (Grado Financiero)',
  'profile.fapiRwDesc': 'Compatible con perfil de seguridad FAPI 1.0 Read-Write',
  'profile.fapi2Security': 'Perfil de Seguridad FAPI 2.0',
  'profile.fapi2SecurityDesc': 'Compatible con perfil de seguridad FAPI 2.0 (máxima seguridad)',

  // Tenant configuration
  'tenant.title': 'Modo de Tenant',
  'tenant.multiTenantPrompt':
    '¿Habilitar modo multi-tenant? (aislamiento de tenant basado en subdominio)',
  'tenant.multiTenantTitle': 'Configuración de URL Multi-tenant',
  'tenant.multiTenantNote1': 'En modo multi-tenant:',
  'tenant.multiTenantNote2': 'Cada tenant tiene un subdominio: https://{tenant}.{dominio-base}',
  'tenant.multiTenantNote3': 'El dominio base apunta al Worker router',
  'tenant.multiTenantNote4': 'La URL del emisor se construye dinámicamente del header Host',
  'tenant.baseDomainPrompt': 'Dominio base (ej: authrim.com)',
  'tenant.baseDomainRequired': 'El dominio base es requerido para modo multi-tenant',
  'tenant.baseDomainValidation': 'Por favor ingresa un dominio válido (ej: authrim.com)',
  'tenant.issuerFormat': 'Formato de URL del emisor: https://{tenant}.{{domain}}',
  'tenant.issuerExample': 'Ejemplo: https://acme.{{domain}}',
  'tenant.defaultTenantPrompt': 'Nombre del tenant predeterminado (identificador)',
  'tenant.defaultTenantValidation': 'Solo se permiten letras minúsculas, números y guiones',
  'tenant.displayNamePrompt': 'Nombre para mostrar del tenant predeterminado',
  'tenant.singleTenantTitle': 'Configuración de URL Single-tenant',
  'tenant.singleTenantNote1': 'En modo single-tenant:',
  'tenant.singleTenantNote2':
    'URL del emisor = dominio personalizado de API (o workers.dev como respaldo)',
  'tenant.singleTenantNote3': 'Todos los clientes comparten el mismo emisor',
  'tenant.organizationName': 'Nombre de la organización (nombre para mostrar)',
  'tenant.uiDomainTitle': 'Configuración de Dominio de UI',
  'tenant.customUiDomainPrompt': '¿Configurar dominios personalizados de UI?',
  'tenant.loginUiDomain': 'Dominio de UI de inicio de sesión (ej: login.ejemplo.com)',
  'tenant.adminUiDomain': 'Dominio de UI de administración (ej: admin.ejemplo.com)',

  // User ID format
  'userId.title': 'Formato de ID de Usuario',
  'userId.prompt': 'Seleccione el formato de ID de usuario',
  'userId.nanoid': 'NanoID (recomendado)',
  'userId.nanoidDesc': 'IDs de 21 caracteres seguros para URL, compactos y seguros',
  'userId.uuid': 'UUID v4',
  'userId.uuidDesc': 'UUIDs estándar de 36 caracteres con guiones',
  'userId.note': 'Nota: Esta configuración no se puede cambiar después de crear usuarios.',
  'userId.selected': 'Formato de ID de usuario: {{format}}',

  // Standard components
  'components.title': 'Componentes estándar',
  'components.note':
    'SAML, Device Flow/CIBA, VC, inicio de sesión social y motor de políticas se instalan de forma predeterminada.',
  'components.samlPrompt': '¿Habilitar soporte SAML?',
  'components.vcPrompt': '¿Habilitar Credenciales Verificables?',
  'components.saml': 'SAML:',
  'components.vc': 'VC:',
  'components.socialLogin': 'Inicio de sesión social:',
  'components.policyEngine': 'Motor de políticas:',

  // Feature flags
  'features.title': 'Flags de Características',
  'features.queuePrompt': '¿Habilitar Cloudflare Queues? (para logs de auditoría)',
  'features.r2Prompt': '¿Habilitar Cloudflare R2? (para avatares)',
  'features.queue': 'Cola:',
  'features.r2': 'R2:',

  // OIDC settings
  'oidc.configurePrompt': '¿Configurar ajustes OIDC? (TTL de tokens, etc.)',
  'oidc.title': 'Configuración OIDC',
  'oidc.accessTokenTtl': 'TTL de Access Token (seg)',
  'oidc.refreshTokenTtl': 'TTL de Refresh Token (seg)',
  'oidc.authCodeTtl': 'TTL de Authorization Code (seg)',
  'oidc.pkceRequired': '¿Requerir PKCE?',
  'oidc.positiveInteger': 'Por favor ingresa un entero positivo',

  // Sharding settings
  'sharding.configurePrompt': '¿Configurar sharding? (para entornos de alta carga)',
  'sharding.title': 'Configuración de Sharding',
  'sharding.note':
    'Nota: Se recomienda potencia de 2 para el número de shards (4, 8, 16, 32, 64, 128)',
  'sharding.authCodeShards': 'Número de shards de Auth Code',
  'sharding.refreshTokenShards': 'Número de shards de Refresh Token',

  // Infrastructure
  'infra.title': 'Infraestructura (Auto-generada)',
  'infra.workersNote': 'Se desplegarán los siguientes Workers:',
  'infra.router': 'Router:',
  'infra.auth': 'Auth:',
  'infra.token': 'Token:',
  'infra.management': 'Management:',
  'infra.otherWorkers': '... y otros workers de soporte',
  'infra.defaultEndpoints': 'Endpoints predeterminados (sin dominio personalizado):',
  'infra.api': 'API:',
  'infra.ui': 'UI:',
  'infra.workersToDeploy': 'Workers a desplegar: {{workers}}',
  'infra.defaultApi': 'API predeterminada: {{url}}',

  // Completion
  'complete.title': '¡Configuración Completa!',
  'complete.summary': 'Tu Proveedor OIDC de Authrim ha sido desplegado.',
  'complete.issuerUrl': 'URL del Emisor: {{url}}',
  'complete.adminUrl': 'Panel de Administración: {{url}}',
  'complete.uiUrl': 'UI de Inicio de Sesión: {{url}}',
  'complete.nextSteps': 'Próximos Pasos:',
  'complete.nextStep1': '1. Verifica el despliegue visitando la URL del emisor',
  'complete.nextStep2': '2. Configura clientes OAuth en el Panel de Administración',
  'complete.nextStep3': '3. Configura dominios personalizados si es necesario',
  'complete.warning': '¡Recuerda mantener tus claves seguras y respaldadas!',
  'complete.success': '¡Configuración completada exitosamente!',
  'complete.urls': 'URLs:',
  'complete.configLocation': 'Configuración:',
  'complete.keysLocation': 'Claves:',

  // Resource provisioning
  'resource.provisioning': 'Aprovisionando {{resource}}...',
  'resource.provisioned': '{{resource}} aprovisionado exitosamente',
  'resource.failed': 'Error al aprovisionar {{resource}}',
  'resource.skipped': '{{resource}} omitido',

  // Manage environments
  'manage.title': 'Entornos Existentes',
  'manage.loading': 'Cargando...',
  'manage.detecting': 'Detectando entornos...',
  'manage.detected': 'Entornos Detectados:',
  'manage.noEnvs': 'No se encontraron entornos de Authrim.',
  'manage.selectAction': 'Selecciona una acción',
  'manage.viewDetails': 'Ver Detalles',
  'manage.viewDetailsDesc': 'Mostrar información detallada de recursos',
  'manage.deleteEnv': 'Eliminar Entorno',
  'manage.deleteEnvDesc': 'Eliminar entorno y recursos',
  'manage.backToMenu': 'Volver al Menú Principal',
  'manage.backToMenuDesc': 'Regresar al menú principal',
  'manage.selectEnv': 'Selecciona entorno',
  'manage.back': 'Atrás',
  'manage.continueManaging': '¿Continuar gestionando entornos?',

  // Load config
  'loadConfig.title': 'Cargar Configuración Existente',
  'loadConfig.found': 'Se encontraron {{count}} configuración(es):',
  'loadConfig.new': '(nuevo)',
  'loadConfig.legacy': '(legacy)',
  'loadConfig.legacyDetected': 'Estructura Legacy Detectada',
  'loadConfig.legacyFiles': 'Archivos legacy:',
  'loadConfig.newBenefits': 'Beneficios de la nueva estructura:',
  'loadConfig.benefit1': 'Portabilidad del entorno (zip .authrim/prod/)',
  'loadConfig.benefit2': 'Seguimiento de versión por entorno',
  'loadConfig.benefit3': 'Estructura de proyecto más limpia',
  'loadConfig.migratePrompt': '¿Te gustaría migrar a la nueva estructura?',
  'loadConfig.migrateOption': 'Migrar a nueva estructura (.authrim/{env}/)',
  'loadConfig.continueOption': 'Continuar con estructura legacy',
  'loadConfig.migrationComplete': '¡Migración completada exitosamente!',
  'loadConfig.validationPassed': 'Validación pasada',
  'loadConfig.validationIssues': 'Problemas de validación:',
  'loadConfig.newLocation': 'Nueva ubicación de configuración:',
  'loadConfig.migrationFailed': 'Migración fallida:',
  'loadConfig.continuingLegacy': 'Continuando con estructura legacy...',
  'loadConfig.loadThis': 'Cargar esta configuración',
  'loadConfig.specifyOther': 'Especificar archivo diferente',
  'loadConfig.noConfigFound': 'No se encontró configuración en el directorio actual.',
  'loadConfig.tip': 'Consejo: Puedes especificar un archivo de configuración con:',
  'loadConfig.specifyPath': 'Especificar ruta del archivo',
  'loadConfig.enterPath': 'Ingresa la ruta del archivo de configuración',
  'loadConfig.pathRequired': 'Por favor ingresa una ruta',
  'loadConfig.fileNotFound': 'Archivo no encontrado: {{path}}',
  'loadConfig.selectConfig': 'Selecciona configuración para cargar',

  // Common
  'common.yes': 'Sí',
  'common.no': 'No',
  'common.continue': 'Continuar',
  'common.cancel': 'Cancelar',
  'common.skip': 'Omitir',
  'common.back': 'Atrás',
  'common.confirm': 'Confirmar',
  'common.error': 'Error',
  'common.warning': 'Advertencia',
  'common.success': 'Éxito',
  'common.info': 'Info',
  'common.loading': 'Cargando...',
  'common.saving': 'Guardando...',
  'common.processing': 'Procesando...',
  'common.done': 'Hecho',
  'common.required': 'Requerido',
  'common.optional': 'Opcional',

  // Errors
  'error.generic': 'Ocurrió un error',
  'error.network': 'Error de red',
  'error.timeout': 'Tiempo de espera agotado',
  'error.invalidInput': 'Entrada inválida',
  'error.fileNotFound': 'Archivo no encontrado',
  'error.permissionDenied': 'Permiso denegado',
  'error.configNotFound': 'Configuración no encontrada',
  'error.configInvalid': 'Configuración inválida',
  'error.deployFailed': 'Despliegue fallido',
  'error.resourceCreationFailed': 'Error al crear recurso',

  // Validation
  'validation.required': 'Este campo es requerido',
  'validation.invalidFormat': 'Formato inválido',
  'validation.tooShort': 'Muy corto',
  'validation.tooLong': 'Muy largo',
  'validation.invalidDomain': 'Dominio inválido',
  'validation.invalidEmail': 'Dirección de email inválida',
  'validation.invalidUrl': 'URL inválida',

  // Delete command
  'delete.title': 'Eliminar Entorno',
  'delete.prompt': 'Selecciona recursos para eliminar',
  'delete.confirm': '¿Estás seguro de que quieres eliminar "{{env}}"?',
  'delete.confirmPermanent':
    '⚠️ Esto eliminará permanentemente todos los recursos de "{{env}}". ¿Continuar?',
  'delete.confirmWarning': '¡Esta acción no se puede deshacer!',
  'delete.deleting': 'Eliminando {{resource}}...',
  'delete.deleted': '{{resource}} eliminado',
  'delete.error': 'Error al eliminar {{resource}}',
  'delete.cancelled': 'Eliminación cancelada',
  'delete.noEnvFound': 'No se encontraron entornos',
  'delete.selectEnv': 'Selecciona entorno para eliminar',
  'delete.workers': 'Workers',
  'delete.databases': 'Bases de datos D1',
  'delete.kvNamespaces': 'Namespaces KV',
  'delete.queues': 'Colas',
  'delete.r2Buckets': 'Buckets R2',

  // Info command
  'info.title': 'Información del Entorno',
  'info.loading': 'Cargando información del entorno...',
  'info.noResources': 'No se encontraron recursos',
  'info.environment': 'Entorno',
  'info.issuer': 'Emisor',
  'info.workers': 'Workers',
  'info.databases': 'Bases de datos',
  'info.kvNamespaces': 'Namespaces KV',
  'info.queues': 'Colas',
  'info.r2Buckets': 'Buckets R2',
  'info.status': 'Estado',
  'info.deployed': 'Desplegado',
  'info.notDeployed': 'No desplegado',

  // Config command
  'configCmd.title': 'Configuración',
  'configCmd.showing': 'Mostrando configuración',
  'configCmd.validating': 'Validando configuración...',
  'configCmd.valid': 'La configuración es válida',
  'configCmd.invalid': 'La configuración es inválida',
  'configCmd.notFound': 'Configuración no encontrada',
  'configCmd.error': 'Error al leer configuración',

  // Migrate command
  'migrate.title': 'Migrar a Nueva Estructura',
  'migrate.checking': 'Verificando estado de migración...',
  'migrate.noLegacyFound': 'No se encontró estructura legacy',
  'migrate.legacyFound': 'Estructura legacy detectada',
  'migrate.prompt': '¿Migrar a nueva estructura?',
  'migrate.migrating': 'Migrando...',
  'migrate.success': 'Migración exitosa',
  'migrate.cancelled': 'Migración cancelada.',
  'migrate.error': 'Migración fallida',
  'migrate.dryRun': 'Ejecución de prueba - sin cambios realizados',
  'migrate.backup': 'Creando respaldo...',
  'migrate.backupCreated': 'Respaldo creado en {{path}}',

  // Security configuration
  'security.title': 'Configuración de Seguridad',
  'security.description':
    'Configura los ajustes de protección de datos. Estos no pueden cambiarse después de almacenar los datos iniciales.',
  'security.piiEncryption': 'Cifrado de PII',
  'security.piiEncryptionEnabled': 'Cifrado a nivel de aplicación (Recomendado)',
  'security.piiEncryptionEnabledDesc':
    'Cifrar datos PII a nivel de aplicación (recomendado para D1)',
  'security.piiEncryptionDisabled': 'Solo cifrado a nivel de base de datos',
  'security.piiEncryptionDisabledDesc': 'Usar cifrado de BD administrada (para Aurora, etc.)',
  'security.domainHash': 'Hash de Dominio de Email',
  'security.domainHashEnabled': 'Activar hash de dominio (Recomendado)',
  'security.domainHashEnabledDesc': 'Aplicar hash a dominios de email para privacidad en análisis',
  'security.domainHashDisabled': 'Almacenar dominios en texto plano',
  'security.domainHashDisabledDesc': 'Almacenar dominios de email sin hash',
  'security.warning': '⚠️ Estos ajustes no pueden cambiarse después de almacenar los datos',

  // Manage command
  'manage.commandTitle': 'Gestor de Entornos de Authrim',

  // Web UI specific
  'web.title': 'Configuración de Authrim',
  'web.subtitle': 'Proveedor OIDC en Cloudflare Workers',
  'web.loading': 'Cargando...',
  'web.error': 'Ocurrió un error',
  'web.retry': 'Reintentar',
  'web.languageSelector': 'Idioma',
  'web.darkMode': 'Oscuro',
  'web.lightMode': 'Claro',
  'web.systemMode': 'Sistema',

  // Web UI Prerequisites
  'web.prereq.title': 'Preparar',
  'web.prereq.checking': 'Verificando...',
  'web.prereq.checkingRequirements': 'Verificando requisitos del sistema...',
  'web.prereq.ready': 'Listo',
  'web.prereq.wranglerInstalled': 'Wrangler instalado',
  'web.prereq.loggedInAs': 'Conectado como {{email}}',

  // Web UI Top Menu
  'web.menu.title': 'Comenzar',
  'web.menu.subtitle': 'Elige una opción para continuar:',
  'web.menu.newSetup': 'Nueva Configuración',
  'web.menu.newSetupDesc': 'Crear un nuevo despliegue de Authrim desde cero',
  'web.menu.loadConfig': 'Cargar Config',
  'web.menu.loadConfigDesc': 'Reanudar o redesplegar usando configuración existente',
  'web.menu.manageEnv': 'Gestionar Entornos',
  'web.menu.manageEnvDesc': 'Ver, inspeccionar o eliminar entornos existentes',

  // Web UI Setup Mode
  'web.mode.title': 'Modo de Configuración',
  'web.mode.subtitle': 'Elige cómo quieres configurar Authrim:',
  'web.mode.quick': 'Configuración Rápida',
  'web.mode.quickDesc': 'Comienza en ~5 minutos',
  'web.mode.quickEnv': 'Selección de entorno',
  'web.mode.quickDomain': 'Dominio personalizado opcional',
  'web.mode.quickDefault': 'Componentes predeterminados',
  'web.mode.recommended': 'Recomendado',
  'web.mode.custom': 'Configuración Personalizada',
  'web.mode.customDesc': 'Control total sobre la configuración',
  'web.mode.customComp': 'Selección de componentes',
  'web.mode.customUrl': 'Configuración de URL',
  'web.mode.customAdvanced': 'Configuración avanzada',

  // Web UI Load Config
  'web.loadConfig.title': 'Cargar Configuración',
  'web.loadConfig.subtitle': 'Selecciona tu archivo authrim-config.json:',
  'web.loadConfig.chooseFile': 'Elegir Archivo',
  'web.loadConfig.preview': 'Vista Previa de Configuración',
  'web.loadConfig.validationFailed': 'Validación de Configuración Fallida',
  'web.loadConfig.valid': 'La configuración es válida',
  'web.loadConfig.loadContinue': 'Cargar y Continuar',

  // Web UI Configuration
  'web.config.title': 'Configuración',
  'web.config.components': 'Componentes',
  'web.config.apiRequired': 'API (requerido)',
  'web.config.apiDesc':
    'Endpoints del Proveedor OIDC: authorize, token, userinfo, discovery, APIs de gestión.',
  'web.config.saml': 'SAML IdP',
  'web.config.deviceFlow': 'Device Flow / CIBA',
  'web.config.vcSdJwt': 'VC SD-JWT',
  'web.config.loginUi': 'UI de Inicio de Sesión',
  'web.config.loginUiDesc': 'UI de autenticación pre-construida desplegada en Cloudflare Workers.',
  'web.config.adminUi': 'UI de Administración',
  'web.config.adminUiDesc': 'Panel de gestión para usuarios, clientes y configuración.',

  // Web UI URLs
  'web.url.title': 'Configuración de URL',
  'web.url.apiDomain': 'Dominio API',
  'web.url.apiDomainHint': 'Dejar vacío para usar subdominio workers.dev',
  'web.url.loginDomain': 'Dominio UI de Inicio de Sesión',
  'web.url.loginDomainHint': 'Dejar vacío para usar subdominio workers.dev',
  'web.url.adminDomain': 'Dominio UI de Administración',
  'web.url.adminDomainHint': 'Dejar vacío para usar subdominio workers.dev',

  // Web UI Database
  'web.db.title': 'Configuración de Base de Datos',
  'web.db.coreTitle': 'Base de Datos Core',
  'web.db.coreSubtitle': '(No-PII)',
  'web.db.coreDesc':
    'Almacena clientes, códigos de autorización, tokens, sesiones. Puede replicarse globalmente.',
  'web.db.piiTitle': 'Base de Datos PII',
  'web.db.piiSubtitle': '(Información de Identificación Personal)',
  'web.db.piiDesc':
    'Almacena perfiles de usuario, credenciales, PII. Debe estar en una sola jurisdicción para cumplimiento.',
  'web.db.name': 'Nombre',
  'web.db.region': 'Región',
  'web.db.regionAuto': 'Automático (más cercano)',
  'web.db.storageProfileTitle': 'Perfil de despliegue de almacenamiento',
  'web.db.storageProfileDesc':
    'Selecciona cómo se ubican los datos core/PII de usuarios para este despliegue.',
  'web.db.sharedD1Title': 'D1 compartido',
  'web.db.sharedD1Desc':
    'Un D1 core y un D1 PII para todo el despliegue. Menor coste de configuración y ruta predeterminada.',
  'web.db.tenantD1Title': 'D1 por tenant',
  'web.db.tenantD1Desc':
    'Un par D1 core/PII por tenant. Requiere aprovisionar la base de datos del tenant antes de activarlo.',
  'web.db.preallocatedSlotsTitle': 'Slots de tenant preasignados',
  'web.db.preallocatedSlotsDesc': 'Cada slot de tenant crea dos bases de datos D1: core y PII.',
  'web.db.slotsLabel': 'Slots',
  'web.db.slotsHelp': 'El valor predeterminado es 3. El máximo es 500 slots.',

  // Web UI Email
  'web.email.title': 'Proveedor de Email',
  'web.email.subtitle':
    'Selecciona servicio de email para restablecimiento de contraseña y verificación:',
  'web.email.none': 'Ninguno',
  'web.email.noneDesc': 'Funciones de email deshabilitadas',
  'web.email.resend': 'Resend',
  'web.email.resendDesc': 'API de email para desarrolladores',
  'web.email.sendgrid': 'SendGrid',
  'web.email.sendgridDesc': 'Entrega de email escalable',
  'web.email.ses': 'Amazon SES',
  'web.email.sesDesc': 'AWS Simple Email Service',
  'web.email.resendConfig': 'Configuración de Resend',
  'web.email.apiKey': 'Clave API',
  'web.email.apiKeyPlaceholder': 're_xxxxxxxx',
  'web.email.fromAddress': 'Dirección del Remitente',
  'web.email.fromAddressPlaceholder': 'noreply@tudominio.com',

  // Web UI Provision
  'web.provision.title': 'Crear Recursos de Cloudflare',
  'web.provision.ready': 'Listo para aprovisionar',
  'web.provision.desc': 'Los siguientes recursos serán creados en tu cuenta de Cloudflare:',
  'web.provision.createResources': 'Crear Recursos',
  'web.provision.saveConfig': 'Guardar Config',
  'web.provision.continueDeploy': 'Continuar a Despliegue →',

  // Web UI Deploy
  'web.deploy.title': 'Desplegar',
  'web.deploy.desc': 'Desplegar workers y UI a Cloudflare:',
  'web.deploy.startDeploy': 'Iniciar Despliegue',
  'web.deploy.deploying': 'Desplegando...',

  // Web UI Complete
  'web.complete.title': '¡Configuración Completa!',
  'web.complete.desc': 'Tu despliegue de Authrim está listo.',
  'web.complete.issuerUrl': 'URL del Emisor',
  'web.complete.loginUrl': 'URL de Inicio de Sesión',
  'web.complete.adminUrl': 'URL de Administración',
  'web.complete.saveConfig': 'Guardar Configuración',
  'web.complete.backToMain': 'Volver al Inicio',
  'web.config.saveToFileTitle': 'Guardar configuración en un archivo',
  'web.complete.backToMainTitle': 'Volver a la pantalla principal',
  'web.complete.canClose':
    'La configuración está completa. Puedes cerrar esta ventana de forma segura.',
  'web.complete.adminAccountTitle': 'Configuración de cuenta de administrador',
  'web.complete.adminAccountImportant': 'IMPORTANTE',
  'web.complete.adminAccountDesc':
    'Registre su primera cuenta de administrador con autenticación Passkey:',
  'web.complete.copy': '📋 Copiar',
  'web.complete.copied': '✓ Copiado',
  'web.complete.openSetup': '🔑 Abrir configuración',
  'web.complete.urlWarning':
    'Esta URL solo se puede usar <strong>una vez</strong> y expira el <strong>{{date}}</strong>.',
  'web.complete.adminSetupUnavailable':
    'URL de configuración no disponible. Puede configurar el acceso de administrador desde la UI de administración más tarde.',
  'web.complete.customDomainNote':
    'ℹ️ Dominio personalizado: la propagación DNS puede tardar de minutos a horas. Si la URL no está accesible todavía, espere e intente de nuevo.',

  // Web UI Environment Management
  'web.env.title': 'Entornos',
  'web.env.loading': 'Cargando entornos...',
  'web.env.noEnvFound': 'No se encontraron entornos',
  'web.env.refresh': 'Actualizar',
  'web.env.adminSetup': 'Configuración Inicial de Admin',
  'web.env.adminSetupDesc': 'Clic para crear cuenta de admin para',
  'web.env.openSetup': 'Abrir Configuración',
  'web.env.copyUrl': 'Copiar',
  'web.env.deleteTitle': 'Eliminar Entorno',
  'web.env.deleteWarning':
    'Esta acción no se puede deshacer. Los siguientes recursos serán eliminados permanentemente:',
  'web.env.confirmDelete': 'Eliminar Seleccionados',
  'web.env.cancel': 'Cancelar',

  // Web UI Common buttons
  'web.btn.back': 'Atrás',
  'web.btn.continue': 'Continuar',
  'web.btn.cancel': 'Cancelar',
  'web.btn.save': 'Guardar',
  'web.btn.skip': 'Omitir',

  // Web UI Save Modal
  'web.modal.saveTitle': '¿Guardar Configuración?',
  'web.modal.saveDesc': 'Guarda la configuración en tu máquina local para uso futuro.',
  'web.modal.skipSave': 'Omitir',
  'web.modal.saveConfig': 'Guardar Configuración',

  // Web UI steps
  'web.step.environment': 'Entorno',
  'web.step.region': 'Región',
  'web.step.domain': 'Dominio',
  'web.step.email': 'Email',
  'web.step.sms': 'SMS',
  'web.step.social': 'Social',
  'web.step.advanced': 'Avanzado',
  'web.step.review': 'Revisar',
  'web.step.deploy': 'Desplegar',

  // Web UI forms
  'web.form.submit': 'Enviar',
  'web.form.next': 'Siguiente',
  'web.form.previous': 'Anterior',
  'web.form.reset': 'Restablecer',
  'web.form.validation': 'Por favor corrige los errores de arriba',

  // Web UI progress
  'web.progress.preparing': 'Preparando despliegue...',
  'web.progress.creatingResources': 'Creando recursos de Cloudflare...',
  'web.progress.generatingKeys': 'Generando claves criptográficas...',
  'web.progress.configuringWorkers': 'Configurando workers...',
  'web.progress.deployingWorkers': 'Desplegando workers...',
  'web.progress.deployingUI': 'Desplegando UI...',
  'web.progress.runningMigrations': 'Ejecutando migraciones de base de datos...',
  'web.progress.complete': '¡Despliegue completo!',
  'web.progress.failed': 'Despliegue fallido',

  // Web UI Form Labels
  'web.form.envName': 'Nombre del Entorno',
  'web.form.envNamePlaceholder': 'ej., prod, main, tokyo, acme-dev',
  'web.form.envNameHint': 'Solo letras minúsculas, números y guiones',
  'web.form.envNameError':
    'Solo se permiten letras minúsculas, números y guiones (debe comenzar con una letra)',
  'web.form.baseDomain': 'Dominio Base (Dominio API)',
  'web.form.baseDomainPlaceholder': 'oidc.ejemplo.com',
  'web.form.baseDomainHint':
    'Dominio personalizado para Authrim. Dejar vacío para usar workers.dev',
  'web.form.nakedDomain': 'Excluir nombre de tenant de la URL',
  'web.form.nakedDomainHint': 'Usar https://ejemplo.com en lugar de https://{tenant}.ejemplo.com',
  'web.form.nakedDomainWarning':
    'Los subdominios de tenant requieren un dominio personalizado. Workers.dev no soporta subdominios comodín.',
  'web.form.tenantId': 'ID de Tenant Predeterminado',
  'web.form.tenantIdPlaceholder': 'default',
  'web.form.tenantIdHint': 'Identificador del primer tenant (minúsculas, sin espacios)',
  'web.form.tenantIdWorkerNote':
    '(El ID de Tenant se usa internamente. El subdominio URL requiere dominio personalizado.)',
  'web.form.tenantDisplay': 'Nombre para Mostrar del Tenant',
  'web.form.tenantDisplayPlaceholder': 'Mi Empresa',
  'web.form.tenantDisplayHint':
    'Nombre mostrado en la página de inicio de sesión y pantalla de consentimiento',
  'web.form.userIdFormat': 'Formato de ID de Usuario',
  'web.form.userIdNanoid': 'NanoID (recomendado)',
  'web.form.userIdUuid': 'UUID v4',
  'web.form.userIdFormatHint':
    'Formato para generar IDs de usuario. No se puede cambiar después de crear usuarios.',
  'web.form.loginDomainPlaceholder': 'login.ejemplo.com',
  'web.form.adminDomainPlaceholder': 'admin.ejemplo.com',

  // Web UI Section Headers
  'web.section.apiDomain': 'Dominio API / Emisor',
  'web.section.uiDomains': 'Dominios UI (Opcional)',
  'web.section.uiDomainsHint':
    'Dominios personalizados para UIs de Login/Admin. Cada uno puede configurarse independientemente. Dejar vacío para usar predeterminado de Cloudflare Workers.',
  'web.section.corsHint':
    'CORS: Las solicitudes cross-origin desde UI de Login/Admin a API se permiten automáticamente.',
  'web.section.configPreview': 'Vista Previa de Configuración',
  'web.section.resourceNames': 'Nombres de Recursos',

  // Web UI Preview Labels
  'web.preview.components': 'Componentes:',
  'web.preview.workers': 'Workers:',
  'web.preview.issuerUrl': 'URL del Emisor:',
  'web.preview.loginUi': 'UI de Inicio de Sesión:',
  'web.preview.adminUi': 'UI de Admin:',
  'web.preview.pagesUrl': 'Origen de UI de Inicio de Sesión:',
  'web.preview.tenantDiscover': 'Selección de Tenant (Entrada Común):',
  'web.preview.adminAccess': 'Acceso a la UI de Admin:',
  'web.preview.firstTenant': '{{name}} (Tenant Principal)',
  'web.preview.otherTenants': 'Otros Tenants',
  'web.preview.allTenantsShared': '(compartido por todos los tenants)',
  'web.preview.loginUiOriginNote':
    '(origen de despliegue; el login de tenant usa /login del issuer)',
  'web.preview.viaApiProxy': '(proxied a través del mismo dominio de la API)',
  'web.preview.conflictWarningTitle': '⚠️ Problema de configuración',
  'web.preview.conflictWarningMsg':
    'El dominio personalizado de {{conflictUI}} es el mismo que el de la API ({{baseDomain}}). Como "Eliminar tenant de la URL" está deshabilitado, las solicitudes API a {{baseDomain}} (/authorize, /api/auth/*, etc.) devolverán 404 y el flujo de inicio de sesión fallará.',
  'web.preview.conflictActionMsg':
    'Solución: Habilite "Eliminar tenant de la URL" y configure el primer tenant ({{tenantName}}) como principal. O cambie el dominio de {{conflictUI}} a un dominio diferente al de la API (ej. login.{{baseDomain}}).',

  // Web UI Component Labels
  'web.comp.loginUi': 'UI de Inicio de Sesión',
  'web.comp.loginUiDesc':
    'Páginas de inicio de sesión, registro, consentimiento y gestión de cuenta para usuarios.',
  'web.comp.adminUi': 'UI de Administración',
  'web.comp.adminUiDesc':
    'Panel de administración para gestionar tenants, clientes, usuarios y configuración del sistema.',

  // Web UI Domain Row Labels
  'web.domain.loginUi': 'UI de Inicio de Sesión',
  'web.domain.adminUi': 'UI de Admin',

  // Web UI Database Section
  'web.db.introDesc':
    'Authrim usa dos bases de datos D1 separadas para aislar datos personales de datos de aplicación.',
  'web.db.regionNote':
    'Nota: La región de la base de datos no puede cambiarse después de la creación.',
  'web.db.coreNonPii': 'No-PII',
  'web.db.coreDataDesc': 'Almacena datos de aplicación no personales incluyendo:',
  'web.db.coreData1': 'Clientes OAuth y sus configuraciones',
  'web.db.coreData2': 'Códigos de autorización y access tokens',
  'web.db.coreData3': 'Sesiones de usuario y estado de login',
  'web.db.coreData4': 'Configuraciones de tenant',
  'web.db.coreData5': 'Logs de auditoría y eventos de seguridad',
  'web.db.coreHint':
    'Esta base de datos maneja todos los flujos de autenticación y debe colocarse cerca de tu base de usuarios principal.',
  'web.db.piiLabel': 'Información de Identificación Personal',
  'web.db.piiDataDesc': 'Almacena datos personales de usuario incluyendo:',
  'web.db.piiData1': 'Perfiles de usuario (nombre, email, teléfono)',
  'web.db.piiData2': 'Credenciales Passkey/WebAuthn',
  'web.db.piiData3': 'Preferencias y configuraciones de usuario',
  'web.db.piiData4': 'Cualquier atributo personalizado de usuario',
  'web.db.piiHint':
    'Esta base de datos contiene datos personales. Considera colocarla en una región que cumpla con tus requisitos de protección de datos.',
  'web.db.locationHints': 'Sugerencias de Ubicación',
  'web.db.jurisdiction': 'Jurisdicción (Cumplimiento)',
  'web.db.autoNearest': 'Automático (más cercano)',
  'web.db.northAmericaWest': 'Norteamérica (Oeste)',
  'web.db.northAmericaEast': 'Norteamérica (Este)',
  'web.db.europeWest': 'Europa (Oeste)',
  'web.db.europeEast': 'Europa (Este)',
  'web.db.asiaPacific': 'Asia Pacífico',
  'web.db.oceania': 'Oceanía',
  'web.db.euJurisdiction': 'Jurisdicción UE (cumplimiento GDPR)',

  // Web UI Email Section
  'web.email.introDesc':
    'Usado para enviar OTP por email y verificación de dirección de email. Puedes configurar esto después si lo prefieres.',
  'web.email.configureLater': 'Configurar después',
  'web.email.configureLaterHint': 'Omitir por ahora y configurar después.',
  'web.email.configureCloudflare': 'Configurar Cloudflare Email Service',
  'web.email.configureCloudflareHint':
    'Usa el binding nativo de Workers Email Service. Requiere un plan Workers Paid y Cloudflare DNS.',
  'web.email.configureResend': 'Configurar Resend',
  'web.email.configureResendHint':
    'Configurar envío de email con Resend (recomendado para producción).',
  'web.email.cloudflareSetup': 'Cloudflare Email Service',
  'web.email.cloudflareRequirements': 'Requisitos',
  'web.email.cloudflareRequirementPaid': 'Se requiere un plan Workers Paid',
  'web.email.cloudflareRequirementDns': 'Se requiere Cloudflare DNS / incorporación del dominio',
  'web.email.cloudflareRequirementManual':
    'La configuración del dominio en el panel de Cloudflare sigue siendo manual',
  'web.email.resendSetup': 'Configuración de Resend',
  'web.email.beforeBegin': 'Antes de comenzar:',
  'web.email.step1': 'Crea una cuenta en Resend en',
  'web.email.step2': 'Agrega y verifica tu dominio en',
  'web.email.step3': 'Crea una clave API en',
  'web.email.resendApiKey': 'Clave API de Resend',
  'web.email.resendApiKeyHint': 'Tu clave API comienza con "re_"',
  'web.email.resendApiKeyMissing': 'Ingresa tu clave API de Resend',
  'web.email.resendApiKeyConfirmInvalid':
    'La clave API no comienza con "re_". Puede que no sea una clave API válida de Resend. ¿Quieres continuar de todos modos?',
  'web.email.fromEmailAddress': 'Dirección de Email del Remitente',
  'web.email.cloudflareFromHint':
    'Debe pertenecer a un dominio incorporado en Cloudflare Email Service',
  'web.email.fromEmailHint': 'Debe ser de un dominio verificado en tu cuenta de Resend',
  'web.email.fromEmailMissing': 'Ingresa una dirección de email del remitente',
  'web.email.fromEmailInvalid': 'Ingresa una dirección de email válida',
  'web.email.fromDisplayName': 'Nombre para Mostrar del Remitente (opcional)',
  'web.email.fromDisplayHint': 'Se muestra como el nombre del remitente en clientes de email',
  'web.email.saveConfigFailed': 'No se pudo guardar la configuración de email',
  'web.email.domainVerificationTitle': 'Verificación de Dominio Requerida',
  'web.email.domainVerificationDesc':
    'Antes de que tu dominio sea verificado, los emails solo pueden enviarse desde onboarding@resend.dev (para pruebas).',
  'web.email.learnMore': 'Más información sobre verificación de dominio →',

  // Web UI Provision Section
  'web.provision.resourcePreview': 'Nombres de Recursos:',
  'web.provision.d1Databases': 'Bases de datos D1:',
  'web.provision.kvNamespaces': 'Namespaces KV:',
  'web.provision.cryptoKeys': 'Claves Criptográficas:',
  'web.provision.initializing': 'Inicializando...',
  'web.provision.showLog': 'Mostrar log detallado',
  'web.provision.hideLog': 'Ocultar log detallado',
  'web.provision.keysSavedTo': 'Claves guardadas en:',
  'web.provision.keepSafe': 'Mantén este directorio seguro y agrégalo a .gitignore',

  // Web UI Deploy Section
  'web.deploy.readyText': 'Listo para desplegar workers de Authrim a Cloudflare.',

  // Web UI Environment List
  'web.env.detectedDesc': 'Entornos de Authrim detectados en tu cuenta de Cloudflare:',
  'web.env.noEnvsDetected': 'No se detectaron entornos de Authrim en esta cuenta de Cloudflare.',
  'web.env.backToList': '← Volver a Lista',
  'web.env.deleteEnv': 'Eliminar Entorno...',

  // Web UI Environment Detail
  'web.envDetail.title': 'Detalles del Entorno',
  'web.envDetail.adminNotConfigured': 'Cuenta de Admin No Configurada',
  'web.envDetail.adminNotConfiguredDesc':
    'El administrador inicial no ha sido configurado para este entorno.',
  'web.envDetail.startPasskey': 'Iniciar Configuración de Cuenta Admin con Passkey',
  'web.envDetail.setupUrlGenerated': 'URL de Configuración Generada:',
  'web.envDetail.copyBtn': 'Copiar',
  'web.envDetail.openSetup': 'Abrir Configuración',
  'web.envDetail.urlValidFor':
    'Esta URL es válida por 1 hora. Ábrela en un navegador para registrar la primera cuenta de admin.',
  'web.envDetail.workers': 'Workers',
  'web.envDetail.d1Databases': 'Bases de datos D1',
  'web.envDetail.kvNamespaces': 'Namespaces KV',
  'web.envDetail.queues': 'Colas',
  'web.envDetail.r2Buckets': 'Buckets R2',
  'web.envDetail.pagesProjects': 'Legacy Pages Projects',
  'web.envDetail.emailSettings': 'Configuración de email',
  'web.envDetail.emailDesc': 'Habilita Cloudflare Email Service más tarde para este entorno.',
  'web.envDetail.emailCurrentProvider': 'Proveedor actual',
  'web.envDetail.emailCurrentStatus': 'Estado',
  'web.envDetail.emailCurrentFrom': 'Dirección From',
  'web.envDetail.emailConfigured': 'Configurado',
  'web.envDetail.emailNotConfigured': 'No configurado',
  'web.envDetail.emailProviderNone': 'No configurado',
  'web.envDetail.emailCloudflareRequirements': 'Requisitos',
  'web.envDetail.emailCloudflareRequirementPaid': 'Se requiere Workers Paid Plan',
  'web.envDetail.emailCloudflareRequirementDns':
    'Se requiere DNS de Cloudflare y onboarding del dominio',
  'web.envDetail.emailCloudflareRequirementManual':
    'La configuración del dominio en Cloudflare Dashboard sigue siendo manual',
  'web.envDetail.emailCloudflareFromHint':
    'Debe usar una dirección de un dominio incorporado a Cloudflare Email Service.',
  'web.envDetail.emailFromAddress': 'Dirección de email From',
  'web.envDetail.emailFromName': 'Nombre visible del remitente (opcional)',
  'web.envDetail.emailEnableCloudflare': 'Habilitar Cloudflare Email Service',
  'web.envDetail.emailDeploying': 'Aplicando...',
  'web.envDetail.emailProgress': 'Progreso de configuración de email:',
  'web.envDetail.emailUpdatedSuccess': 'Cloudflare Email habilitado.',
  'web.envDetail.emailUpdateFailed': 'No se pudo habilitar Cloudflare Email.',
  'web.envDetail.emailFromMissing': 'Ingresa una dirección de email From.',
  'web.envDetail.emailFromInvalid': 'Ingresa una dirección de email válida.',
  'web.envDetail.emailSwitchProviderConfirm':
    'Este entorno ya tiene otro proveedor de email configurado. ¿Cambiar a Cloudflare Email Service?',
  'web.envDetail.emailStarting': 'Iniciando configuración de Cloudflare Email...',

  // Web UI Worker Update Section
  'web.envDetail.workerUpdate': 'Actualizar todos los Workers',
  'web.envDetail.workerName': 'Worker',
  'web.envDetail.deployedVersion': 'Desplegado',
  'web.envDetail.localVersion': 'Local',
  'web.envDetail.updateStatus': 'Estado',
  'web.envDetail.needsUpdate': 'Actualizar',
  'web.envDetail.upToDate': 'Actual',
  'web.envDetail.notDeployed': 'No desplegado',
  'web.envDetail.updateOnlyChanged': 'Actualizar solo versiones cambiadas',
  'web.envDetail.updateAllWorkers': 'Actualizar todos los Workers',
  'web.envDetail.refreshVersions': 'Refrescar',
  'web.envDetail.updateProgress': 'Progreso de actualización:',
  'web.envDetail.updatesAvailable': '{{count}} actualización(es) disponible(s)',
  'web.envDetail.allUpToDate': 'Todo actualizado',

  'web.envDetail.action': 'Acción',

  // Web UI Update Section
  'web.envDetail.uiUpdate': 'Actualizar UI (Worker)',
  'web.envDetail.uiUpdateDesc':
    'Actualizar Admin UI o Login UI individualmente. Estos se despliegan en Cloudflare Workers.',
  'web.envDetail.updateNow': 'Actualizar',

  // Web UI Delete Section
  'web.delete.title': 'Eliminar Entorno',
  'web.delete.warning':
    'Esta acción es irreversible. Todos los recursos seleccionados serán eliminados permanentemente.',
  'web.delete.environment': 'Entorno:',
  'web.delete.selectResources': 'Selecciona recursos para eliminar:',
  'web.delete.workers': 'Workers',
  'web.delete.d1Databases': 'Bases de datos D1',
  'web.delete.kvNamespaces': 'Namespaces KV',
  'web.delete.queues': 'Colas',
  'web.delete.r2Buckets': 'Buckets R2',
  'web.delete.pagesProjects': 'Legacy Pages Projects',
  'web.delete.cancelBtn': 'Cancelar',
  'web.delete.confirmBtn': 'Eliminar Seleccionados',

  // Web UI Save Modal
  'web.modal.saveQuestion':
    '¿Te gustaría guardar tu configuración en un archivo antes de continuar?',
  'web.modal.saveReason':
    'Esto te permite reanudar la configuración después o usar la misma configuración para otro despliegue.',
  'web.modal.skipBtn': 'Omitir',
  'web.modal.saveBtn': 'Guardar Configuración',

  // Web UI Error Messages
  'web.error.wranglerNotInstalled': 'Wrangler no instalado',
  'web.error.pleaseInstall': 'Por favor instala wrangler primero:',
  'web.error.notLoggedIn': 'No has iniciado sesión en Cloudflare',
  'web.error.runCommand': 'Por favor ejecuta este comando en tu terminal:',
  'web.error.thenRefresh': 'Luego actualiza esta página.',
  'web.error.checkingPrereq': 'Error verificando preparación:',
  'web.error.invalidJson': 'JSON inválido:',
  'web.error.validationFailed': 'Solicitud de validación fallida:',

  // Web UI Status Messages
  'web.status.checking': 'Verificando...',
  'web.status.running': 'Ejecutando...',
  'web.status.deploying': 'Desplegando...',
  'web.status.complete': 'Completo',
  'web.status.error': 'Error',
  'web.status.scanning': 'Escaneando...',
  'web.status.saving': 'Guardando...',
  'web.status.notDeployed': '(No desplegado)',
  'web.status.startingDeploy': 'Iniciando despliegue...',
  'web.status.none': 'Ninguno',
  'web.status.loading': 'Cargando...',
  'web.status.failedToLoad': 'Error al cargar',
  'web.status.adminNotConfigured': 'Admin No Configurado',
  'web.status.initializing': 'Inicializando...',
  'web.status.found': '{{count}} encontrado(s)',

  // Web UI Button Labels (dynamic)
  'web.btn.reprovision': 'Re-aprovisionar (Eliminar y Crear)',
  'web.btn.createResources': 'Crear Recursos',
  'web.btn.saveConfiguration': 'Guardar Configuración',

  // Quick setup specific
  'quickSetup.title': 'Configuración Rápida',

  // Custom setup specific
  'customSetup.title': 'Configuración Personalizada',
  'customSetup.cancelled': 'Configuración cancelada.',

  // Web UI starting
  'webUi.starting': 'Iniciando Web UI...',
};

export default es;

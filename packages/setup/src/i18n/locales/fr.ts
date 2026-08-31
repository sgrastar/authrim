/**
 * French Translations for Authrim Setup Tool
 * Traductions françaises
 */

import type { Translations } from '../types.js';

const fr: Translations = {
  // Language selection
  'language.select': 'Select language / 言語を選択 / 选择语言',
  'language.selected': 'Langue : {{language}}',

  // Banner
  'banner.title': 'Configuration Authrim',
  'banner.subtitle': 'Fournisseur OIDC sur Cloudflare Workers',
  'banner.exitHint': 'Appuyez sur Ctrl+C à tout moment pour quitter',

  // Mode selection
  'mode.prompt': 'Choisissez la méthode de configuration',
  'mode.quick': 'Interface Web (Recommandé)',
  'mode.quickDesc': 'Configuration interactive dans votre navigateur',
  'mode.advanced': 'Mode CLI',
  'mode.advancedDesc': 'Configuration interactive dans le terminal',

  // Startup menu
  'startup.description': 'Configurez le fournisseur OIDC Authrim sur Cloudflare Workers.',
  'startup.cancel': 'Annuler',
  'startup.cancelDesc': 'Quitter la configuration',
  'startup.cancelled': 'Configuration annulée.',
  'startup.resumeLater': 'Pour reprendre plus tard :',

  // Main menu
  'menu.prompt': 'Que souhaitez-vous faire ?',
  'menu.quick': 'Configuration Rapide',
  'menu.quickDesc': 'Déployer Authrim avec une configuration minimale',
  'menu.custom': 'Configuration Personnalisée',
  'menu.customDesc': 'Configurer toutes les options étape par étape',

  // Setup titles
  'quick.title': '⚡ Configuration Rapide',
  'custom.title': '🔧 Configuration Personnalisée',
  'menu.manage': 'Voir les Environnements Existants',
  'menu.manageDesc': 'Voir, inspecter ou supprimer les environnements existants',
  'menu.load': 'Charger une Configuration Existante',
  'menu.loadDesc': 'Reprendre la configuration depuis authrim-config.json',
  'menu.exit': 'Quitter',
  'menu.exitDesc': 'Quitter la configuration',
  'menu.goodbye': 'Au revoir !',

  // Update check
  'update.checking': 'Vérification des mises à jour...',
  'update.available': 'Mise à jour disponible : {{localVersion}} → {{remoteVersion}}',
  'update.prompt': 'Que souhaitez-vous faire ?',
  'update.continue': 'Continuer avec la version actuelle ({{version}})',
  'update.continueDesc': 'Utiliser le code source existant',
  'update.update': 'Mettre à jour vers la dernière version ({{version}})',
  'update.updateDesc': 'Télécharger et remplacer par la nouvelle version',
  'update.cancel': 'Annuler',
  'update.cancelled': 'Annulé.',
  'update.current': 'Utilisation du code source Authrim (v{{version}})',

  // Source download
  'source.downloading': 'Téléchargement du code source...',
  'source.downloaded': 'Code source téléchargé ({{version}})',
  'source.extracting': 'Extraction du code source...',
  'source.installing': 'Installation des dépendances (cela peut prendre quelques minutes)...',
  'source.installed': 'Dépendances installées',
  'source.installFailed': "Échec de l'installation des dépendances",
  'source.installManually': "Vous pouvez essayer d'installer manuellement :",
  'source.notInSourceDir': 'Code source Authrim introuvable',
  'source.downloadPrompt': 'Télécharger le code source dans {{path}} ?',
  'source.downloadOption': 'Télécharger le code source',
  'source.downloadOptionDesc': 'Télécharger la dernière version',
  'source.exitOption': 'Quitter',
  'source.exitOptionDesc': 'Quitter la configuration',
  'source.cloneManually': 'Pour cloner manuellement :',
  'source.directoryExists':
    "Le répertoire {{path}} existe mais ce n'est pas un code source Authrim valide",
  'source.replaceOption': 'Remplacer par un nouveau téléchargement',
  'source.replaceOptionDesc': 'Supprimer {{path}} et télécharger la dernière version',
  'source.differentOption': 'Utiliser un répertoire différent',
  'source.differentOptionDesc': 'Spécifier un autre emplacement',
  'source.enterPath': 'Entrez le chemin du répertoire :',
  'source.updateFailed': 'Échec de la mise à jour',
  'source.downloadFailed': 'Échec du téléchargement',
  'source.verificationWarnings': 'Avertissements de vérification de la structure du code :',

  // WSL Environment
  'wsl.detected': 'Environnement WSL détecté',
  'wsl.cliOnly': "L'interface Web n'est pas disponible sous WSL. Utilisation du mode CLI.",
  'wsl.explanation': "Pour accéder à l'interface Web depuis le navigateur Windows, le serveur doit",
  'wsl.explanationCont': 'se lier à 0.0.0.0 au lieu de localhost.',
  'wsl.securityNote': 'Note de sécurité :',
  'wsl.securityWarning':
    "Cela rendra le serveur accessible depuis d'autres appareils sur votre réseau.",
  'wsl.trustedNetworkOnly': 'Utilisez uniquement sur des réseaux de confiance.',
  'wsl.bindPrompt': "Lier à 0.0.0.0 pour l'accès Windows ? (y/N) :",
  'wsl.bindingToAll': 'Liaison à 0.0.0.0',
  'wsl.usingLocalhost': 'Utilisation de localhost (interne WSL uniquement)',

  // Prerequisites
  'prereq.checking': 'Vérification du statut de wrangler...',
  'prereq.wranglerNotInstalled': "wrangler n'est pas installé",
  'prereq.wranglerInstallHint': 'Exécutez la commande suivante pour installer :',
  'prereq.notLoggedIn': 'Non connecté à Cloudflare',
  'prereq.loginHint': 'Exécutez la commande suivante pour vous authentifier :',
  'prereq.loggedInAs': 'Connecté à Cloudflare ({{email}})',
  'prereq.authenticated': 'Connecté à Cloudflare',
  'prereq.checkFailed': 'Impossible de vérifier wrangler',
  'prereq.accountId': 'ID du compte : {{accountId}}',

  // Environment
  'env.prompt': "Entrez le nom de l'environnement",
  'env.prod': 'Production',
  'env.prodDesc': 'Pour une utilisation en production',
  'env.staging': 'Staging',
  'env.stagingDesc': 'Pour les tests avant la production',
  'env.dev': 'Développement',
  'env.devDesc': 'Pour le développement local',
  'env.custom': 'Personnalisé',
  'env.customDesc': "Entrez un nom d'environnement personnalisé",
  'env.customPrompt': "Entrez le nom d'environnement personnalisé",
  'env.customValidation':
    'Seuls les lettres minuscules, chiffres et tirets sont autorisés (ex : prod, main, tokyo, acme-dev)',
  'env.detected': 'Environnements Détectés :',
  'env.selectExisting': 'Sélectionner un environnement existant',
  'env.createNew': 'Créer un nouvel environnement',
  'env.createNewDesc': 'Configurer un nouvel environnement',
  'env.checking': 'Vérification des environnements existants...',
  'env.alreadyExists': 'L\'environnement "{{env}}" existe déjà',
  'env.existingResources': 'Ressources existantes :',
  'env.workers': 'Workers : {{count}}',
  'env.d1Databases': 'Bases de données D1 : {{count}}',
  'env.kvNamespaces': 'Namespaces KV : {{count}}',
  'env.chooseAnother':
    'Veuillez choisir un autre nom ou utilisez "{{command}} manage" pour le supprimer d\'abord.',
  'env.available': "Le nom de l'environnement est disponible",
  'env.checkFailed':
    'Impossible de vérifier les environnements existants (continuation quand même)',
  'env.noEnvFound': 'Aucun environnement Authrim trouvé.',

  // Region
  'region.prompt': 'Sélectionnez la région',
  'region.auto': 'Automatique (la plus proche)',
  'region.autoDesc': 'Laisser Cloudflare choisir la région la plus proche',
  'region.wnam': 'Amérique du Nord (Ouest)',
  'region.wnamDesc': "Ouest de l'Amérique du Nord",
  'region.enam': 'Amérique du Nord (Est)',
  'region.enamDesc': "Est de l'Amérique du Nord",
  'region.weur': 'Europe (Ouest)',
  'region.weurDesc': "Europe de l'Ouest",
  'region.eeur': 'Europe (Est)',
  'region.eeurDesc': "Europe de l'Est",
  'region.apac': 'Asie Pacifique',
  'region.apacDesc': 'Région Asie Pacifique',
  'region.oceania': 'Océanie',
  'region.oceaniaDesc': 'Australie et îles du Pacifique',
  'region.euJurisdiction': 'Juridiction UE (conformité RGPD)',
  'region.euJurisdictionDesc': "Données stockées dans l'UE",

  // UI deployment
  'ui.prompt': "Méthode de déploiement de l'UI",
  'ui.pagesOption': 'Cloudflare Workers',
  'ui.pagesDesc': 'Déployer sur Cloudflare Workers (recommandé)',
  'ui.customOption': 'Domaine personnalisé',
  'ui.customDesc': 'Utiliser votre propre hébergement',
  'ui.skipOption': 'Ignorer',
  'ui.skipDesc': "Ignorer le déploiement de l'UI",
  'ui.customPrompt': "Entrez l'URL personnalisée de l'UI",

  // Domain
  'domain.prompt': 'Configurer un domaine personnalisé ?',
  'domain.workersDevOption': 'Utiliser le domaine workers.dev',
  'domain.workersDevDesc': 'Utiliser le domaine par défaut de Cloudflare',
  'domain.customOption': 'Configurer un domaine personnalisé',
  'domain.customDesc': 'Utiliser votre propre domaine',
  'domain.customPrompt': 'Entrez le domaine personnalisé (ex : auth.exemple.com)',
  'domain.customValidation': 'Veuillez entrer un domaine valide (ex : auth.exemple.com)',
  'domain.checkZoneButton': 'Vérifier la zone',
  'domain.checkingZone': 'Vérification de la zone Cloudflare pour {{domain}}...',
  'domain.zoneFound': "Zone '{{zone}}' trouvée (statut : {{status}})",
  'domain.zoneNotFound': "Zone '{{zone}}' introuvable dans votre compte Cloudflare",
  'domain.zoneNotFoundHint':
    "Le routage de domaine personnalisé nécessite que la zone soit d'abord ajoutée à Cloudflare.",
  'domain.zoneCheckFailed': 'Impossible de vérifier la zone',
  'domain.zoneCheckSkipped': 'Vérification de zone ignorée, poursuite de la configuration...',
  'domain.continueWithoutZone': 'Continuer sans vérification de zone ?',
  'domain.configureBinding': 'Configurer la liaison de domaine personnalisé pour Workers',
  'domain.configureBindingDesc':
    'Attribue directement le domaine de base au Worker routeur afin que Cloudflare gère le DNS et le certificat TLS. Les sous-domaines des tenants continuent d’utiliser le routage générique.',
  'domain.customHostnamesDesc':
    'Automatisez les domaines personnalisés des tenants avec Cloudflare Custom Hostnames.',
  'domain.customHostnamesPrivacy':
    'Le jeton est conservé uniquement dans un fichier secret local et envoyé comme secret Worker ; il n’est pas enregistré dans D1, KV ou la configuration.',
  'domain.customHostnamesPrompt': 'Activer l’automatisation Cloudflare Custom Hostnames ?',
  'domain.action.retryCheck': 'Vérifier à nouveau',
  'domain.action.reloadPage': 'Recharger la page',
  'domain.action.openCloudflareDashboard': 'Ouvrir le tableau de bord Cloudflare',
  'domain.prereq.reviewTitle': 'La vérification du domaine personnalisé demande une revue',
  'domain.prereq.reviewBody':
    'Si vous comptez utiliser un domaine personnalisé, relancez la vérification après avoir rechargé la page ou rafraîchi la connexion Cloudflare.',
  'domain.diagnostic.zone_found.title': 'La zone Cloudflare est prête',
  'domain.diagnostic.zone_found.body':
    'La zone "{{zone}}" est disponible dans votre compte Cloudflare.',
  'domain.diagnostic.zone_found.next':
    'Vous pouvez continuer avec la configuration du binding de domaine personnalisé.',
  'domain.diagnostic.not_logged_in.title': 'Une connexion Cloudflare est nécessaire',
  'domain.diagnostic.not_logged_in.body':
    'Authrim n’a pas pu confirmer une connexion Cloudflare pour cette vérification de zone.',
  'domain.diagnostic.not_logged_in.next':
    '1. Exécutez `wrangler login` dans votre terminal.\n2. Rechargez cette page.\n3. Vérifiez à nouveau la zone.',
  'domain.diagnostic.token_unavailable.title': 'Le jeton Cloudflare n’a pas pu être chargé',
  'domain.diagnostic.token_unavailable.body':
    'La connexion Wrangler semble présente, mais le jeton API nécessaire pour lire la zone n’est pas encore disponible.',
  'domain.diagnostic.token_unavailable.next':
    '1. Rechargez cette page puis vérifiez à nouveau.\n2. Si cela échoue encore, relancez `wrangler login`.\n3. Essayez ensuite de vérifier la zone de nouveau.',
  'domain.diagnostic.zone_read_forbidden.title': 'L’accès à la liste des zones est limité',
  'domain.diagnostic.zone_read_forbidden.body':
    'Le jeton Cloudflare actuel ne peut pas lire la liste des zones. Les zones existantes peuvent encore fonctionner, mais la vérification automatique et l’assistance DNS seront limitées.',
  'domain.diagnostic.zone_read_forbidden.next':
    '1. Vérifiez de nouveau une première fois.\n2. Si cela échoue encore, relancez `wrangler login`.\n3. Vérifiez que le jeton possède la permission Zone:Read.\n4. Si la zone existe déjà, vous pouvez continuer manuellement.',
  'domain.diagnostic.zone_not_found.title': 'La zone est introuvable dans ce compte',
  'domain.diagnostic.zone_not_found.body':
    'Cloudflare a répondu, mais la zone "{{zone}}" n’est pas visible dans le compte actuel.',
  'domain.diagnostic.zone_not_found.next':
    '1. Vérifiez que la zone existe dans le compte Cloudflare utilisé.\n2. Si nécessaire, changez de compte ou ouvrez le tableau de bord Cloudflare.\n3. Vérifiez ensuite la zone de nouveau.',
  'domain.diagnostic.api_error.title': 'La vérification de l’API Cloudflare a échoué',
  'domain.diagnostic.api_error.body':
    'Cloudflare a renvoyé une réponse inattendue pendant la vérification de cette zone.',
  'domain.diagnostic.api_error.next':
    'Relancez la vérification. Si cela échoue encore, rechargez cette page puis réessayez.',
  'domain.diagnostic.network_error.title': 'La vérification réseau vers Cloudflare a échoué',
  'domain.diagnostic.network_error.body':
    'La vérification de zone n’a pas pu se terminer, car Cloudflare ou le réseau n’a pas répondu comme prévu.',
  'domain.diagnostic.network_error.next':
    'Relancez la vérification. Si cela échoue encore, rechargez cette page puis réessayez.',
  'domain.issuerUrl': "URL de l'émetteur : {{url}}",
  'domain.apiDomain': 'Domaine API / Émetteur (ex : auth.exemple.com)',
  'domain.loginUiDomain': 'Domaine UI de connexion (Entrée pour ignorer)',
  'domain.adminUiDomain': "Domaine UI d'admin (Entrée pour ignorer)",
  'domain.baseDomainDepthError':
    'Base Domain doit être le domaine parent utilisé par les URL des locataires. « {{hostname}} » contient trop de libellés avant le domaine enregistré.',
  'domain.uiDomainDepthError':
    'Le domaine {{label}} « {{hostname}} » est trop profond pour le modèle standard de domaine de locataire.',
  'domain.suggestedHost': 'Hôte suggéré : {{hostname}}',
  'domain.uiRequiresOwnRoute':
    'Le domaine personnalisé de {{label}} nécessite sa propre route Worker.',
  'domain.enterDomains':
    'Entrez les domaines personnalisés (laisser vide pour utiliser les valeurs par défaut de Cloudflare)',
  'domain.singleTenantNote': "En mode single-tenant, URL de l'émetteur = domaine API",
  'domain.usingWorkersDev': '(utilisation du domaine workers.dev de Cloudflare)',
  'web.form.multiTenantEnable': 'Activer le mode multi-tenant',
  'web.form.multiTenantHint': 'Créer des sous-domaines de tenant sous votre domaine personnalisé',
  'web.form.multiTenantExamples': 'Exemples d’URL de tenant',
  'web.form.multiTenantExampleDefaultOmitted': 'Tenant par défaut avec nom omis : {{url}}',
  'web.form.multiTenantExampleDefaultIncluded': 'Tenant par défaut avec nom explicite : {{url}}',
  'web.form.multiTenantExampleOther': 'Tenant non par défaut : {{url}}',

  // Database
  'db.title': 'Configuration de la Base de Données',
  'db.regionWarning':
    'La région de la base de données ne peut pas être modifiée après la création.',
  'db.coreDescription': "BD plateforme : Stocke les métadonnées et journaux d'audit non PII",
  'db.coreRegion': 'Région de la Base de Données Core',
  'db.piiDescription': "BD PII plateforme : Stocke l'audit PII et les données anonymisées",
  'db.piiNote': 'Considérez vos exigences de protection des données.',
  'db.piiRegion': 'Région de la Base de Données PII',
  'db.creating': 'Création de la base de données...',
  'db.created': 'Base de données créée : {{name}}',
  'db.existing': 'Utilisation de la base de données existante : {{name}}',
  'db.error': 'Échec de la création de la base de données',
  'db.locationHints': 'Conseils de Localisation',
  'db.jurisdictionCompliance': 'Juridiction (Conformité)',

  // KV
  'kv.creating': 'Création du namespace KV...',
  'kv.created': 'Namespace KV créé : {{name}}',
  'kv.existing': 'Utilisation du namespace KV existant : {{name}}',
  'kv.error': 'Échec de la création du namespace KV',

  // Queue
  'queue.creating': "Création de la file d'attente...",
  'queue.created': "File d'attente créée : {{name}}",
  'queue.existing': "Utilisation de la file d'attente existante : {{name}}",
  'queue.error': "Échec de la création de la file d'attente",

  // R2
  'r2.creating': 'Création du bucket R2...',
  'r2.created': 'Bucket R2 créé : {{name}}',
  'r2.existing': 'Utilisation du bucket R2 existant : {{name}}',
  'r2.error': 'Échec de la création du bucket R2',

  // Keys
  'keys.generating': 'Génération des clés cryptographiques...',
  'keys.generated': 'Clés générées ({{path}})',
  'keys.existing': 'Des clés existent déjà pour l\'environnement "{{env}}"',
  'keys.existingWarning': 'Les clés existantes seront écrasées.',
  'keys.replaced':
    'Les clés existantes ont été remplacées après confirmation de la disponibilité de l’environnement.',
  'keys.error': 'Échec de la génération des clés',
  'keys.regeneratePrompt': 'Régénérer les clés ?',
  'keys.regenerateWarning': 'Cela invalidera tous les tokens existants !',

  // Config
  'config.saving': 'Enregistrement de la configuration...',
  'config.saved': 'Configuration enregistrée dans {{path}}',
  'config.error': "Échec de l'enregistrement de la configuration",
  'config.path': 'Chemin de la configuration',
  'config.summary': 'Résumé de la Configuration',
  'config.infrastructure': 'Infrastructure :',
  'config.environment': 'Environnement :',
  'config.workerPrefix': 'Préfixe du Worker :',
  'config.profile': 'Profil :',
  'config.tenantIssuer': 'Tenant et Émetteur :',
  'config.mode': 'Mode :',
  'config.multiTenant': 'Multi-tenant',
  'config.singleTenant': 'Single-tenant',
  'config.baseDomain': 'Domaine de Base :',
  'config.issuerFormat': "Format de l'Émetteur :",
  'config.issuerUrl': "URL de l'Émetteur :",
  'config.defaultTenant': 'Tenant Par Défaut :',
  'config.displayName': "Nom d'Affichage :",
  'config.publicUrls': 'URLs Publiques :',
  'config.apiRouter': 'Routeur API :',
  'config.loginUi': 'UI de Connexion :',
  'config.adminUi': "UI d'Admin :",
  'config.components': 'Composants :',
  'config.featureFlags': 'Flags de Fonctionnalités :',
  'config.emailSettings': 'Email :',
  'config.oidcSettings': 'Paramètres OIDC :',
  'config.accessTtl': 'TTL Access Token :',
  'config.refreshTtl': 'TTL Refresh Token :',
  'config.authCodeTtl': 'TTL Auth Code :',
  'config.pkceRequired': 'PKCE Requis :',
  'config.sharding': 'Sharding :',
  'config.authCodeShards': 'Auth Code :',
  'config.refreshTokenShards': 'Refresh Token :',
  'config.database': 'Base de Données :',
  'config.coreDb': 'BD Core :',
  'config.piiDb': 'BD PII :',
  'config.enabled': 'Activé',
  'config.disabled': 'Désactivé',
  'config.standard': '(standard)',
  'config.notConfigured': 'Non configuré (configurer plus tard)',
  'config.yes': 'Oui',
  'config.no': 'Non',
  'config.shards': 'shards',
  'config.sec': 'sec',
  'config.automatic': 'Automatique',
  'config.d1Routing': 'Routage D1 :',
  'config.placement': 'Placement :',
  'config.provisioning': 'Provisionnement :',
  'config.uiEnvNoApi': 'ui.env sera créé après la configuration d’une URL d’API.',
  'config.wranglerConfigsSaved': '{{count}} configurations maîtres wrangler.toml enregistrées',
  'config.wranglerConfigsPartial':
    'Certaines configurations wrangler n’ont pas pu être enregistrées',
  'config.wranglerConfigsSyncing':
    'Synchronisation des configurations wrangler avec les paquets...',
  'config.wranglerConfigsSynced': 'Configurations wrangler synchronisées avec {{count}} composants',
  'config.wranglerConfigsSyncFailed': 'Échec de la synchronisation des configurations wrangler',

  // Deploy
  'deploy.prompt': 'Démarrer la configuration avec ces paramètres ?',
  'deploy.starting': 'Exécution de la Configuration...',
  'deploy.building': 'Compilation des paquets...',
  'deploy.deploying': 'Déploiement sur Cloudflare...',
  'deploy.success': 'Configuration terminée !',
  'deploy.error': 'Échec du déploiement',
  'deploy.skipped': 'Déploiement ignoré',
  'deploy.component': 'Déploiement de {{component}}...',
  'deploy.uploadingSecrets': 'Téléversement des secrets...',
  'deploy.secretsUploaded': 'Secrets téléversés',
  'deploy.runningMigrations': 'Exécution des migrations de base de données...',
  'deploy.migrationsComplete': 'Migrations terminées',
  'deploy.deployingWorker': 'Déploiement du worker {{name}}...',
  'deploy.workerDeployed': 'Worker déployé : {{name}}',
  'deploy.deployingUI': "Déploiement de l'UI...",
  'deploy.uiDeployed': 'UI déployée',
  'deploy.creatingResources': 'Création des ressources Cloudflare...',
  'deploy.resourcesFailed': 'Échec de la création des ressources',
  'deploy.continueWithout':
    'Continuer sans provisionnement ? (vous devrez créer les ressources manuellement)',
  'deploy.emailSecretsSaved': 'Secrets email enregistrés dans {{path}}',
  'deploy.confirmStart': 'Démarrer le déploiement ?',
  'deploy.confirmDryRun': 'Exécuter le déploiement en mode test ?',
  'deploy.cancelled': 'Déploiement annulé.',
  'deploy.wranglerChanged': 'Comment voulez-vous gérer ces modifications ?',
  'deploy.wranglerKeep': '📝 Conserver les modifications manuelles (déployer tel quel)',
  'deploy.wranglerBackup': '💾 Sauvegarder et écraser avec le master',
  'deploy.wranglerOverwrite': '⚠️ Écraser avec le master (perdre les modifications)',
  'deploy.initialProvisioningFailed':
    'Le provisionnement Cloudflare n’a pas abouti. Aucun verrou d’environnement n’a été créé ; relancez init pour reprendre en toute sécurité.',

  // Email provider
  'email.title': "Fournisseur d'Email",
  'email.description':
    "Configurez l'envoi d'email pour les liens magiques et les codes de vérification.",
  'email.prompt': "Configurer le fournisseur d'email maintenant ?",
  'email.resendOption': 'Resend',
  'email.resendDesc': 'API email moderne pour les développeurs',
  'email.sesOption': 'AWS SES',
  'email.sesDesc': 'Amazon Simple Email Service',
  'email.smtpOption': 'SMTP',
  'email.smtpDesc': 'Serveur SMTP générique',
  'email.skipOption': 'Aucun (configurer plus tard)',
  'email.skipDesc': 'Ignorer la configuration email',
  'email.apiKeyPrompt': 'Clé API Resend',
  'email.apiKeyHint': 'Obtenez votre clé API sur : https://resend.com/api-keys',
  'email.domainHint': 'Configurez le domaine sur : https://resend.com/domains',
  'email.apiKeyRequired': 'La clé API est requise',
  'email.apiKeyWarning': 'Attention : Les clés API Resend commencent généralement par "re_"',
  'email.fromAddressPrompt': "Adresse email de l'expéditeur",
  'email.fromAddressValidation': 'Veuillez entrer une adresse email valide',
  'email.fromNamePrompt': "Nom d'affichage de l'expéditeur (optionnel)",
  'email.domainVerificationRequired':
    'Vérification du domaine requise pour envoyer depuis votre propre domaine.',
  'email.seeDocumentation': 'Voir : https://resend.com/docs/dashboard/domains/introduction',
  'email.provider': 'Fournisseur :',
  'email.fromAddress': "Adresse de l'Expéditeur :",
  'email.fromName': "Nom de l'Expéditeur :",

  // SMS provider
  'sms.prompt': 'Configurer le fournisseur SMS ?',
  'sms.twilioOption': 'Twilio',
  'sms.twilioDesc': 'SMS via Twilio',
  'sms.skipOption': 'Aucun (configurer plus tard)',
  'sms.skipDesc': 'Ignorer la configuration SMS',
  'sms.accountSidPrompt': 'Account SID Twilio',
  'sms.authTokenPrompt': 'Auth Token Twilio',
  'sms.fromNumberPrompt': "Numéro de téléphone de l'expéditeur",

  // Social providers
  'social.prompt': 'Configurer les fournisseurs de connexion sociale ?',
  'social.googleOption': 'Google',
  'social.googleDesc': 'Se connecter avec Google',
  'social.githubOption': 'GitHub',
  'social.githubDesc': 'Se connecter avec GitHub',
  'social.appleOption': 'Apple',
  'social.appleDesc': 'Se connecter avec Apple',
  'social.microsoftOption': 'Microsoft',
  'social.microsoftDesc': 'Se connecter avec Microsoft',
  'social.skipOption': 'Aucun (configurer plus tard)',
  'social.skipDesc': 'Ignorer la configuration de connexion sociale',
  'social.clientIdPrompt': 'Client ID',
  'social.clientSecretPrompt': 'Client Secret',

  // Cloudflare API Token
  'cf.apiTokenPrompt': 'Entrez le Token API Cloudflare',
  'cf.apiTokenValidation': 'Veuillez entrer un Token API valide',
  'cf.apiTokenCreationMethod': 'Comment souhaitez-vous créer le jeton d’API ?',
  'cf.apiTokenCreateFromLink': 'Créer depuis un lien préconfiguré (recommandé)',
  'cf.apiTokenCreateFromLinkDesc':
    'Ouvrir Cloudflare avec l’autorisation et la zone requises déjà sélectionnées',
  'cf.apiTokenCreateManually': 'Créer manuellement',
  'cf.apiTokenCreateManuallyDesc':
    'Vérifier l’autorisation requise et configurer vous-même le jeton',
  'cf.apiTokenTemplateUrl': 'URL de création du jeton Cloudflare :',
  'cf.apiTokenTemplateOpenPrompt': 'Appuyez sur Entrée pour ouvrir Cloudflare dans le navigateur',
  'cf.apiTokenTemplateOpened': 'Page de création du jeton Cloudflare ouverte',
  'cf.apiTokenTemplateOpenFailed':
    'Impossible d’ouvrir le navigateur. Ouvrez manuellement l’URL ci-dessous.',
  'cf.apiTokenManualTitle': 'Créez un jeton d’API utilisateur avec les paramètres suivants :',
  'cf.apiTokenManualType': 'Utilisez un API Token, pas la Global API Key.',
  'cf.apiTokenManualPermission': 'Autorisation : Zone > SSL and Certificates > Edit',
  'cf.apiTokenManualResource': 'Ressource de zone : Include > Specific zone > {{zone}}',
  'cf.apiTokenManualLeastPrivilege': 'N’ajoutez pas d’autorisations ou de zones sans rapport.',
  'cf.apiTokenSecretOnce':
    'Le secret du jeton n’est affiché qu’une fois. Copiez-le avant de quitter Cloudflare.',
  'cf.apiTokenSelectedZone': 'la zone utilisée par cet environnement',

  // Tenant configuration
  'tenant.title': 'Mode Tenant',
  'tenant.multiTenantPrompt':
    'Activer le mode multi-tenant ? (isolation des tenants basée sur les sous-domaines)',
  'tenant.multiTenantTitle': 'Configuration URL Multi-tenant',
  'tenant.multiTenantNote1': 'En mode multi-tenant :',
  'tenant.multiTenantNote2': 'Chaque tenant a un sous-domaine : https://{tenant}.{domaine-base}',
  'tenant.multiTenantNote3': 'Le domaine de base pointe vers le Worker routeur',
  'tenant.multiTenantNote4':
    "L'URL de l'émetteur est construite dynamiquement à partir de l'en-tête Host",
  'tenant.baseDomainPrompt': 'Domaine de base (ex : authrim.com)',
  'tenant.baseDomainRequired': 'Le domaine de base est requis pour le mode multi-tenant',
  'tenant.baseDomainValidation': 'Veuillez entrer un domaine valide (ex : authrim.com)',
  'tenant.issuerFormat': "Format URL de l'émetteur : https://{tenant}.{{domain}}",
  'tenant.issuerExample': 'Exemple : https://acme.{{domain}}',
  'tenant.defaultTenantPrompt': 'Nom du tenant par défaut (identifiant)',
  'tenant.defaultTenantValidation':
    'Seuls les lettres minuscules, chiffres et tirets sont autorisés',
  'tenant.displayNamePrompt': "Nom d'affichage du tenant par défaut",
  'tenant.domainSetupHint': 'Laissez vide pour utiliser workers.dev en mode tenant unique.',
  'tenant.customDomainExamples': 'Avec un domaine personnalisé :',
  'tenant.nakedDomainExample': 'https://example.com (issuer sans sous-domaine de tenant)',
  'tenant.subdomainExample': 'https://acme.example.com (issuer avec sous-domaine de tenant)',
  'tenant.idRules':
    'L’ID du tenant doit contenir 1 à 63 caractères, commencer par une minuscule et ne contenir que des minuscules, chiffres et tirets.',
  'tenant.randomIdHint':
    'Un ID aléatoire évite d’exposer un nom de client ou d’entreprise dans l’URL de l’issuer.',
  'tenant.randomIdPrompt': 'Générer un ID de tenant aléatoire ? ({{id}})',
  'tenant.initialDisplayName': 'Tenant initial',
  'tenant.nakedDomainPrompt': 'Utiliser le domaine de base comme issuer du tenant principal ?',
  'tenant.primaryTenantPrompt':
    'ID du tenant principal pour le domaine de base (vide pour le tenant initial)',
  'tenant.singleTenantTitle': 'Configuration URL Single-tenant',
  'tenant.singleTenantNote1': 'En mode single-tenant :',
  'tenant.singleTenantNote2':
    "URL de l'émetteur = domaine personnalisé API (ou workers.dev en repli)",
  'tenant.singleTenantNote3': 'Tous les clients partagent le même émetteur',
  'tenant.organizationName': "Nom de l'organisation (nom d'affichage)",
  'tenant.uiDomainTitle': 'Configuration du Domaine UI',
  'tenant.customUiDomainPrompt': 'Configurer des domaines UI personnalisés ?',
  'tenant.loginUiDomain': 'Domaine UI de connexion (ex : login.exemple.com)',
  'tenant.adminUiDomain': "Domaine UI d'admin (ex : admin.exemple.com)",

  // User ID format
  'userId.title': "Format d'ID Utilisateur",
  'userId.prompt': "Sélectionnez le format d'ID utilisateur",
  'userId.nanoid': 'NanoID (recommandé)',
  'userId.nanoidDesc': 'IDs de 21 caractères sécurisés pour URL, compacts et sûrs',
  'userId.uuid': 'UUID v4',
  'userId.uuidDesc': 'UUIDs standard de 36 caractères avec tirets',
  'userId.note': 'Note : Ce paramètre ne peut pas être modifié après la création des utilisateurs.',
  'userId.selected': "Format d'ID utilisateur : {{format}}",

  // Standard components
  'components.title': 'Composants standard',
  'components.note':
    'SAML, Device Flow/CIBA, VC, Connexion Sociale et Moteur de Politiques sont installés par défaut.',
  'components.samlPrompt': 'Activer le support SAML ?',
  'components.vcPrompt': 'Activer les Credentials Vérifiables ?',
  'components.saml': 'SAML :',
  'components.vc': 'VC :',
  'components.socialLogin': 'Connexion Sociale :',
  'components.policyEngine': 'Moteur de Politiques :',

  // Feature flags
  'features.title': 'Flags de Fonctionnalités',
  'features.queuePrompt': "Activer Cloudflare Queues ? (pour les logs d'audit)",
  'features.r2Prompt': 'Activer le stockage d’objets Cloudflare R2 ?',
  'features.queue': 'File :',
  'features.r2': 'R2 :',

  // OIDC settings
  'oidc.configurePrompt': 'Configurer les paramètres OIDC ? (TTL des tokens, etc.)',
  'oidc.title': 'Paramètres OIDC',
  'oidc.accessTokenTtl': 'TTL Access Token (sec)',
  'oidc.refreshTokenTtl': 'TTL Refresh Token (sec)',
  'oidc.authCodeTtl': 'TTL Authorization Code (sec)',
  'oidc.pkceRequired': 'Exiger PKCE ?',
  'oidc.positiveInteger': 'Veuillez entrer un entier positif',

  // Sharding settings
  'sharding.configurePrompt': 'Configurer le sharding ? (pour les environnements à forte charge)',
  'sharding.title': 'Paramètres de Sharding',
  'sharding.note':
    'Note : Une puissance de 2 est recommandée pour le nombre de shards (4, 8, 16, 32, 64, 128)',
  'sharding.authCodeShards': 'Nombre de shards Auth Code',
  'sharding.refreshTokenShards': 'Nombre de shards Refresh Token',

  // Infrastructure
  'infra.title': 'Infrastructure (Générée Automatiquement)',
  'infra.workersNote': 'Les Workers suivants seront déployés :',
  'infra.router': 'Routeur :',
  'infra.auth': 'Auth :',
  'infra.token': 'Token :',
  'infra.management': 'Gestion :',
  'infra.otherWorkers': '... et autres workers de support',
  'infra.defaultEndpoints': "Points d'accès par défaut (sans domaine personnalisé) :",
  'infra.api': 'API :',
  'infra.ui': 'UI :',
  'infra.workersToDeploy': 'Workers à déployer : {{workers}}',
  'infra.defaultApi': 'API par défaut : {{url}}',

  // Completion
  'complete.title': 'Configuration Terminée !',
  'complete.summary': 'Votre Fournisseur OIDC Authrim a été déployé.',
  'complete.issuerUrl': "URL de l'Émetteur : {{url}}",
  'complete.adminUrl': "Panneau d'Admin : {{url}}",
  'complete.uiUrl': 'UI de Connexion : {{url}}',
  'complete.nextSteps': 'Prochaines Étapes :',
  'complete.nextStep1': "1. Vérifiez le déploiement en visitant l'URL de l'émetteur",
  'complete.nextStep2': "2. Configurez les clients OAuth dans le Panneau d'Admin",
  'complete.nextStep3': '3. Configurez les domaines personnalisés si nécessaire',
  'complete.warning': "N'oubliez pas de garder vos clés en sécurité et sauvegardées !",
  'complete.success': 'Configuration terminée avec succès !',
  'complete.urls': 'URLs :',
  'complete.configLocation': 'Configuration :',
  'complete.keysLocation': 'Clés :',
  'complete.createdResources': 'Ressources créées :',
  'complete.generatedFiles': 'Fichiers générés :',
  'complete.automaticStep1': '1. Appliquez les schémas et déployez la version complète :',
  'complete.automaticStep2':
    '2. Lorsque vous y êtes invité, créez et saisissez un jeton d’amorçage Cloudflare à usage unique.',
  'complete.automaticStep2Detail':
    'Setup enregistre directement les jetons enfants séparés dans Control et révoque le jeton d’amorçage.',
  'complete.manualStep1':
    '1. Appliquez les schémas et déployez avec la session OAuth Wrangler actuelle :',
  'complete.manualStep2':
    '2. Utilisez Setup pour exécuter les opérations de provisionnement en attente demandées depuis Admin.',
  'complete.manualStep2Detail':
    'Le provisionnement automatique est désactivé ; aucun jeton d’API Cloudflare n’est stocké dans Control.',

  // Resource provisioning
  'resource.provisioning': 'Provisionnement de {{resource}}...',
  'resource.provisioned': '{{resource}} provisionné avec succès',
  'resource.failed': 'Échec du provisionnement de {{resource}}',
  'resource.skipped': '{{resource}} ignoré',

  // Manage environments
  'manage.title': 'Environnements Existants',
  'manage.loading': 'Chargement...',
  'manage.detecting': 'Détection des environnements...',
  'manage.detected': 'Environnements Détectés :',
  'manage.noEnvs': 'Aucun environnement Authrim trouvé.',
  'manage.selectAction': 'Sélectionnez une action',
  'manage.viewDetails': 'Voir les Détails',
  'manage.viewDetailsDesc': 'Afficher les informations détaillées des ressources',
  'manage.deleteEnv': "Supprimer l'Environnement",
  'manage.deleteEnvDesc': "Supprimer l'environnement et les ressources",
  'manage.backToMenu': 'Retour au Menu Principal',
  'manage.backToMenuDesc': 'Retourner au menu principal',
  'manage.selectEnv': "Sélectionnez l'environnement",
  'manage.back': 'Retour',
  'manage.continueManaging': 'Continuer à gérer les environnements ?',

  // Load config
  'loadConfig.title': 'Charger une Configuration Existante',
  'loadConfig.found': '{{count}} configuration(s) trouvée(s) :',
  'loadConfig.new': '(nouveau)',
  'loadConfig.legacy': '(ancien)',
  'loadConfig.legacyDetected': 'Structure Ancienne Détectée',
  'loadConfig.legacyFiles': 'Fichiers anciens :',
  'loadConfig.newBenefits': 'Avantages de la nouvelle structure :',
  'loadConfig.benefit1': "Portabilité de l'environnement (zip .authrim/prod/)",
  'loadConfig.benefit2': 'Suivi de version par environnement',
  'loadConfig.benefit3': 'Structure de projet plus propre',
  'loadConfig.migratePrompt': 'Souhaitez-vous migrer vers la nouvelle structure ?',
  'loadConfig.migrateOption': 'Migrer vers la nouvelle structure (.authrim/{env}/)',
  'loadConfig.continueOption': "Continuer avec l'ancienne structure",
  'loadConfig.migrationComplete': 'Migration terminée avec succès !',
  'loadConfig.validationPassed': 'Validation réussie',
  'loadConfig.validationIssues': 'Problèmes de validation :',
  'loadConfig.newLocation': 'Nouvel emplacement de la configuration :',
  'loadConfig.migrationFailed': 'Échec de la migration :',
  'loadConfig.continuingLegacy': "Continuation avec l'ancienne structure...",
  'loadConfig.loadThis': 'Charger cette configuration',
  'loadConfig.specifyOther': 'Spécifier un fichier différent',
  'loadConfig.noConfigFound': 'Aucune configuration trouvée dans le répertoire actuel.',
  'loadConfig.tip': 'Conseil : Vous pouvez spécifier un fichier de configuration avec :',
  'loadConfig.specifyPath': 'Spécifier le chemin du fichier',
  'loadConfig.enterPath': 'Entrez le chemin du fichier de configuration',
  'loadConfig.pathRequired': 'Veuillez entrer un chemin',
  'loadConfig.fileNotFound': 'Fichier introuvable : {{path}}',
  'loadConfig.selectConfig': 'Sélectionnez la configuration à charger',

  // Common
  'common.yes': 'Oui',
  'common.no': 'Non',
  'common.example': 'Exemple',
  'common.comingSoon': 'bientôt disponible',
  'common.continue': 'Continuer',
  'common.cancel': 'Annuler',
  'common.skip': 'Ignorer',
  'common.back': 'Retour',
  'common.confirm': 'Confirmer',
  'common.error': 'Erreur',
  'common.warning': 'Attention',
  'common.success': 'Succès',
  'common.info': 'Info',
  'common.loading': 'Chargement...',
  'common.saving': 'Enregistrement...',
  'common.processing': 'Traitement...',
  'common.done': 'Terminé',
  'common.required': 'Requis',
  'common.optional': 'Optionnel',

  // Errors
  'error.generic': "Une erreur s'est produite",
  'error.network': 'Erreur réseau',
  'error.timeout': "Délai d'attente dépassé",
  'error.invalidInput': 'Entrée invalide',
  'error.fileNotFound': 'Fichier introuvable',
  'error.permissionDenied': 'Permission refusée',
  'error.configNotFound': 'Configuration introuvable',
  'error.configInvalid': 'Configuration invalide',
  'error.deployFailed': 'Échec du déploiement',
  'error.resourceCreationFailed': 'Échec de la création de la ressource',

  // Validation
  'validation.required': 'Ce champ est requis',
  'validation.invalidFormat': 'Format invalide',
  'validation.tooShort': 'Trop court',
  'validation.tooLong': 'Trop long',
  'validation.invalidDomain': 'Domaine invalide',
  'validation.invalidEmail': 'Adresse email invalide',
  'validation.invalidUrl': 'URL invalide',

  // Delete command
  'delete.title': "Supprimer l'Environnement",
  'delete.prompt': 'Sélectionnez les ressources à supprimer',
  'delete.confirm': 'Êtes-vous sûr de vouloir supprimer "{{env}}" ?',
  'delete.confirmPermanent':
    '⚠️ Cela supprimera définitivement toutes les ressources de "{{env}}". Continuer ?',
  'delete.deleting': 'Suppression de {{resource}}...',
  'delete.deleted': '{{resource}} supprimé',
  'delete.error': 'Échec de la suppression de {{resource}}',
  'delete.cancelled': 'Suppression annulée',
  'delete.noEnvFound': 'Aucun environnement trouvé',
  'delete.selectEnv': "Sélectionnez l'environnement à supprimer",
  'delete.workers': 'Workers',
  'delete.databases': 'Bases de données D1',
  'delete.kvNamespaces': 'Namespaces KV',
  'delete.queues': "Files d'attente",
  'delete.r2Buckets': 'Buckets R2',
  'delete.pages': 'Projets Pages',
  'delete.partialSuccess':
    "Les ressources sélectionnées ont été supprimées et le reste de l'état de l'environnement a été conservé",
  'delete.inventoryUnavailable':
    "La suppression n'a pas démarré, car l'inventaire des ressources Cloudflare n'a pas pu être vérifié",

  // Info command
  'info.title': "Informations sur l'Environnement",
  'info.loading': "Chargement des informations de l'environnement...",
  'info.noResources': 'Aucune ressource trouvée',
  'info.environment': 'Environnement',
  'info.issuer': 'Émetteur',
  'info.workers': 'Workers',
  'info.databases': 'Bases de données',
  'info.kvNamespaces': 'Namespaces KV',
  'info.queues': "Files d'attente",
  'info.r2Buckets': 'Buckets R2',
  'info.status': 'Statut',
  'info.deployed': 'Déployé',
  'info.notDeployed': 'Non déployé',

  // Config command
  'configCmd.title': 'Configuration',
  'configCmd.showing': 'Affichage de la configuration',
  'configCmd.validating': 'Validation de la configuration...',
  'configCmd.valid': 'La configuration est valide',
  'configCmd.invalid': 'La configuration est invalide',
  'configCmd.notFound': 'Configuration introuvable',
  'configCmd.error': 'Erreur lors de la lecture de la configuration',

  // Migrate command
  'migrate.title': 'Migrer vers la Nouvelle Structure',
  'migrate.checking': 'Vérification du statut de migration...',
  'migrate.noLegacyFound': 'Aucune ancienne structure trouvée',
  'migrate.legacyFound': 'Ancienne structure détectée',
  'migrate.prompt': 'Migrer vers la nouvelle structure ?',
  'migrate.migrating': 'Migration en cours...',
  'migrate.success': 'Migration réussie',
  'migrate.cancelled': 'Migration annulée.',
  'migrate.error': 'Échec de la migration',
  'migrate.dryRun': 'Exécution test - aucune modification effectuée',
  'migrate.backup': 'Création de la sauvegarde...',
  'migrate.backupCreated': 'Sauvegarde créée dans {{path}}',

  // Security configuration
  'security.title': 'Paramètres de Sécurité',
  'security.description':
    'Configurer les paramètres de protection des données. Ils ne peuvent pas être modifiés après le stockage initial des données.',
  'security.piiEncryption': 'Chiffrement des PII',
  'security.piiEncryptionEnabled': 'Chiffrement au niveau application (Recommandé)',
  'security.piiEncryptionEnabledDesc':
    'Chiffrer les données PII au niveau application (recommandé pour D1)',
  'security.piiEncryptionDisabled': 'Chiffrement au niveau base de données uniquement',
  'security.piiEncryptionDisabledDesc':
    'Utiliser le chiffrement de la BD managée (pour Aurora, etc.)',
  'security.domainHash': 'Hachage des Domaines Email',
  'security.domainHashEnabled': 'Activer le hachage des domaines (Recommandé)',
  'security.domainHashEnabledDesc':
    'Hacher les domaines email pour la confidentialité dans les analyses',
  'security.domainHashDisabled': 'Stocker les domaines en clair',
  'security.domainHashDisabledDesc': 'Stocker les domaines email sans hachage',
  'security.warning':
    '⚠️ Ces paramètres ne peuvent pas être modifiés après le stockage des données',

  // Manage command
  'manage.commandTitle': "Gestionnaire d'Environnements Authrim",

  // Web UI specific
  'web.title': 'Configuration Authrim',
  'web.subtitle': 'Fournisseur OIDC sur Cloudflare Workers',
  'web.loading': 'Chargement...',
  'web.error': "Une erreur s'est produite",
  'web.retry': 'Réessayer',
  'web.languageSelector': 'Langue',
  'web.darkMode': 'Sombre',
  'web.lightMode': 'Clair',
  'web.systemMode': 'Système',

  // Web UI Prerequisites
  'web.prereq.title': 'Préparer',
  'web.prereq.checking': 'Vérification...',
  'web.prereq.checkingRequirements': 'Vérification des exigences système...',
  'web.prereq.ready': 'Prêt',
  'web.prereq.wranglerInstalled': 'Wrangler installé',
  'web.prereq.loggedInAs': 'Connecté en tant que {{email}}',

  // Web UI Top Menu
  'web.menu.title': 'Commencer',
  'web.menu.subtitle': 'Choisissez une option pour continuer :',
  'web.menu.newSetup': 'Nouvelle Configuration',
  'web.menu.newSetupDesc': 'Créer un nouveau déploiement Authrim à partir de zéro',
  'web.menu.loadConfig': 'Charger Config',
  'web.menu.loadConfigDesc': 'Reprendre ou redéployer en utilisant une configuration existante',
  'web.menu.manageEnv': 'Gérer les Environnements',
  'web.menu.manageEnvDesc': 'Voir, inspecter ou supprimer les environnements existants',

  // Web UI Setup Mode
  'web.mode.title': 'Mode de Configuration',
  'web.mode.subtitle': 'Choisissez comment vous voulez configurer Authrim :',
  'web.mode.quick': 'Configuration Rapide',
  'web.mode.quickDesc': 'Commencez en ~5 minutes',
  'web.mode.quickEnv': "Sélection de l'environnement",
  'web.mode.quickDomain': 'Domaine personnalisé optionnel',
  'web.mode.quickDefault': 'Composants par défaut',
  'web.mode.recommended': 'Recommandé',
  'web.mode.custom': 'Configuration Personnalisée',
  'web.mode.customDesc': 'Contrôle total sur la configuration',
  'web.mode.customComp': 'Sélection des composants',
  'web.mode.customUrl': 'Configuration URL',
  'web.mode.customAdvanced': 'Paramètres avancés',

  // Web UI Load Config
  'web.loadConfig.title': 'Charger la Configuration',
  'web.loadConfig.subtitle': 'Sélectionnez votre fichier authrim-config.json :',
  'web.loadConfig.chooseFile': 'Choisir le Fichier',
  'web.loadConfig.preview': 'Aperçu de la Configuration',
  'web.loadConfig.validationFailed': 'Échec de la Validation de la Configuration',
  'web.loadConfig.valid': 'La configuration est valide',
  'web.loadConfig.loadContinue': 'Charger et Continuer',

  // Web UI Configuration
  'web.config.title': 'Configuration',
  'web.config.components': 'Composants',
  'web.config.apiRequired': 'API (requis)',
  'web.config.apiDesc':
    "Points d'accès du Fournisseur OIDC : authorize, token, userinfo, discovery, APIs de gestion.",
  'web.config.saml': 'SAML IdP',
  'web.config.deviceFlow': 'Device Flow / CIBA',
  'web.config.vcSdJwt': 'VC SD-JWT',
  'web.config.loginUi': 'UI de Connexion',
  'web.config.loginUiDesc': "UI d'authentification pré-construite déployée sur Cloudflare Workers.",
  'web.config.adminUi': "UI d'Admin",
  'web.config.adminUiDesc':
    'Tableau de bord de gestion pour les utilisateurs, clients et paramètres.',

  // Web UI URLs
  'web.url.title': 'Configuration URL',
  'web.url.apiDomain': 'Domaine API',
  'web.url.apiDomainHint': 'Laisser vide pour utiliser le sous-domaine workers.dev',
  'web.url.loginDomain': 'Domaine UI de Connexion',
  'web.url.loginDomainHint': 'Laisser vide pour utiliser le sous-domaine workers.dev',
  'web.url.adminDomain': "Domaine UI d'Admin",
  'web.url.adminDomainHint': 'Laisser vide pour utiliser le sous-domaine workers.dev',

  // Web UI Database
  'web.db.title': 'Configuration de la Base de Données',
  'web.db.coreTitle': 'Base de Données Core',
  'web.db.coreSubtitle': '(Non-PII)',
  'web.db.coreDesc':
    "Stocke les clients, codes d'autorisation, tokens, sessions. Peut être répliquée globalement.",
  'web.db.piiTitle': 'Base de Données PII',
  'web.db.piiSubtitle': '(Informations Personnelles Identifiables)',
  'web.db.piiDesc':
    'Stocke les profils utilisateur, identifiants, PII. Doit être dans une seule juridiction pour la conformité.',
  'web.db.name': 'Nom',
  'web.db.region': 'Région',
  'web.db.regionAuto': 'Automatique (la plus proche)',
  'web.db.controlPlaneTitle': 'D1 Control Plane',
  'web.db.controlPlaneDesc':
    'Initialise le plan de contrôle et les shards initiaux ; la capacité suivante est créée automatiquement.',
  'web.db.controlPlaneWorkerDesc':
    'Cette fonction permet à Authrim de gérer les bases de données de vos tenants. Les ressources nécessaires sont créées pendant le setup.',
  'web.db.controlPlaneTenantPlacement':
    'Le tenant initial commence avec son propre emplacement de stockage. Vous pourrez choisir un emplacement pour chaque tenant ajouté.',
  'web.db.controlPlaneResolverNote':
    'Authrim gère automatiquement la création des bases de données et le routage des connexions.',
  'web.db.automaticProvisioningTitle': 'Création automatique des bases de données des tenants',
  'web.db.automaticProvisioningOn': 'Activé (création automatique)',
  'web.db.automaticProvisioningOnDesc':
    'Lorsque le nombre de tenants ou de données augmente, Authrim crée automatiquement les bases nécessaires.',
  'web.db.automaticProvisioningTokenNote':
    'Un Control Worker dédié stocke et utilise le token API Cloudflare aux permissions limitées nécessaire à la création des bases de données des tenants.',
  'web.db.automaticProvisioningOff': 'Désactivé (création depuis Setup)',
  'web.db.automaticProvisioningOffDesc':
    'Les bases ne sont pas créées automatiquement. Créez-les depuis l’outil Setup lorsque nécessaire.',
  'web.db.automaticProvisioningNote':
    'La séparation des données entre tenants reste active même si cette option est désactivée.',
  'web.deploy.controlCredentialsTitle': 'Connexion Cloudflare',
  'web.deploy.bootstrapTokenTitle': 'Token Cloudflare temporaire pour la configuration automatique',
  'web.deploy.cloudflareLoginNote':
    'La connexion au Dashboard Cloudflare est distincte de Wrangler OAuth et peut demander une nouvelle connexion.',
  'web.deploy.createBootstrapToken': 'Créer un token Cloudflare à usage unique',
  'web.deploy.bootstrapTokenLabel': 'Token Cloudflare temporaire',
  'web.deploy.bootstrapTokenPlaceholder': 'Saisir le token Cloudflare temporaire',
  'web.deploy.bootstrapTokenHelp':
    'Ce token est utilisé une fois puis révoqué après l’enregistrement des tokens nécessaires.',
  'web.deploy.bootstrapTokenDescription':
    'Ce token temporaire permet à Authrim de créer automatiquement les bases de données des tenants. Il doit pouvoir créer et modifier des tokens API : Account API Tokens: Write/Edit pour un token de compte ou API Tokens: Write/Edit pour un token utilisateur. Setup l’utilise pour créer au besoin des tokens API limités pour D1, Workers, KV et R2, les enregistrer auprès du Control Worker, puis révoquer le token temporaire.',
  'web.deploy.manualDnsSectionTitle': 'Paramètres DNS',
  'web.deploy.bootstrapTokenCreateStatus':
    'Créez un token temporaire dans le Dashboard Cloudflare, puis saisissez-le ci-dessous.',
  'web.deploy.bootstrapPopupBlocked':
    'Le navigateur a bloqué le nouvel onglet. Autorisez les fenêtres contextuelles et réessayez.',
  'web.deploy.bootstrapTokenRequired':
    'Créez et saisissez le token Cloudflare temporaire avant le déploiement.',
  'web.envDetail.automaticProvisioningTitle': 'Provisionnement automatique',
  'web.envDetail.automaticProvisioningChecking': 'Vérification...',
  'web.envDetail.automaticProvisioningUnavailable': 'Indisponible',
  'web.envDetail.createOneTimeCloudflareToken': 'Créer un token Cloudflare à usage unique',
  'web.envDetail.oneTimeBootstrapTokenPlaceholder': 'Token bootstrap à usage unique',
  'web.envDetail.enableAutomaticProvisioning': 'Activer',
  'web.envDetail.enterOneTimeTokenThenEnable':
    'Saisissez le token à usage unique, puis sélectionnez Activer.',
  'web.envDetail.bootstrapPopupBlocked': 'Le navigateur a bloqué l’onglet du Dashboard Cloudflare.',
  'web.envDetail.enterOneTimeTokenFirst': 'Saisissez d’abord le token Cloudflare à usage unique.',
  'web.envDetail.preparingControlAuthority':
    'Préparation de l’autorité de provisionnement de Control...',
  'web.envDetail.deployingControlWorker': 'Déploiement de la configuration du Control Worker...',
  'web.envDetail.registeringScopedCredentials': 'Enregistrement des identifiants limités...',
  'web.envDetail.automaticProvisioningOn': 'Activé',
  'web.envDetail.automaticProvisioningOff': 'Désactivé',
  'web.envDetail.automaticProvisioningCredentialsRegistered':
    'Les identifiants limités du Control Worker sont enregistrés.',
  'web.envDetail.automaticProvisioningBlocked': 'Le provisionnement automatique est bloqué.',
  'web.envDetail.automaticProvisioningMissing': '(manquant : {{missing}})',
  'web.envDetail.automaticProvisioningRepairHint':
    'Saisissez un nouveau token à usage unique pour réparer.',
  'web.envDetail.bootstrapRetainedForRetry':
    'Cloudflare a renvoyé une erreur temporaire. Le token bootstrap reste actif ; saisissez à nouveau le même token et sélectionnez Activer pour reprendre.',
  'web.envDetail.revokeTokensBeforeRetry':
    'Révoquez les tokens bootstrap et enfants Authrim indiqués dans le Dashboard Cloudflare avant de réessayer.',
  'web.envDetail.bootstrapRevokedPendingReset':
    'Le token bootstrap a été révoqué, mais l’état en attente n’a pas pu être réinitialisé.',
  'web.envDetail.bootstrapRevokedDisabled':
    'Le token bootstrap a été révoqué et le provisionnement automatique a été désactivé.',

  // Web UI Email
  'web.email.title': "Fournisseur d'Email",
  'web.email.subtitle':
    'Sélectionnez le service email pour la réinitialisation du mot de passe et les emails de vérification :',
  'web.email.none': 'Aucun',
  'web.email.noneDesc': 'Fonctionnalités email désactivées',
  'web.email.resend': 'Resend',
  'web.email.resendDesc': 'API email pour les développeurs',
  'web.email.sendgrid': 'SendGrid',
  'web.email.sendgridDesc': "Livraison d'email évolutive",
  'web.email.ses': 'Amazon SES',
  'web.email.sesDesc': 'AWS Simple Email Service',
  'web.email.resendConfig': 'Configuration Resend',
  'web.email.apiKey': 'Clé API',
  'web.email.apiKeyPlaceholder': 're_xxxxxxxx',
  'web.email.fromAddress': "Adresse de l'Expéditeur",
  'web.email.fromAddressPlaceholder': 'noreply@votredomaine.com',

  // Web UI Provision
  'web.provision.title': 'Créer les Ressources Cloudflare',
  'web.provision.ready': 'Prêt à provisionner',
  'web.provision.desc': 'Les ressources suivantes seront créées dans votre compte Cloudflare :',
  'web.provision.createResources': 'Créer les Ressources',
  'web.provision.saveConfig': 'Enregistrer Config',
  'web.provision.continueDeploy': 'Continuer vers le Déploiement →',

  // Web UI Deploy
  'web.deploy.title': 'Déployer',
  'web.deploy.desc': "Déployer les workers et l'UI sur Cloudflare :",
  'web.deploy.startDeploy': 'Démarrer le Déploiement',
  'web.deploy.deploying': 'Déploiement en cours...',

  // Web UI Complete
  'web.complete.title': 'Configuration Terminée !',
  'web.complete.desc': 'Votre déploiement Authrim est prêt.',
  'web.complete.issuerUrl': "URL de l'Émetteur",
  'web.complete.loginUrl': 'URL de Connexion',
  'web.complete.adminUrl': "URL d'Admin",
  'web.complete.saveConfig': 'Enregistrer la Configuration',
  'web.complete.backToMain': "Retour à l'Accueil",
  'web.config.saveToFileTitle': 'Enregistrer la configuration dans un fichier',
  'web.complete.backToMainTitle': 'Revenir à l’écran principal',
  'web.complete.canClose':
    'La configuration est terminée. Vous pouvez fermer cette fenêtre en toute sécurité.',
  'web.complete.adminAccountTitle': 'Configuration du compte administrateur',
  'web.complete.adminAccountImportant': 'IMPORTANT',
  'web.complete.adminAccountDesc':
    "Enregistrez votre premier compte administrateur avec l'authentification Passkey\u00a0:",
  'web.complete.copy': '📋 Copier',
  'web.complete.copied': '✓ Copié',
  'web.complete.openSetup': '🔑 Ouvrir la configuration',
  'web.complete.urlWarning':
    "Cette URL ne peut être utilisée qu'<strong>une seule fois</strong> et expire le <strong>{{date}}</strong>.",
  'web.complete.adminSetupUnavailable':
    "URL de configuration non disponible. Vous pouvez configurer l'accès administrateur depuis l'interface d'administration plus tard.",
  'web.complete.customDomainNote':
    "ℹ️ Domaine personnalisé : la propagation DNS peut prendre de quelques minutes à plusieurs heures. Si l'URL ci-dessus n'est pas encore accessible, veuillez patienter.",

  // Web UI Environment Management
  'web.env.title': 'Environnements',
  'web.env.loading': 'Chargement des environnements...',
  'web.env.noEnvFound': 'Aucun environnement trouvé',
  'web.env.refresh': 'Actualiser',
  'web.env.adminSetup': 'Configuration Initiale Admin',
  'web.env.adminSetupDesc': 'Cliquez pour créer un compte admin pour',
  'web.env.openSetup': 'Ouvrir la Configuration',
  'web.env.copyUrl': 'Copier',
  'web.env.deleteTitle': "Supprimer l'Environnement",
  'web.env.deleteWarning': 'Les ressources sélectionnées suivantes seront supprimées :',
  'web.env.confirmDelete': 'Supprimer la Sélection',
  'web.env.cancel': 'Annuler',

  // Web UI Common buttons
  'web.btn.back': 'Retour',
  'web.btn.continue': 'Continuer',
  'web.btn.cancel': 'Annuler',
  'web.btn.save': 'Enregistrer',
  'web.btn.skip': 'Ignorer',

  // Web UI Save Modal
  'web.modal.saveTitle': 'Enregistrer la Configuration ?',
  'web.modal.saveDesc':
    'Enregistrez la configuration sur votre ordinateur local pour une utilisation future.',
  'web.modal.skipSave': 'Ignorer',
  'web.modal.saveConfig': 'Enregistrer la Configuration',

  // Web UI steps
  'web.step.environment': 'Environnement',
  'web.step.region': 'Région',
  'web.step.domain': 'Domaine',
  'web.step.email': 'Email',
  'web.step.sms': 'SMS',
  'web.step.social': 'Social',
  'web.step.advanced': 'Avancé',
  'web.step.review': 'Réviser',
  'web.step.deploy': 'Déployer',

  // Web UI forms
  'web.form.submit': 'Soumettre',
  'web.form.next': 'Suivant',
  'web.form.previous': 'Précédent',
  'web.form.reset': 'Réinitialiser',
  'web.form.validation': 'Veuillez corriger les erreurs ci-dessus',

  // Web UI progress
  'web.progress.preparing': 'Préparation du déploiement...',
  'web.progress.creatingResources': 'Création des ressources Cloudflare...',
  'web.progress.generatingKeys': 'Génération des clés cryptographiques...',
  'web.progress.configuringWorkers': 'Configuration des workers...',
  'web.progress.deployingWorkers': 'Déploiement des workers...',
  'web.progress.deployingUI': "Déploiement de l'UI...",
  'web.progress.runningMigrations': 'Exécution des migrations de base de données...',
  'web.progress.complete': 'Déploiement terminé !',
  'web.progress.failed': 'Échec du déploiement',

  // Web UI Form Labels
  'web.form.envName': "Nom de l'Environnement",
  'web.form.envNamePlaceholder': 'ex : prod, main, tokyo, acme-dev',
  'web.form.envNameHint': 'Lettres minuscules, chiffres et tirets uniquement',
  'web.form.envNameError':
    'Seuls les lettres minuscules, chiffres et tirets sont autorisés (doit commencer par une lettre)',
  'web.form.baseDomain': 'Domaine de Base (Domaine API)',
  'web.form.baseDomainPlaceholder': 'oidc.exemple.com',
  'web.form.baseDomainHint':
    'Domaine personnalisé pour Authrim. Laisser vide pour utiliser workers.dev',
  'web.form.nakedDomain': "Exclure le nom du tenant de l'URL",
  'web.form.nakedDomainHint':
    'Utiliser https://exemple.com au lieu de https://{tenant}.exemple.com',
  'web.form.nakedDomainWarning':
    'Les sous-domaines tenant nécessitent un domaine personnalisé. Workers.dev ne prend pas en charge les sous-domaines génériques.',
  'web.form.tenantId': 'ID du Tenant Par Défaut',
  'web.form.tenantIdPlaceholder': 'default',
  'web.form.tenantIdHint': 'Identifiant du premier tenant (minuscules, sans espaces)',
  'web.form.tenantIdWorkerNote':
    "(L'ID du Tenant est utilisé en interne. Le sous-domaine URL nécessite un domaine personnalisé.)",
  'web.form.tenantDisplay': "Nom d'Affichage du Tenant",
  'web.form.tenantDisplayPlaceholder': 'Mon Entreprise',
  'web.form.tenantDisplayHint': "Nom affiché sur la page de connexion et l'écran de consentement",
  'web.form.userIdFormat': "Format d'ID Utilisateur",
  'web.form.userIdNanoid': 'NanoID (recommandé)',
  'web.form.userIdUuid': 'UUID v4',
  'web.form.userIdExample': 'Exemple :',
  'web.form.userIdFormatHint': 'Ne peut pas être modifié après la création des utilisateurs.',
  'web.form.loginDomainPlaceholder': 'login.exemple.com',
  'web.form.adminDomainPlaceholder': 'admin.exemple.com',

  // Web UI Section Headers
  'web.section.apiDomain': 'Domaine API / Émetteur',
  'web.section.uiDomains': 'Domaines UI (Optionnel)',
  'web.section.uiDomainsHint':
    'Domaines personnalisés pour les UIs de Connexion/Admin. Chacun peut être configuré indépendamment. Laisser vide pour utiliser les valeurs par défaut de Cloudflare Workers.',
  'web.section.corsHint':
    "CORS : Les requêtes cross-origin depuis l'UI de Connexion/Admin vers l'API sont automatiquement autorisées.",
  'web.section.configPreview': 'Aperçu de la Configuration',
  'web.section.resourceNames': 'Noms des Ressources',

  // Web UI Preview Labels
  'web.preview.components': 'Composants :',
  'web.preview.workers': 'Workers :',
  'web.preview.issuerUrl': "URL de l'Émetteur :",
  'web.preview.loginUi': 'UI de Connexion :',
  'web.preview.adminUi': "UI d'Admin :",
  'web.preview.pagesUrl': "Origine de l'UI de Connexion :",
  'web.preview.tenantDiscover': 'Sélection du Tenant (Entrée Commune) :',
  'web.preview.adminAccess': "Accès à l'UI Admin :",
  'web.preview.firstTenant': '{{name}} (Tenant Principal)',
  'web.preview.otherTenants': 'Autres Tenants',
  'web.preview.allTenantsShared': '(partagé par tous les tenants)',
  'web.preview.loginUiOriginNote':
    "(origine de déploiement ; le login tenant utilise /login de l'issuer)",
  'web.preview.viaApiProxy': '(proxié via le même domaine API)',
  'web.preview.conflictWarningTitle': '⚠️ Problème de configuration',
  'web.preview.conflictWarningMsg':
    'Le domaine personnalisé de {{conflictUI}} est le même que celui de l\'API ({{baseDomain}}). Puisque "Supprimer le tenant de l\'URL" est désactivé, les requêtes API vers {{baseDomain}} (/authorize, /api/auth/*, etc.) retourneront 404 et le flux de connexion sera interrompu.',
  'web.preview.conflictActionMsg':
    'Solution : Activez "Supprimer le tenant de l\'URL" et définissez le premier tenant ({{tenantName}}) comme principal. Ou changez le domaine de {{conflictUI}} pour un domaine différent de l\'API (ex. login.{{baseDomain}}).',

  // Web UI Component Labels
  'web.comp.loginUi': 'UI de Connexion',
  'web.comp.loginUiDesc':
    'Pages de connexion, inscription, consentement et gestion de compte destinées aux utilisateurs.',
  'web.comp.adminUi': "UI d'Admin",
  'web.comp.adminUiDesc':
    'Tableau de bord admin pour gérer les tenants, clients, utilisateurs et paramètres système.',

  // Web UI Domain Row Labels
  'web.domain.loginUi': 'UI de Connexion',
  'web.domain.adminUi': "UI d'Admin",

  // Web UI Database Section
  'web.db.introDesc':
    'Authrim utilise deux bases de données D1 séparées pour isoler les données personnelles des données applicatives.',
  'web.db.regionNote':
    'Note : La région de la base de données ne peut pas être modifiée après la création.',
  'web.db.coreNonPii': 'Non-PII',
  'web.db.coreDataDesc': 'Stocke les données applicatives non personnelles incluant :',
  'web.db.coreData1': 'Clients OAuth et leurs configurations',
  'web.db.coreData2': "Codes d'autorisation et access tokens",
  'web.db.coreData3': 'Sessions utilisateur et état de connexion',
  'web.db.coreData4': 'Paramètres et configurations des tenants',
  'web.db.coreData5': "Logs d'audit et événements de sécurité",
  'web.db.coreHint':
    "Cette base de données gère tous les flux d'authentification et doit être placée près de votre base d'utilisateurs principale.",
  'web.db.piiLabel': 'Informations Personnelles Identifiables',
  'web.db.piiDataDesc': 'Stocke les données personnelles des utilisateurs incluant :',
  'web.db.piiData1': 'Profils utilisateur (nom, email, téléphone)',
  'web.db.piiData2': 'Identifiants Passkey/WebAuthn',
  'web.db.piiData3': 'Préférences et paramètres utilisateur',
  'web.db.piiData4': 'Attributs personnalisés utilisateur',
  'web.db.piiHint':
    'Cette base de données contient des données personnelles. Envisagez de la placer dans une région conforme à vos exigences de protection des données.',
  'web.db.locationHints': 'Conseils de Localisation',
  'web.db.jurisdiction': 'Juridiction (Conformité)',
  'web.db.autoNearest': 'Automatique (la plus proche de vous)',
  'web.db.northAmericaWest': 'Amérique du Nord (Ouest)',
  'web.db.northAmericaEast': 'Amérique du Nord (Est)',
  'web.db.europeWest': 'Europe (Ouest)',
  'web.db.europeEast': 'Europe (Est)',
  'web.db.asiaPacific': 'Asie Pacifique',
  'web.db.oceania': 'Océanie',
  'web.db.euJurisdiction': 'Juridiction UE (conformité RGPD)',

  // Web UI Email Section
  'web.email.introDesc':
    "Utilisé pour envoyer des OTP par email et la vérification d'adresse email. Vous pouvez configurer cela plus tard si vous préférez.",
  'web.email.configureLater': 'Configurer plus tard',
  'web.email.configureLaterHint': "Ignorer pour l'instant et configurer plus tard.",
  'web.email.configureCloudflare': 'Configurer Cloudflare Email Service',
  'web.email.configureCloudflareHint':
    'Utilise le binding natif Workers Email Service. Nécessite un plan Workers Paid et Cloudflare DNS.',
  'web.email.configureResend': 'Configurer Resend',
  'web.email.configureResendHint':
    "Configurer l'envoi d'email avec Resend (recommandé pour la production).",
  'web.email.cloudflareSetup': 'Cloudflare Email Service',
  'web.email.cloudflareRequirements': 'Prérequis',
  'web.email.cloudflareRequirementPaid': 'Un plan Workers Paid est requis',
  'web.email.cloudflareRequirementDns': "Cloudflare DNS / l'intégration du domaine est requis",
  'web.email.cloudflareRequirementManual':
    'La configuration du domaine dans le tableau de bord Cloudflare reste manuelle',
  'web.email.resendSetup': 'Configuration Resend',
  'web.email.beforeBegin': 'Avant de commencer :',
  'web.email.step1': 'Créez un compte Resend sur',
  'web.email.step2': 'Ajoutez et vérifiez votre domaine sur',
  'web.email.step3': 'Créez une clé API sur',
  'web.email.resendApiKey': 'Clé API Resend',
  'web.email.resendApiKeyHint': 'Votre clé API commence par "re_"',
  'web.email.resendApiKeyMissing': 'Veuillez saisir votre clé API Resend',
  'web.email.resendApiKeyConfirmInvalid':
    'La clé API ne commence pas par "re_". Il se peut que ce ne soit pas une clé API Resend valide. Continuer quand même ?',
  'web.email.fromEmailAddress': "Adresse Email de l'Expéditeur",
  'web.email.cloudflareFromHint': "Doit provenir d'un domaine intégré à Cloudflare Email Service",
  'web.email.fromEmailHint': "Doit être d'un domaine vérifié dans votre compte Resend",
  'web.email.fromEmailMissing': "Veuillez saisir une adresse email d'expéditeur",
  'web.email.fromEmailInvalid': 'Veuillez saisir une adresse email valide',
  'web.email.fromDisplayName': "Nom d'Affichage de l'Expéditeur (optionnel)",
  'web.email.fromDisplayHint': "Affiché comme le nom de l'expéditeur dans les clients email",
  'web.email.saveConfigFailed': "Échec de l'enregistrement de la configuration email",
  'web.email.domainVerificationTitle': 'Vérification du Domaine Requise',
  'web.email.domainVerificationDesc':
    'Avant que votre domaine soit vérifié, les emails ne peuvent être envoyés que depuis onboarding@resend.dev (pour les tests).',
  'web.email.learnMore': 'En savoir plus sur la vérification de domaine →',

  // Web UI Provision Section
  'web.provision.resourcePreview': 'Noms des Ressources :',
  'web.provision.d1Databases': 'Bases de données D1 :',
  'web.provision.kvNamespaces': 'Namespaces KV :',
  'web.provision.cryptoKeys': 'Clés Cryptographiques :',
  'web.provision.initializing': 'Initialisation...',
  'web.provision.showLog': 'Afficher le log détaillé',
  'web.provision.hideLog': 'Masquer le log détaillé',
  'web.provision.keysSavedTo': 'Clés enregistrées dans :',
  'web.provision.keepSafe': 'Gardez ce répertoire en sécurité et ajoutez-le au .gitignore',

  // Web UI Deploy Section
  'web.deploy.readyText': 'Prêt à déployer les workers Authrim sur Cloudflare.',

  // Web UI Environment List
  'web.env.detectedDesc': 'Environnements Authrim détectés dans votre compte Cloudflare :',
  'web.env.noEnvsDetected': 'Aucun environnement Authrim détecté dans ce compte Cloudflare.',
  'web.env.backToList': '← Retour à la Liste',
  'web.env.deleteEnv': "Supprimer l'Environnement...",

  // Web UI Environment Detail
  'web.envDetail.title': "Détails de l'Environnement",
  'web.envDetail.initialDeployRecoveryTitle': 'Le déploiement initial est incomplet',
  'web.envDetail.initialDeployRecoveryDesc':
    'Le déploiement précédent s’est arrêté avant la vérification. Les ressources créées seront réutilisées lors de la reprise.',
  'web.envDetail.initialDeployRecoveryAction': 'Reprendre le déploiement initial',
  'web.envDetail.initialDeployRecoveryVerified':
    'État Cloudflare vérifié. Terminé : {{completed}}. La reprise commencera à {{stage}}.',
  'web.envDetail.initialDeployRecoveryStageMigrations':
    'la vérification des migrations de base de données',
  'web.envDetail.initialDeployRecoveryStageControlPlane': 'la préparation du déploiement initial',
  'web.envDetail.initialDeployRecoveryStageWorkers': 'le déploiement des Workers',
  'web.envDetail.initialDeployRecoveryStageVerification': 'la vérification après déploiement',
  'web.envDetail.initialDeployRecoveryResources': 'le provisionnement des ressources',
  'web.envDetail.initialDeployRecoverySchema': 'les migrations de base de données',
  'web.envDetail.initialDeployRecoveryWorkers': 'le déploiement des Workers',
  'web.envDetail.initialDeployRecoveryRecreate':
    'Le point de contrôle enregistré ne correspond pas à l’état dans Cloudflare. La reprise est désactivée. Supprimez cet environnement incomplet et recréez-le.',
  'web.envDetail.initialDeployRecoveryManifestChanged':
    'La définition draft des migrations a changé après le début du déploiement initial. L’état enregistré peut ne plus correspondre aux bases de données ; la reprise est donc désactivée. Supprimez cet environnement incomplet et recréez-le.',
  'web.envDetail.initialDeployRecoveryBlocked':
    'L’état actuel n’a pas pu être vérifié ; la reprise est donc désactivée. Vérifiez la connexion Cloudflare et contrôlez à nouveau cet environnement. Si la vérification échoue toujours, supprimez l’environnement incomplet et recréez-le.',
  'web.envDetail.initialDeployRecoveryTokenRequired':
    ' Les identifiants de déploiement doivent être actualisés ; un nouveau token Cloudflare à usage unique sera demandé.',
  'web.envDetail.adminNotConfigured': 'Compte Admin Non Configuré',
  'web.envDetail.adminNotConfiguredDesc':
    "L'administrateur initial n'a pas été configuré pour cet environnement.",
  'web.envDetail.startPasskey': 'Démarrer la Configuration du Compte Admin avec Passkey',
  'web.envDetail.setupUrlGenerated': 'URL de Configuration Générée :',
  'web.envDetail.copyBtn': 'Copier',
  'web.envDetail.openSetup': 'Ouvrir la Configuration',
  'web.envDetail.urlValidFor':
    'Cette URL est valide pendant 1 heure. Ouvrez-la dans un navigateur pour enregistrer le premier compte admin.',
  'web.envDetail.workers': 'Workers',
  'web.envDetail.d1Databases': 'Bases de données D1',
  'web.envDetail.kvNamespaces': 'Namespaces KV',
  'web.envDetail.queues': "Files d'attente",
  'web.envDetail.r2Buckets': 'Buckets R2',
  'web.envDetail.pagesProjects': 'Legacy Pages Projects',
  'web.envDetail.emailSettings': 'Paramètres email',
  'web.envDetail.emailDesc': 'Activez Cloudflare Email Service plus tard pour cet environnement.',
  'web.envDetail.emailCurrentProvider': 'Fournisseur actuel',
  'web.envDetail.emailCurrentStatus': 'État',
  'web.envDetail.emailCurrentFrom': 'Adresse From',
  'web.envDetail.emailConfigured': 'Configuré',
  'web.envDetail.emailNotConfigured': 'Non configuré',
  'web.envDetail.emailProviderNone': 'Non configuré',
  'web.envDetail.emailCloudflareRequirements': 'Prérequis',
  'web.envDetail.emailCloudflareRequirementPaid': 'Workers Paid Plan est requis',
  'web.envDetail.emailCloudflareRequirementDns':
    'Le DNS Cloudflare et l’onboarding du domaine sont requis',
  'web.envDetail.emailCloudflareRequirementManual':
    'La configuration du domaine dans Cloudflare Dashboard reste manuelle',
  'web.envDetail.emailCloudflareFromHint':
    'Si vous utilisez Cloudflare Email Service, l’adresse doit appartenir à un domaine onboardé dans Cloudflare.',
  'web.envDetail.emailCloudflareSettingsLink': 'Paramètres Cloudflare Email Routing',
  'web.envDetail.emailResendFromHint':
    'Si vous utilisez Resend, le domaine doit être ajouté et vérifié dans Resend.',
  'web.envDetail.emailResendDomainsLink': 'Domaines Resend',
  'web.envDetail.emailFromAddress': 'Adresse email From',
  'web.envDetail.emailFromName': 'Nom affiché de l’expéditeur (optionnel)',
  'web.envDetail.emailEnableCloudflare': 'Activer Cloudflare Email Service',
  'web.envDetail.emailDeploying': 'Application...',
  'web.envDetail.emailProgress': 'Progression de la configuration email :',
  'web.envDetail.emailUpdatedSuccess': 'Cloudflare Email activé.',
  'web.envDetail.emailUpdateFailed': 'Échec de l’activation de Cloudflare Email.',
  'web.envDetail.emailFromMissing': 'Saisissez une adresse email From.',
  'web.envDetail.emailFromInvalid': 'Saisissez une adresse email valide.',
  'web.envDetail.emailSwitchProviderConfirm':
    'Cet environnement a déjà un autre fournisseur email configuré. Passer à Cloudflare Email Service ?',
  'web.envDetail.emailStarting': 'Démarrage de la configuration Cloudflare Email...',
  'web.envDetail.emailSwitchProviderToResendConfirm':
    'Cet environnement a déjà un autre fournisseur email configuré. Passer à Resend ?',
  'web.envDetail.emailResendStarting': 'Enregistrement de la configuration email Resend...',
  'web.envDetail.emailResendUpdatedSuccess': 'Configuration email Resend enregistrée.',

  // Web UI Worker Update Section
  'web.envDetail.workerUpdate': 'Mettre à jour tous les Workers',
  'web.envDetail.workerName': 'Worker',
  'web.envDetail.deployedVersion': 'Déployé',
  'web.envDetail.localVersion': 'Local',
  'web.envDetail.updateStatus': 'Statut',
  'web.envDetail.needsUpdate': 'Mise à jour',
  'web.envDetail.upToDate': 'À jour',
  'web.envDetail.notDeployed': 'Non déployé',
  'web.envDetail.updateOnlyChanged': 'Mettre à jour uniquement les versions modifiées',
  'web.envDetail.updateIncludeUiWorkers': 'Mettre à jour Admin UI / Login UI',
  'web.envDetail.updateAllWorkers': 'Mettre à jour tous les Workers',
  'web.envDetail.refreshVersions': 'Actualiser',
  'web.envDetail.updateProgress': 'Progression de la mise à jour :',
  'web.envDetail.updatesAvailable': '{{count}} mise(s) à jour disponible(s)',
  'web.envDetail.allUpToDate': 'Tout est à jour',

  'web.envDetail.action': 'Action',

  // Web UI Update Section
  'web.envDetail.uiUpdate': 'Mettre à jour UI (Worker)',
  'web.envDetail.uiUpdateDesc':
    'Mettre à jour Admin UI ou Login UI individuellement. Ils sont déployés sur Cloudflare Workers.',
  'web.envDetail.updateNow': 'Mettre à jour',

  // Web UI Delete Section
  'web.delete.title': "Supprimer l'Environnement",
  'web.delete.warning': 'Les ressources sélectionnées seront supprimées de cet environnement.',
  'web.delete.environment': 'Environnement :',
  'web.delete.selectResources': 'Sélectionnez les ressources à supprimer :',
  'web.delete.workers': 'Workers',
  'web.delete.d1Databases': 'Bases de données D1',
  'web.delete.kvNamespaces': 'Namespaces KV',
  'web.delete.queues': "Files d'attente",
  'web.delete.r2Buckets': 'Buckets R2',
  'web.delete.pagesProjects': 'Legacy Pages Projects',
  'web.delete.cancelBtn': 'Annuler',
  'web.delete.confirmBtn': 'Supprimer la Sélection',

  // Web UI Save Modal
  'web.modal.saveQuestion':
    'Souhaitez-vous enregistrer votre configuration dans un fichier avant de continuer ?',
  'web.modal.saveReason':
    "Cela vous permet de reprendre la configuration plus tard ou d'utiliser les mêmes paramètres pour un autre déploiement.",
  'web.modal.skipBtn': 'Ignorer',
  'web.modal.saveBtn': 'Enregistrer la Configuration',

  // Web UI Error Messages
  'web.error.wranglerNotInstalled': 'Wrangler non installé',
  'web.error.pleaseInstall': "Veuillez d'abord installer wrangler :",
  'web.error.notLoggedIn': 'Non connecté à Cloudflare',
  'web.error.runCommand': 'Veuillez exécuter cette commande dans votre terminal :',
  'web.error.thenRefresh': 'Puis actualisez cette page.',
  'web.error.checkingPrereq': 'Erreur lors de la vérification de la préparation :',
  'web.error.invalidJson': 'JSON invalide :',
  'web.error.validationFailed': 'Échec de la requête de validation :',

  // Web UI Status Messages
  'web.status.checking': 'Vérification...',
  'web.status.running': 'Exécution...',
  'web.status.deploying': 'Déploiement...',
  'web.status.complete': 'Terminé',
  'web.status.error': 'Erreur',
  'web.status.scanning': 'Analyse...',
  'web.status.saving': 'Enregistrement...',
  'web.status.notDeployed': '(Non déployé)',
  'web.status.startingDeploy': 'Démarrage du déploiement...',
  'web.status.none': 'Aucun',
  'web.status.loading': 'Chargement...',
  'web.status.failedToLoad': 'Échec du chargement',
  'web.status.adminNotConfigured': 'Admin Non Configuré',
  'web.status.initializing': 'Initialisation...',
  'web.status.found': '{{count}} trouvé(s)',
  'web.status.operationInProgress':
    'Une autre opération de configuration est déjà en cours. Attendez qu’elle se termine, puis réessayez.',
  'web.status.warning': 'Avertissement :',

  // Web UI Button Labels (dynamic)
  'web.btn.reprovision': 'Re-provisionner (Supprimer et Créer)',
  'web.btn.createResources': 'Créer les Ressources',
  'web.btn.saveConfiguration': 'Enregistrer la Configuration',

  // Quick setup specific
  'quickSetup.title': 'Configuration Rapide',

  // Custom setup specific
  'customSetup.title': 'Configuration Personnalisée',
  'customSetup.cancelled': 'Configuration annulée.',

  // Web UI starting
  'webUi.starting': "Démarrage de l'Interface Web...",
};

export default fr;

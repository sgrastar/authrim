/**
 * Russian Translations for Authrim Setup Tool
 * Русский перевод (формальное обращение на «Вы»)
 */

import type { Translations } from '../types.js';

const ru: Translations = {
  // Language selection
  'language.select': 'Select language / Выберите язык / 言語を選択',
  'language.selected': 'Язык: {{language}}',

  // Banner
  'banner.title': 'Настройка Authrim',
  'banner.subtitle': 'OIDC-провайдер на Cloudflare Workers',
  'banner.exitHint': 'Нажмите Ctrl+C в любой момент для выхода',

  // Mode selection
  'mode.prompt': 'Выберите способ настройки',
  'mode.quick': 'Веб-интерфейс (рекомендуется)',
  'mode.quickDesc': 'Интерактивная настройка в браузере',
  'mode.advanced': 'Режим CLI',
  'mode.advancedDesc': 'Интерактивная настройка в терминале',

  // Startup menu
  'startup.description': 'Настройка OIDC-провайдера Authrim на Cloudflare Workers.',
  'startup.cancel': 'Отмена',
  'startup.cancelDesc': 'Выйти из настройки',
  'startup.cancelled': 'Настройка отменена.',
  'startup.resumeLater': 'Для продолжения позже:',

  // Main menu
  'menu.prompt': 'Что вы хотите сделать?',
  'menu.quick': 'Быстрая настройка',
  'menu.quickDesc': 'Развернуть Authrim с минимальной конфигурацией',
  'menu.custom': 'Расширенная настройка',
  'menu.customDesc': 'Настроить все параметры пошагово',

  // Setup titles
  'quick.title': '⚡ Быстрая настройка',
  'custom.title': '🔧 Расширенная настройка',
  'menu.manage': 'Просмотр существующих окружений',
  'menu.manageDesc': 'Просмотр, проверка или удаление существующих окружений',
  'menu.load': 'Загрузить существующую конфигурацию',
  'menu.loadDesc': 'Продолжить настройку из authrim-config.json',
  'menu.exit': 'Выход',
  'menu.exitDesc': 'Выйти из настройки',
  'menu.goodbye': 'До свидания!',

  // Update check
  'update.checking': 'Проверка обновлений...',
  'update.available': 'Доступно обновление: {{localVersion}} → {{remoteVersion}}',
  'update.prompt': 'Что вы хотите сделать?',
  'update.continue': 'Продолжить с текущей версией ({{version}})',
  'update.continueDesc': 'Использовать существующий исходный код',
  'update.update': 'Обновить до последней версии ({{version}})',
  'update.updateDesc': 'Загрузить и заменить на новую версию',
  'update.cancel': 'Отмена',
  'update.cancelled': 'Отменено.',
  'update.current': 'Используется исходный код Authrim (v{{version}})',

  // Source download
  'source.downloading': 'Загрузка исходного кода...',
  'source.downloaded': 'Исходный код загружен ({{version}})',
  'source.extracting': 'Распаковка исходного кода...',
  'source.installing': 'Установка зависимостей (это может занять несколько минут)...',
  'source.installed': 'Зависимости установлены',
  'source.installFailed': 'Не удалось установить зависимости',
  'source.installManually': 'Вы можете попробовать установить вручную:',
  'source.notInSourceDir': 'Исходный код Authrim не найден',
  'source.downloadPrompt': 'Загрузить исходный код в {{path}}?',
  'source.downloadOption': 'Загрузить исходный код',
  'source.downloadOptionDesc': 'Загрузить последнюю версию',
  'source.exitOption': 'Выход',
  'source.exitOptionDesc': 'Выйти из настройки',
  'source.cloneManually': 'Для ручного клонирования:',
  'source.directoryExists':
    'Каталог {{path}} существует, но не является допустимым исходным кодом Authrim',
  'source.replaceOption': 'Заменить свежей загрузкой',
  'source.replaceOptionDesc': 'Удалить {{path}} и загрузить последнюю версию',
  'source.differentOption': 'Использовать другой каталог',
  'source.differentOptionDesc': 'Указать другое расположение',
  'source.enterPath': 'Введите путь к каталогу:',
  'source.updateFailed': 'Обновление не удалось',
  'source.downloadFailed': 'Загрузка не удалась',
  'source.verificationWarnings': 'Предупреждения проверки структуры исходного кода:',

  // WSL Environment
  'wsl.detected': 'Обнаружена среда WSL',
  'wsl.cliOnly': 'Web UI недоступен в WSL. Используется режим CLI.',
  'wsl.explanation': 'Для доступа к Web UI из браузера Windows сервер должен',
  'wsl.explanationCont': 'привязаться к 0.0.0.0 вместо localhost.',
  'wsl.securityNote': 'Примечание по безопасности:',
  'wsl.securityWarning': 'Это сделает сервер доступным с других устройств в вашей сети.',
  'wsl.trustedNetworkOnly': 'Используйте только в доверенных сетях.',
  'wsl.bindPrompt': 'Привязать к 0.0.0.0 для доступа из Windows? (y/N):',
  'wsl.bindingToAll': 'Привязка к 0.0.0.0',
  'wsl.usingLocalhost': 'Использование localhost (только внутри WSL)',

  // Prerequisites
  'prereq.checking': 'Проверка состояния wrangler...',
  'prereq.wranglerNotInstalled': 'wrangler не установлен',
  'prereq.wranglerInstallHint': 'Выполните следующую команду для установки:',
  'prereq.notLoggedIn': 'Не выполнен вход в Cloudflare',
  'prereq.loginHint': 'Выполните следующую команду для аутентификации:',
  'prereq.loggedInAs': 'Подключено к Cloudflare ({{email}})',
  'prereq.authenticated': 'Подключено к Cloudflare',
  'prereq.checkFailed': 'Не удалось проверить wrangler',
  'prereq.accountId': 'ID аккаунта: {{accountId}}',

  // Environment
  'env.prompt': 'Введите название окружения',
  'env.prod': 'Продакшн',
  'env.prodDesc': 'Для рабочего использования',
  'env.staging': 'Стейджинг',
  'env.stagingDesc': 'Для тестирования перед продакшном',
  'env.dev': 'Разработка',
  'env.devDesc': 'Для локальной разработки',
  'env.custom': 'Другое',
  'env.customDesc': 'Ввести своё название окружения',
  'env.customPrompt': 'Введите название окружения',
  'env.customValidation':
    'Допускаются только строчные буквы, цифры и дефисы (например, prod, main, tokyo, acme-dev)',
  'env.detected': 'Обнаруженные окружения:',
  'env.selectExisting': 'Выбрать существующее окружение',
  'env.createNew': 'Создать новое окружение',
  'env.createNewDesc': 'Настроить новое окружение',
  'env.checking': 'Проверка существующих окружений...',
  'env.alreadyExists': 'Окружение "{{env}}" уже существует',
  'env.existingResources': 'Существующие ресурсы:',
  'env.workers': 'Workers: {{count}}',
  'env.d1Databases': 'Базы данных D1: {{count}}',
  'env.kvNamespaces': 'Пространства имён KV: {{count}}',
  'env.chooseAnother':
    'Пожалуйста, выберите другое имя или используйте "{{command}} manage" для удаления.',
  'env.available': 'Название окружения доступно',
  'env.checkFailed': 'Не удалось проверить существующие окружения (продолжаем)',
  'env.noEnvFound': 'Окружения Authrim не найдены.',

  // Region
  'region.prompt': 'Выберите регион',
  'region.auto': 'Автоматически (ближайший к вам)',
  'region.autoDesc': 'Позволить Cloudflare выбрать ближайший регион',
  'region.wnam': 'Северная Америка (Запад)',
  'region.wnamDesc': 'Западная Северная Америка',
  'region.enam': 'Северная Америка (Восток)',
  'region.enamDesc': 'Восточная Северная Америка',
  'region.weur': 'Европа (Запад)',
  'region.weurDesc': 'Западная Европа',
  'region.eeur': 'Европа (Восток)',
  'region.eeurDesc': 'Восточная Европа',
  'region.apac': 'Азиатско-Тихоокеанский регион',
  'region.apacDesc': 'Азиатско-Тихоокеанский регион',
  'region.oceania': 'Океания',
  'region.oceaniaDesc': 'Австралия и острова Тихого океана',
  'region.euJurisdiction': 'Юрисдикция ЕС (соответствие GDPR)',
  'region.euJurisdictionDesc': 'Данные хранятся в ЕС',

  // UI deployment
  'ui.prompt': 'Способ развёртывания UI',
  'ui.pagesOption': 'Cloudflare Workers',
  'ui.pagesDesc': 'Развернуть на Cloudflare Workers (рекомендуется)',
  'ui.customOption': 'Собственный домен',
  'ui.customDesc': 'Использовать собственный хостинг',
  'ui.skipOption': 'Пропустить',
  'ui.skipDesc': 'Пропустить развёртывание UI',
  'ui.customPrompt': 'Введите URL собственного UI',

  // Domain
  'domain.prompt': 'Настроить собственный домен?',
  'domain.workersDevOption': 'Использовать домен workers.dev',
  'domain.workersDevDesc': 'Использовать домен Cloudflare по умолчанию',
  'domain.customOption': 'Настроить собственный домен',
  'domain.customDesc': 'Использовать свой домен',
  'domain.customPrompt': 'Введите собственный домен (например, auth.example.com)',
  'domain.customValidation': 'Пожалуйста, введите корректный домен (например, auth.example.com)',
  'domain.checkZoneButton': 'Проверить зону',
  'domain.checkingZone': 'Проверка зоны Cloudflare для {{domain}}...',
  'domain.zoneFound': "Зона '{{zone}}' найдена (статус: {{status}})",
  'domain.zoneNotFound': "Зона '{{zone}}' не найдена в вашем аккаунте Cloudflare",
  'domain.zoneNotFoundHint':
    'Маршрутизация пользовательского домена требует, чтобы зона была сначала добавлена в Cloudflare.',
  'domain.zoneCheckFailed': 'Не удалось проверить зону',
  'domain.zoneCheckSkipped': 'Проверка зоны пропущена, продолжение настройки...',
  'domain.continueWithoutZone': 'Продолжить без проверки зоны?',
  'domain.configureBinding': 'Настроить привязку пользовательского домена для Workers',
  'domain.configureBindingDesc':
    'Назначает базовый домен непосредственно Worker-маршрутизатору, чтобы Cloudflare управляла DNS и TLS-сертификатом. Поддомены тенантов продолжают использовать маршрутизацию по шаблону.',
  'domain.customHostnamesDesc':
    'Автоматизируйте пользовательские домены тенантов с помощью Cloudflare Custom Hostnames.',
  'domain.customHostnamesPrivacy':
    'Токен хранится только в локальном секретном файле и загружается как секрет Worker; он не сохраняется в D1, KV или конфигурации.',
  'domain.customHostnamesPrompt': 'Включить автоматизацию Cloudflare Custom Hostnames?',
  'domain.action.retryCheck': 'Проверить снова',
  'domain.action.reloadPage': 'Перезагрузить страницу',
  'domain.action.openCloudflareDashboard': 'Открыть панель Cloudflare',
  'domain.prereq.reviewTitle': 'Проверка пользовательского домена требует уточнения',
  'domain.prereq.reviewBody':
    'Если вы планируете использовать пользовательский домен, повторите проверку после перезагрузки страницы или обновления входа в Cloudflare.',
  'domain.diagnostic.zone_found.title': 'Зона Cloudflare готова',
  'domain.diagnostic.zone_found.body': 'Зона "{{zone}}" доступна в вашем аккаунте Cloudflare.',
  'domain.diagnostic.zone_found.next':
    'Можно продолжать настройку привязки пользовательского домена.',
  'domain.diagnostic.not_logged_in.title': 'Требуется вход в Cloudflare',
  'domain.diagnostic.not_logged_in.body':
    'Authrim не смог подтвердить вход в Cloudflare для этой проверки зоны.',
  'domain.diagnostic.not_logged_in.next':
    '1. Выполните `wrangler login` в терминале.\n2. Перезагрузите эту страницу.\n3. Повторно проверьте зону.',
  'domain.diagnostic.token_unavailable.title': 'Не удалось загрузить токен Cloudflare',
  'domain.diagnostic.token_unavailable.body':
    'Похоже, вход Wrangler есть, но API-токен, нужный для доступа к зоне, пока недоступен.',
  'domain.diagnostic.token_unavailable.next':
    '1. Перезагрузите эту страницу и проверьте снова.\n2. Если ошибка останется, заново выполните `wrangler login`.\n3. После этого повторите проверку зоны.',
  'domain.diagnostic.zone_read_forbidden.title': 'Доступ к списку зон ограничен',
  'domain.diagnostic.zone_read_forbidden.body':
    'Текущий токен Cloudflare не может читать список зон. Существующие зоны могут продолжить работать, но автоматическая проверка и помощь с DNS будут ограничены.',
  'domain.diagnostic.zone_read_forbidden.next':
    '1. Сначала проверьте снова.\n2. Если ошибка останется, заново выполните `wrangler login`.\n3. Убедитесь, что у токена есть разрешение Zone:Read.\n4. Если зона уже существует, можно продолжить вручную.',
  'domain.diagnostic.zone_not_found.title': 'Зона не найдена в этом аккаунте',
  'domain.diagnostic.zone_not_found.body':
    'Cloudflare ответил, но зона "{{zone}}" не видна в текущем аккаунте.',
  'domain.diagnostic.zone_not_found.next':
    '1. Убедитесь, что зона существует в используемом аккаунте Cloudflare.\n2. При необходимости переключите аккаунт или откройте панель Cloudflare.\n3. Затем повторно проверьте зону.',
  'domain.diagnostic.api_error.title': 'Проверка Cloudflare API завершилась ошибкой',
  'domain.diagnostic.api_error.body': 'Cloudflare вернул неожиданный ответ при проверке этой зоны.',
  'domain.diagnostic.api_error.next':
    'Сначала повторите проверку. Если ошибка останется, перезагрузите страницу и попробуйте снова.',
  'domain.diagnostic.network_error.title': 'Ошибка сетевой проверки Cloudflare',
  'domain.diagnostic.network_error.body':
    'Проверку зоны не удалось завершить, потому что Cloudflare или сеть ответили не так, как ожидалось.',
  'domain.diagnostic.network_error.next':
    'Сначала повторите проверку. Если ошибка останется, перезагрузите страницу и попробуйте снова.',
  'domain.issuerUrl': 'URL издателя: {{url}}',
  'domain.apiDomain': 'Домен API / издателя (например, auth.example.com)',
  'domain.loginUiDomain': 'Домен UI для входа (Enter для пропуска)',
  'domain.adminUiDomain': 'Домен панели администратора (Enter для пропуска)',
  'domain.baseDomainDepthError':
    'Base Domain должен быть родительским доменом URL тенантов. В «{{hostname}}» слишком много меток перед зарегистрированным доменом.',
  'domain.uiDomainDepthError':
    'Домен {{label}} «{{hostname}}» имеет слишком большую глубину для стандартной модели доменов тенанта.',
  'domain.suggestedHost': 'Рекомендуемый хост: {{hostname}}',
  'domain.uiRequiresOwnRoute':
    'Для пользовательского домена {{label}} требуется отдельный маршрут Worker.',
  'domain.enterDomains':
    'Введите собственные домены (оставьте пустым для использования Cloudflare по умолчанию)',
  'domain.singleTenantNote': 'В однотенантном режиме URL издателя = домен API',
  'domain.usingWorkersDev': '(используется домен Cloudflare workers.dev)',
  'web.form.multiTenantEnable': 'Включить мультитенантный режим',
  'web.form.multiTenantHint': 'Создавать субдомены тенантов под вашим пользовательским доменом',
  'web.form.multiTenantExamples': 'Примеры URL тенантов',
  'web.form.multiTenantExampleDefaultOmitted': 'Тенант по умолчанию без имени в URL: {{url}}',
  'web.form.multiTenantExampleDefaultIncluded': 'Тенант по умолчанию с явным именем: {{url}}',
  'web.form.multiTenantExampleOther': 'Неосновной тенант: {{url}}',

  // Database
  'db.title': 'Конфигурация базы данных',
  'db.regionWarning': 'Регион базы данных нельзя изменить после создания.',
  'db.coreDescription': 'БД платформы: хранит метаданные и журналы аудита без PII',
  'db.coreRegion': 'Регион основной базы данных',
  'db.piiDescription': 'PII БД платформы: хранит PII-аудит и данные анонимизации',
  'db.piiNote': 'Учитывайте требования к защите данных.',
  'db.piiRegion': 'Регион базы данных PII',
  'db.creating': 'Создание базы данных...',
  'db.created': 'База данных создана: {{name}}',
  'db.existing': 'Используется существующая база данных: {{name}}',
  'db.error': 'Не удалось создать базу данных',
  'db.locationHints': 'Подсказки по расположению',
  'db.jurisdictionCompliance': 'Юрисдикция (соответствие)',

  // KV
  'kv.creating': 'Создание пространства имён KV...',
  'kv.created': 'Пространство имён KV создано: {{name}}',
  'kv.existing': 'Используется существующее пространство имён KV: {{name}}',
  'kv.error': 'Не удалось создать пространство имён KV',

  // Queue
  'queue.creating': 'Создание очереди...',
  'queue.created': 'Очередь создана: {{name}}',
  'queue.existing': 'Используется существующая очередь: {{name}}',
  'queue.error': 'Не удалось создать очередь',

  // R2
  'r2.creating': 'Создание бакета R2...',
  'r2.created': 'Бакет R2 создан: {{name}}',
  'r2.existing': 'Используется существующий бакет R2: {{name}}',
  'r2.error': 'Не удалось создать бакет R2',

  // Keys
  'keys.generating': 'Генерация криптографических ключей...',
  'keys.generated': 'Ключи сгенерированы ({{path}})',
  'keys.existing': 'Ключи для окружения "{{env}}" уже существуют',
  'keys.existingWarning': 'Существующие ключи будут перезаписаны.',
  'keys.replaced': 'Существующие ключи заменены после подтверждения доступности окружения.',
  'keys.error': 'Не удалось сгенерировать ключи',
  'keys.regeneratePrompt': 'Перегенерировать ключи?',
  'keys.regenerateWarning': 'Это сделает недействительными все существующие токены!',

  // Config
  'config.saving': 'Сохранение конфигурации...',
  'config.saved': 'Конфигурация сохранена в {{path}}',
  'config.error': 'Не удалось сохранить конфигурацию',
  'config.path': 'Путь к конфигурации',
  'config.summary': 'Сводка конфигурации',
  'config.infrastructure': 'Инфраструктура:',
  'config.environment': 'Окружение:',
  'config.workerPrefix': 'Префикс Worker:',
  'config.profile': 'Профиль:',
  'config.tenantIssuer': 'Тенант и издатель:',
  'config.mode': 'Режим:',
  'config.multiTenant': 'Мультитенантный',
  'config.singleTenant': 'Однотенантный',
  'config.baseDomain': 'Базовый домен:',
  'config.issuerFormat': 'Формат издателя:',
  'config.issuerUrl': 'URL издателя:',
  'config.defaultTenant': 'Тенант по умолчанию:',
  'config.displayName': 'Отображаемое имя:',
  'config.publicUrls': 'Публичные URL:',
  'config.apiRouter': 'API-маршрутизатор:',
  'config.loginUi': 'UI для входа:',
  'config.adminUi': 'Панель администратора:',
  'config.components': 'Компоненты:',
  'config.featureFlags': 'Флаги функций:',
  'config.emailSettings': 'Email:',
  'config.oidcSettings': 'Настройки OIDC:',
  'config.accessTtl': 'TTL токена доступа:',
  'config.refreshTtl': 'TTL токена обновления:',
  'config.authCodeTtl': 'TTL кода авторизации:',
  'config.pkceRequired': 'Требуется PKCE:',
  'config.sharding': 'Шардинг:',
  'config.authCodeShards': 'Код авторизации:',
  'config.refreshTokenShards': 'Токен обновления:',
  'config.database': 'База данных:',
  'config.coreDb': 'Основная БД:',
  'config.piiDb': 'БД PII:',
  'config.enabled': 'Включено',
  'config.disabled': 'Отключено',
  'config.standard': '(стандартный)',
  'config.notConfigured': 'Не настроено (настроить позже)',
  'config.yes': 'Да',
  'config.no': 'Нет',
  'config.shards': 'шардов',
  'config.sec': 'сек',
  'config.automatic': 'Автоматически',
  'config.d1Routing': 'Маршрутизация D1:',
  'config.placement': 'Размещение:',
  'config.provisioning': 'Подготовка ресурсов:',
  'config.uiEnvNoApi': 'ui.env будет создан после настройки URL API.',
  'config.wranglerConfigsSaved': 'Сохранено главных конфигураций wrangler.toml: {{count}}',
  'config.wranglerConfigsPartial': 'Некоторые конфигурации wrangler не удалось сохранить',
  'config.wranglerConfigsSyncing': 'Синхронизация конфигураций wrangler с пакетами...',
  'config.wranglerConfigsSynced': 'Конфигурации wrangler синхронизированы с {{count}} компонентами',
  'config.wranglerConfigsSyncFailed': 'Не удалось синхронизировать конфигурации wrangler',

  // Deploy
  'deploy.prompt': 'Начать настройку с этой конфигурацией?',
  'deploy.starting': 'Запуск настройки...',
  'deploy.building': 'Сборка пакетов...',
  'deploy.deploying': 'Развёртывание на Cloudflare...',
  'deploy.success': 'Настройка завершена!',
  'deploy.error': 'Не удалось развернуть',
  'deploy.skipped': 'Развёртывание пропущено',
  'deploy.component': 'Развёртывание {{component}}...',
  'deploy.uploadingSecrets': 'Загрузка секретов...',
  'deploy.secretsUploaded': 'Секреты загружены',
  'deploy.runningMigrations': 'Выполнение миграций базы данных...',
  'deploy.migrationsComplete': 'Миграции завершены',
  'deploy.deployingWorker': 'Развёртывание worker {{name}}...',
  'deploy.workerDeployed': 'Worker развёрнут: {{name}}',
  'deploy.deployingUI': 'Развёртывание UI...',
  'deploy.uiDeployed': 'UI развёрнут',
  'deploy.creatingResources': 'Создание ресурсов Cloudflare...',
  'deploy.resourcesFailed': 'Не удалось создать ресурсы',
  'deploy.continueWithout': 'Продолжить без подготовки? (вам потребуется создать ресурсы вручную)',
  'deploy.emailSecretsSaved': 'Секреты email сохранены в {{path}}',
  'deploy.confirmStart': 'Начать развёртывание?',
  'deploy.confirmDryRun': 'Запустить развёртывание в режиме dry-run?',
  'deploy.cancelled': 'Развёртывание отменено.',
  'deploy.wranglerChanged': 'Как вы хотите обработать эти изменения?',
  'deploy.wranglerKeep': '📝 Сохранить ручные изменения (развернуть как есть)',
  'deploy.wranglerBackup': '💾 Создать резервную копию и перезаписать мастером',
  'deploy.wranglerOverwrite': '⚠️  Перезаписать мастером (потерять изменения)',
  'deploy.initialProvisioningFailed':
    'Подготовка Cloudflare не завершена. Блокировка среды не создана; запустите init ещё раз для безопасного продолжения.',

  // Email provider
  'email.title': 'Провайдер email',
  'email.description': 'Настройка отправки email для magic-ссылок и кодов подтверждения.',
  'email.prompt': 'Настроить провайдера email сейчас?',
  'email.resendOption': 'Resend',
  'email.resendDesc': 'Современный email API для разработчиков',
  'email.sesOption': 'AWS SES',
  'email.sesDesc': 'Amazon Simple Email Service',
  'email.smtpOption': 'SMTP',
  'email.smtpDesc': 'Общий SMTP-сервер',
  'email.skipOption': 'Нет (настроить позже)',
  'email.skipDesc': 'Пропустить настройку email',
  'email.apiKeyPrompt': 'API-ключ Resend',
  'email.apiKeyHint': 'Получите API-ключ на: https://resend.com/api-keys',
  'email.domainHint': 'Настройка домена: https://resend.com/domains',
  'email.apiKeyRequired': 'Требуется API-ключ',
  'email.apiKeyWarning': 'Предупреждение: API-ключи Resend обычно начинаются с "re_"',
  'email.fromAddressPrompt': 'Адрес отправителя email',
  'email.fromAddressValidation': 'Пожалуйста, введите корректный адрес email',
  'email.fromNamePrompt': 'Отображаемое имя отправителя (необязательно)',
  'email.domainVerificationRequired': 'Для отправки с вашего домена требуется верификация домена.',
  'email.seeDocumentation': 'См.: https://resend.com/docs/dashboard/domains/introduction',
  'email.provider': 'Провайдер:',
  'email.fromAddress': 'Адрес отправителя:',
  'email.fromName': 'Имя отправителя:',

  // SMS provider
  'sms.prompt': 'Настроить провайдера SMS?',
  'sms.twilioOption': 'Twilio',
  'sms.twilioDesc': 'SMS через Twilio',
  'sms.skipOption': 'Нет (настроить позже)',
  'sms.skipDesc': 'Пропустить настройку SMS',
  'sms.accountSidPrompt': 'Twilio Account SID',
  'sms.authTokenPrompt': 'Twilio Auth Token',
  'sms.fromNumberPrompt': 'Номер телефона отправителя',

  // Social providers
  'social.prompt': 'Настроить провайдеров социального входа?',
  'social.googleOption': 'Google',
  'social.googleDesc': 'Вход через Google',
  'social.githubOption': 'GitHub',
  'social.githubDesc': 'Вход через GitHub',
  'social.appleOption': 'Apple',
  'social.appleDesc': 'Вход через Apple',
  'social.microsoftOption': 'Microsoft',
  'social.microsoftDesc': 'Вход через Microsoft',
  'social.skipOption': 'Нет (настроить позже)',
  'social.skipDesc': 'Пропустить настройку социального входа',
  'social.clientIdPrompt': 'ID клиента',
  'social.clientSecretPrompt': 'Секрет клиента',

  // Cloudflare API Token
  'cf.apiTokenPrompt': 'Введите API-токен Cloudflare',
  'cf.apiTokenValidation': 'Пожалуйста, введите корректный API-токен',
  'cf.apiTokenCreationMethod': 'Как вы хотите создать API-токен?',
  'cf.apiTokenCreateFromLink': 'Создать по предварительно настроенной ссылке (рекомендуется)',
  'cf.apiTokenCreateFromLinkDesc': 'Открыть Cloudflare с уже выбранными правами и зоной',
  'cf.apiTokenCreateManually': 'Создать вручную',
  'cf.apiTokenCreateManuallyDesc': 'Проверить необходимые права и самостоятельно настроить токен',
  'cf.apiTokenTemplateUrl': 'URL создания токена Cloudflare:',
  'cf.apiTokenTemplateOpenPrompt': 'Нажмите Enter, чтобы открыть Cloudflare в браузере',
  'cf.apiTokenTemplateOpened': 'Открыта страница создания токена Cloudflare',
  'cf.apiTokenTemplateOpenFailed': 'Не удалось открыть браузер. Откройте URL ниже вручную.',
  'cf.apiTokenManualTitle': 'Создайте пользовательский API-токен со следующими параметрами:',
  'cf.apiTokenManualType': 'Используйте API Token, а не Global API Key.',
  'cf.apiTokenManualPermission': 'Право: Zone > SSL and Certificates > Edit',
  'cf.apiTokenManualResource': 'Ресурс зоны: Include > Specific zone > {{zone}}',
  'cf.apiTokenManualLeastPrivilege': 'Не добавляйте несвязанные права или зоны.',
  'cf.apiTokenSecretOnce':
    'Секрет токена показывается только один раз. Скопируйте его до выхода из Cloudflare.',
  'cf.apiTokenSelectedZone': 'зона, используемая этой средой',

  // Tenant configuration
  'tenant.title': 'Режим тенантов',
  'tenant.multiTenantPrompt':
    'Включить мультитенантный режим? (изоляция тенантов на основе поддоменов)',
  'tenant.multiTenantTitle': 'Конфигурация URL мультитенантности',
  'tenant.multiTenantNote1': 'В мультитенантном режиме:',
  'tenant.multiTenantNote2': 'Каждый тенант имеет поддомен: https://{tenant}.{base-domain}',
  'tenant.multiTenantNote3': 'Базовый домен указывает на Worker-маршрутизатор',
  'tenant.multiTenantNote4': 'URL издателя динамически строится из заголовка Host',
  'tenant.baseDomainPrompt': 'Базовый домен (например, authrim.com)',
  'tenant.baseDomainRequired': 'Базовый домен обязателен для мультитенантного режима',
  'tenant.baseDomainValidation': 'Пожалуйста, введите корректный домен (например, authrim.com)',
  'tenant.issuerFormat': 'Формат URL издателя: https://{tenant}.{{domain}}',
  'tenant.issuerExample': 'Пример: https://acme.{{domain}}',
  'tenant.defaultTenantPrompt': 'Имя тенанта по умолчанию (идентификатор)',
  'tenant.defaultTenantValidation': 'Допускаются только строчные буквы, цифры и дефисы',
  'tenant.displayNamePrompt': 'Отображаемое имя тенанта по умолчанию',
  'tenant.domainSetupHint':
    'Оставьте пустым, чтобы использовать workers.dev в режиме одного тенанта.',
  'tenant.customDomainExamples': 'С пользовательским доменом:',
  'tenant.nakedDomainExample': 'https://example.com (issuer без поддомена тенанта)',
  'tenant.subdomainExample': 'https://acme.example.com (issuer с поддоменом тенанта)',
  'tenant.idRules':
    'ID тенанта должен содержать 1–63 символа, начинаться со строчной буквы и включать только строчные буквы, цифры и дефисы.',
  'tenant.randomIdHint':
    'Случайный ID тенанта не раскрывает имя клиента или компании в URL issuer.',
  'tenant.randomIdPrompt': 'Создать случайный ID тенанта? ({{id}})',
  'tenant.initialDisplayName': 'Начальный тенант',
  'tenant.nakedDomainPrompt': 'Использовать базовый домен как issuer основного тенанта?',
  'tenant.primaryTenantPrompt':
    'ID основного тенанта для базового домена (оставьте пустым для начального тенанта)',
  'tenant.singleTenantTitle': 'Конфигурация URL однотенантности',
  'tenant.singleTenantNote1': 'В однотенантном режиме:',
  'tenant.singleTenantNote2': 'URL издателя = собственный домен API (или workers.dev по умолчанию)',
  'tenant.singleTenantNote3': 'Все клиенты используют одного издателя',
  'tenant.organizationName': 'Название организации (отображаемое имя)',
  'tenant.uiDomainTitle': 'Конфигурация домена UI',
  'tenant.customUiDomainPrompt': 'Настроить собственные домены UI?',
  'tenant.loginUiDomain': 'Домен UI для входа (например, login.example.com)',
  'tenant.adminUiDomain': 'Домен панели администратора (например, admin.example.com)',

  // User ID format
  'userId.title': 'Формат ID пользователя',
  'userId.prompt': 'Выберите формат ID пользователя',
  'userId.nanoid': 'NanoID (рекомендуется)',
  'userId.nanoidDesc': 'URL-безопасные 21-символьные ID, компактные и надёжные',
  'userId.uuid': 'UUID v4',
  'userId.uuidDesc': 'Стандартные 36-символьные UUID с дефисами',
  'userId.note': 'Примечание: Этот параметр нельзя изменить после создания пользователей.',
  'userId.selected': 'Формат ID пользователя: {{format}}',

  // Standard components
  'components.title': 'Стандартные компоненты',
  'components.note':
    'SAML, Device Flow/CIBA, VC, социальный вход и Policy Engine устанавливаются по умолчанию.',
  'components.samlPrompt': 'Включить поддержку SAML?',
  'components.vcPrompt': 'Включить верифицируемые учётные данные (VC)?',
  'components.saml': 'SAML:',
  'components.vc': 'VC:',
  'components.socialLogin': 'Социальный вход:',
  'components.policyEngine': 'Policy Engine:',

  // Feature flags
  'features.title': 'Флаги функций',
  'features.queuePrompt': 'Включить Cloudflare Queues? (для журналов аудита)',
  'features.r2Prompt': 'Включить объектное хранилище Cloudflare R2?',
  'features.queue': 'Очередь:',
  'features.r2': 'R2:',

  // OIDC settings
  'oidc.configurePrompt': 'Настроить параметры OIDC? (TTL токенов и т.д.)',
  'oidc.title': 'Настройки OIDC',
  'oidc.accessTokenTtl': 'TTL токена доступа (сек)',
  'oidc.refreshTokenTtl': 'TTL токена обновления (сек)',
  'oidc.authCodeTtl': 'TTL кода авторизации (сек)',
  'oidc.pkceRequired': 'Требовать PKCE?',
  'oidc.positiveInteger': 'Пожалуйста, введите положительное целое число',

  // Sharding settings
  'sharding.configurePrompt': 'Настроить шардинг? (для высоконагруженных окружений)',
  'sharding.title': 'Настройки шардинга',
  'sharding.note':
    'Примечание: рекомендуется степень 2 для количества шардов (4, 8, 16, 32, 64, 128)',
  'sharding.authCodeShards': 'Количество шардов кода авторизации',
  'sharding.refreshTokenShards': 'Количество шардов токена обновления',

  // Infrastructure
  'infra.title': 'Инфраструктура (автогенерация)',
  'infra.workersNote': 'Будут развёрнуты следующие Workers:',
  'infra.router': 'Маршрутизатор:',
  'infra.auth': 'Аутентификация:',
  'infra.token': 'Токен:',
  'infra.management': 'Управление:',
  'infra.otherWorkers': '... и другие вспомогательные workers',
  'infra.defaultEndpoints': 'Эндпоинты по умолчанию (без собственного домена):',
  'infra.api': 'API:',
  'infra.ui': 'UI:',
  'infra.workersToDeploy': 'Workers для развёртывания: {{workers}}',
  'infra.defaultApi': 'API по умолчанию: {{url}}',

  // Completion
  'complete.title': 'Настройка завершена!',
  'complete.summary': 'Ваш OIDC-провайдер Authrim развёрнут.',
  'complete.issuerUrl': 'URL издателя: {{url}}',
  'complete.adminUrl': 'Панель администратора: {{url}}',
  'complete.uiUrl': 'UI для входа: {{url}}',
  'complete.nextSteps': 'Следующие шаги:',
  'complete.nextStep1': '1. Проверьте развёртывание, посетив URL издателя',
  'complete.nextStep2': '2. Настройте OAuth-клиентов в панели администратора',
  'complete.nextStep3': '3. При необходимости настройте собственные домены',
  'complete.warning': 'Не забудьте сохранить ключи в безопасном месте и сделать резервную копию!',
  'complete.success': 'Настройка успешно завершена!',
  'complete.urls': 'URL-адреса:',
  'complete.configLocation': 'Конфигурация:',
  'complete.keysLocation': 'Ключи:',
  'complete.createdResources': 'Созданные ресурсы:',
  'complete.generatedFiles': 'Созданные файлы:',
  'complete.automaticStep1': '1. Примените схемы и разверните полный релиз:',
  'complete.automaticStep2':
    '2. По запросу создайте и введите одноразовый загрузочный токен Cloudflare.',
  'complete.automaticStep2Detail':
    'Setup регистрирует разделённые дочерние токены напрямую в Control и отзывает загрузочный токен.',
  'complete.manualStep1':
    '1. Примените схемы и выполните развёртывание с текущим входом Wrangler OAuth:',
  'complete.manualStep2':
    '2. Используйте Setup для выполнения ожидающих операций подготовки, запрошенных из Admin.',
  'complete.manualStep2Detail':
    'Автоматическая подготовка отключена; токен API Cloudflare не хранится в Control.',

  // Resource provisioning
  'resource.provisioning': 'Подготовка {{resource}}...',
  'resource.provisioned': '{{resource}} успешно подготовлен',
  'resource.failed': 'Не удалось подготовить {{resource}}',
  'resource.skipped': 'Пропущено {{resource}}',

  // Manage environments
  'manage.title': 'Существующие окружения',
  'manage.loading': 'Загрузка...',
  'manage.detecting': 'Обнаружение окружений...',
  'manage.detected': 'Обнаруженные окружения:',
  'manage.noEnvs': 'Окружения Authrim не найдены.',
  'manage.selectAction': 'Выберите действие',
  'manage.viewDetails': 'Просмотр деталей',
  'manage.viewDetailsDesc': 'Показать подробную информацию о ресурсах',
  'manage.deleteEnv': 'Удалить окружение',
  'manage.deleteEnvDesc': 'Удалить окружение и ресурсы',
  'manage.backToMenu': 'Вернуться в главное меню',
  'manage.backToMenuDesc': 'Вернуться в главное меню',
  'manage.selectEnv': 'Выберите окружение',
  'manage.back': 'Назад',
  'manage.continueManaging': 'Продолжить управление окружениями?',

  // Load config
  'loadConfig.title': 'Загрузка существующей конфигурации',
  'loadConfig.found': 'Найдено конфигураций: {{count}}',
  'loadConfig.new': '(новая)',
  'loadConfig.legacy': '(устаревшая)',
  'loadConfig.legacyDetected': 'Обнаружена устаревшая структура',
  'loadConfig.legacyFiles': 'Устаревшие файлы:',
  'loadConfig.newBenefits': 'Преимущества новой структуры:',
  'loadConfig.benefit1': 'Переносимость окружения (zip .authrim/prod/)',
  'loadConfig.benefit2': 'Отслеживание версий по окружениям',
  'loadConfig.benefit3': 'Более чистая структура проекта',
  'loadConfig.migratePrompt': 'Хотите перейти на новую структуру?',
  'loadConfig.migrateOption': 'Перейти на новую структуру (.authrim/{env}/)',
  'loadConfig.continueOption': 'Продолжить с устаревшей структурой',
  'loadConfig.migrationComplete': 'Миграция успешно завершена!',
  'loadConfig.validationPassed': 'Проверка пройдена',
  'loadConfig.validationIssues': 'Проблемы валидации:',
  'loadConfig.newLocation': 'Новое расположение конфигурации:',
  'loadConfig.migrationFailed': 'Миграция не удалась:',
  'loadConfig.continuingLegacy': 'Продолжение с устаревшей структурой...',
  'loadConfig.loadThis': 'Загрузить эту конфигурацию',
  'loadConfig.specifyOther': 'Указать другой файл',
  'loadConfig.noConfigFound': 'Конфигурация не найдена в текущем каталоге.',
  'loadConfig.tip': 'Совет: вы можете указать файл конфигурации:',
  'loadConfig.specifyPath': 'Указать путь к файлу',
  'loadConfig.enterPath': 'Введите путь к файлу конфигурации',
  'loadConfig.pathRequired': 'Пожалуйста, введите путь',
  'loadConfig.fileNotFound': 'Файл не найден: {{path}}',
  'loadConfig.selectConfig': 'Выберите конфигурацию для загрузки',

  // Common
  'common.yes': 'Да',
  'common.no': 'Нет',
  'common.example': 'Пример',
  'common.comingSoon': 'скоро',
  'common.continue': 'Продолжить',
  'common.cancel': 'Отмена',
  'common.skip': 'Пропустить',
  'common.back': 'Назад',
  'common.confirm': 'Подтвердить',
  'common.error': 'Ошибка',
  'common.warning': 'Предупреждение',
  'common.success': 'Успешно',
  'common.info': 'Информация',
  'common.loading': 'Загрузка...',
  'common.saving': 'Сохранение...',
  'common.processing': 'Обработка...',
  'common.done': 'Готово',
  'common.required': 'Обязательно',
  'common.optional': 'Необязательно',

  // Errors
  'error.generic': 'Произошла ошибка',
  'error.network': 'Ошибка сети',
  'error.timeout': 'Время ожидания запроса истекло',
  'error.invalidInput': 'Некорректный ввод',
  'error.fileNotFound': 'Файл не найден',
  'error.permissionDenied': 'Доступ запрещён',
  'error.configNotFound': 'Конфигурация не найдена',
  'error.configInvalid': 'Некорректная конфигурация',
  'error.deployFailed': 'Развёртывание не удалось',
  'error.resourceCreationFailed': 'Не удалось создать ресурс',

  // Validation
  'validation.required': 'Это поле обязательно',
  'validation.invalidFormat': 'Некорректный формат',
  'validation.tooShort': 'Слишком коротко',
  'validation.tooLong': 'Слишком длинно',
  'validation.invalidDomain': 'Некорректный домен',
  'validation.invalidEmail': 'Некорректный адрес email',
  'validation.invalidUrl': 'Некорректный URL',

  // Delete command
  'delete.title': 'Удаление окружения',
  'delete.prompt': 'Выберите ресурсы для удаления',
  'delete.confirm': 'Вы уверены, что хотите удалить "{{env}}"?',
  'delete.confirmPermanent':
    '⚠️  Все ресурсы для "{{env}}" будут безвозвратно удалены. Продолжить?',
  'delete.deleting': 'Удаление {{resource}}...',
  'delete.deleted': '{{resource}} удалён',
  'delete.error': 'Не удалось удалить {{resource}}',
  'delete.cancelled': 'Удаление отменено',
  'delete.noEnvFound': 'Окружения не найдены',
  'delete.selectEnv': 'Выберите окружение для удаления',
  'delete.workers': 'Workers',
  'delete.databases': 'Базы данных D1',
  'delete.kvNamespaces': 'Пространства имён KV',
  'delete.queues': 'Очереди',
  'delete.r2Buckets': 'Бакеты R2',
  'delete.pages': 'Проекты Pages',
  'delete.partialSuccess': 'Выбранные ресурсы удалены, остальные данные окружения сохранены',
  'delete.inventoryUnavailable':
    'Удаление не началось, так как не удалось проверить список ресурсов Cloudflare',

  // Info command
  'info.title': 'Информация об окружении',
  'info.loading': 'Загрузка информации об окружении...',
  'info.noResources': 'Ресурсы не найдены',
  'info.environment': 'Окружение',
  'info.issuer': 'Издатель',
  'info.workers': 'Workers',
  'info.databases': 'Базы данных',
  'info.kvNamespaces': 'Пространства имён KV',
  'info.queues': 'Очереди',
  'info.r2Buckets': 'Бакеты R2',
  'info.status': 'Статус',
  'info.deployed': 'Развёрнуто',
  'info.notDeployed': 'Не развёрнуто',

  // Config command
  'configCmd.title': 'Конфигурация',
  'configCmd.showing': 'Отображение конфигурации',
  'configCmd.validating': 'Проверка конфигурации...',
  'configCmd.valid': 'Конфигурация корректна',
  'configCmd.invalid': 'Конфигурация некорректна',
  'configCmd.notFound': 'Конфигурация не найдена',
  'configCmd.error': 'Ошибка чтения конфигурации',

  // Migrate command
  'migrate.title': 'Миграция на новую структуру',
  'migrate.checking': 'Проверка статуса миграции...',
  'migrate.noLegacyFound': 'Устаревшая структура не найдена',
  'migrate.legacyFound': 'Обнаружена устаревшая структура',
  'migrate.prompt': 'Перейти на новую структуру?',
  'migrate.migrating': 'Миграция...',
  'migrate.success': 'Миграция успешна',
  'migrate.cancelled': 'Миграция отменена.',
  'migrate.error': 'Миграция не удалась',
  'migrate.dryRun': 'Dry run — изменения не внесены',
  'migrate.backup': 'Создание резервной копии...',
  'migrate.backupCreated': 'Резервная копия создана: {{path}}',

  // Security configuration
  'security.title': 'Настройки безопасности',
  'security.description':
    'Настройка параметров защиты данных. Эти настройки нельзя изменить после сохранения начальных данных.',
  'security.piiEncryption': 'Шифрование PII',
  'security.piiEncryptionEnabled': 'Шифрование на уровне приложения (Рекомендуется)',
  'security.piiEncryptionEnabledDesc':
    'Шифровать данные PII на уровне приложения (рекомендуется для D1)',
  'security.piiEncryptionDisabled': 'Только шифрование на уровне базы данных',
  'security.piiEncryptionDisabledDesc': 'Использовать шифрование управляемой БД (для Aurora и др.)',
  'security.domainHash': 'Хеширование доменов email',
  'security.domainHashEnabled': 'Включить хеширование доменов (Рекомендуется)',
  'security.domainHashEnabledDesc': 'Хешировать домены email для конфиденциальности в аналитике',
  'security.domainHashDisabled': 'Хранить домены в открытом виде',
  'security.domainHashDisabledDesc': 'Хранить домены email без хеширования',
  'security.warning': '⚠️ Эти настройки нельзя изменить после сохранения данных',

  // Manage command
  'manage.commandTitle': 'Менеджер окружений Authrim',

  // Web UI specific
  'web.title': 'Настройка Authrim',
  'web.subtitle': 'OIDC-провайдер на Cloudflare Workers',
  'web.loading': 'Загрузка...',
  'web.error': 'Произошла ошибка',
  'web.retry': 'Повторить',
  'web.languageSelector': 'Язык',
  'web.darkMode': 'Тёмная',
  'web.lightMode': 'Светлая',
  'web.systemMode': 'Системная',

  // Web UI Prerequisites
  'web.prereq.title': 'Подготовка',
  'web.prereq.checking': 'Проверка...',
  'web.prereq.checkingRequirements': 'Проверка системных требований...',
  'web.prereq.ready': 'Готово',
  'web.prereq.wranglerInstalled': 'Wrangler установлен',
  'web.prereq.loggedInAs': 'Вход выполнен как {{email}}',

  // Web UI Top Menu
  'web.menu.title': 'Начало работы',
  'web.menu.subtitle': 'Выберите вариант для продолжения:',
  'web.menu.newSetup': 'Новая настройка',
  'web.menu.newSetupDesc': 'Создать новое развёртывание Authrim с нуля',
  'web.menu.loadConfig': 'Загрузить конфигурацию',
  'web.menu.loadConfigDesc': 'Продолжить или повторно развернуть с существующей конфигурацией',
  'web.menu.manageEnv': 'Управление окружениями',
  'web.menu.manageEnvDesc': 'Просмотр, проверка или удаление существующих окружений',

  // Web UI Setup Mode
  'web.mode.title': 'Режим настройки',
  'web.mode.subtitle': 'Выберите способ настройки Authrim:',
  'web.mode.quick': 'Быстрая настройка',
  'web.mode.quickDesc': 'Начните за ~5 минут',
  'web.mode.quickEnv': 'Выбор окружения',
  'web.mode.quickDomain': 'Необязательный собственный домен',
  'web.mode.quickDefault': 'Компоненты по умолчанию',
  'web.mode.recommended': 'Рекомендуется',
  'web.mode.custom': 'Расширенная настройка',
  'web.mode.customDesc': 'Полный контроль над конфигурацией',
  'web.mode.customComp': 'Выбор компонентов',
  'web.mode.customUrl': 'Конфигурация URL',
  'web.mode.customAdvanced': 'Расширенные настройки',

  // Web UI Load Config
  'web.loadConfig.title': 'Загрузка конфигурации',
  'web.loadConfig.subtitle': 'Выберите файл authrim-config.json:',
  'web.loadConfig.chooseFile': 'Выбрать файл',
  'web.loadConfig.preview': 'Предпросмотр конфигурации',
  'web.loadConfig.validationFailed': 'Проверка конфигурации не пройдена',
  'web.loadConfig.valid': 'Конфигурация корректна',
  'web.loadConfig.loadContinue': 'Загрузить и продолжить',

  // Web UI Configuration
  'web.config.title': 'Конфигурация',
  'web.config.components': 'Компоненты',
  'web.config.apiRequired': 'API (обязательно)',
  'web.config.apiDesc':
    'Эндпоинты OIDC-провайдера: authorize, token, userinfo, discovery, management API.',
  'web.config.saml': 'SAML IdP',
  'web.config.deviceFlow': 'Device Flow / CIBA',
  'web.config.vcSdJwt': 'VC SD-JWT',
  'web.config.loginUi': 'UI для входа',
  'web.config.loginUiDesc': 'Готовый UI аутентификации на Cloudflare Workers.',
  'web.config.adminUi': 'Панель администратора',
  'web.config.adminUiDesc': 'Панель управления пользователями, клиентами и настройками.',

  // Web UI URLs
  'web.url.title': 'Конфигурация URL',
  'web.url.apiDomain': 'Домен API',
  'web.url.apiDomainHint': 'Оставьте пустым для использования поддомена workers.dev',
  'web.url.loginDomain': 'Домен UI для входа',
  'web.url.loginDomainHint': 'Оставьте пустым для использования поддомена workers.dev',
  'web.url.adminDomain': 'Домен панели администратора',
  'web.url.adminDomainHint': 'Оставьте пустым для использования поддомена workers.dev',

  // Web UI Database
  'web.db.title': 'Конфигурация базы данных',
  'web.db.coreTitle': 'Основная база данных',
  'web.db.coreSubtitle': '(без PII)',
  'web.db.coreDesc':
    'Хранит клиентов, коды авторизации, токены, сессии. Может реплицироваться глобально.',
  'web.db.piiTitle': 'База данных PII',
  'web.db.piiSubtitle': '(персональные данные)',
  'web.db.piiDesc':
    'Хранит профили пользователей, учётные данные, PII. Должна находиться в одной юрисдикции для соответствия требованиям.',
  'web.db.name': 'Имя',
  'web.db.region': 'Регион',
  'web.db.regionAuto': 'Автоматически (ближайший)',
  'web.db.controlPlaneTitle': 'D1 Control Plane',
  'web.db.controlPlaneDesc':
    'Инициализирует Control Plane и первые shards; дальнейшая емкость создается автоматически.',
  'web.db.controlPlaneWorkerDesc':
    'Эта функция позволяет Authrim управлять базами данных tenant. Нужные ресурсы управления создаются при настройке.',
  'web.db.controlPlaneTenantPlacement':
    'Начальный tenant начинает с собственного места хранения. Для добавляемых tenant можно выбрать отдельное место.',
  'web.db.controlPlaneResolverNote':
    'Authrim автоматически управляет созданием баз данных и маршрутизацией подключений.',
  'web.db.automaticProvisioningTitle': 'Автоматическое создание баз tenant',
  'web.db.automaticProvisioningOn': 'Вкл. (создавать автоматически)',
  'web.db.automaticProvisioningOnDesc':
    'При росте числа tenant или объема данных Authrim автоматически создает нужные базы.',
  'web.db.automaticProvisioningTokenNote':
    'Выделенный Control Worker хранит и использует Cloudflare API token с ограниченными правами, необходимый для создания баз данных tenant.',
  'web.db.automaticProvisioningOff': 'Выкл. (создавать через Setup)',
  'web.db.automaticProvisioningOffDesc':
    'Базы не создаются автоматически. Создайте их через Setup, когда это потребуется.',
  'web.db.automaticProvisioningNote': 'При отключении разделение данных tenant сохраняется.',
  'web.deploy.controlCredentialsTitle': 'Подключение к Cloudflare',
  'web.deploy.bootstrapTokenTitle': 'Временный токен Cloudflare для автоматической настройки',
  'web.deploy.cloudflareLoginNote':
    'Вход в Cloudflare Dashboard отдельный от Wrangler OAuth и может потребовать повторного входа.',
  'web.deploy.createBootstrapToken': 'Создать одноразовый токен Cloudflare',
  'web.deploy.bootstrapTokenLabel': 'Временный токен Cloudflare',
  'web.deploy.bootstrapTokenPlaceholder': 'Введите временный токен Cloudflare',
  'web.deploy.bootstrapTokenHelp':
    'Этот токен используется один раз и отзывается после регистрации необходимых токенов.',
  'web.deploy.bootstrapTokenDescription':
    'Этот временный токен позволяет Authrim автоматически создавать базы данных тенантов. Нужны права на создание и изменение API-токенов: Account API Tokens: Write/Edit для токена аккаунта или API Tokens: Write/Edit для пользовательского токена. Setup использует его для создания при необходимости API-токенов с ограниченной областью для D1, Workers, KV и R2, регистрирует их в Control Worker и затем отзывает временный токен.',
  'web.deploy.manualDnsSectionTitle': 'Настройки DNS',
  'web.deploy.bootstrapTokenCreateStatus':
    'Установите End Date на {{endDate}} (UTC) в Cloudflare Dashboard, создайте временный токен и введите его ниже.',
  'web.deploy.bootstrapPopupBlocked':
    'Браузер заблокировал новую вкладку. Разрешите всплывающие окна и нажмите кнопку снова.',
  'web.deploy.bootstrapTokenRequired':
    'Перед развертыванием создайте и введите временный токен Cloudflare.',
  'web.envDetail.automaticProvisioningTitle': 'Автоматическое провижининг',
  'web.envDetail.automaticProvisioningChecking': 'Проверка...',
  'web.envDetail.automaticProvisioningUnavailable': 'Недоступно',
  'web.envDetail.createOneTimeCloudflareToken': 'Создать одноразовый токен Cloudflare',
  'web.envDetail.oneTimeBootstrapTokenPlaceholder': 'Одноразовый bootstrap-токен',
  'web.envDetail.enableAutomaticProvisioning': 'Включить',
  'web.envDetail.enterOneTimeTokenThenEnable':
    'Установите End Date на {{endDate}} (UTC), создайте и введите одноразовый токен, затем выберите «Включить».',
  'web.envDetail.bootstrapPopupBlocked': 'Браузер заблокировал вкладку Cloudflare Dashboard.',
  'web.envDetail.enterOneTimeTokenFirst': 'Сначала введите одноразовый токен Cloudflare.',
  'web.envDetail.preparingControlAuthority': 'Подготовка полномочий провижининга Control...',
  'web.envDetail.deployingControlWorker': 'Развертывание конфигурации Control Worker...',
  'web.envDetail.registeringScopedCredentials': 'Регистрация ограниченных учетных данных...',
  'web.envDetail.automaticProvisioningOn': 'Вкл.',
  'web.envDetail.automaticProvisioningOff': 'Выкл.',
  'web.envDetail.automaticProvisioningCredentialsRegistered':
    'Ограниченные учетные данные Control Worker зарегистрированы.',
  'web.envDetail.automaticProvisioningBlocked': 'Автоматическое провижининг заблокировано.',
  'web.envDetail.automaticProvisioningMissing': '(отсутствует: {{missing}})',
  'web.envDetail.automaticProvisioningRepairHint':
    'Введите новый одноразовый токен для исправления.',
  'web.envDetail.bootstrapRetainedForRetry':
    'Cloudflare вернул временную ошибку. Bootstrap-токен остаётся активным; повторно введите тот же токен и выберите «Включить», чтобы продолжить.',
  'web.envDetail.bootstrapNotSubmittedForRetry':
    'Setup остановился до отправки bootstrap-токена. Токен остался в поле ввода, и попытку можно повторить.',
  'web.envDetail.revokeTokensBeforeRetry':
    'Перед повторной попыткой отзовите указанные bootstrap- и дочерние токены Authrim в Cloudflare Dashboard.',
  'web.envDetail.bootstrapRevokedPendingReset':
    'Bootstrap-токен отозван, но ожидающее состояние не удалось сбросить.',
  'web.envDetail.bootstrapRevokedDisabled':
    'Bootstrap-токен отозван, автоматическое провижининг выключено.',

  // Web UI Email
  'web.email.title': 'Провайдер email',
  'web.email.subtitle': 'Выберите сервис email для сброса пароля и подтверждения:',
  'web.email.none': 'Нет',
  'web.email.noneDesc': 'Функции email отключены',
  'web.email.resend': 'Resend',
  'web.email.resendDesc': 'Email API для разработчиков',
  'web.email.sendgrid': 'SendGrid',
  'web.email.sendgridDesc': 'Масштабируемая доставка email',
  'web.email.ses': 'Amazon SES',
  'web.email.sesDesc': 'AWS Simple Email Service',
  'web.email.resendConfig': 'Конфигурация Resend',
  'web.email.apiKey': 'API-ключ',
  'web.email.apiKeyPlaceholder': 're_xxxxxxxx',
  'web.email.fromAddress': 'Адрес отправителя',
  'web.email.fromAddressPlaceholder': 'noreply@yourdomain.com',

  // Web UI Provision
  'web.provision.title': 'Создание ресурсов Cloudflare',
  'web.provision.ready': 'Готово к подготовке',
  'web.provision.desc': 'В вашем аккаунте Cloudflare будут созданы следующие ресурсы:',
  'web.provision.createResources': 'Создать ресурсы',
  'web.provision.saveConfig': 'Сохранить конфигурацию',
  'web.provision.continueDeploy': 'Перейти к развёртыванию →',

  // Web UI Deploy
  'web.deploy.title': 'Развёртывание',
  'web.deploy.desc': 'Развернуть workers и UI на Cloudflare:',
  'web.deploy.startDeploy': 'Начать развёртывание',
  'web.deploy.deploying': 'Развёртывание...',

  // Web UI Complete
  'web.complete.title': 'Настройка завершена!',
  'web.complete.desc': 'Ваше развёртывание Authrim готово.',
  'web.complete.issuerUrl': 'URL издателя',
  'web.complete.loginUrl': 'URL для входа',
  'web.complete.adminUrl': 'URL администратора',
  'web.complete.saveConfig': 'Сохранить конфигурацию',
  'web.complete.backToMain': 'Вернуться на главную',
  'web.config.saveToFileTitle': 'Сохранить конфигурацию в файл',
  'web.complete.backToMainTitle': 'Вернуться на главный экран',
  'web.complete.canClose': 'Настройка завершена. Вы можете безопасно закрыть это окно.',
  'web.complete.adminAccountTitle': 'Настройка учётной записи администратора',
  'web.complete.adminAccountImportant': 'ВАЖНО',
  'web.complete.adminAccountDesc':
    'Зарегистрируйте первую учётную запись администратора с помощью Passkey:',
  'web.complete.copy': '📋 Копировать',
  'web.complete.copied': '✓ Скопировано',
  'web.complete.openSetup': '🔑 Открыть настройку',
  'web.complete.urlWarning':
    'Этот URL можно использовать только <strong>один раз</strong>, он истекает <strong>{{date}}</strong>.',
  'web.complete.adminSetupUnavailable':
    'URL настройки недоступен. Вы можете настроить доступ администратора в интерфейсе администрирования позже.',
  'web.complete.customDomainNote':
    'ℹ️ Пользовательский домен: распространение DNS может занять от нескольких минут до нескольких часов. Если URL ещё недоступен, подождите.',

  // Web UI Environment Management
  'web.env.title': 'Окружения',
  'web.env.loading': 'Загрузка окружений...',
  'web.env.noEnvFound': 'Окружения не найдены',
  'web.env.refresh': 'Обновить',
  'web.env.adminSetup': 'Начальная настройка администратора',
  'web.env.adminSetupDesc': 'Нажмите для создания учётной записи администратора для',
  'web.env.openSetup': 'Открыть настройку',
  'web.env.copyUrl': 'Копировать',
  'web.env.deleteTitle': 'Удаление окружения',
  'web.env.deleteWarning': 'Будут удалены следующие выбранные ресурсы:',
  'web.env.confirmDelete': 'Удалить выбранное',
  'web.env.cancel': 'Отмена',

  // Web UI Common buttons
  'web.btn.back': 'Назад',
  'web.btn.continue': 'Продолжить',
  'web.btn.cancel': 'Отмена',
  'web.btn.save': 'Сохранить',
  'web.btn.skip': 'Пропустить',

  // Web UI Save Modal
  'web.modal.saveTitle': 'Сохранить конфигурацию?',
  'web.modal.saveDesc':
    'Сохраните конфигурацию на локальный компьютер для использования в будущем.',
  'web.modal.skipSave': 'Пропустить',
  'web.modal.saveConfig': 'Сохранить конфигурацию',

  // Web UI steps
  'web.step.environment': 'Окружение',
  'web.step.region': 'Регион',
  'web.step.domain': 'Домен',
  'web.step.email': 'Email',
  'web.step.sms': 'SMS',
  'web.step.social': 'Соцсети',
  'web.step.advanced': 'Расширенные',
  'web.step.review': 'Обзор',
  'web.step.deploy': 'Развёртывание',

  // Web UI forms
  'web.form.submit': 'Отправить',
  'web.form.next': 'Далее',
  'web.form.previous': 'Назад',
  'web.form.reset': 'Сбросить',
  'web.form.validation': 'Пожалуйста, исправьте ошибки выше',

  // Web UI progress
  'web.progress.preparing': 'Подготовка к развёртыванию...',
  'web.progress.creatingResources': 'Создание ресурсов Cloudflare...',
  'web.progress.generatingKeys': 'Генерация криптографических ключей...',
  'web.progress.configuringWorkers': 'Настройка workers...',
  'web.progress.deployingWorkers': 'Развёртывание workers...',
  'web.progress.deployingUI': 'Развёртывание UI...',
  'web.progress.runningMigrations': 'Выполнение миграций базы данных...',
  'web.progress.complete': 'Развёртывание завершено!',
  'web.progress.failed': 'Развёртывание не удалось',

  // Web UI Form Labels
  'web.form.envName': 'Название окружения',
  'web.form.envNamePlaceholder': 'например, prod, main, tokyo, acme-dev',
  'web.form.envNameHint': 'Только строчные буквы, цифры и дефисы',
  'web.form.envNameError':
    'Допустимы только строчные буквы, цифры и дефисы (должно начинаться с буквы)',
  'web.form.baseDomain': 'Базовый домен (домен API)',
  'web.form.baseDomainPlaceholder': 'oidc.example.com',
  'web.form.baseDomainHint': 'Собственный домен для Authrim. Оставьте пустым для workers.dev',
  'web.form.nakedDomain': 'Исключить имя тенанта из URL',
  'web.form.nakedDomainHint':
    'Использовать https://example.com вместо https://{tenant}.example.com',
  'web.form.nakedDomainWarning':
    'Поддомены тенантов требуют собственного домена. Workers.dev не поддерживает wildcard-поддомены.',
  'web.form.tenantId': 'ID тенанта по умолчанию',
  'web.form.tenantIdPlaceholder': 'default',
  'web.form.tenantIdHint': 'Идентификатор первого тенанта (строчные, без пробелов)',
  'web.form.tenantIdWorkerNote':
    '(ID тенанта используется внутренне. URL-поддомен требует собственного домена.)',
  'web.form.tenantDisplay': 'Отображаемое имя тенанта',
  'web.form.tenantDisplayPlaceholder': 'Моя компания',
  'web.form.tenantDisplayHint': 'Имя, отображаемое на странице входа и экране согласия',
  'web.form.userIdFormat': 'Формат ID пользователя',
  'web.form.userIdNanoid': 'NanoID (рекомендуется)',
  'web.form.userIdUuid': 'UUID v4',
  'web.form.userIdExample': 'Пример:',
  'web.form.userIdFormatHint': 'Нельзя изменить после создания пользователей.',
  'web.form.loginDomainPlaceholder': 'login.example.com',
  'web.form.adminDomainPlaceholder': 'admin.example.com',

  // Web UI Section Headers
  'web.section.apiDomain': 'Домен API / издателя',
  'web.section.uiDomains': 'Домены UI (необязательно)',
  'web.section.uiDomainsHint':
    'Собственные домены для UI входа/администратора. Каждый можно настроить независимо. Оставьте пустым для использования Cloudflare Workers по умолчанию.',
  'web.section.corsHint':
    'CORS: кросс-доменные запросы от UI входа/администратора к API разрешены автоматически.',
  'web.section.configPreview': 'Предпросмотр конфигурации',
  'web.section.resourceNames': 'Имена ресурсов',

  // Web UI Preview Labels
  'web.preview.components': 'Компоненты:',
  'web.preview.workers': 'Workers:',
  'web.preview.issuerUrl': 'URL издателя:',
  'web.preview.loginUi': 'UI для входа:',
  'web.preview.adminUi': 'Панель администратора:',
  'web.preview.pagesUrl': 'Origin UI для входа:',
  'web.preview.tenantDiscover': 'Выбор тенанта (общий вход):',
  'web.preview.adminAccess': 'Доступ к панели администратора:',
  'web.preview.firstTenant': '{{name}} (основной тенант)',
  'web.preview.otherTenants': 'Другие тенанты',
  'web.preview.allTenantsShared': '(общий для всех тенантов)',
  'web.preview.loginUiOriginNote': '(origin развертывания; вход тенанта использует /login issuer)',
  'web.preview.viaApiProxy': '(проксируется через тот же домен API)',
  'web.preview.conflictWarningTitle': '⚠️ Проблема конфигурации',
  'web.preview.conflictWarningMsg':
    'Пользовательский домен {{conflictUI}} совпадает с доменом API ({{baseDomain}}). Поскольку "Удалить тенант из URL" отключено, API-запросы к {{baseDomain}} (/authorize, /api/auth/*, и т.д.) будут возвращать 404 и процесс входа не будет работать.',
  'web.preview.conflictActionMsg':
    'Решение: включите "Удалить тенант из URL" и установите первого тенанта ({{tenantName}}) как основного. Или измените домен {{conflictUI}} на домен, отличный от API (например, login.{{baseDomain}}).',

  // Web UI Component Labels
  'web.comp.loginUi': 'UI для входа',
  'web.comp.loginUiDesc': 'Страницы входа, регистрации, согласия и управления учётной записью.',
  'web.comp.adminUi': 'Панель администратора',
  'web.comp.adminUiDesc':
    'Панель управления тенантами, клиентами, пользователями и системными настройками.',

  // Web UI Domain Row Labels
  'web.domain.loginUi': 'UI для входа',
  'web.domain.adminUi': 'Панель администратора',

  // Web UI Database Section
  'web.db.introDesc':
    'Authrim использует две отдельные базы данных D1 для изоляции персональных данных от данных приложения.',
  'web.db.regionNote': 'Примечание: регион базы данных нельзя изменить после создания.',
  'web.db.coreNonPii': 'Без PII',
  'web.db.coreDataDesc': 'Хранит неперсональные данные приложения, включая:',
  'web.db.coreData1': 'OAuth-клиенты и их конфигурации',
  'web.db.coreData2': 'Коды авторизации и токены доступа',
  'web.db.coreData3': 'Сессии пользователей и состояние входа',
  'web.db.coreData4': 'Настройки и конфигурации тенантов',
  'web.db.coreData5': 'Журналы аудита и события безопасности',
  'web.db.coreHint':
    'Эта база данных обрабатывает все потоки аутентификации и должна располагаться ближе к основной базе пользователей.',
  'web.db.piiLabel': 'Персональные данные',
  'web.db.piiDataDesc': 'Хранит персональные данные пользователей, включая:',
  'web.db.piiData1': 'Профили пользователей (имя, email, телефон)',
  'web.db.piiData2': 'Учётные данные Passkey/WebAuthn',
  'web.db.piiData3': 'Настройки и предпочтения пользователей',
  'web.db.piiData4': 'Любые пользовательские атрибуты',
  'web.db.piiHint':
    'Эта база данных содержит персональные данные. Рассмотрите размещение в регионе, соответствующем требованиям защиты данных.',
  'web.db.locationHints': 'Подсказки по расположению',
  'web.db.jurisdiction': 'Юрисдикция (соответствие)',
  'web.db.autoNearest': 'Автоматически (ближайший к вам)',
  'web.db.northAmericaWest': 'Северная Америка (Запад)',
  'web.db.northAmericaEast': 'Северная Америка (Восток)',
  'web.db.europeWest': 'Европа (Запад)',
  'web.db.europeEast': 'Европа (Восток)',
  'web.db.asiaPacific': 'Азиатско-Тихоокеанский регион',
  'web.db.oceania': 'Океания',
  'web.db.euJurisdiction': 'Юрисдикция ЕС (соответствие GDPR)',

  // Web UI Email Section
  'web.email.introDesc':
    'Используется для отправки OTP по email и подтверждения адреса. Можете настроить позже.',
  'web.email.configureLater': 'Настроить позже',
  'web.email.configureLaterHint': 'Пропустить сейчас и настроить позже.',
  'web.email.configureCloudflare': 'Настроить Cloudflare Email Service',
  'web.email.configureCloudflareHint':
    'Использует нативный binding Workers Email Service. Требуется тариф Workers Paid и Cloudflare DNS.',
  'web.email.configureResend': 'Настроить Resend',
  'web.email.configureResendHint':
    'Настроить отправку email через Resend (рекомендуется для продакшна).',
  'web.email.cloudflareSetup': 'Cloudflare Email Service',
  'web.email.cloudflareRequirements': 'Требования',
  'web.email.cloudflareRequirementPaid': 'Требуется тариф Workers Paid',
  'web.email.cloudflareRequirementDns': 'Требуется Cloudflare DNS / онбординг домена',
  'web.email.cloudflareRequirementManual':
    'Настройка домена в панели Cloudflare по-прежнему выполняется вручную',
  'web.email.resendSetup': 'Конфигурация Resend',
  'web.email.beforeBegin': 'Перед началом:',
  'web.email.step1': 'Создайте аккаунт Resend на',
  'web.email.step2': 'Добавьте и подтвердите домен на',
  'web.email.step3': 'Создайте API-ключ на',
  'web.email.resendApiKey': 'API-ключ Resend',
  'web.email.resendApiKeyHint': 'Ваш API-ключ начинается с "re_"',
  'web.email.resendApiKeyMissing': 'Введите API-ключ Resend',
  'web.email.resendApiKeyConfirmInvalid':
    'API-ключ не начинается с "re_". Возможно, это недействительный API-ключ Resend. Всё равно продолжить?',
  'web.email.fromEmailAddress': 'Адрес отправителя email',
  'web.email.cloudflareFromHint':
    'Должен относиться к домену, подключённому к Cloudflare Email Service',
  'web.email.fromEmailHint': 'Должен быть с подтверждённого домена в вашем аккаунте Resend',
  'web.email.fromEmailMissing': 'Введите адрес отправителя email',
  'web.email.fromEmailInvalid': 'Введите корректный email-адрес',
  'web.email.fromDisplayName': 'Отображаемое имя отправителя (необязательно)',
  'web.email.fromDisplayHint': 'Отображается как имя отправителя в почтовых клиентах',
  'web.email.saveConfigFailed': 'Не удалось сохранить настройки email',
  'web.email.domainVerificationTitle': 'Требуется верификация домена',
  'web.email.domainVerificationDesc':
    'До верификации домена письма можно отправлять только с onboarding@resend.dev (для тестирования).',
  'web.email.learnMore': 'Подробнее о верификации домена →',

  // Web UI Provision Section
  'web.provision.resourcePreview': 'Имена ресурсов:',
  'web.provision.d1Databases': 'Базы данных D1:',
  'web.provision.kvNamespaces': 'Пространства имён KV:',
  'web.provision.cryptoKeys': 'Криптографические ключи:',
  'web.provision.initializing': 'Инициализация...',
  'web.provision.showLog': 'Показать подробный журнал',
  'web.provision.hideLog': 'Скрыть подробный журнал',
  'web.provision.keysSavedTo': 'Ключи сохранены в:',
  'web.provision.keepSafe': 'Храните этот каталог в безопасности и добавьте в .gitignore',

  // Web UI Deploy Section
  'web.deploy.readyText': 'Готово к развёртыванию workers Authrim на Cloudflare.',

  // Web UI Environment List
  'web.env.detectedDesc': 'Обнаруженные окружения Authrim в вашем аккаунте Cloudflare:',
  'web.env.noEnvsDetected': 'Окружения Authrim не обнаружены в этом аккаунте Cloudflare.',
  'web.env.backToList': '← Назад к списку',
  'web.env.deleteEnv': 'Удалить окружение...',

  // Web UI Environment Detail
  'web.envDetail.title': 'Детали окружения',
  'web.envDetail.initialDeployRecoveryTitle': 'Первичное развертывание не завершено',
  'web.envDetail.initialDeployRecoveryDesc':
    'Предыдущее развертывание остановилось до проверки. При возобновлении созданные ресурсы будут использованы повторно.',
  'web.envDetail.initialDeployRecoveryAction': 'Возобновить первичное развертывание',
  'web.envDetail.initialDeployRecoveryVerified':
    'Состояние Cloudflare проверено. Завершено: {{completed}}. Возобновление начнется с этапа «{{stage}}».',
  'web.envDetail.initialDeployRecoveryStageMigrations': 'проверка миграций базы данных',
  'web.envDetail.initialDeployRecoveryStageControlPlane': 'подготовки первичного развертывания',
  'web.envDetail.initialDeployRecoveryStageWorkers': 'развертывание Workers',
  'web.envDetail.initialDeployRecoveryStageVerification': 'проверка после развертывания',
  'web.envDetail.initialDeployRecoveryResources': 'создание ресурсов',
  'web.envDetail.initialDeployRecoverySchema': 'миграции базы данных',
  'web.envDetail.initialDeployRecoveryWorkers': 'развертывание Workers',
  'web.envDetail.initialDeployRecoveryRecreate':
    'Сохраненная контрольная точка не соответствует состоянию Cloudflare. Возобновление отключено. Удалите это незавершенное окружение и создайте его заново.',
  'web.envDetail.initialDeployRecoveryManifestChanged':
    'После начала первичного развертывания определение draft-миграций изменилось. Сохраненное состояние развертывания может больше не соответствовать базам данных, поэтому возобновление отключено. Удалите это незавершенное окружение и создайте его заново.',
  'web.envDetail.initialDeployRecoveryBlocked':
    'Текущее состояние не удалось проверить, поэтому возобновление отключено. Проверьте подключение к Cloudflare и повторите проверку окружения. Если проверка по-прежнему не проходит, удалите незавершенное окружение и создайте его заново.',
  'web.envDetail.initialDeployRecoveryTokenRequired':
    ' Учетные данные развертывания необходимо обновить; будет запрошен новый одноразовый token Cloudflare.',
  'web.envDetail.adminNotConfigured': 'Администратор не настроен',
  'web.envDetail.adminNotConfiguredDesc':
    'Начальный администратор не настроен для этого окружения.',
  'web.envDetail.startPasskey': 'Начать настройку администратора с Passkey',
  'web.envDetail.setupUrlGenerated': 'URL настройки сгенерирован:',
  'web.envDetail.copyBtn': 'Копировать',
  'web.envDetail.openSetup': 'Открыть настройку',
  'web.envDetail.urlValidFor':
    'Этот URL действителен 1 час. Откройте его в браузере для регистрации первой учётной записи администратора.',
  'web.envDetail.workers': 'Workers',
  'web.envDetail.d1Databases': 'Базы данных D1',
  'web.envDetail.kvNamespaces': 'Пространства имён KV',
  'web.envDetail.queues': 'Очереди',
  'web.envDetail.r2Buckets': 'Бакеты R2',
  'web.envDetail.pagesProjects': 'Legacy Pages Projects',
  'web.envDetail.emailSettings': 'Настройки email',
  'web.envDetail.emailDesc': 'Позже включите Cloudflare Email Service для этой среды.',
  'web.envDetail.emailCurrentProvider': 'Текущий провайдер',
  'web.envDetail.emailCurrentStatus': 'Статус',
  'web.envDetail.emailCurrentFrom': 'Адрес From',
  'web.envDetail.emailConfigured': 'Настроено',
  'web.envDetail.emailNotConfigured': 'Не настроено',
  'web.envDetail.emailProviderNone': 'Не настроено',
  'web.envDetail.emailCloudflareRequirements': 'Требования',
  'web.envDetail.emailCloudflareRequirementPaid': 'Требуется Workers Paid Plan',
  'web.envDetail.emailCloudflareRequirementDns': 'Требуются Cloudflare DNS и подключение домена',
  'web.envDetail.emailCloudflareRequirementManual':
    'Настройка домена в Cloudflare Dashboard пока выполняется вручную',
  'web.envDetail.emailCloudflareFromHint':
    'При использовании Cloudflare Email Service адрес должен принадлежать домену, подключенному в Cloudflare.',
  'web.envDetail.emailCloudflareSettingsLink': 'Настройки Cloudflare Email Routing',
  'web.envDetail.emailResendFromHint':
    'При использовании Resend домен должен быть добавлен и проверен в Resend.',
  'web.envDetail.emailResendDomainsLink': 'Домены Resend',
  'web.envDetail.emailFromAddress': 'Email-адрес From',
  'web.envDetail.emailFromName': 'Отображаемое имя отправителя (необязательно)',
  'web.envDetail.emailEnableCloudflare': 'Включить Cloudflare Email Service',
  'web.envDetail.emailDeploying': 'Применение...',
  'web.envDetail.emailProgress': 'Ход настройки email:',
  'web.envDetail.emailUpdatedSuccess': 'Cloudflare Email включен.',
  'web.envDetail.emailUpdateFailed': 'Не удалось включить Cloudflare Email.',
  'web.envDetail.emailFromMissing': 'Введите email-адрес From.',
  'web.envDetail.emailFromInvalid': 'Введите корректный email-адрес.',
  'web.envDetail.emailSwitchProviderConfirm':
    'В этой среде уже настроен другой email-провайдер. Переключиться на Cloudflare Email Service?',
  'web.envDetail.emailStarting': 'Запуск настройки Cloudflare Email...',
  'web.envDetail.emailSwitchProviderToResendConfirm':
    'В этой среде уже настроен другой email-провайдер. Переключиться на Resend?',
  'web.envDetail.emailResendStarting': 'Сохранение настроек email Resend...',
  'web.envDetail.emailResendUpdatedSuccess': 'Настройки email Resend сохранены.',

  // Web UI Worker Update Section
  'web.envDetail.workerUpdate': 'Обновить все Workers',
  'web.envDetail.workerName': 'Worker',
  'web.envDetail.deployedVersion': 'Развёрнутый',
  'web.envDetail.localVersion': 'Локальный',
  'web.envDetail.updateStatus': 'Статус',
  'web.envDetail.needsUpdate': 'Обновить',
  'web.envDetail.upToDate': 'Актуально',
  'web.envDetail.notDeployed': 'Не развёрнут',
  'web.envDetail.updateOnlyChanged': 'Обновить только изменённые версии',
  'web.envDetail.updateIncludeUiWorkers': 'Обновить Admin UI / Login UI',
  'web.envDetail.updateAllWorkers': 'Обновить все Workers',
  'web.envDetail.refreshVersions': 'Обновить',
  'web.envDetail.updateProgress': 'Прогресс обновления:',
  'web.envDetail.updatesAvailable': '{{count}} обновление(й) доступно',
  'web.envDetail.allUpToDate': 'Всё актуально',

  'web.envDetail.action': 'Действие',

  // Web UI Update Section
  'web.envDetail.uiUpdate': 'Обновить UI (Workers)',
  'web.envDetail.uiUpdateDesc':
    'Обновить Admin UI или Login UI по отдельности. Они развёрнуты на Cloudflare Workers.',
  'web.envDetail.updateNow': 'Обновить',

  // Web UI Delete Section
  'web.delete.title': 'Удаление окружения',
  'web.delete.warning': 'Выбранные ресурсы будут удалены из этого окружения.',
  'web.delete.environment': 'Окружение:',
  'web.delete.selectResources': 'Выберите ресурсы для удаления:',
  'web.delete.workers': 'Workers',
  'web.delete.d1Databases': 'Базы данных D1',
  'web.delete.kvNamespaces': 'Пространства имён KV',
  'web.delete.queues': 'Очереди',
  'web.delete.r2Buckets': 'Бакеты R2',
  'web.delete.pagesProjects': 'Legacy Pages Projects',
  'web.delete.cancelBtn': 'Отмена',
  'web.delete.confirmBtn': 'Удалить выбранное',

  // Web UI Save Modal
  'web.modal.saveQuestion': 'Хотите сохранить конфигурацию в файл перед продолжением?',
  'web.modal.saveReason':
    'Это позволит возобновить настройку позже или использовать те же настройки для другого развёртывания.',
  'web.modal.skipBtn': 'Пропустить',
  'web.modal.saveBtn': 'Сохранить конфигурацию',

  // Web UI Error Messages
  'web.error.wranglerNotInstalled': 'Wrangler не установлен',
  'web.error.pleaseInstall': 'Сначала установите wrangler:',
  'web.error.notLoggedIn': 'Не выполнен вход в Cloudflare',
  'web.error.runCommand': 'Выполните эту команду в терминале:',
  'web.error.thenRefresh': 'Затем обновите эту страницу.',
  'web.error.checkingPrereq': 'Ошибка проверки подготовки:',
  'web.error.invalidJson': 'Некорректный JSON:',
  'web.error.validationFailed': 'Запрос валидации не удался:',

  // Web UI Status Messages
  'web.status.checking': 'Проверка...',
  'web.status.running': 'Выполнение...',
  'web.status.deploying': 'Развёртывание...',
  'web.status.complete': 'Завершено',
  'web.status.error': 'Ошибка',
  'web.status.scanning': 'Сканирование...',
  'web.status.saving': 'Сохранение...',
  'web.status.notDeployed': '(не развёрнуто)',
  'web.status.startingDeploy': 'Начало развёртывания...',
  'web.status.none': 'Нет',
  'web.status.loading': 'Загрузка...',
  'web.status.failedToLoad': 'Не удалось загрузить',
  'web.status.adminNotConfigured': 'Администратор не настроен',
  'web.status.initializing': 'Инициализация...',
  'web.status.found': 'Найдено: {{count}}',
  'web.status.operationInProgress':
    'Уже выполняется другая операция настройки. Дождитесь её завершения и повторите попытку.',
  'web.status.warning': 'Предупреждение:',

  // Web UI Button Labels (dynamic)
  'web.btn.reprovision': 'Пересоздать (удалить и создать)',
  'web.btn.createResources': 'Создать ресурсы',
  'web.btn.saveConfiguration': 'Сохранить конфигурацию',

  // Quick setup specific
  'quickSetup.title': 'Быстрая настройка',

  // Custom setup specific
  'customSetup.title': 'Расширенная настройка',
  'customSetup.cancelled': 'Настройка отменена.',

  // Web UI starting
  'webUi.starting': 'Запуск веб-интерфейса...',
};

export default ru;

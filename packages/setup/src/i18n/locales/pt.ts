/**
 * Portuguese Translations for Authrim Setup Tool
 * Traduções em português
 */

import type { Translations } from '../types.js';

const pt: Translations = {
  // Language selection
  'language.select': 'Select language / 言語を選択 / 选择语言',
  'language.selected': 'Idioma: {{language}}',

  // Banner
  'banner.title': 'Configuração do Authrim',
  'banner.subtitle': 'Provedor OIDC no Cloudflare Workers',
  'banner.exitHint': 'Pressione Ctrl+C a qualquer momento para sair',

  // Mode selection
  'mode.prompt': 'Escolha o método de configuração',
  'mode.quick': 'Web UI (Recomendado)',
  'mode.quickDesc': 'Configuração interativa no seu navegador',
  'mode.advanced': 'Modo CLI',
  'mode.advancedDesc': 'Configuração interativa no terminal',

  // Startup menu
  'startup.description': 'Configure o Provedor OIDC Authrim no Cloudflare Workers.',
  'startup.cancel': 'Cancelar',
  'startup.cancelDesc': 'Sair da configuração',
  'startup.cancelled': 'Configuração cancelada.',
  'startup.resumeLater': 'Para continuar depois:',

  // Main menu
  'menu.prompt': 'O que você gostaria de fazer?',
  'menu.quick': 'Configuração Rápida (5 minutos)',
  'menu.quickDesc': 'Implante o Authrim com configuração mínima',
  'menu.custom': 'Configuração Personalizada',
  'menu.customDesc': 'Configure todas as opções passo a passo',

  // Setup titles
  'quick.title': '⚡ Configuração Rápida',
  'custom.title': '🔧 Configuração Personalizada',
  'menu.manage': 'Ver Ambientes Existentes',
  'menu.manageDesc': 'Ver, inspecionar ou excluir ambientes existentes',
  'menu.load': 'Carregar Configuração Existente',
  'menu.loadDesc': 'Retomar configuração do authrim-config.json',
  'menu.exit': 'Sair',
  'menu.exitDesc': 'Sair da configuração',
  'menu.goodbye': 'Até logo!',

  // Update check
  'update.checking': 'Verificando atualizações...',
  'update.available': 'Atualização disponível: {{localVersion}} → {{remoteVersion}}',
  'update.prompt': 'O que você gostaria de fazer?',
  'update.continue': 'Continuar com a versão atual ({{version}})',
  'update.continueDesc': 'Usar o código fonte existente',
  'update.update': 'Atualizar para a última versão ({{version}})',
  'update.updateDesc': 'Baixar e substituir pela nova versão',
  'update.cancel': 'Cancelar',
  'update.cancelled': 'Cancelado.',
  'update.current': 'Usando código fonte do Authrim (v{{version}})',

  // Source download
  'source.downloading': 'Baixando código fonte...',
  'source.downloaded': 'Código fonte baixado ({{version}})',
  'source.extracting': 'Extraindo código fonte...',
  'source.installing': 'Instalando dependências (isso pode levar alguns minutos)...',
  'source.installed': 'Dependências instaladas',
  'source.installFailed': 'Falha ao instalar dependências',
  'source.installManually': 'Você pode tentar instalar manualmente:',
  'source.notInSourceDir': 'Código fonte do Authrim não encontrado',
  'source.downloadPrompt': 'Baixar código fonte em {{path}}?',
  'source.downloadOption': 'Baixar código fonte',
  'source.downloadOptionDesc': 'Baixar última versão',
  'source.exitOption': 'Sair',
  'source.exitOptionDesc': 'Sair da configuração',
  'source.cloneManually': 'Para clonar manualmente:',
  'source.directoryExists':
    'O diretório {{path}} existe mas não é um código fonte válido do Authrim',
  'source.replaceOption': 'Substituir por novo download',
  'source.replaceOptionDesc': 'Remover {{path}} e baixar a última versão',
  'source.differentOption': 'Usar diretório diferente',
  'source.differentOptionDesc': 'Especificar outro local',
  'source.enterPath': 'Digite o caminho do diretório:',
  'source.updateFailed': 'Falha na atualização',
  'source.downloadFailed': 'Falha no download',
  'source.verificationWarnings': 'Avisos de verificação da estrutura do código:',

  // WSL Environment
  'wsl.detected': 'Ambiente WSL detectado',
  'wsl.explanation': 'Para acessar a Web UI pelo navegador do Windows, o servidor precisa',
  'wsl.explanationCont': 'vincular-se a 0.0.0.0 em vez de localhost.',
  'wsl.securityNote': 'Nota de segurança:',
  'wsl.securityWarning': 'Isso tornará o servidor acessível de outros dispositivos na sua rede.',
  'wsl.trustedNetworkOnly': 'Use apenas em redes confiáveis.',
  'wsl.bindPrompt': 'Vincular a 0.0.0.0 para acesso do Windows? (y/N):',
  'wsl.bindingToAll': 'Vinculando a 0.0.0.0',
  'wsl.usingLocalhost': 'Usando localhost (apenas interno do WSL)',

  // Prerequisites
  'prereq.checking': 'Verificando status do wrangler...',
  'prereq.wranglerNotInstalled': 'wrangler não está instalado',
  'prereq.wranglerInstallHint': 'Execute o seguinte comando para instalar:',
  'prereq.notLoggedIn': 'Não conectado ao Cloudflare',
  'prereq.loginHint': 'Execute o seguinte comando para autenticar:',
  'prereq.loggedInAs': 'Conectado ao Cloudflare ({{email}})',
  'prereq.accountId': 'ID da Conta: {{accountId}}',

  // Environment
  'env.prompt': 'Digite o nome do ambiente',
  'env.prod': 'Produção',
  'env.prodDesc': 'Para uso em produção',
  'env.staging': 'Staging',
  'env.stagingDesc': 'Para testes antes da produção',
  'env.dev': 'Desenvolvimento',
  'env.devDesc': 'Para desenvolvimento local',
  'env.custom': 'Personalizado',
  'env.customDesc': 'Digite um nome de ambiente personalizado',
  'env.customPrompt': 'Digite nome de ambiente personalizado',
  'env.customValidation':
    'Apenas letras minúsculas, números e hífens são permitidos (ex: prod, staging, dev)',
  'env.detected': 'Ambientes Detectados:',
  'env.selectExisting': 'Selecionar ambiente existente',
  'env.createNew': 'Criar novo ambiente',
  'env.createNewDesc': 'Configurar um novo ambiente',
  'env.checking': 'Verificando ambientes existentes...',
  'env.alreadyExists': 'O ambiente "{{env}}" já existe',
  'env.existingResources': 'Recursos existentes:',
  'env.workers': 'Workers: {{count}}',
  'env.d1Databases': 'Bancos de dados D1: {{count}}',
  'env.kvNamespaces': 'Namespaces KV: {{count}}',
  'env.chooseAnother':
    'Por favor, escolha outro nome ou use "npx @authrim/setup manage" para excluí-lo primeiro.',
  'env.available': 'Nome do ambiente disponível',
  'env.checkFailed': 'Não foi possível verificar ambientes existentes (continuando mesmo assim)',
  'env.noEnvFound': 'Nenhum ambiente Authrim encontrado.',

  // Region
  'region.prompt': 'Selecione a região',
  'region.auto': 'Automático (mais próximo)',
  'region.autoDesc': 'Deixar o Cloudflare escolher a região mais próxima',
  'region.wnam': 'América do Norte (Oeste)',
  'region.wnamDesc': 'Oeste da América do Norte',
  'region.enam': 'América do Norte (Leste)',
  'region.enamDesc': 'Leste da América do Norte',
  'region.weur': 'Europa (Oeste)',
  'region.weurDesc': 'Europa Ocidental',
  'region.eeur': 'Europa (Leste)',
  'region.eeurDesc': 'Europa Oriental',
  'region.apac': 'Ásia Pacífico',
  'region.apacDesc': 'Região Ásia Pacífico',
  'region.oceania': 'Oceania',
  'region.oceaniaDesc': 'Austrália e Ilhas do Pacífico',
  'region.euJurisdiction': 'Jurisdição UE (conformidade GDPR)',
  'region.euJurisdictionDesc': 'Dados armazenados na UE',

  // UI deployment
  'ui.prompt': 'Método de implantação da UI',
  'ui.pagesOption': 'Cloudflare Pages',
  'ui.pagesDesc': 'Implantar no Cloudflare Pages (recomendado)',
  'ui.customOption': 'Domínio personalizado',
  'ui.customDesc': 'Usar sua própria hospedagem',
  'ui.skipOption': 'Pular',
  'ui.skipDesc': 'Pular implantação da UI',
  'ui.customPrompt': 'Digite URL personalizada da UI',

  // Domain
  'domain.prompt': 'Configurar domínio personalizado?',
  'domain.workersDevOption': 'Usar domínio workers.dev',
  'domain.workersDevDesc': 'Usar domínio padrão do Cloudflare',
  'domain.customOption': 'Configurar domínio personalizado',
  'domain.customDesc': 'Usar seu próprio domínio',
  'domain.customPrompt': 'Digite domínio personalizado (ex: auth.exemplo.com)',
  'domain.customValidation': 'Por favor, digite um domínio válido (ex: auth.exemplo.com)',
  'domain.issuerUrl': 'URL do Emissor: {{url}}',
  'domain.apiDomain': 'Domínio API / Emissor (ex: auth.exemplo.com)',
  'domain.loginUiDomain': 'Domínio UI de Login (Enter para pular)',
  'domain.adminUiDomain': 'Domínio UI de Admin (Enter para pular)',
  'domain.enterDomains':
    'Digite domínios personalizados (deixe vazio para usar padrões do Cloudflare)',
  'domain.singleTenantNote': 'No modo single-tenant, URL do Emissor = domínio API',
  'domain.usingWorkersDev': '(usando domínio workers.dev do Cloudflare)',

  // Database
  'db.title': 'Configuração do Banco de Dados',
  'db.regionWarning': 'A região do banco de dados não pode ser alterada após a criação.',
  'db.coreDescription': 'BD Core: Armazena clientes OAuth, tokens, sessões, logs de auditoria',
  'db.coreRegion': 'Região do Banco de Dados Core',
  'db.piiDescription': 'BD PII: Armazena perfis de usuário, credenciais, dados pessoais',
  'db.piiNote': 'Considere seus requisitos de proteção de dados.',
  'db.piiRegion': 'Região do Banco de Dados PII',
  'db.creating': 'Criando banco de dados...',
  'db.created': 'Banco de dados criado: {{name}}',
  'db.existing': 'Usando banco de dados existente: {{name}}',
  'db.error': 'Falha ao criar banco de dados',
  'db.locationHints': 'Dicas de Localização',
  'db.jurisdictionCompliance': 'Jurisdição (Conformidade)',

  // KV
  'kv.creating': 'Criando namespace KV...',
  'kv.created': 'Namespace KV criado: {{name}}',
  'kv.existing': 'Usando namespace KV existente: {{name}}',
  'kv.error': 'Falha ao criar namespace KV',

  // Queue
  'queue.creating': 'Criando fila...',
  'queue.created': 'Fila criada: {{name}}',
  'queue.existing': 'Usando fila existente: {{name}}',
  'queue.error': 'Falha ao criar fila',

  // R2
  'r2.creating': 'Criando bucket R2...',
  'r2.created': 'Bucket R2 criado: {{name}}',
  'r2.existing': 'Usando bucket R2 existente: {{name}}',
  'r2.error': 'Falha ao criar bucket R2',

  // Keys
  'keys.generating': 'Gerando chaves criptográficas...',
  'keys.generated': 'Chaves geradas ({{path}})',
  'keys.existing': 'Chaves já existem para o ambiente "{{env}}"',
  'keys.existingWarning': 'Chaves existentes serão sobrescritas.',
  'keys.error': 'Falha ao gerar chaves',
  'keys.regeneratePrompt': 'Regenerar chaves?',
  'keys.regenerateWarning': 'Isso invalidará todos os tokens existentes!',

  // Config
  'config.saving': 'Salvando configuração...',
  'config.saved': 'Configuração salva em {{path}}',
  'config.error': 'Falha ao salvar configuração',
  'config.path': 'Caminho da configuração',
  'config.summary': 'Resumo da Configuração',
  'config.infrastructure': 'Infraestrutura:',
  'config.environment': 'Ambiente:',
  'config.workerPrefix': 'Prefixo do Worker:',
  'config.profile': 'Perfil:',
  'config.tenantIssuer': 'Tenant e Emissor:',
  'config.mode': 'Modo:',
  'config.multiTenant': 'Multi-tenant',
  'config.singleTenant': 'Single-tenant',
  'config.baseDomain': 'Domínio Base:',
  'config.issuerFormat': 'Formato do Emissor:',
  'config.issuerUrl': 'URL do Emissor:',
  'config.defaultTenant': 'Tenant Padrão:',
  'config.displayName': 'Nome de Exibição:',
  'config.publicUrls': 'URLs Públicas:',
  'config.apiRouter': 'Roteador API:',
  'config.loginUi': 'UI de Login:',
  'config.adminUi': 'UI de Admin:',
  'config.components': 'Componentes:',
  'config.featureFlags': 'Flags de Recursos:',
  'config.emailSettings': 'Email:',
  'config.oidcSettings': 'Configurações OIDC:',
  'config.accessTtl': 'TTL do Access Token:',
  'config.refreshTtl': 'TTL do Refresh Token:',
  'config.authCodeTtl': 'TTL do Auth Code:',
  'config.pkceRequired': 'PKCE Obrigatório:',
  'config.sharding': 'Sharding:',
  'config.authCodeShards': 'Auth Code:',
  'config.refreshTokenShards': 'Refresh Token:',
  'config.database': 'Banco de Dados:',
  'config.coreDb': 'BD Core:',
  'config.piiDb': 'BD PII:',
  'config.enabled': 'Habilitado',
  'config.disabled': 'Desabilitado',
  'config.standard': '(padrão)',
  'config.notConfigured': 'Não configurado (configurar depois)',
  'config.yes': 'Sim',
  'config.no': 'Não',
  'config.shards': 'shards',
  'config.sec': 'seg',
  'config.automatic': 'Automático',

  // Deploy
  'deploy.prompt': 'Iniciar configuração com esta configuração?',
  'deploy.starting': 'Executando Configuração...',
  'deploy.building': 'Compilando pacotes...',
  'deploy.deploying': 'Implantando no Cloudflare...',
  'deploy.success': 'Configuração concluída!',
  'deploy.error': 'Falha na implantação',
  'deploy.skipped': 'Implantação pulada',
  'deploy.component': 'Implantando {{component}}...',
  'deploy.uploadingSecrets': 'Enviando segredos...',
  'deploy.secretsUploaded': 'Segredos enviados',
  'deploy.runningMigrations': 'Executando migrações do banco de dados...',
  'deploy.migrationsComplete': 'Migrações concluídas',
  'deploy.deployingWorker': 'Implantando worker {{name}}...',
  'deploy.workerDeployed': 'Worker implantado: {{name}}',
  'deploy.deployingUI': 'Implantando UI...',
  'deploy.uiDeployed': 'UI implantada',
  'deploy.creatingResources': 'Criando recursos do Cloudflare...',
  'deploy.resourcesFailed': 'Falha ao criar recursos',
  'deploy.continueWithout':
    'Continuar sem provisionamento? (você precisará criar recursos manualmente)',
  'deploy.emailSecretsSaved': 'Segredos de email salvos em {{path}}',
  'deploy.confirmStart': 'Iniciar implantação?',
  'deploy.confirmDryRun': 'Executar implantação em modo de teste?',
  'deploy.cancelled': 'Implantação cancelada.',
  'deploy.wranglerChanged': 'Como você quer lidar com essas alterações?',
  'deploy.wranglerKeep': '📝 Manter alterações manuais (implantar como está)',
  'deploy.wranglerBackup': '💾 Fazer backup e sobrescrever com master',
  'deploy.wranglerOverwrite': '⚠️ Sobrescrever com master (perder alterações)',

  // Email provider
  'email.title': 'Provedor de Email',
  'email.description': 'Configure o envio de email para links mágicos e códigos de verificação.',
  'email.prompt': 'Configurar provedor de email agora?',
  'email.resendOption': 'Resend',
  'email.resendDesc': 'API de email moderna para desenvolvedores',
  'email.sesOption': 'AWS SES',
  'email.sesDesc': 'Amazon Simple Email Service',
  'email.smtpOption': 'SMTP',
  'email.smtpDesc': 'Servidor SMTP genérico',
  'email.skipOption': 'Nenhum (configurar depois)',
  'email.skipDesc': 'Pular configuração de email',
  'email.apiKeyPrompt': 'Chave API do Resend',
  'email.apiKeyHint': 'Obtenha sua chave API em: https://resend.com/api-keys',
  'email.domainHint': 'Configure o domínio em: https://resend.com/domains',
  'email.apiKeyRequired': 'Chave API é obrigatória',
  'email.apiKeyWarning': 'Aviso: Chaves API do Resend geralmente começam com "re_"',
  'email.fromAddressPrompt': 'Endereço de email do remetente',
  'email.fromAddressValidation': 'Por favor, digite um endereço de email válido',
  'email.fromNamePrompt': 'Nome de exibição do remetente (opcional)',
  'email.domainVerificationRequired':
    'Verificação de domínio necessária para enviar do seu próprio domínio.',
  'email.seeDocumentation': 'Veja: https://resend.com/docs/dashboard/domains/introduction',
  'email.provider': 'Provedor:',
  'email.fromAddress': 'Endereço do Remetente:',
  'email.fromName': 'Nome do Remetente:',

  // SMS provider
  'sms.prompt': 'Configurar provedor de SMS?',
  'sms.twilioOption': 'Twilio',
  'sms.twilioDesc': 'SMS via Twilio',
  'sms.skipOption': 'Nenhum (configurar depois)',
  'sms.skipDesc': 'Pular configuração de SMS',
  'sms.accountSidPrompt': 'Account SID do Twilio',
  'sms.authTokenPrompt': 'Auth Token do Twilio',
  'sms.fromNumberPrompt': 'Número de telefone do remetente',

  // Social providers
  'social.prompt': 'Configurar provedores de login social?',
  'social.googleOption': 'Google',
  'social.googleDesc': 'Entrar com Google',
  'social.githubOption': 'GitHub',
  'social.githubDesc': 'Entrar com GitHub',
  'social.appleOption': 'Apple',
  'social.appleDesc': 'Entrar com Apple',
  'social.microsoftOption': 'Microsoft',
  'social.microsoftDesc': 'Entrar com Microsoft',
  'social.skipOption': 'Nenhum (configurar depois)',
  'social.skipDesc': 'Pular configuração de login social',
  'social.clientIdPrompt': 'Client ID',
  'social.clientSecretPrompt': 'Client Secret',

  // Cloudflare API Token
  'cf.apiTokenPrompt': 'Digite o Token API do Cloudflare',
  'cf.apiTokenValidation': 'Por favor, digite um Token API válido',

  // OIDC Profile
  'profile.prompt': 'Selecione o perfil OIDC',
  'profile.basicOp': 'OP Básico (Provedor OIDC Padrão)',
  'profile.basicOpDesc': 'Recursos OIDC padrão',
  'profile.fapiRw': 'FAPI Read-Write (Nível Financeiro)',
  'profile.fapiRwDesc': 'Compatível com perfil de segurança FAPI 1.0 Read-Write',
  'profile.fapi2Security': 'Perfil de Segurança FAPI 2.0',
  'profile.fapi2SecurityDesc': 'Compatível com perfil de segurança FAPI 2.0 (máxima segurança)',

  // Tenant configuration
  'tenant.title': 'Modo de Tenant',
  'tenant.multiTenantPrompt':
    'Habilitar modo multi-tenant? (isolamento de tenant baseado em subdomínio)',
  'tenant.multiTenantTitle': 'Configuração de URL Multi-tenant',
  'tenant.multiTenantNote1': 'No modo multi-tenant:',
  'tenant.multiTenantNote2': 'Cada tenant tem um subdomínio: https://{tenant}.{domínio-base}',
  'tenant.multiTenantNote3': 'O domínio base aponta para o Worker roteador',
  'tenant.multiTenantNote4': 'A URL do emissor é construída dinamicamente do header Host',
  'tenant.baseDomainPrompt': 'Domínio base (ex: authrim.com)',
  'tenant.baseDomainRequired': 'Domínio base é obrigatório para modo multi-tenant',
  'tenant.baseDomainValidation': 'Por favor, digite um domínio válido (ex: authrim.com)',
  'tenant.issuerFormat': 'Formato da URL do emissor: https://{tenant}.{{domain}}',
  'tenant.issuerExample': 'Exemplo: https://acme.{{domain}}',
  'tenant.defaultTenantPrompt': 'Nome do tenant padrão (identificador)',
  'tenant.defaultTenantValidation': 'Apenas letras minúsculas, números e hífens são permitidos',
  'tenant.displayNamePrompt': 'Nome de exibição do tenant padrão',
  'tenant.singleTenantTitle': 'Configuração de URL Single-tenant',
  'tenant.singleTenantNote1': 'No modo single-tenant:',
  'tenant.singleTenantNote2':
    'URL do emissor = domínio personalizado da API (ou workers.dev como fallback)',
  'tenant.singleTenantNote3': 'Todos os clientes compartilham o mesmo emissor',
  'tenant.organizationName': 'Nome da organização (nome de exibição)',
  'tenant.uiDomainTitle': 'Configuração de Domínio de UI',
  'tenant.customUiDomainPrompt': 'Configurar domínios personalizados de UI?',
  'tenant.loginUiDomain': 'Domínio de UI de login (ex: login.exemplo.com)',
  'tenant.adminUiDomain': 'Domínio de UI de admin (ex: admin.exemplo.com)',

  // Optional components
  'components.title': 'Componentes Opcionais',
  'components.note': 'Nota: Login Social e Motor de Políticas são componentes padrão',
  'components.samlPrompt': 'Habilitar suporte SAML?',
  'components.vcPrompt': 'Habilitar Credenciais Verificáveis?',
  'components.saml': 'SAML:',
  'components.vc': 'VC:',
  'components.socialLogin': 'Login Social:',
  'components.policyEngine': 'Motor de Políticas:',

  // Feature flags
  'features.title': 'Flags de Recursos',
  'features.queuePrompt': 'Habilitar Cloudflare Queues? (para logs de auditoria)',
  'features.r2Prompt': 'Habilitar Cloudflare R2? (para avatares)',
  'features.queue': 'Fila:',
  'features.r2': 'R2:',

  // OIDC settings
  'oidc.configurePrompt': 'Configurar ajustes OIDC? (TTL de tokens, etc.)',
  'oidc.title': 'Configurações OIDC',
  'oidc.accessTokenTtl': 'TTL do Access Token (seg)',
  'oidc.refreshTokenTtl': 'TTL do Refresh Token (seg)',
  'oidc.authCodeTtl': 'TTL do Authorization Code (seg)',
  'oidc.pkceRequired': 'Exigir PKCE?',
  'oidc.positiveInteger': 'Por favor, digite um número inteiro positivo',

  // Sharding settings
  'sharding.configurePrompt': 'Configurar sharding? (para ambientes de alta carga)',
  'sharding.title': 'Configurações de Sharding',
  'sharding.note': 'Nota: Recomenda-se potência de 2 para número de shards (8, 16, 32, 64, 128)',
  'sharding.authCodeShards': 'Número de shards do Auth Code',
  'sharding.refreshTokenShards': 'Número de shards do Refresh Token',

  // Infrastructure
  'infra.title': 'Infraestrutura (Gerada Automaticamente)',
  'infra.workersNote': 'Os seguintes Workers serão implantados:',
  'infra.router': 'Roteador:',
  'infra.auth': 'Auth:',
  'infra.token': 'Token:',
  'infra.management': 'Gerenciamento:',
  'infra.otherWorkers': '... e outros workers de suporte',
  'infra.defaultEndpoints': 'Endpoints padrão (sem domínio personalizado):',
  'infra.api': 'API:',
  'infra.ui': 'UI:',
  'infra.workersToDeploy': 'Workers a implantar: {{workers}}',
  'infra.defaultApi': 'API padrão: {{url}}',

  // Completion
  'complete.title': 'Configuração Concluída!',
  'complete.summary': 'Seu Provedor OIDC Authrim foi implantado.',
  'complete.issuerUrl': 'URL do Emissor: {{url}}',
  'complete.adminUrl': 'Painel de Admin: {{url}}',
  'complete.uiUrl': 'UI de Login: {{url}}',
  'complete.nextSteps': 'Próximos Passos:',
  'complete.nextStep1': '1. Verifique a implantação visitando a URL do emissor',
  'complete.nextStep2': '2. Configure clientes OAuth no Painel de Admin',
  'complete.nextStep3': '3. Configure domínios personalizados se necessário',
  'complete.warning': 'Lembre-se de manter suas chaves seguras e com backup!',
  'complete.success': 'Configuração concluída com sucesso!',
  'complete.urls': 'URLs:',
  'complete.configLocation': 'Configuração:',
  'complete.keysLocation': 'Chaves:',

  // Resource provisioning
  'resource.provisioning': 'Provisionando {{resource}}...',
  'resource.provisioned': '{{resource}} provisionado com sucesso',
  'resource.failed': 'Falha ao provisionar {{resource}}',
  'resource.skipped': '{{resource}} pulado',

  // Manage environments
  'manage.title': 'Ambientes Existentes',
  'manage.loading': 'Carregando...',
  'manage.detecting': 'Detectando ambientes...',
  'manage.detected': 'Ambientes Detectados:',
  'manage.noEnvs': 'Nenhum ambiente Authrim encontrado.',
  'manage.selectAction': 'Selecione uma ação',
  'manage.viewDetails': 'Ver Detalhes',
  'manage.viewDetailsDesc': 'Mostrar informações detalhadas dos recursos',
  'manage.deleteEnv': 'Excluir Ambiente',
  'manage.deleteEnvDesc': 'Remover ambiente e recursos',
  'manage.backToMenu': 'Voltar ao Menu Principal',
  'manage.backToMenuDesc': 'Retornar ao menu principal',
  'manage.selectEnv': 'Selecione o ambiente',
  'manage.back': 'Voltar',
  'manage.continueManaging': 'Continuar gerenciando ambientes?',

  // Load config
  'loadConfig.title': 'Carregar Configuração Existente',
  'loadConfig.found': 'Encontrada(s) {{count}} configuração(ões):',
  'loadConfig.new': '(novo)',
  'loadConfig.legacy': '(legado)',
  'loadConfig.legacyDetected': 'Estrutura Legada Detectada',
  'loadConfig.legacyFiles': 'Arquivos legados:',
  'loadConfig.newBenefits': 'Benefícios da nova estrutura:',
  'loadConfig.benefit1': 'Portabilidade do ambiente (zip .authrim/prod/)',
  'loadConfig.benefit2': 'Rastreamento de versão por ambiente',
  'loadConfig.benefit3': 'Estrutura de projeto mais limpa',
  'loadConfig.migratePrompt': 'Você gostaria de migrar para a nova estrutura?',
  'loadConfig.migrateOption': 'Migrar para nova estrutura (.authrim/{env}/)',
  'loadConfig.continueOption': 'Continuar com estrutura legada',
  'loadConfig.migrationComplete': 'Migração concluída com sucesso!',
  'loadConfig.validationPassed': 'Validação aprovada',
  'loadConfig.validationIssues': 'Problemas de validação:',
  'loadConfig.newLocation': 'Nova localização da configuração:',
  'loadConfig.migrationFailed': 'Migração falhou:',
  'loadConfig.continuingLegacy': 'Continuando com estrutura legada...',
  'loadConfig.loadThis': 'Carregar esta configuração',
  'loadConfig.specifyOther': 'Especificar arquivo diferente',
  'loadConfig.noConfigFound': 'Nenhuma configuração encontrada no diretório atual.',
  'loadConfig.tip': 'Dica: Você pode especificar um arquivo de configuração com:',
  'loadConfig.specifyPath': 'Especificar caminho do arquivo',
  'loadConfig.enterPath': 'Digite o caminho do arquivo de configuração',
  'loadConfig.pathRequired': 'Por favor, digite um caminho',
  'loadConfig.fileNotFound': 'Arquivo não encontrado: {{path}}',
  'loadConfig.selectConfig': 'Selecione a configuração para carregar',

  // Common
  'common.yes': 'Sim',
  'common.no': 'Não',
  'common.continue': 'Continuar',
  'common.cancel': 'Cancelar',
  'common.skip': 'Pular',
  'common.back': 'Voltar',
  'common.confirm': 'Confirmar',
  'common.error': 'Erro',
  'common.warning': 'Aviso',
  'common.success': 'Sucesso',
  'common.info': 'Info',
  'common.loading': 'Carregando...',
  'common.saving': 'Salvando...',
  'common.processing': 'Processando...',
  'common.done': 'Concluído',
  'common.required': 'Obrigatório',
  'common.optional': 'Opcional',

  // Errors
  'error.generic': 'Ocorreu um erro',
  'error.network': 'Erro de rede',
  'error.timeout': 'Tempo esgotado',
  'error.invalidInput': 'Entrada inválida',
  'error.fileNotFound': 'Arquivo não encontrado',
  'error.permissionDenied': 'Permissão negada',
  'error.configNotFound': 'Configuração não encontrada',
  'error.configInvalid': 'Configuração inválida',
  'error.deployFailed': 'Implantação falhou',
  'error.resourceCreationFailed': 'Falha ao criar recurso',

  // Validation
  'validation.required': 'Este campo é obrigatório',
  'validation.invalidFormat': 'Formato inválido',
  'validation.tooShort': 'Muito curto',
  'validation.tooLong': 'Muito longo',
  'validation.invalidDomain': 'Domínio inválido',
  'validation.invalidEmail': 'Endereço de email inválido',
  'validation.invalidUrl': 'URL inválida',

  // Delete command
  'delete.title': 'Excluir Ambiente',
  'delete.prompt': 'Selecione recursos para excluir',
  'delete.confirm': 'Tem certeza de que deseja excluir "{{env}}"?',
  'delete.confirmPermanent':
    '⚠️ Isso excluirá permanentemente todos os recursos de "{{env}}". Continuar?',
  'delete.confirmWarning': 'Esta ação não pode ser desfeita!',
  'delete.deleting': 'Excluindo {{resource}}...',
  'delete.deleted': '{{resource}} excluído',
  'delete.error': 'Falha ao excluir {{resource}}',
  'delete.cancelled': 'Exclusão cancelada',
  'delete.noEnvFound': 'Nenhum ambiente encontrado',
  'delete.selectEnv': 'Selecione o ambiente para excluir',
  'delete.workers': 'Workers',
  'delete.databases': 'Bancos de dados D1',
  'delete.kvNamespaces': 'Namespaces KV',
  'delete.queues': 'Filas',
  'delete.r2Buckets': 'Buckets R2',

  // Info command
  'info.title': 'Informações do Ambiente',
  'info.loading': 'Carregando informações do ambiente...',
  'info.noResources': 'Nenhum recurso encontrado',
  'info.environment': 'Ambiente',
  'info.issuer': 'Emissor',
  'info.workers': 'Workers',
  'info.databases': 'Bancos de dados',
  'info.kvNamespaces': 'Namespaces KV',
  'info.queues': 'Filas',
  'info.r2Buckets': 'Buckets R2',
  'info.status': 'Status',
  'info.deployed': 'Implantado',
  'info.notDeployed': 'Não implantado',

  // Config command
  'configCmd.title': 'Configuração',
  'configCmd.showing': 'Mostrando configuração',
  'configCmd.validating': 'Validando configuração...',
  'configCmd.valid': 'A configuração é válida',
  'configCmd.invalid': 'A configuração é inválida',
  'configCmd.notFound': 'Configuração não encontrada',
  'configCmd.error': 'Erro ao ler configuração',

  // Migrate command
  'migrate.title': 'Migrar para Nova Estrutura',
  'migrate.checking': 'Verificando status da migração...',
  'migrate.noLegacyFound': 'Nenhuma estrutura legada encontrada',
  'migrate.legacyFound': 'Estrutura legada detectada',
  'migrate.prompt': 'Migrar para nova estrutura?',
  'migrate.migrating': 'Migrando...',
  'migrate.success': 'Migração bem-sucedida',
  'migrate.cancelled': 'Migração cancelada.',
  'migrate.error': 'Migração falhou',
  'migrate.dryRun': 'Execução de teste - nenhuma alteração feita',
  'migrate.backup': 'Criando backup...',
  'migrate.backupCreated': 'Backup criado em {{path}}',

  // Security configuration
  'security.title': 'Configurações de Segurança',
  'security.description':
    'Configure as configurações de proteção de dados. Estas não podem ser alteradas após o armazenamento inicial dos dados.',
  'security.piiEncryption': 'Criptografia de PII',
  'security.piiEncryptionEnabled': 'Criptografia a nível de aplicação (Recomendado)',
  'security.piiEncryptionEnabledDesc':
    'Criptografar dados PII a nível de aplicação (recomendado para D1)',
  'security.piiEncryptionDisabled': 'Apenas criptografia a nível de banco de dados',
  'security.piiEncryptionDisabledDesc': 'Usar criptografia do BD gerenciado (para Aurora, etc.)',
  'security.domainHash': 'Hash de Domínio de Email',
  'security.domainHashEnabled': 'Ativar hash de domínio (Recomendado)',
  'security.domainHashEnabledDesc':
    'Aplicar hash em domínios de email para privacidade em análises',
  'security.domainHashDisabled': 'Armazenar domínios em texto simples',
  'security.domainHashDisabledDesc': 'Armazenar domínios de email sem hash',
  'security.warning':
    '⚠️ Estas configurações não podem ser alteradas após o armazenamento dos dados',

  // Manage command
  'manage.commandTitle': 'Gerenciador de Ambientes Authrim',

  // Web UI specific
  'web.title': 'Configuração do Authrim',
  'web.subtitle': 'Provedor OIDC no Cloudflare Workers',
  'web.loading': 'Carregando...',
  'web.error': 'Ocorreu um erro',
  'web.retry': 'Tentar novamente',
  'web.languageSelector': 'Idioma',
  'web.darkMode': 'Escuro',
  'web.lightMode': 'Claro',
  'web.systemMode': 'Sistema',

  // Web UI Prerequisites
  'web.prereq.title': 'Pré-requisitos',
  'web.prereq.checking': 'Verificando...',
  'web.prereq.checkingRequirements': 'Verificando requisitos do sistema...',
  'web.prereq.ready': 'Pronto',
  'web.prereq.wranglerInstalled': 'Wrangler instalado',
  'web.prereq.loggedInAs': 'Conectado como {{email}}',

  // Web UI Top Menu
  'web.menu.title': 'Começar',
  'web.menu.subtitle': 'Escolha uma opção para continuar:',
  'web.menu.newSetup': 'Nova Configuração',
  'web.menu.newSetupDesc': 'Criar uma nova implantação do Authrim do zero',
  'web.menu.loadConfig': 'Carregar Config',
  'web.menu.loadConfigDesc': 'Retomar ou reimplantar usando configuração existente',
  'web.menu.manageEnv': 'Gerenciar Ambientes',
  'web.menu.manageEnvDesc': 'Ver, inspecionar ou excluir ambientes existentes',

  // Web UI Setup Mode
  'web.mode.title': 'Modo de Configuração',
  'web.mode.subtitle': 'Escolha como você quer configurar o Authrim:',
  'web.mode.quick': 'Configuração Rápida',
  'web.mode.quickDesc': 'Comece em ~5 minutos',
  'web.mode.quickEnv': 'Seleção de ambiente',
  'web.mode.quickDomain': 'Domínio personalizado opcional',
  'web.mode.quickDefault': 'Componentes padrão',
  'web.mode.recommended': 'Recomendado',
  'web.mode.custom': 'Configuração Personalizada',
  'web.mode.customDesc': 'Controle total sobre a configuração',
  'web.mode.customComp': 'Seleção de componentes',
  'web.mode.customUrl': 'Configuração de URL',
  'web.mode.customAdvanced': 'Configurações avançadas',

  // Web UI Load Config
  'web.loadConfig.title': 'Carregar Configuração',
  'web.loadConfig.subtitle': 'Selecione seu arquivo authrim-config.json:',
  'web.loadConfig.chooseFile': 'Escolher Arquivo',
  'web.loadConfig.preview': 'Prévia da Configuração',
  'web.loadConfig.validationFailed': 'Validação da Configuração Falhou',
  'web.loadConfig.valid': 'A configuração é válida',
  'web.loadConfig.loadContinue': 'Carregar e Continuar',

  // Web UI Configuration
  'web.config.title': 'Configuração',
  'web.config.components': 'Componentes',
  'web.config.apiRequired': 'API (obrigatório)',
  'web.config.apiDesc':
    'Endpoints do Provedor OIDC: authorize, token, userinfo, discovery, APIs de gerenciamento.',
  'web.config.saml': 'SAML IdP',
  'web.config.deviceFlow': 'Device Flow / CIBA',
  'web.config.vcSdJwt': 'VC SD-JWT',
  'web.config.loginUi': 'UI de Login',
  'web.config.loginUiDesc': 'UI de autenticação pré-construída implantada no Cloudflare Pages.',
  'web.config.adminUi': 'UI de Admin',
  'web.config.adminUiDesc': 'Painel de gerenciamento para usuários, clientes e configurações.',

  // Web UI URLs
  'web.url.title': 'Configuração de URL',
  'web.url.apiDomain': 'Domínio API',
  'web.url.apiDomainHint': 'Deixe vazio para usar subdomínio workers.dev',
  'web.url.loginDomain': 'Domínio UI de Login',
  'web.url.loginDomainHint': 'Deixe vazio para usar subdomínio pages.dev',
  'web.url.adminDomain': 'Domínio UI de Admin',
  'web.url.adminDomainHint': 'Deixe vazio para usar subdomínio pages.dev',

  // Web UI Database
  'web.db.title': 'Configuração do Banco de Dados',
  'web.db.coreTitle': 'Banco de Dados Core',
  'web.db.coreSubtitle': '(Não-PII)',
  'web.db.coreDesc':
    'Armazena clientes, códigos de autorização, tokens, sessões. Pode ser replicado globalmente.',
  'web.db.piiTitle': 'Banco de Dados PII',
  'web.db.piiSubtitle': '(Informações Pessoais Identificáveis)',
  'web.db.piiDesc':
    'Armazena perfis de usuário, credenciais, PII. Deve estar em uma única jurisdição para conformidade.',
  'web.db.name': 'Nome',
  'web.db.region': 'Região',
  'web.db.regionAuto': 'Automático (mais próximo)',

  // Web UI Email
  'web.email.title': 'Provedor de Email',
  'web.email.subtitle':
    'Selecione serviço de email para redefinição de senha e emails de verificação:',
  'web.email.none': 'Nenhum',
  'web.email.noneDesc': 'Recursos de email desabilitados',
  'web.email.resend': 'Resend',
  'web.email.resendDesc': 'API de email para desenvolvedores',
  'web.email.sendgrid': 'SendGrid',
  'web.email.sendgridDesc': 'Entrega de email escalável',
  'web.email.ses': 'Amazon SES',
  'web.email.sesDesc': 'AWS Simple Email Service',
  'web.email.resendConfig': 'Configuração do Resend',
  'web.email.apiKey': 'Chave API',
  'web.email.apiKeyPlaceholder': 're_xxxxxxxx',
  'web.email.fromAddress': 'Endereço do Remetente',
  'web.email.fromAddressPlaceholder': 'noreply@seudominio.com',

  // Web UI Provision
  'web.provision.title': 'Criar Recursos do Cloudflare',
  'web.provision.ready': 'Pronto para provisionar',
  'web.provision.desc': 'Os seguintes recursos serão criados na sua conta Cloudflare:',
  'web.provision.createResources': 'Criar Recursos',
  'web.provision.saveConfig': 'Salvar Config',
  'web.provision.continueDeploy': 'Continuar para Implantar →',

  // Web UI Deploy
  'web.deploy.title': 'Implantar',
  'web.deploy.desc': 'Implantar workers e UI no Cloudflare:',
  'web.deploy.startDeploy': 'Iniciar Implantação',
  'web.deploy.deploying': 'Implantando...',

  // Web UI Complete
  'web.complete.title': 'Configuração Concluída!',
  'web.complete.desc': 'Sua implantação do Authrim está pronta.',
  'web.complete.issuerUrl': 'URL do Emissor',
  'web.complete.loginUrl': 'URL de Login',
  'web.complete.adminUrl': 'URL de Admin',
  'web.complete.nextSteps': 'Próximos Passos:',
  'web.complete.step1': 'Complete a configuração inicial do admin usando o botão acima',
  'web.complete.step2': 'Configure seu primeiro cliente OAuth na UI de Admin',
  'web.complete.step3': 'Integre com sua aplicação',
  'web.complete.saveConfig': 'Salvar Configuração',
  'web.complete.backToMain': 'Voltar ao Início',
  'web.complete.canClose':
    'A configuração está completa. Você pode fechar esta janela com segurança.',

  // Web UI Environment Management
  'web.env.title': 'Ambientes',
  'web.env.loading': 'Carregando ambientes...',
  'web.env.noEnvFound': 'Nenhum ambiente encontrado',
  'web.env.refresh': 'Atualizar',
  'web.env.adminSetup': 'Configuração Inicial do Admin',
  'web.env.adminSetupDesc': 'Clique para criar conta de admin para',
  'web.env.openSetup': 'Abrir Configuração',
  'web.env.copyUrl': 'Copiar',
  'web.env.deleteTitle': 'Excluir Ambiente',
  'web.env.deleteWarning':
    'Esta ação não pode ser desfeita. Os seguintes recursos serão excluídos permanentemente:',
  'web.env.confirmDelete': 'Excluir Selecionados',
  'web.env.cancel': 'Cancelar',

  // Web UI Common buttons
  'web.btn.back': 'Voltar',
  'web.btn.continue': 'Continuar',
  'web.btn.cancel': 'Cancelar',
  'web.btn.save': 'Salvar',
  'web.btn.skip': 'Pular',

  // Web UI Save Modal
  'web.modal.saveTitle': 'Salvar Configuração?',
  'web.modal.saveDesc': 'Salve a configuração no seu computador local para uso futuro.',
  'web.modal.skipSave': 'Pular',
  'web.modal.saveConfig': 'Salvar Configuração',

  // Web UI steps
  'web.step.environment': 'Ambiente',
  'web.step.region': 'Região',
  'web.step.domain': 'Domínio',
  'web.step.email': 'Email',
  'web.step.sms': 'SMS',
  'web.step.social': 'Social',
  'web.step.advanced': 'Avançado',
  'web.step.review': 'Revisar',
  'web.step.deploy': 'Implantar',

  // Web UI forms
  'web.form.submit': 'Enviar',
  'web.form.next': 'Próximo',
  'web.form.previous': 'Anterior',
  'web.form.reset': 'Redefinir',
  'web.form.validation': 'Por favor, corrija os erros acima',

  // Web UI progress
  'web.progress.preparing': 'Preparando implantação...',
  'web.progress.creatingResources': 'Criando recursos do Cloudflare...',
  'web.progress.generatingKeys': 'Gerando chaves criptográficas...',
  'web.progress.configuringWorkers': 'Configurando workers...',
  'web.progress.deployingWorkers': 'Implantando workers...',
  'web.progress.deployingUI': 'Implantando UI...',
  'web.progress.runningMigrations': 'Executando migrações do banco de dados...',
  'web.progress.complete': 'Implantação concluída!',
  'web.progress.failed': 'Implantação falhou',

  // Web UI Form Labels
  'web.form.envName': 'Nome do Ambiente',
  'web.form.envNamePlaceholder': 'ex: prod, staging, dev',
  'web.form.envNameHint': 'Apenas letras minúsculas, números e hífens',
  'web.form.baseDomain': 'Domínio Base (Domínio API)',
  'web.form.baseDomainPlaceholder': 'oidc.exemplo.com',
  'web.form.baseDomainHint':
    'Domínio personalizado para Authrim. Deixe vazio para usar workers.dev',
  'web.form.nakedDomain': 'Excluir nome do tenant da URL',
  'web.form.nakedDomainHint': 'Usar https://exemplo.com em vez de https://{tenant}.exemplo.com',
  'web.form.nakedDomainWarning':
    'Subdomínios de tenant requerem domínio personalizado. Workers.dev não suporta subdomínios curinga.',
  'web.form.tenantId': 'ID do Tenant Padrão',
  'web.form.tenantIdPlaceholder': 'default',
  'web.form.tenantIdHint': 'Identificador do primeiro tenant (minúsculas, sem espaços)',
  'web.form.tenantIdWorkerNote':
    '(ID do Tenant é usado internamente. Subdomínio URL requer domínio personalizado.)',
  'web.form.tenantDisplay': 'Nome de Exibição do Tenant',
  'web.form.tenantDisplayPlaceholder': 'Minha Empresa',
  'web.form.tenantDisplayHint': 'Nome mostrado na página de login e tela de consentimento',
  'web.form.loginDomainPlaceholder': 'login.exemplo.com',
  'web.form.adminDomainPlaceholder': 'admin.exemplo.com',

  // Web UI Section Headers
  'web.section.apiDomain': 'Domínio API / Emissor',
  'web.section.uiDomains': 'Domínios UI (Opcional)',
  'web.section.uiDomainsHint':
    'Domínios personalizados para UIs de Login/Admin. Cada um pode ser configurado independentemente. Deixe vazio para usar padrão do Cloudflare Pages.',
  'web.section.corsHint':
    'CORS: Requisições cross-origin de UI de Login/Admin para API são permitidas automaticamente.',
  'web.section.configPreview': 'Prévia da Configuração',
  'web.section.resourceNames': 'Nomes dos Recursos',

  // Web UI Preview Labels
  'web.preview.components': 'Componentes:',
  'web.preview.workers': 'Workers:',
  'web.preview.issuerUrl': 'URL do Emissor:',
  'web.preview.loginUi': 'UI de Login:',
  'web.preview.adminUi': 'UI de Admin:',

  // Web UI Component Labels
  'web.comp.loginUi': 'UI de Login',
  'web.comp.loginUiDesc':
    'Páginas de login, registro, consentimento e gerenciamento de conta para usuários.',
  'web.comp.adminUi': 'UI de Admin',
  'web.comp.adminUiDesc':
    'Painel de admin para gerenciar tenants, clientes, usuários e configurações do sistema.',

  // Web UI Domain Row Labels
  'web.domain.loginUi': 'UI de Login',
  'web.domain.adminUi': 'UI de Admin',

  // Web UI Database Section
  'web.db.introDesc':
    'Authrim usa dois bancos de dados D1 separados para isolar dados pessoais dos dados da aplicação.',
  'web.db.regionNote': 'Nota: A região do banco de dados não pode ser alterada após a criação.',
  'web.db.coreNonPii': 'Não-PII',
  'web.db.coreDataDesc': 'Armazena dados de aplicação não pessoais incluindo:',
  'web.db.coreData1': 'Clientes OAuth e suas configurações',
  'web.db.coreData2': 'Códigos de autorização e access tokens',
  'web.db.coreData3': 'Sessões de usuário e estado de login',
  'web.db.coreData4': 'Configurações de tenant',
  'web.db.coreData5': 'Logs de auditoria e eventos de segurança',
  'web.db.coreHint':
    'Este banco de dados lida com todos os fluxos de autenticação e deve ser colocado perto da sua base de usuários principal.',
  'web.db.piiLabel': 'Informações Pessoais Identificáveis',
  'web.db.piiDataDesc': 'Armazena dados pessoais do usuário incluindo:',
  'web.db.piiData1': 'Perfis de usuário (nome, email, telefone)',
  'web.db.piiData2': 'Credenciais Passkey/WebAuthn',
  'web.db.piiData3': 'Preferências e configurações do usuário',
  'web.db.piiData4': 'Quaisquer atributos personalizados do usuário',
  'web.db.piiHint':
    'Este banco de dados contém dados pessoais. Considere colocá-lo em uma região que cumpra seus requisitos de proteção de dados.',
  'web.db.locationHints': 'Dicas de Localização',
  'web.db.jurisdiction': 'Jurisdição (Conformidade)',
  'web.db.autoNearest': 'Automático (mais próximo de você)',
  'web.db.northAmericaWest': 'América do Norte (Oeste)',
  'web.db.northAmericaEast': 'América do Norte (Leste)',
  'web.db.europeWest': 'Europa (Oeste)',
  'web.db.europeEast': 'Europa (Leste)',
  'web.db.asiaPacific': 'Ásia Pacífico',
  'web.db.oceania': 'Oceania',
  'web.db.euJurisdiction': 'Jurisdição UE (conformidade GDPR)',

  // Web UI Email Section
  'web.email.introDesc':
    'Usado para enviar OTP por email e verificação de endereço de email. Você pode configurar isso depois se preferir.',
  'web.email.configureLater': 'Configurar depois',
  'web.email.configureLaterHint': 'Pular por agora e configurar depois.',
  'web.email.configureResend': 'Configurar Resend',
  'web.email.configureResendHint':
    'Configurar envio de email com Resend (recomendado para produção).',
  'web.email.resendSetup': 'Configuração do Resend',
  'web.email.beforeBegin': 'Antes de começar:',
  'web.email.step1': 'Crie uma conta no Resend em',
  'web.email.step2': 'Adicione e verifique seu domínio em',
  'web.email.step3': 'Crie uma chave API em',
  'web.email.resendApiKey': 'Chave API do Resend',
  'web.email.resendApiKeyHint': 'Sua chave API começa com "re_"',
  'web.email.fromEmailAddress': 'Endereço de Email do Remetente',
  'web.email.fromEmailHint': 'Deve ser de um domínio verificado na sua conta Resend',
  'web.email.fromDisplayName': 'Nome de Exibição do Remetente (opcional)',
  'web.email.fromDisplayHint': 'Exibido como o nome do remetente em clientes de email',
  'web.email.domainVerificationTitle': 'Verificação de Domínio Necessária',
  'web.email.domainVerificationDesc':
    'Antes do seu domínio ser verificado, emails só podem ser enviados de onboarding@resend.dev (para testes).',
  'web.email.learnMore': 'Saiba mais sobre verificação de domínio →',

  // Web UI Provision Section
  'web.provision.resourcePreview': 'Nomes dos Recursos:',
  'web.provision.d1Databases': 'Bancos de dados D1:',
  'web.provision.kvNamespaces': 'Namespaces KV:',
  'web.provision.cryptoKeys': 'Chaves Criptográficas:',
  'web.provision.initializing': 'Inicializando...',
  'web.provision.showLog': 'Mostrar log detalhado',
  'web.provision.hideLog': 'Ocultar log detalhado',
  'web.provision.keysSavedTo': 'Chaves salvas em:',
  'web.provision.keepSafe': 'Mantenha este diretório seguro e adicione ao .gitignore',

  // Web UI Deploy Section
  'web.deploy.readyText': 'Pronto para implantar workers do Authrim no Cloudflare.',

  // Web UI Environment List
  'web.env.detectedDesc': 'Ambientes Authrim detectados na sua conta Cloudflare:',
  'web.env.noEnvsDetected': 'Nenhum ambiente Authrim detectado nesta conta Cloudflare.',
  'web.env.backToList': '← Voltar à Lista',
  'web.env.deleteEnv': 'Excluir Ambiente...',

  // Web UI Environment Detail
  'web.envDetail.title': 'Detalhes do Ambiente',
  'web.envDetail.adminNotConfigured': 'Conta de Admin Não Configurada',
  'web.envDetail.adminNotConfiguredDesc':
    'O administrador inicial não foi configurado para este ambiente.',
  'web.envDetail.startPasskey': 'Iniciar Configuração de Conta Admin com Passkey',
  'web.envDetail.setupUrlGenerated': 'URL de Configuração Gerada:',
  'web.envDetail.copyBtn': 'Copiar',
  'web.envDetail.openSetup': 'Abrir Configuração',
  'web.envDetail.urlValidFor':
    'Esta URL é válida por 1 hora. Abra-a em um navegador para registrar a primeira conta de admin.',
  'web.envDetail.workers': 'Workers',
  'web.envDetail.d1Databases': 'Bancos de dados D1',
  'web.envDetail.kvNamespaces': 'Namespaces KV',
  'web.envDetail.queues': 'Filas',
  'web.envDetail.r2Buckets': 'Buckets R2',
  'web.envDetail.pagesProjects': 'Projetos Pages',

  // Web UI Worker Update Section
  'web.envDetail.workerUpdate': 'Atualizar Workers',
  'web.envDetail.workerName': 'Worker',
  'web.envDetail.deployedVersion': 'Implantado',
  'web.envDetail.localVersion': 'Local',
  'web.envDetail.updateStatus': 'Status',
  'web.envDetail.needsUpdate': 'Atualizar',
  'web.envDetail.upToDate': 'Atual',
  'web.envDetail.notDeployed': 'Não implantado',
  'web.envDetail.updateOnlyChanged': 'Atualizar apenas versões alteradas',
  'web.envDetail.updateAllWorkers': 'Atualizar Workers',
  'web.envDetail.refreshVersions': 'Atualizar',
  'web.envDetail.updateProgress': 'Progresso da atualização:',
  'web.envDetail.updatesAvailable': '{{count}} atualização(ões) disponível(is)',
  'web.envDetail.allUpToDate': 'Tudo atualizado',

  // Web UI Delete Section
  'web.delete.title': 'Excluir Ambiente',
  'web.delete.warning':
    'Esta ação é irreversível. Todos os recursos selecionados serão excluídos permanentemente.',
  'web.delete.environment': 'Ambiente:',
  'web.delete.selectResources': 'Selecione recursos para excluir:',
  'web.delete.workers': 'Workers',
  'web.delete.d1Databases': 'Bancos de dados D1',
  'web.delete.kvNamespaces': 'Namespaces KV',
  'web.delete.queues': 'Filas',
  'web.delete.r2Buckets': 'Buckets R2',
  'web.delete.pagesProjects': 'Projetos Pages',
  'web.delete.cancelBtn': 'Cancelar',
  'web.delete.confirmBtn': 'Excluir Selecionados',

  // Web UI Save Modal
  'web.modal.saveQuestion':
    'Você gostaria de salvar sua configuração em um arquivo antes de continuar?',
  'web.modal.saveReason':
    'Isso permite retomar a configuração depois ou usar as mesmas configurações para outra implantação.',
  'web.modal.skipBtn': 'Pular',
  'web.modal.saveBtn': 'Salvar Configuração',

  // Web UI Error Messages
  'web.error.wranglerNotInstalled': 'Wrangler não instalado',
  'web.error.pleaseInstall': 'Por favor, instale o wrangler primeiro:',
  'web.error.notLoggedIn': 'Não conectado ao Cloudflare',
  'web.error.runCommand': 'Por favor, execute este comando no seu terminal:',
  'web.error.thenRefresh': 'Depois atualize esta página.',
  'web.error.checkingPrereq': 'Erro ao verificar pré-requisitos:',
  'web.error.invalidJson': 'JSON inválido:',
  'web.error.validationFailed': 'Requisição de validação falhou:',

  // Web UI Status Messages
  'web.status.checking': 'Verificando...',
  'web.status.running': 'Executando...',
  'web.status.deploying': 'Implantando...',
  'web.status.complete': 'Concluído',
  'web.status.error': 'Erro',
  'web.status.scanning': 'Escaneando...',
  'web.status.saving': 'Salvando...',
  'web.status.notDeployed': '(Não implantado)',
  'web.status.startingDeploy': 'Iniciando implantação...',
  'web.status.none': 'Nenhum',
  'web.status.loading': 'Carregando...',
  'web.status.failedToLoad': 'Falha ao carregar',
  'web.status.adminNotConfigured': 'Admin Não Configurado',
  'web.status.initializing': 'Inicializando...',
  'web.status.found': '{{count}} encontrado(s)',

  // Web UI Button Labels (dynamic)
  'web.btn.reprovision': 'Re-provisionar (Excluir e Criar)',
  'web.btn.createResources': 'Criar Recursos',
  'web.btn.saveConfiguration': 'Salvar Configuração',

  // Quick setup specific
  'quickSetup.title': 'Configuração Rápida',

  // Custom setup specific
  'customSetup.title': 'Configuração Personalizada',
  'customSetup.cancelled': 'Configuração cancelada.',

  // Web UI starting
  'webUi.starting': 'Iniciando Web UI...',
};

export default pt;

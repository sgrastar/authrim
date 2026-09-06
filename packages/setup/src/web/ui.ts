/**
 * HTML Template for Authrim Setup Web UI
 *
 * A simple, self-contained UI for the setup wizard.
 * Follows the setup flow defined in the design document.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale, LocaleInfo } from '../i18n/types.js';
import { D1_DATABASES, KV_NAMESPACES, WORKER_COMPONENTS } from '../core/naming.js';
import { SETUP_CAPABILITY_COPY } from '../core/setup-capability-copy.js';
import {
  CLOUDFLARE_DNS_RECORDS_DOCS_URL,
  WILDCARD_DNS_MANUAL_COPY,
  getCloudflareDnsRecordsDashboardUrl,
} from '../core/wildcard-dns-manual-action.js';
import { SETUP_WEB_FONT_FACE } from './ui-fonts.js';
import { SETUP_WEB_UI_STYLE } from './ui-style.js';

const CLOUDFLARE_DNS_ADD_RECORD_IMAGE_DATA_URI = `data:image/png;base64,${readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'cloudflare-dns-add-record-example.png')
).toString('base64')}`;

function readSetupPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8')
    ) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SETUP_PACKAGE_VERSION = readSetupPackageVersion();

export const CONTROL_OPERATION_RESULT_TRANSLATION_KEYS = {
  awaiting_migration: 'web.control.operationAwaitingMigration',
  awaiting_worker_bindings: 'web.control.operationAwaitingWorkerBindings',
  awaiting_smoke: 'web.control.operationAwaitingSmoke',
  awaiting_quarantine: 'web.control.operationAwaitingQuarantine',
  retry_required: 'web.control.operationRetryRequired',
  lease_unavailable: 'web.control.operationLeaseUnavailable',
  succeeded: 'web.control.operationSucceeded',
  blocked: 'web.control.operationBlocked',
} as const;

interface SetupUiCopy {
  stepLabels: readonly string[];
  stepTitles: readonly string[];
  stepAsides: readonly string[];
  stepKicker: string;
  startTarget: string;
  startRuntime: string;
  startTheme: string;
  startKicker: string;
  startTitle: string;
  startAside: string;
  startWrangler: string;
  startAccount: string;
  startSubdomain: string;
  startUnknown: string;
  startNewTitle: string;
  startNewDesc: string;
  startNewAction: string;
  startLoadTitle: string;
  startLoadDesc: string;
  startLoadAction: string;
  startManageTitle: string;
  startManageDesc: string;
  startManageAction: string;
}

const SETUP_UI_COPY = {
  en: {
    stepLabels: [
      'Prepare',
      'Start',
      'Basic',
      'Domain',
      'Database',
      'Features / Email',
      'Resources',
      'Deploy',
      'Complete',
    ],
    stepTitles: [
      'Prepare',
      'Choose How to Start',
      'Basic Settings',
      'Domain & Tenant',
      'Database',
      'Features & Email',
      'Resource Provisioning',
      'Deploying',
      '{env} is Live',
    ],
    stepAsides: [
      'Check Cloudflare authentication and the local requirements needed for setup.',
      'Start a new deployment, resume from authrim-config.json, or manage existing environments.',
      'Set the environment name, deployed components, and user ID format. The content is saved to authrim-config.json and can be re-run later.',
      'Choose the issuer base domain and tenant URL structure. Leave it empty to use *.workers.dev.',
      'Authrim separates personal data (PII) and application data into separate D1 databases. Regions cannot be changed after creation.',
      'Set optional feature flags and the sending provider used for Mail OTP and email address verification. Both can be changed later.',
      'Creating D1, KV, and cryptographic keys. Every generated resource name uses the environment name as its prefix.',
      'Deploy workers in dependency order. This usually takes 3 to 5 minutes and can continue if this tab closes.',
      '',
    ],
    stepKicker: 'Setup — Step',
    startTarget: 'Target',
    startRuntime: 'wrangler',
    startTheme: 'Theme',
    startKicker: 'Setup — Step 02 / 09',
    startTitle: 'Choose How to Start',
    startAside:
      'Start a new deployment, resume from authrim-config.json, or manage existing environments.',
    startWrangler: 'wrangler',
    startAccount: 'Account',
    startSubdomain: 'Subdomain',
    startUnknown: 'Not loaded',
    startNewTitle: 'New<br>Setup',
    startNewDesc:
      'Build an Authrim environment from zero. The wizard guides basic settings, domains, database, features, and deployment in order.',
    startNewAction: 'Start',
    startLoadTitle: 'Load<br>Configuration',
    startLoadDesc:
      'Resume an interrupted setup or redeploy an existing environment from a saved authrim-config.json file.',
    startLoadAction: 'Choose file',
    startManageTitle: 'Manage<br>Environments',
    startManageDesc:
      'List deployed environments in this Cloudflare account, then inspect, update, or delete them.',
    startManageAction: 'Open list',
  },
  ja: {
    stepLabels: [
      '準備',
      '開始',
      '基本設定',
      'ドメイン',
      'データベース',
      '機能・メール',
      'リソース',
      'デプロイ',
      '完了',
    ],
    stepTitles: [
      '準備',
      '開始方法を選択',
      '基本設定',
      'ドメインとテナント',
      'データベース',
      '機能とメール',
      'リソース作成',
      'デプロイ中',
      '{env} が稼働開始',
    ],
    stepAsides: [
      'Cloudflare認証と、セットアップに必要なローカル要件を確認します。',
      '新規構築するか、保存済みの authrim-config.json から再開するか、既存環境を管理するかを選んでください。',
      '環境名・デプロイするコンポーネント・ユーザーIDの形式を決めます。内容は authrim-config.json に保存され、あとから再実行できます。',
      '発行者（Issuer）となるベースドメインと、テナントの構成を決めます。空欄のまま進めると *.workers.dev で動作します。',
      'Authrimは個人データ（PII）とアプリケーションデータを別々のD1データベースに分離します。リージョンは作成後に変更できません。',
      '任意機能のフラグと、メールOTP・メールアドレス確認に使う送信プロバイダを設定します。どちらもあとから変更できます。',
      'D1・KV・暗号鍵を作成しています。作成されるリソース名は環境名を接頭辞に持ちます。',
      'Workerを依存順にデプロイしています。通常3〜5分かかります。このタブは閉じても処理は継続します。',
      '',
    ],
    stepKicker: 'セットアップ — ステップ',
    startTarget: 'デプロイ先',
    startRuntime: 'wrangler',
    startTheme: 'テーマ',
    startKicker: 'セットアップ — ステップ 02 / 09',
    startTitle: '開始方法を選択',
    startAside:
      '新規構築するか、保存済みの authrim-config.json から再開するか、既存環境を管理するかを選んでください。',
    startWrangler: 'wrangler',
    startAccount: 'アカウント',
    startSubdomain: 'サブドメイン',
    startUnknown: '未取得',
    startNewTitle: '新規<br>セットアップ',
    startNewDesc:
      'Authrim環境をゼロから構築します。ウィザードが基本設定・ドメイン・データベース・機能・デプロイまで順に案内します。',
    startNewAction: '開始する',
    startLoadTitle: '設定を<br>読み込む',
    startLoadDesc:
      '中断したセットアップの再開や、既存環境の再デプロイを、保存済みの authrim-config.json から行います。',
    startLoadAction: 'ファイルを選択',
    startManageTitle: '環境を<br>管理する',
    startManageDesc:
      'このCloudflareアカウントにデプロイ済みの環境を一覧表示し、確認・更新・削除を行います。',
    startManageAction: '一覧を開く',
  },
  'zh-CN': {
    stepLabels: ['准备', '开始', '基本', '域名', '数据库', '功能/邮件', '资源', '部署', '完成'],
    stepTitles: [
      '准备',
      '选择开始方式',
      '基本设置',
      '域名与租户',
      '数据库',
      '功能与邮件',
      '资源创建',
      '部署中',
      '{env} 已上线',
    ],
    stepAsides: [
      '检查 Cloudflare 身份验证以及设置所需的本地条件。',
      '选择新建部署、从 authrim-config.json 继续，或管理现有环境。',
      '设置环境名称、要部署的组件和用户 ID 格式。内容会保存到 authrim-config.json，之后可重新执行。',
      '选择作为 Issuer 的基础域名和租户 URL 结构。留空则使用 *.workers.dev。',
      'Authrim 将个人数据（PII）和应用数据分离到不同的 D1 数据库中。区域创建后无法更改。',
      '设置可选功能标志，以及用于邮件 OTP 和邮箱验证的发送服务。两者之后都可以更改。',
      '正在创建 D1、KV 和加密密钥。生成的资源名称都会使用环境名作为前缀。',
      '正在按依赖顺序部署 Worker。通常需要 3 到 5 分钟，关闭此标签页后处理也会继续。',
      '',
    ],
    stepKicker: '设置 — 步骤',
    startTarget: '部署目标',
    startRuntime: 'wrangler',
    startTheme: '主题',
    startKicker: '设置 — 步骤 02 / 09',
    startTitle: '选择开始方式',
    startAside: '选择新建部署、从 authrim-config.json 继续，或管理现有环境。',
    startWrangler: 'wrangler',
    startAccount: '账户',
    startSubdomain: '子域名',
    startUnknown: '未加载',
    startNewTitle: '新建<br>设置',
    startNewDesc: '从零构建 Authrim 环境。向导会依次引导基本设置、域名、数据库、功能和部署。',
    startNewAction: '开始',
    startLoadTitle: '加载<br>配置',
    startLoadDesc: '使用保存的 authrim-config.json 继续中断的设置或重新部署现有环境。',
    startLoadAction: '选择文件',
    startManageTitle: '管理<br>环境',
    startManageDesc: '列出此 Cloudflare 账户中已部署的环境，并进行查看、更新或删除。',
    startManageAction: '打开列表',
  },
  'zh-TW': {
    stepLabels: ['準備', '開始', '基本', '網域', '資料庫', '功能/郵件', '資源', '部署', '完成'],
    stepTitles: [
      '準備',
      '選擇開始方式',
      '基本設定',
      '網域與租戶',
      '資料庫',
      '功能與郵件',
      '資源建立',
      '部署中',
      '{env} 已上線',
    ],
    stepAsides: [
      '檢查 Cloudflare 驗證狀態以及設定所需的本機條件。',
      '選擇新建部署、從 authrim-config.json 繼續，或管理既有環境。',
      '設定環境名稱、要部署的元件和使用者 ID 格式。內容會保存到 authrim-config.json，之後可重新執行。',
      '選擇作為 Issuer 的基礎網域與租戶 URL 結構。留空則使用 *.workers.dev。',
      'Authrim 會將個人資料（PII）與應用程式資料分離到不同的 D1 資料庫。區域建立後無法變更。',
      '設定選用功能旗標，以及用於郵件 OTP 和電子郵件驗證的寄送服務。兩者之後都可以變更。',
      '正在建立 D1、KV 和加密金鑰。產生的資源名稱都會使用環境名稱作為前綴。',
      '正在依相依順序部署 Worker。通常需要 3 到 5 分鐘，關閉此分頁後處理也會繼續。',
      '',
    ],
    stepKicker: '設定 — 步驟',
    startTarget: '部署目標',
    startRuntime: 'wrangler',
    startTheme: '主題',
    startKicker: '設定 — 步驟 02 / 09',
    startTitle: '選擇開始方式',
    startAside: '選擇新建部署、從 authrim-config.json 繼續，或管理既有環境。',
    startWrangler: 'wrangler',
    startAccount: '帳戶',
    startSubdomain: '子網域',
    startUnknown: '未載入',
    startNewTitle: '新建<br>設定',
    startNewDesc: '從零建立 Authrim 環境。精靈會依序引導基本設定、網域、資料庫、功能與部署。',
    startNewAction: '開始',
    startLoadTitle: '載入<br>設定',
    startLoadDesc: '使用保存的 authrim-config.json 繼續中斷的設定或重新部署既有環境。',
    startLoadAction: '選擇檔案',
    startManageTitle: '管理<br>環境',
    startManageDesc: '列出此 Cloudflare 帳戶中已部署的環境，並進行查看、更新或刪除。',
    startManageAction: '開啟列表',
  },
  es: {
    stepLabels: [
      'Preparar',
      'Inicio',
      'Básico',
      'Dominio',
      'Base de datos',
      'Funciones / email',
      'Recursos',
      'Deploy',
      'Completo',
    ],
    stepTitles: [
      'Preparar',
      'Elige cómo empezar',
      'Configuración básica',
      'Dominio y tenant',
      'Base de datos',
      'Funciones y email',
      'Creación de recursos',
      'Deploy en curso',
      '{env} está activo',
    ],
    stepAsides: [
      'Comprueba la autenticación de Cloudflare y los requisitos locales necesarios para la configuración.',
      'Inicia un despliegue nuevo, reanuda desde authrim-config.json o administra entornos existentes.',
      'Define el nombre del entorno, los componentes a desplegar y el formato de ID de usuario. El contenido se guarda en authrim-config.json y puede ejecutarse de nuevo.',
      'Elige el dominio base del Issuer y la estructura de URL de tenants. Si lo dejas vacío, se usará *.workers.dev.',
      'Authrim separa los datos personales (PII) y los datos de aplicación en bases D1 distintas. La región no se puede cambiar después de crearla.',
      'Configura funciones opcionales y el proveedor de envío para Mail OTP y verificación de email. Ambos se pueden cambiar después.',
      'Creando D1, KV y claves criptográficas. Todos los recursos generados usan el nombre del entorno como prefijo.',
      'Desplegando Workers en orden de dependencias. Suele tardar de 3 a 5 minutos y continúa aunque cierres esta pestaña.',
      '',
    ],
    stepKicker: 'Setup — paso',
    startTarget: 'Destino',
    startRuntime: 'wrangler',
    startTheme: 'Tema',
    startKicker: 'Setup — paso 02 / 09',
    startTitle: 'Elige cómo empezar',
    startAside:
      'Inicia un despliegue nuevo, reanuda desde authrim-config.json o administra entornos existentes.',
    startWrangler: 'wrangler',
    startAccount: 'Cuenta',
    startSubdomain: 'Subdominio',
    startUnknown: 'Sin cargar',
    startNewTitle: 'Nuevo<br>setup',
    startNewDesc:
      'Construye un entorno Authrim desde cero. El asistente guía la configuración básica, dominios, base de datos, funciones y deploy.',
    startNewAction: 'Empezar',
    startLoadTitle: 'Cargar<br>configuración',
    startLoadDesc:
      'Reanuda un setup interrumpido o vuelve a desplegar un entorno existente desde un authrim-config.json guardado.',
    startLoadAction: 'Elegir archivo',
    startManageTitle: 'Administrar<br>entornos',
    startManageDesc:
      'Lista los entornos desplegados en esta cuenta de Cloudflare para inspeccionarlos, actualizarlos o eliminarlos.',
    startManageAction: 'Abrir lista',
  },
  pt: {
    stepLabels: [
      'Preparar',
      'Início',
      'Básico',
      'Domínio',
      'Banco de dados',
      'Recursos / email',
      'Recursos',
      'Deploy',
      'Concluir',
    ],
    stepTitles: [
      'Preparar',
      'Escolha como começar',
      'Configuração básica',
      'Domínio e tenant',
      'Banco de dados',
      'Recursos e email',
      'Criação de recursos',
      'Deploy em andamento',
      '{env} está no ar',
    ],
    stepAsides: [
      'Verifique a autenticação da Cloudflare e os requisitos locais necessários para a configuração.',
      'Inicie um novo deploy, retome a partir de authrim-config.json ou gerencie ambientes existentes.',
      'Defina o nome do ambiente, os componentes implantados e o formato de ID de usuário. O conteúdo é salvo em authrim-config.json e pode ser executado novamente depois.',
      'Escolha o domínio base do Issuer e a estrutura de URL dos tenants. Deixe em branco para usar *.workers.dev.',
      'O Authrim separa dados pessoais (PII) e dados da aplicação em bancos D1 diferentes. A região não pode ser alterada após a criação.',
      'Configure flags opcionais e o provedor de envio usado para Mail OTP e verificação de email. Ambos podem ser alterados depois.',
      'Criando D1, KV e chaves criptográficas. Todos os recursos gerados usam o nome do ambiente como prefixo.',
      'Implantando Workers na ordem de dependência. Normalmente leva de 3 a 5 minutos e continua mesmo se esta aba for fechada.',
      '',
    ],
    stepKicker: 'Setup — etapa',
    startTarget: 'Destino',
    startRuntime: 'wrangler',
    startTheme: 'Tema',
    startKicker: 'Setup — etapa 02 / 09',
    startTitle: 'Escolha como começar',
    startAside:
      'Inicie um novo deploy, retome a partir de authrim-config.json ou gerencie ambientes existentes.',
    startWrangler: 'wrangler',
    startAccount: 'Conta',
    startSubdomain: 'Subdomínio',
    startUnknown: 'Não carregado',
    startNewTitle: 'Novo<br>setup',
    startNewDesc:
      'Construa um ambiente Authrim do zero. O assistente guia configuração básica, domínios, banco de dados, recursos e deploy.',
    startNewAction: 'Começar',
    startLoadTitle: 'Carregar<br>configuração',
    startLoadDesc:
      'Retome um setup interrompido ou faça redeploy de um ambiente existente a partir de um authrim-config.json salvo.',
    startLoadAction: 'Escolher arquivo',
    startManageTitle: 'Gerenciar<br>ambientes',
    startManageDesc:
      'Liste os ambientes implantados nesta conta Cloudflare para inspecionar, atualizar ou excluir.',
    startManageAction: 'Abrir lista',
  },
  fr: {
    stepLabels: [
      'Préparer',
      'Démarrer',
      'Base',
      'Domaine',
      'Base de données',
      'Fonctions / email',
      'Ressources',
      'Déployer',
      'Terminé',
    ],
    stepTitles: [
      'Préparer',
      'Choisir comment démarrer',
      'Paramètres de base',
      'Domaine et tenant',
      'Base de données',
      'Fonctions et email',
      'Création des ressources',
      'Déploiement',
      '{env} est en service',
    ],
    stepAsides: [
      'Vérifiez l’authentification Cloudflare et les prérequis locaux nécessaires à la configuration.',
      'Démarrez un nouveau déploiement, reprenez depuis authrim-config.json ou gérez les environnements existants.',
      'Définissez le nom de l’environnement, les composants à déployer et le format des ID utilisateur. Le contenu est enregistré dans authrim-config.json et peut être relancé plus tard.',
      'Choisissez le domaine de base de l’Issuer et la structure d’URL des tenants. Laissez vide pour utiliser *.workers.dev.',
      'Authrim sépare les données personnelles (PII) et les données applicatives dans des bases D1 distinctes. La région ne peut plus être changée après création.',
      'Configurez les fonctions optionnelles et le fournisseur d’envoi pour Mail OTP et la vérification d’adresse email. Les deux peuvent être modifiés plus tard.',
      'Création des bases D1, des KV et des clés cryptographiques. Tous les noms de ressources générés utilisent le nom de l’environnement comme préfixe.',
      'Déploiement des Workers dans l’ordre des dépendances. Cela prend généralement 3 à 5 minutes et continue si cet onglet est fermé.',
      '',
    ],
    stepKicker: 'Configuration — étape',
    startTarget: 'Cible',
    startRuntime: 'wrangler',
    startTheme: 'Thème',
    startKicker: 'Configuration — étape 02 / 09',
    startTitle: 'Choisir comment démarrer',
    startAside:
      'Démarrez un nouveau déploiement, reprenez depuis authrim-config.json ou gérez les environnements existants.',
    startWrangler: 'wrangler',
    startAccount: 'Compte',
    startSubdomain: 'Sous-domaine',
    startUnknown: 'Non chargé',
    startNewTitle: 'Nouveau<br>setup',
    startNewDesc:
      'Construisez un environnement Authrim de zéro. L’assistant guide les paramètres de base, domaines, base de données, fonctions et déploiement.',
    startNewAction: 'Démarrer',
    startLoadTitle: 'Charger<br>configuration',
    startLoadDesc:
      'Reprenez une configuration interrompue ou redéployez un environnement existant depuis un fichier authrim-config.json enregistré.',
    startLoadAction: 'Choisir un fichier',
    startManageTitle: 'Gérer<br>environnements',
    startManageDesc:
      'Listez les environnements déployés dans ce compte Cloudflare, puis inspectez, mettez à jour ou supprimez-les.',
    startManageAction: 'Ouvrir la liste',
  },
  de: {
    stepLabels: [
      'Vorbereiten',
      'Start',
      'Basis',
      'Domain',
      'Datenbank',
      'Funktionen / E-Mail',
      'Ressourcen',
      'Deploy',
      'Fertig',
    ],
    stepTitles: [
      'Vorbereiten',
      'Startmethode wählen',
      'Basiseinstellungen',
      'Domain und Tenant',
      'Datenbank',
      'Funktionen und E-Mail',
      'Ressourcen erstellen',
      'Deployment läuft',
      '{env} ist live',
    ],
    stepAsides: [
      'Prüfen Sie die Cloudflare-Authentifizierung und die lokalen Voraussetzungen für die Einrichtung.',
      'Starten Sie ein neues Deployment, fahren Sie mit authrim-config.json fort oder verwalten Sie bestehende Umgebungen.',
      'Legen Sie Umgebungsname, zu deployende Komponenten und Benutzer-ID-Format fest. Die Inhalte werden in authrim-config.json gespeichert und können später erneut ausgeführt werden.',
      'Wählen Sie die Issuer-Basisdomain und die Tenant-URL-Struktur. Leer lassen, um *.workers.dev zu verwenden.',
      'Authrim trennt personenbezogene Daten (PII) und Anwendungsdaten in separate D1-Datenbanken. Regionen können nach der Erstellung nicht geändert werden.',
      'Konfigurieren Sie optionale Feature-Flags und den Versandprovider für Mail OTP und E-Mail-Verifizierung. Beides kann später geändert werden.',
      'D1, KV und kryptografische Schlüssel werden erstellt. Alle generierten Ressourcennamen verwenden den Umgebungsnamen als Präfix.',
      'Workers werden in Abhängigkeitsreihenfolge deployed. Das dauert normalerweise 3 bis 5 Minuten und läuft weiter, wenn dieser Tab geschlossen wird.',
      '',
    ],
    stepKicker: 'Setup — Schritt',
    startTarget: 'Ziel',
    startRuntime: 'wrangler',
    startTheme: 'Theme',
    startKicker: 'Setup — Schritt 02 / 09',
    startTitle: 'Startmethode wählen',
    startAside:
      'Starten Sie ein neues Deployment, fahren Sie mit authrim-config.json fort oder verwalten Sie bestehende Umgebungen.',
    startWrangler: 'wrangler',
    startAccount: 'Konto',
    startSubdomain: 'Subdomain',
    startUnknown: 'Nicht geladen',
    startNewTitle: 'Neues<br>Setup',
    startNewDesc:
      'Erstellen Sie eine Authrim-Umgebung von Grund auf. Der Assistent führt durch Basiseinstellungen, Domains, Datenbank, Funktionen und Deployment.',
    startNewAction: 'Starten',
    startLoadTitle: 'Konfiguration<br>laden',
    startLoadDesc:
      'Setzen Sie ein unterbrochenes Setup fort oder deployen Sie eine bestehende Umgebung erneut aus einer gespeicherten authrim-config.json.',
    startLoadAction: 'Datei wählen',
    startManageTitle: 'Umgebungen<br>verwalten',
    startManageDesc:
      'Listen Sie die in diesem Cloudflare-Konto deployten Umgebungen auf, prüfen, aktualisieren oder löschen Sie sie.',
    startManageAction: 'Liste öffnen',
  },
  ko: {
    stepLabels: [
      '준비',
      '시작',
      '기본',
      '도메인',
      '데이터베이스',
      '기능/메일',
      '리소스',
      '배포',
      '완료',
    ],
    stepTitles: [
      '준비',
      '시작 방법 선택',
      '기본 설정',
      '도메인과 테넌트',
      '데이터베이스',
      '기능과 메일',
      '리소스 생성',
      '배포 중',
      '{env} 실행 시작',
    ],
    stepAsides: [
      'Cloudflare 인증 상태와 설정에 필요한 로컬 요구 사항을 확인합니다.',
      '새 배포를 시작하거나 authrim-config.json에서 재개하거나 기존 환경을 관리합니다.',
      '환경 이름, 배포할 컴포넌트, 사용자 ID 형식을 정합니다. 내용은 authrim-config.json에 저장되며 나중에 다시 실행할 수 있습니다.',
      'Issuer가 될 기본 도메인과 테넌트 URL 구조를 선택합니다. 비워 두면 *.workers.dev를 사용합니다.',
      'Authrim은 개인 데이터(PII)와 애플리케이션 데이터를 별도의 D1 데이터베이스로 분리합니다. 리전은 생성 후 변경할 수 없습니다.',
      '선택 기능 플래그와 Mail OTP 및 이메일 주소 확인에 사용할 발송 제공자를 설정합니다. 둘 다 나중에 변경할 수 있습니다.',
      'D1, KV, 암호화 키를 생성하고 있습니다. 생성되는 리소스 이름은 모두 환경 이름을 접두사로 사용합니다.',
      '의존성 순서대로 Worker를 배포하고 있습니다. 보통 3~5분 걸리며 이 탭을 닫아도 처리는 계속됩니다.',
      '',
    ],
    stepKicker: '설정 — 단계',
    startTarget: '배포 대상',
    startRuntime: 'wrangler',
    startTheme: '테마',
    startKicker: '설정 — 단계 02 / 09',
    startTitle: '시작 방법 선택',
    startAside: '새 배포를 시작하거나 authrim-config.json에서 재개하거나 기존 환경을 관리합니다.',
    startWrangler: 'wrangler',
    startAccount: '계정',
    startSubdomain: '서브도메인',
    startUnknown: '불러오지 않음',
    startNewTitle: '새<br>설정',
    startNewDesc:
      'Authrim 환경을 처음부터 구성합니다. 마법사가 기본 설정, 도메인, 데이터베이스, 기능, 배포를 순서대로 안내합니다.',
    startNewAction: '시작',
    startLoadTitle: '설정<br>불러오기',
    startLoadDesc:
      '저장된 authrim-config.json으로 중단된 설정을 재개하거나 기존 환경을 다시 배포합니다.',
    startLoadAction: '파일 선택',
    startManageTitle: '환경<br>관리',
    startManageDesc: '이 Cloudflare 계정에 배포된 환경을 나열하고 확인, 업데이트 또는 삭제합니다.',
    startManageAction: '목록 열기',
  },
  ru: {
    stepLabels: [
      'Подготовка',
      'Старт',
      'Основное',
      'Домен',
      'База данных',
      'Функции / почта',
      'Ресурсы',
      'Деплой',
      'Готово',
    ],
    stepTitles: [
      'Подготовка',
      'Выберите способ начала',
      'Основные настройки',
      'Домен и тенант',
      'База данных',
      'Функции и почта',
      'Создание ресурсов',
      'Идет деплой',
      '{env} запущен',
    ],
    stepAsides: [
      'Проверьте аутентификацию Cloudflare и локальные требования для настройки.',
      'Начните новый деплой, продолжите из authrim-config.json или управляйте существующими средами.',
      'Задайте имя среды, компоненты для деплоя и формат ID пользователя. Данные сохраняются в authrim-config.json и могут быть запущены повторно.',
      'Выберите базовый домен Issuer и структуру URL тенантов. Если оставить пустым, будет использоваться *.workers.dev.',
      'Authrim разделяет персональные данные (PII) и данные приложения в отдельные базы D1. Регион нельзя изменить после создания.',
      'Настройте необязательные флаги функций и провайдера отправки для Mail OTP и проверки email. Оба параметра можно изменить позже.',
      'Создаются D1, KV и криптографические ключи. Все имена ресурсов используют имя среды как префикс.',
      'Workers деплоятся в порядке зависимостей. Обычно это занимает 3–5 минут и продолжается, если закрыть эту вкладку.',
      '',
    ],
    stepKicker: 'Настройка — шаг',
    startTarget: 'Цель',
    startRuntime: 'wrangler',
    startTheme: 'Тема',
    startKicker: 'Настройка — шаг 02 / 09',
    startTitle: 'Выберите способ начала',
    startAside:
      'Начните новый деплой, продолжите из authrim-config.json или управляйте существующими средами.',
    startWrangler: 'wrangler',
    startAccount: 'Аккаунт',
    startSubdomain: 'Субдомен',
    startUnknown: 'Не загружено',
    startNewTitle: 'Новая<br>настройка',
    startNewDesc:
      'Создайте среду Authrim с нуля. Мастер проведет через основные настройки, домены, базу данных, функции и деплой.',
    startNewAction: 'Начать',
    startLoadTitle: 'Загрузить<br>конфигурацию',
    startLoadDesc:
      'Продолжите прерванную настройку или повторно задеплойте существующую среду из сохраненного authrim-config.json.',
    startLoadAction: 'Выбрать файл',
    startManageTitle: 'Управлять<br>средами',
    startManageDesc:
      'Показать среды, развернутые в этом аккаунте Cloudflare, затем проверить, обновить или удалить их.',
    startManageAction: 'Открыть список',
  },
  id: {
    stepLabels: [
      'Persiapan',
      'Mulai',
      'Dasar',
      'Domain',
      'Database',
      'Fitur / email',
      'Resource',
      'Deploy',
      'Selesai',
    ],
    stepTitles: [
      'Persiapan',
      'Pilih cara memulai',
      'Pengaturan dasar',
      'Domain dan tenant',
      'Database',
      'Fitur dan email',
      'Pembuatan resource',
      'Sedang deploy',
      '{env} sudah aktif',
    ],
    stepAsides: [
      'Periksa autentikasi Cloudflare dan persyaratan lokal yang dibutuhkan untuk setup.',
      'Mulai deployment baru, lanjutkan dari authrim-config.json, atau kelola environment yang sudah ada.',
      'Tentukan nama environment, komponen yang dideploy, dan format ID pengguna. Isinya disimpan ke authrim-config.json dan dapat dijalankan ulang nanti.',
      'Pilih domain dasar Issuer dan struktur URL tenant. Kosongkan untuk memakai *.workers.dev.',
      'Authrim memisahkan data pribadi (PII) dan data aplikasi ke database D1 yang berbeda. Region tidak dapat diubah setelah dibuat.',
      'Atur feature flag opsional dan provider pengiriman untuk Mail OTP serta verifikasi alamat email. Keduanya dapat diubah nanti.',
      'Membuat D1, KV, dan kunci kriptografi. Semua nama resource yang dibuat memakai nama environment sebagai prefix.',
      'Mendeploy Worker sesuai urutan dependensi. Biasanya butuh 3 sampai 5 menit dan tetap berjalan jika tab ini ditutup.',
      '',
    ],
    stepKicker: 'Setup — langkah',
    startTarget: 'Target',
    startRuntime: 'wrangler',
    startTheme: 'Tema',
    startKicker: 'Setup — langkah 02 / 09',
    startTitle: 'Pilih cara memulai',
    startAside:
      'Mulai deployment baru, lanjutkan dari authrim-config.json, atau kelola environment yang sudah ada.',
    startWrangler: 'wrangler',
    startAccount: 'Akun',
    startSubdomain: 'Subdomain',
    startUnknown: 'Belum dimuat',
    startNewTitle: 'Setup<br>baru',
    startNewDesc:
      'Bangun environment Authrim dari awal. Wizard memandu pengaturan dasar, domain, database, fitur, dan deployment secara berurutan.',
    startNewAction: 'Mulai',
    startLoadTitle: 'Muat<br>konfigurasi',
    startLoadDesc:
      'Lanjutkan setup yang terhenti atau redeploy environment yang ada dari file authrim-config.json tersimpan.',
    startLoadAction: 'Pilih file',
    startManageTitle: 'Kelola<br>environment',
    startManageDesc:
      'Daftar environment yang sudah dideploy di akun Cloudflare ini, lalu periksa, update, atau hapus.',
    startManageAction: 'Buka daftar',
  },
} as const satisfies Record<string, SetupUiCopy>;

function getSetupUiCopy(locale: string): SetupUiCopy {
  const exact = SETUP_UI_COPY[locale as keyof typeof SETUP_UI_COPY];
  if (exact) return exact;
  const normalized = locale.toLowerCase();
  if (normalized.startsWith('zh-tw')) return SETUP_UI_COPY['zh-TW'];
  if (normalized.startsWith('zh')) return SETUP_UI_COPY['zh-CN'];
  const language = normalized.split('-')[0] as keyof typeof SETUP_UI_COPY;
  if (SETUP_UI_COPY[language]) return SETUP_UI_COPY[language];
  return SETUP_UI_COPY.en;
}

function escapeTemplateHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

const DOMAIN_FORM_BROWSER_SCRIPT = String.raw`
    function isValidCustomDomain(domain) {
      const normalized = String(domain || '').trim();
      if (normalized.length === 0 || normalized.length > 253) {
        return false;
      }

      const labels = normalized.split('.');
      if (labels.length < 2 || labels.some(function(label) {
        return label.length === 0 || label.length > 63;
      })) {
        return false;
      }

      if (labels.some(function(label) {
        return label.toLowerCase().startsWith('xn--');
      })) {
        return false;
      }

      const tld = labels[labels.length - 1];
      if (!/^[a-z]{2,63}$/i.test(tld)) {
        return false;
      }

      return labels.every(function(label) {
        return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
      });
    }

    function validateSetupDomainInputs(input) {
      function normalizeDomain(value) {
        return String(value || '')
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '')
          .replace(/\\.+$/, '')
          .toLowerCase();
      }

      function getZoneName(hostname) {
        const parts = hostname.split('.').filter(Boolean);
        const twoPartTlds = new Set([
          'co.uk',
          'org.uk',
          'gov.uk',
          'ac.uk',
          'co.jp',
          'or.jp',
          'ne.jp',
          'co.nz',
          'org.nz',
          'net.nz',
          'co.kr',
          'or.kr',
          'ne.kr',
          'co.in',
          'firm.in',
          'net.in',
          'org.in',
          'gen.in',
          'co.id',
          'web.id',
          'ac.id',
          'or.id',
          'co.za',
          'org.za',
          'net.za',
          'com.au',
          'net.au',
          'org.au',
          'com.br',
          'net.br',
          'org.br',
        ]);
        const lastTwo = parts.slice(-2).join('.');
        if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
          return parts.slice(-3).join('.');
        }
        return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
      }

      function prefixLabelsFor(hostname, parentDomain) {
        if (!hostname || !parentDomain || hostname === parentDomain) {
          return [];
        }
        const suffix = '.' + parentDomain;
        if (!hostname.endsWith(suffix)) {
          return [];
        }
        return hostname.slice(0, -suffix.length).split('.').filter(Boolean);
      }

      function buildBaseMessage(hostname) {
        return (
          'Base Domain must be the parent domain used by tenant URLs. "' + hostname + '" has ' +
          'two or more labels before the registered domain, which would create unsupported ' +
          'two-label tenant hosts.'
        );
      }

      function buildUiMessage(label, hostname, suggestion) {
        return (
          label + ' domain "' + hostname + '" is too deep for the standard tenant domain model. ' +
          'Use a one-label host such as "' + suggestion + '" instead.'
        );
      }

      const issues = [];
      const apiDomain = normalizeDomain(input.apiDomain);
      const loginUiDomain = normalizeDomain(input.loginUiDomain);
      const adminUiDomain = normalizeDomain(input.adminUiDomain);

      if (apiDomain && isValidCustomDomain(apiDomain)) {
        const zoneName = getZoneName(apiDomain);
        const apiPrefixLabels = prefixLabelsFor(apiDomain, zoneName);
        if (apiPrefixLabels.length >= 2) {
          const suggested = apiPrefixLabels[apiPrefixLabels.length - 1] + '.' + zoneName;
          issues.push({
            field: 'apiDomain',
            kind: 'baseDomainDepth',
            hostname: apiDomain,
            message: buildBaseMessage(apiDomain),
            suggestion: suggested,
          });
        }
      }

      [
        ['loginUiDomain', 'Login UI', loginUiDomain],
        ['adminUiDomain', 'Admin UI', adminUiDomain],
      ].forEach(function(entry) {
        const field = entry[0];
        const label = entry[1];
        const hostname = entry[2];
        if (!hostname || !isValidCustomDomain(hostname)) {
          return;
        }

        const parentDomain =
          apiDomain && hostname.endsWith('.' + apiDomain) ? apiDomain : getZoneName(hostname);
        const uiPrefixLabels = prefixLabelsFor(hostname, parentDomain);
        if (uiPrefixLabels.length >= 2) {
          const suggestion = uiPrefixLabels.join('-') + '.' + parentDomain;
          issues.push({
            field: field,
            kind: 'uiDomainDepth',
            hostname: hostname,
            message: buildUiMessage(label, hostname, suggestion),
            suggestion: suggestion,
          });
        }
      });

      return issues;
    }

    function computeApiDomainUiState(input) {
      const baseDomain = input.baseDomain.trim();
      const tenantName = input.tenantName.trim() || 'default';
      const primaryTenant = (input.primaryTenant || '').trim();
      const hasBaseDomain = baseDomain.length > 0;
      const multiTenantEnabled = hasBaseDomain && input.multiTenantChecked;
      const nakedDomainEnabled = multiTenantEnabled && input.nakedDomainChecked;
      const nakedTenantName = primaryTenant || tenantName;
      const exampleRows = [];

      if (multiTenantEnabled) {
        if (nakedDomainEnabled) {
          exampleRows.push({
            kind: 'initial-tenant',
            tenantName: nakedTenantName,
            url: 'https://' + baseDomain,
          });
          if (nakedTenantName !== tenantName) {
            exampleRows.push({
              kind: 'initial-tenant-explicit',
              tenantName: tenantName,
              url: 'https://' + tenantName + '.' + baseDomain,
            });
          }
          exampleRows.push({
            kind: 'other-tenant',
            url: 'https://{tenantName}.' + baseDomain,
          });
        } else {
          exampleRows.push({
            kind: 'initial-tenant',
            tenantName: tenantName,
            url: 'https://' + tenantName + '.' + baseDomain,
          });
          exampleRows.push({
            kind: 'other-tenant',
            url: 'https://{tenantName}.' + baseDomain,
          });
        }
      }

      return {
        hasBaseDomain: hasBaseDomain,
        hasValidBaseDomain: isValidCustomDomain(baseDomain),
        multiTenantEnabled: multiTenantEnabled,
        showWorkersDevNote: !hasBaseDomain,
        showNakedDomainControls: multiTenantEnabled,
        showTenantFields: !hasBaseDomain || (multiTenantEnabled && !nakedDomainEnabled),
        showPrimaryTenantRow: false,
        showExamples: multiTenantEnabled,
        baseDomainPlaceholder: nakedDomainEnabled ? 'example.com' : 'id.example.com',
        multiTenantHintMode: !hasBaseDomain
          ? 'needs-custom-domain'
          : multiTenantEnabled
            ? 'multi-tenant'
            : 'single-tenant',
        nakedDomainHintMode: !multiTenantEnabled
          ? 'hidden'
          : nakedDomainEnabled
            ? 'omit-tenant'
            : 'include-tenant',
        exampleRows: exampleRows,
      };
    }
`;

export function getHtmlTemplate(
  sessionToken?: string,
  manageOnly?: boolean,
  locale: Locale = 'en',
  translations: Record<string, string> = {},
  availableLocales: LocaleInfo[] = [],
  setupVersion: string = SETUP_PACKAGE_VERSION
): string {
  // Escape token for safe embedding in JavaScript
  const safeToken = sessionToken ? sessionToken.replace(/['"\\]/g, '') : '';
  const manageOnlyFlag = manageOnly ? 'true' : 'false';

  // Safely stringify translations for embedding in JavaScript
  const translationsJson = JSON.stringify(translations);
  const availableLocalesJson = JSON.stringify(availableLocales);
  const controlOperationResultTranslationKeysJson = JSON.stringify(
    CONTROL_OPERATION_RESULT_TRANSLATION_KEYS
  );
  const wildcardDnsManualCopyJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(WILDCARD_DNS_MANUAL_COPY).map(([code, copy]) => [
        code,
        {
          title: copy.title,
          summaryTemplate: copy.summary('{baseDomain}'),
          timing: copy.timing,
          stepsTemplate: copy.steps(
            '{zoneName}',
            '*.{baseDomain}',
            '{baseDomain}',
            '{dashboardRecordName}'
          ),
          retryHint: copy.retryHint,
          continueHint: copy.continueHint,
          dashboardLinkLabel: copy.dashboardLinkLabel,
          docsLinkLabel: copy.docsLinkLabel,
          confirmSuffix: copy.confirmSuffix,
        },
      ])
    )
  );
  const cloudflareDnsAddRecordImageDataUriJson = JSON.stringify(
    CLOUDFLARE_DNS_ADD_RECORD_IMAGE_DATA_URI
  );

  // Generate locale options HTML server-side
  const localeOptionsHtml = availableLocales
    .map(
      (l) =>
        `<option value="${l.code}"${l.code === locale ? ' selected' : ''}>${l.nativeName}</option>`
    )
    .join('');
  const setupCopy = getSetupUiCopy(locale);
  const setupUiCopyJson = JSON.stringify(SETUP_UI_COPY);
  const prepareStepLabel =
    typeof translations['web.prereq.title'] === 'string'
      ? translations['web.prereq.title']
      : setupCopy.stepLabels[0];
  const setupStepLabels = [...setupCopy.stepLabels];
  setupStepLabels[0] = prepareStepLabel;
  const startCopy = {
    target: setupCopy.startTarget,
    runtime: setupCopy.startRuntime,
    theme: setupCopy.startTheme,
    kicker: setupCopy.startKicker,
    title: setupCopy.startTitle,
    aside: setupCopy.startAside,
    wrangler: setupCopy.startWrangler,
    account: setupCopy.startAccount,
    subdomain: setupCopy.startSubdomain,
    unknown: setupCopy.startUnknown,
    newNum: '',
    newTitle: setupCopy.startNewTitle,
    newDesc: setupCopy.startNewDesc,
    newAction: setupCopy.startNewAction,
    loadNum: '',
    loadTitle: setupCopy.startLoadTitle,
    loadDesc: setupCopy.startLoadDesc,
    loadAction: setupCopy.startLoadAction,
    manageNum: '',
    manageTitle: setupCopy.startManageTitle,
    manageDesc: setupCopy.startManageDesc,
    manageAction: setupCopy.startManageAction,
  };

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authrim Setup</title>
  <style>${SETUP_WEB_FONT_FACE}
${SETUP_WEB_UI_STYLE}</style>
  <script>
    // i18n Translation System
    let _translations = ${translationsJson};
    const _availableLocales = ${availableLocalesJson};
    const _setupUiCopy = ${setupUiCopyJson};
    let _currentLocale = '${locale}';
    let lastCompleteResult = null;

    /**
     * Translate a key with optional parameter substitution
     * @param {string} key - Translation key
     * @param {Object} params - Parameters for substitution {{param}}
     * @returns {string} Translated string or key if not found
     */
    function getSetupUiFallbackTranslation(key) {
      const copy = getSetupUiRuntimeCopy();
      const staticCopy = getSetupStaticFallbackCopy();
      const fallback = {
        'setup.step.1': copy.stepLabels[0],
        'setup.step.2': copy.stepLabels[1],
        'setup.step.3': copy.stepLabels[2],
        'setup.step.4': copy.stepLabels[3],
        'setup.step.5': copy.stepLabels[4],
        'setup.step.6': copy.stepLabels[5],
        'setup.step.7': copy.stepLabels[6],
        'setup.step.8': copy.stepLabels[7],
        'setup.step.9': copy.stepLabels[8],
        'setup.start.target': copy.startTarget,
        'setup.start.theme': copy.startTheme,
        'setup.start.title': copy.startTitle,
        'setup.start.aside': copy.startAside,
        ...staticCopy,
      };

      return fallback[key];
    }

    function getSetupStaticFallbackCopy(locale = _currentLocale) {
      const normalized = String(locale || '').toLowerCase();
      const language = normalized.startsWith('zh-tw')
        ? 'zh-TW'
        : normalized.startsWith('zh')
          ? 'zh-CN'
          : normalized.split('-')[0];
      const copyByLocale = {
        en: {
          'web.domain.bindingHint': 'Bind the selected domain to',
          'web.header.setupWizard': 'Setup Wizard',
          'web.header.subtitle': 'OIDC Provider on Cloudflare Workers',
          'web.domain.multiTenantMode': 'Multi-tenant mode',
          'web.domain.livePreview': 'Live preview',
          'web.domain.uiDomains': 'UI Domains',
          'web.domain.loginUiDomain': 'Login UI domain',
          'web.domain.adminUiDomain': 'Admin UI domain',
          'web.domain.defaultWhenEmpty': 'Default when empty:',
          'web.domain.corsNote': 'Cross-origin requests from Login UI / Admin UI to the API are allowed automatically. No separate configuration is required.',
          'web.domain.deploymentPreview': 'Deployment preview',
          'web.domain.review': 'Review',
          'web.domain.issuerInitialTenant': 'Issuer URL (initial tenant)',
          'web.domain.loginUiOrigin': 'Login UI origin',
          'web.domain.adminUiApiMode': 'Admin UI API mode',
          'web.domain.previewHelp': 'If a combination has an issue, warnings and repair hints appear below.',
          'web.basic.envIsolation': 'Each environment gets its own Workers, D1 databases, and KV namespaces.',
          'web.basic.componentsNote': 'The API is always included. UIs are optional when using your own frontend through the SDK.',
          'web.domain.workersDevFallback': 'Leave the base domain empty to deploy to workers.dev. This is useful for evaluation and requires no DNS changes.',
          'web.domain.generateRandom': 'Generate Random',
          'web.domain.primaryTenantNote': 'When naked domain mode is enabled, specify the tenant that runs directly on the base domain.',
          'web.domain.primaryTenantLabel': 'Tenant that uses the naked URL',
          'web.domain.primaryTenantPlaceholder': 'Leave empty to use initial tenant',
          'web.domain.primaryTenantInitialHint': 'Tenant ID to use when accessing the naked domain. Leave empty to use the first tenant above.',
          'web.domain.uiDomainsNote': 'Each UI domain can be configured independently. DNS can be configured automatically when the zone is available.',
          'web.email.queuePlanGuide': 'Workers Free plan guide',
          'web.email.queueResourceNote': 'When enabled, logging queues are added during resource creation. Features that affect OIDC conformance remain disabled by default.',
          'web.common.notSelected': 'Not selected',
          'web.prereq.environmentCheck': 'Environment Check',
          'web.prereq.recheck': 'Re-check',
          'web.prereq.continueStart': 'Continue to Start',
          'web.loadConfig.kicker': 'Setup - Load Configuration',
          'web.loadConfig.heroAside': 'Select a saved <b>authrim-config.json</b>. After validation passes, the wizard can resume from that configuration.',
          'web.loadConfig.fileSelection': 'File Selection',
          'web.loadConfig.dropConfigHere': 'Drop authrim-config.json here',
          'web.loadConfig.chooseJsonOnly': 'or click to choose a file - .json only',
          'web.loadConfig.validationOk': 'Validation OK',
          'web.loadConfig.validationOkDesc': 'The configuration is valid. Review it and continue.',
          'web.loadConfig.validationHelp': 'If validation finds a problem, errors and repair hints are shown here.',
          'web.loadConfig.configurationFile': 'Configuration file',
          'web.loadConfig.loadedConfiguration': 'Loaded Configuration',
          'web.loadConfig.validated': 'Validated ✓',
          'web.loadConfig.pendingValidation': 'Pending validation',
          'web.loadConfig.environment': 'Environment',
          'web.loadConfig.baseDomain': 'Base domain',
          'web.loadConfig.multiTenant': 'Multi-tenant',
          'web.loadConfig.enabledInitialTenant': 'Enabled (initial tenant: {{tenant}})',
          'web.loadConfig.components': 'Components',
          'web.loadConfig.d1Regions': 'D1 regions',
          'web.loadConfig.emailProvider': 'Email provider',
          'web.loadConfig.envConflictConfirm': 'This configuration uses an existing environment name.\\n\\nEnvironment: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nContinuing and deploying with this configuration may overwrite the existing environment. Continue?',
          'web.loadConfig.validating': 'Validating',
          'web.loadConfig.loadDeploy': 'Load & Deploy',
          'web.loadConfig.provisionedValid': 'The configuration is valid. Resources are already provisioned, so setup can resume from Step 08 (Deploy).',
          'web.envDetail.initialDeployRecoveryTitle': 'Initial deployment incomplete',
          'web.envDetail.initialDeployRecoveryDesc': 'The previous deployment stopped before verification. Existing resources will be reused when you resume.',
          'web.envDetail.initialDeployRecoveryAction': 'Resume initial deployment',
          'web.envDetail.initialDeployRecoveryVerified': 'Cloudflare state verified. Completed: {{completed}}. Resume from {{stage}}.',
          'web.envDetail.initialDeployRecoveryStageMigrations': 'database migration verification',
          'web.envDetail.initialDeployRecoveryStageControlPlane': 'initial deployment setup',
          'web.envDetail.initialDeployRecoveryStageWorkers': 'Worker deployment',
          'web.envDetail.initialDeployRecoveryStageVerification': 'post-deployment verification',
          'web.envDetail.initialDeployRecoveryResources': 'resource provisioning',
          'web.envDetail.initialDeployRecoverySchema': 'database migrations',
          'web.envDetail.initialDeployRecoveryWorkers': 'Worker deployment',
          'web.envDetail.initialDeployRecoveryRecreate': 'The saved checkpoint does not match Cloudflare. Resume is disabled. Delete this incomplete environment and create it again.',
          'web.envDetail.initialDeployRecoveryManifestChanged': 'The draft migration definition changed after initial deployment started, so the saved deployment state may no longer match the databases. Resume is disabled. Delete this incomplete environment and create it again.',
          'web.envDetail.initialDeployRecoveryBlocked': 'The current state could not be verified, so resume is disabled. Check the Cloudflare connection and recheck this environment. If verification continues to fail, delete the incomplete environment and create it again.',
          'web.envDetail.initialDeployRecoveryTokenRequired': ' Deployment credentials need to be refreshed; a new one-time Cloudflare token will be requested.',
          'web.deploy.retryDeploy': 'Retry deployment',
          'web.loadConfig.checkingEnvironment': 'Checking environment',
          'web.provision.resourcesToCreate': 'Resources to Create',
          'web.provision.queues': 'Queues',
          'web.provision.queuesDisabled': 'Cloudflare Queues is disabled, so queues will not be created.',
          'web.provision.durableObjectsNote': 'Durable Objects such as SessionStore and KeyManager are defined during deployment in the next step, not during resource creation.',
          'web.provision.progress': 'Progress',
          'web.provision.runningMigrations': 'Running migrations',
          'web.provision.elapsedPending': 'Waiting for progress...',
          'web.provision.detailedLog': 'Detailed log',
          'web.provision.keyStorageTitle': 'Key storage location - handle carefully',
          'web.provision.directory': 'Directory',
          'web.provision.keyStorageNote': 'Keep this directory safe and add it to .gitignore. Private keys are also uploaded as Workers secrets, but the local copy is the only recovery source.',
          'web.provision.retrySafeNote': 'Already-created resources are skipped on rerun, so you can safely retry the same operation after an interruption. Save the configuration before moving to deploy.',
          'web.provision.runningTasks': 'Task {{current}} / {{total}} running',
          'web.provision.jwtSigning': 'JWT signing',
          'web.provision.setupMachineAuth': 'setup machine auth',
          'web.provision.aesSecrets': 'AES secrets x4',
          'web.provision.encryption': 'encryption',
          'web.deploy.progress': 'Progress',
          'web.deploy.elapsedPending': 'Waiting for progress...',
          'web.deploy.wranglerLog': 'wrangler log',
          'web.deploy.cancelDeploy': 'Cancel Deploy',
          'web.deploy.continueComplete': 'Continue to Complete',
          'web.deploy.manualWildcardTitle': 'Check wildcard DNS setup',
          'web.deploy.manualWildcardSummary': 'The wildcard DNS record for tenant URLs could not be confirmed. If you already created it, click Re-check DNS. Otherwise, add the record shown below.',
          'web.deploy.manualWildcardStep1': 'Open Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Add a CNAME record: name {{record}}, target {{target}}, proxy on.',
          'web.deploy.manualWildcardStep3': 'After adding it, click Re-check DNS on this screen.',
          'web.deploy.openCloudflareDns': 'Open Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'DNS docs ↗',
          'web.deploy.recheckDns': 'Re-check DNS',
          'web.complete.endpoints': 'Endpoints',
          'web.complete.verified': 'verified ✓',
          'web.complete.progress': 'Setup complete - you can close this window',
          'web.complete.openEnvDetail': 'Open environment detail',
          'web.complete.authorizationEndpoint': 'Authorization endpoint',
          'web.complete.tokenEndpoint': 'Token endpoint',
          'web.complete.expiresOneHour': ' - expires in 1 hour',
          'web.complete.adminSetupLabel': 'Admin Setup',
        },
        ja: {
          'web.domain.bindingHint': '選択したドメインを紐付けます:',
          'web.header.setupWizard': 'セットアップウィザード',
          'web.header.subtitle': 'Cloudflare Workers 上の OIDC Provider',
          'web.domain.multiTenantMode': 'マルチテナントモード',
          'web.domain.livePreview': 'ライブプレビュー',
          'web.domain.uiDomains': 'UIドメイン',
          'web.domain.loginUiDomain': 'Login UI ドメイン',
          'web.domain.adminUiDomain': 'Admin UI ドメイン',
          'web.domain.defaultWhenEmpty': '空欄時のデフォルト:',
          'web.domain.corsNote': 'Login UI / Admin UI からAPIへのクロスオリジンリクエストは自動的に許可されます。個別の設定は不要です。',
          'web.domain.deploymentPreview': 'この構成でデプロイされます',
          'web.domain.review': '確認',
          'web.domain.issuerInitialTenant': 'Issuer URL（初期テナント）',
          'web.domain.loginUiOrigin': 'Login UI 配信元',
          'web.domain.adminUiApiMode': 'Admin UI APIモード',
          'web.domain.previewHelp': '組み合わせに問題がある場合は、この下に警告と修正案を表示します。',
          'web.basic.envIsolation': '環境ごとに専用の Workers・D1・KV が作られ、互いに干渉しません。',
          'web.basic.componentsNote': 'APIは常に含まれます。UIは独自フロントエンドをSDKで使う場合は省略できます。',
          'web.domain.workersDevFallback': 'ベースドメインを空欄にすると workers.dev にデプロイします。DNS不要で評価用に適しています。',
          'web.domain.generateRandom': 'ランダム生成',
          'web.domain.primaryTenantNote': 'ネイキッドドメインを有効にした場合は、ベースドメイン直下で動くテナントのIDをここで指定します。',
          'web.domain.primaryTenantLabel': 'URLにテナント名を含めないテナント',
          'web.domain.primaryTenantPlaceholder': '空欄なら初期テナントを使用',
          'web.domain.primaryTenantInitialHint': 'ネイキッドドメインで表示するテナントIDです。空欄なら上の初期テナントを使います。',
          'web.domain.uiDomainsNote': 'それぞれ独立して設定できます。ベースドメインと同じゾーンならDNSも自動構成されます。',
          'web.email.queuePlanGuide': 'Workers Free プランの目安',
          'web.email.queueResourceNote': '有効にするとログ配送用のキューがリソース作成ステップで追加されます。OIDC適合性に影響する機能は既定で無効です。',
          'web.common.notSelected': '未選択',
          'web.prereq.environmentCheck': '環境チェック',
          'web.prereq.recheck': '再チェック',
          'web.prereq.continueStart': '開始へ進む',
          'web.loadConfig.kicker': 'セットアップ - 設定の読み込み',
          'web.loadConfig.heroAside': '保存済みの <b>authrim-config.json</b> を選択してください。検証に合格すると、その内容でウィザードを再開できます。',
          'web.loadConfig.fileSelection': 'ファイル選択',
          'web.loadConfig.dropConfigHere': 'authrim-config.json をここにドロップ',
          'web.loadConfig.chooseJsonOnly': 'またはクリックしてファイルを選択 - .json のみ',
          'web.loadConfig.validationOk': '検証OK',
          'web.loadConfig.validationOkDesc': '設定は有効です。内容を確認して続行できます。',
          'web.loadConfig.validationHelp': '検証で問題が見つかった場合は、エラー項目の一覧と修正のヒントをここに表示します。',
          'web.loadConfig.configurationFile': '設定ファイル',
          'web.loadConfig.loadedConfiguration': '読み込んだ設定',
          'web.loadConfig.validated': '検証済み ✓',
          'web.loadConfig.pendingValidation': '検証待ち',
          'web.loadConfig.environment': '環境名',
          'web.loadConfig.baseDomain': 'ベースドメイン',
          'web.loadConfig.multiTenant': 'マルチテナント',
          'web.loadConfig.enabledInitialTenant': '有効（初期テナント: {{tenant}}）',
          'web.loadConfig.components': 'コンポーネント',
          'web.loadConfig.d1Regions': 'D1 リージョン',
          'web.loadConfig.emailProvider': 'メールプロバイダ',
          'web.loadConfig.envConflictConfirm': '既存の環境名と同じです。\\n\\n環境: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nこのまま設定を継続してデプロイした場合、既存環境が上書きされる可能性があります。続行しますか？',
          'web.loadConfig.validating': '検証中',
          'web.loadConfig.loadDeploy': '読み込んでデプロイへ',
          'web.loadConfig.provisionedValid': '設定は有効です。リソース作成は完了しているため、ステップ08（デプロイ）から再開できます。',
          'web.envDetail.initialDeployRecoveryTitle': '初回デプロイが完了していません',
          'web.envDetail.initialDeployRecoveryDesc': '前回のデプロイは検証前に停止しました。作成済みのリソースを再利用して再開できます。',
          'web.envDetail.initialDeployRecoveryAction': '初回デプロイを再開',
          'web.envDetail.initialDeployRecoveryVerified': 'Cloudflare 上の状態を確認しました。完了済み: {{completed}}。{{stage}}から再開できます。',
          'web.envDetail.initialDeployRecoveryStageMigrations': 'データベースマイグレーションの検証',
          'web.envDetail.initialDeployRecoveryStageControlPlane': '初回デプロイの準備',
          'web.envDetail.initialDeployRecoveryStageWorkers': 'Worker のデプロイ',
          'web.envDetail.initialDeployRecoveryStageVerification': 'デプロイ後の検証',
          'web.envDetail.initialDeployRecoveryResources': 'リソース作成',
          'web.envDetail.initialDeployRecoverySchema': 'データベースマイグレーション',
          'web.envDetail.initialDeployRecoveryWorkers': 'Worker のデプロイ',
          'web.envDetail.initialDeployRecoveryRecreate': '保存されたチェックポイントと Cloudflare 上の状態が一致しないため、再開を無効にしました。この不完全な環境を削除して、最初から作り直してください。',
          'web.envDetail.initialDeployRecoveryManifestChanged': '初回デプロイ開始後にデータベースの定義が変わり、保存済みの進行状況と現在のデータベースが一致しない可能性があります。安全のため再開を無効にしました。この不完全な環境を削除して、最初から作り直してください。',
          'web.envDetail.initialDeployRecoveryBlocked': '現在の状態を確認できなかったため、再開を無効にしました。Cloudflare 接続を確認して、この環境を再チェックしてください。確認できない状態が続く場合は、不完全な環境を削除して作り直してください。',
          'web.envDetail.initialDeployRecoveryTokenRequired': ' デプロイ用の接続情報を更新するため、新しい一時 Cloudflare token の入力が必要です。',
          'web.deploy.retryDeploy': 'デプロイを再試行',
          'web.loadConfig.checkingEnvironment': '既存環境を確認中',
          'web.provision.resourcesToCreate': '作成されるリソース',
          'web.provision.queues': 'Queues',
          'web.provision.queuesDisabled': 'Cloudflare Queues は無効のため、キューは作成されません。',
          'web.provision.durableObjectsNote': 'Durable Objects（SessionStore・KeyManager など）はリソース作成ではなく、次のステップのデプロイ時に定義されます。',
          'web.provision.progress': '実行状況',
          'web.provision.runningMigrations': 'マイグレーション実行中',
          'web.provision.elapsedPending': '進行状況を待機中...',
          'web.provision.detailedLog': '詳細ログ',
          'web.provision.keyStorageTitle': '鍵の保存先 - 取り扱い注意',
          'web.provision.directory': 'ディレクトリ',
          'web.provision.keyStorageNote': 'このディレクトリは安全に保管し、.gitignore に追加してください。秘密鍵はWorkersシークレットにもアップロードされますが、ローカルのコピーが唯一の再発行手段です。',
          'web.provision.retrySafeNote': '作成済みのリソースは再実行時にスキップされるため、途中で失敗しても同じ操作を安全にやり直せます。完了後は設定を保存してからデプロイへ進んでください。',
          'web.provision.runningTasks': 'タスク {{current}} / {{total}} 実行中',
          'web.provision.jwtSigning': 'JWT署名',
          'web.provision.setupMachineAuth': 'セットアップ機械認証',
          'web.provision.aesSecrets': 'AES シークレット x4',
          'web.provision.encryption': '暗号化',
          'web.deploy.progress': '実行状況',
          'web.deploy.elapsedPending': '進行状況を待機中...',
          'web.deploy.wranglerLog': 'wrangler log',
          'web.deploy.cancelDeploy': 'デプロイを中止',
          'web.deploy.continueComplete': '完了へ',
          'web.deploy.manualWildcardTitle': 'ワイルドカードDNS設定の確認',
          'web.deploy.manualWildcardSummary': 'テナントURL用のワイルドカードDNSレコードを確認できていません。すでに設定済みの場合は「DNSを再確認」を押してください。未設定の場合は、以下のレコードを追加してください。',
          'web.deploy.manualWildcardStep1': 'Cloudflareダッシュボード -> {{zone}} -> DNS > Records を開く',
          'web.deploy.manualWildcardStep2': 'タイプ CNAME、名前 {{record}}、ターゲット {{target}}、Proxy オンで追加',
          'web.deploy.manualWildcardStep3': '追加後にこの画面の「DNSを再確認」を押す',
          'web.deploy.openCloudflareDns': 'Cloudflare DNS を開く ↗',
          'web.deploy.openDnsDocs': 'DNSドキュメント ↗',
          'web.deploy.recheckDns': 'DNSを再確認',
          'web.complete.endpoints': 'エンドポイント',
          'web.complete.verified': '検証済み ✓',
          'web.complete.progress': 'セットアップ完了 - このウィンドウは閉じて構いません',
          'web.complete.openEnvDetail': '環境詳細を開く',
          'web.complete.authorizationEndpoint': '認可エンドポイント',
          'web.complete.tokenEndpoint': 'トークンエンドポイント',
          'web.complete.expiresOneHour': ' - 有効期限 1時間',
          'web.complete.adminSetupLabel': 'Admin Setup',
        },
        'zh-CN': {
          'web.domain.bindingHint': '将所选域名绑定到',
          'web.header.setupWizard': '设置向导',
          'web.header.subtitle': '运行在 Cloudflare Workers 上的 OIDC Provider',
          'web.domain.multiTenantMode': '多租户模式',
          'web.domain.livePreview': '实时预览',
          'web.domain.uiDomains': 'UI 域名',
          'web.domain.loginUiDomain': 'Login UI 域名',
          'web.domain.adminUiDomain': 'Admin UI 域名',
          'web.domain.defaultWhenEmpty': '留空时默认：',
          'web.domain.corsNote': 'Login UI / Admin UI 到 API 的跨源请求会自动允许，无需单独配置。',
          'web.domain.deploymentPreview': '部署预览',
          'web.domain.review': '检查',
          'web.domain.issuerInitialTenant': 'Issuer URL（初始租户）',
          'web.domain.loginUiOrigin': 'Login UI 来源',
          'web.domain.adminUiApiMode': 'Admin UI API 模式',
          'web.domain.previewHelp': '如果组合存在问题，警告和修正建议会显示在下方。',
          'web.basic.envIsolation': '每个环境都会拥有独立的 Workers、D1 数据库和 KV 命名空间。',
          'web.basic.componentsNote': 'API 始终包含在内。使用 SDK 接入自有前端时，可以不部署 UI。',
          'web.domain.workersDevFallback': '基础域名留空时会部署到 workers.dev。适合评估且无需 DNS 变更。',
          'web.domain.generateRandom': '随机生成',
          'web.domain.primaryTenantNote': '启用裸域名模式时，在这里指定直接运行在基础域名上的租户 ID。',
          'web.domain.primaryTenantLabel': '使用无租户名 URL 的租户',
          'web.domain.primaryTenantPlaceholder': '留空则使用初始租户',
          'web.domain.primaryTenantInitialHint': '访问裸域名时使用的租户 ID。留空则使用上面的第一个租户。',
          'web.domain.uiDomainsNote': '各 UI 域名可独立配置。若与基础域名属于同一 Zone，可自动配置 DNS。',
          'web.email.queuePlanGuide': 'Workers Free 计划参考',
          'web.email.queueResourceNote': '启用后，日志队列会在资源创建步骤中加入。影响 OIDC 合规性的功能默认保持关闭。',
        },
        'zh-TW': {
          'web.domain.bindingHint': '將所選網域綁定到',
          'web.header.setupWizard': '設定精靈',
          'web.header.subtitle': '執行於 Cloudflare Workers 的 OIDC Provider',
          'web.domain.multiTenantMode': '多租戶模式',
          'web.domain.livePreview': '即時預覽',
          'web.domain.uiDomains': 'UI 網域',
          'web.domain.loginUiDomain': 'Login UI 網域',
          'web.domain.adminUiDomain': 'Admin UI 網域',
          'web.domain.defaultWhenEmpty': '空白時預設：',
          'web.domain.corsNote': 'Login UI / Admin UI 到 API 的跨來源請求會自動允許，無需個別設定。',
          'web.domain.deploymentPreview': '部署預覽',
          'web.domain.review': '確認',
          'web.domain.issuerInitialTenant': 'Issuer URL（初始租戶）',
          'web.domain.loginUiOrigin': 'Login UI 來源',
          'web.domain.adminUiApiMode': 'Admin UI API 模式',
          'web.domain.previewHelp': '如果組合有問題，警告與修正建議會顯示在下方。',
          'web.basic.envIsolation': '每個環境都會擁有獨立的 Workers、D1 資料庫和 KV 命名空間。',
          'web.basic.componentsNote': 'API 一律包含。使用 SDK 接入自有前端時，可以不部署 UI。',
          'web.domain.workersDevFallback': '基礎網域空白時會部署到 workers.dev。適合評估且不需要 DNS 變更。',
          'web.domain.generateRandom': '隨機產生',
          'web.domain.primaryTenantNote': '啟用裸網域模式時，請在這裡指定直接運行於基礎網域上的租戶 ID。',
          'web.domain.primaryTenantLabel': '使用無租戶名稱 URL 的租戶',
          'web.domain.primaryTenantPlaceholder': '留空則使用初始租戶',
          'web.domain.primaryTenantInitialHint': '存取裸網域時使用的租戶 ID。留空則使用上方的第一個租戶。',
          'web.domain.uiDomainsNote': '各 UI 網域可獨立設定。若與基礎網域屬於同一 Zone，可自動設定 DNS。',
          'web.email.queuePlanGuide': 'Workers Free 方案參考',
          'web.email.queueResourceNote': '啟用後，日誌佇列會在資源建立步驟中加入。影響 OIDC 合規性的功能預設保持關閉。',
        },
        es: {
          'web.domain.bindingHint': 'Vincular el dominio seleccionado a',
          'web.header.setupWizard': 'Asistente de setup',
          'web.header.subtitle': 'OIDC Provider en Cloudflare Workers',
          'web.domain.multiTenantMode': 'Modo multi-tenant',
          'web.domain.livePreview': 'Vista previa en vivo',
          'web.domain.uiDomains': 'Dominios de UI',
          'web.domain.loginUiDomain': 'Dominio de Login UI',
          'web.domain.adminUiDomain': 'Dominio de Admin UI',
          'web.domain.defaultWhenEmpty': 'Predeterminado si está vacío:',
          'web.domain.corsNote': 'Las solicitudes de origen cruzado desde Login UI / Admin UI hacia la API se permiten automáticamente. No se requiere configuración adicional.',
          'web.domain.deploymentPreview': 'Vista previa del despliegue',
          'web.domain.review': 'Revisar',
          'web.domain.issuerInitialTenant': 'Issuer URL (tenant inicial)',
          'web.domain.loginUiOrigin': 'Origen de Login UI',
          'web.domain.adminUiApiMode': 'Modo API de Admin UI',
          'web.domain.previewHelp': 'Si una combinación tiene problemas, las advertencias y sugerencias aparecerán abajo.',
          'web.basic.envIsolation': 'Cada entorno tiene sus propios Workers, bases D1 y namespaces KV.',
          'web.basic.componentsNote': 'La API siempre se incluye. Las UI son opcionales si usas tu propio frontend con el SDK.',
          'web.domain.workersDevFallback': 'Deja el dominio base vacío para desplegar en workers.dev. Es útil para evaluación y no requiere cambios DNS.',
          'web.domain.generateRandom': 'Generar aleatorio',
          'web.domain.primaryTenantNote': 'Al activar el dominio naked, indica aquí el tenant que se ejecuta directamente en el dominio base.',
          'web.domain.primaryTenantLabel': 'Tenant que usa la URL sin nombre de tenant',
          'web.domain.primaryTenantPlaceholder': 'Vacío para usar el tenant inicial',
          'web.domain.primaryTenantInitialHint': 'ID del tenant usado al acceder al dominio naked. Déjalo vacío para usar el primer tenant.',
          'web.domain.uiDomainsNote': 'Cada dominio de UI puede configurarse de forma independiente. Si comparte zona con el dominio base, DNS puede configurarse automáticamente.',
          'web.email.queuePlanGuide': 'Guía del plan Workers Free',
          'web.email.queueResourceNote': 'Al activarlo, se agregan colas de logging durante la creación de recursos. Las funciones que afectan la conformidad OIDC siguen desactivadas por defecto.',
        },
        pt: {
          'web.domain.bindingHint': 'Vincular o domínio selecionado a',
          'web.header.setupWizard': 'Assistente de setup',
          'web.header.subtitle': 'OIDC Provider no Cloudflare Workers',
          'web.domain.multiTenantMode': 'Modo multi-tenant',
          'web.domain.livePreview': 'Prévia ao vivo',
          'web.domain.uiDomains': 'Domínios da UI',
          'web.domain.loginUiDomain': 'Domínio da Login UI',
          'web.domain.adminUiDomain': 'Domínio da Admin UI',
          'web.domain.defaultWhenEmpty': 'Padrão quando vazio:',
          'web.domain.corsNote': 'Requisições cross-origin da Login UI / Admin UI para a API são permitidas automaticamente. Nenhuma configuração separada é necessária.',
          'web.domain.deploymentPreview': 'Prévia do deploy',
          'web.domain.review': 'Revisar',
          'web.domain.issuerInitialTenant': 'Issuer URL (tenant inicial)',
          'web.domain.loginUiOrigin': 'Origem da Login UI',
          'web.domain.adminUiApiMode': 'Modo de API da Admin UI',
          'web.domain.previewHelp': 'Se uma combinação tiver problema, avisos e sugestões aparecerão abaixo.',
          'web.basic.envIsolation': 'Cada ambiente recebe seus próprios Workers, bancos D1 e namespaces KV.',
          'web.basic.componentsNote': 'A API sempre é incluída. As UIs são opcionais quando você usa seu próprio frontend via SDK.',
          'web.domain.workersDevFallback': 'Deixe o domínio base vazio para fazer deploy em workers.dev. É útil para avaliação e não exige alterações de DNS.',
          'web.domain.generateRandom': 'Gerar aleatório',
          'web.domain.primaryTenantNote': 'Ao ativar o domínio naked, informe aqui o tenant que roda diretamente no domínio base.',
          'web.domain.primaryTenantLabel': 'Tenant que usa a URL sem nome de tenant',
          'web.domain.primaryTenantPlaceholder': 'Vazio para usar o tenant inicial',
          'web.domain.primaryTenantInitialHint': 'ID do tenant usado ao acessar o domínio naked. Deixe em branco para usar o primeiro tenant.',
          'web.domain.uiDomainsNote': 'Cada domínio de UI pode ser configurado de forma independente. Se estiver na mesma zona do domínio base, o DNS pode ser configurado automaticamente.',
          'web.email.queuePlanGuide': 'Guia do plano Workers Free',
          'web.email.queueResourceNote': 'Ao ativar, filas de logging são adicionadas durante a criação de recursos. Recursos que afetam conformidade OIDC continuam desativados por padrão.',
        },
        fr: {
          'web.domain.bindingHint': 'Associer le domaine sélectionné à',
          'web.header.setupWizard': 'Assistant de setup',
          'web.header.subtitle': 'OIDC Provider sur Cloudflare Workers',
          'web.domain.multiTenantMode': 'Mode multi-tenant',
          'web.domain.livePreview': 'Aperçu en direct',
          'web.domain.uiDomains': 'Domaines UI',
          'web.domain.loginUiDomain': 'Domaine Login UI',
          'web.domain.adminUiDomain': 'Domaine Admin UI',
          'web.domain.defaultWhenEmpty': 'Par défaut si vide :',
          'web.domain.corsNote': 'Les requêtes cross-origin depuis Login UI / Admin UI vers l’API sont autorisées automatiquement. Aucun réglage séparé n’est nécessaire.',
          'web.domain.deploymentPreview': 'Aperçu du déploiement',
          'web.domain.review': 'Vérification',
          'web.domain.issuerInitialTenant': 'Issuer URL (tenant initial)',
          'web.domain.loginUiOrigin': 'Origine Login UI',
          'web.domain.adminUiApiMode': 'Mode API Admin UI',
          'web.domain.previewHelp': 'Si une combinaison pose problème, les avertissements et corrections apparaîtront ci-dessous.',
          'web.basic.envIsolation': 'Chaque environnement possède ses propres Workers, bases D1 et namespaces KV.',
          'web.basic.componentsNote': 'L’API est toujours incluse. Les UI sont optionnelles si vous utilisez votre propre frontend via le SDK.',
          'web.domain.workersDevFallback': 'Laissez le domaine de base vide pour déployer sur workers.dev. C’est utile pour l’évaluation et ne nécessite aucun changement DNS.',
          'web.domain.generateRandom': 'Générer au hasard',
          'web.domain.primaryTenantNote': 'Quand le domaine naked est activé, indiquez ici le tenant qui s’exécute directement sur le domaine de base.',
          'web.domain.primaryTenantLabel': 'Tenant utilisant l’URL sans segment tenant',
          'web.domain.primaryTenantPlaceholder': 'Vide pour utiliser le tenant initial',
          'web.domain.primaryTenantInitialHint': 'ID du tenant utilisé sur le domaine naked. Laissez vide pour utiliser le premier tenant.',
          'web.domain.uiDomainsNote': 'Chaque domaine UI peut être configuré indépendamment. Si la zone est la même que celle du domaine de base, le DNS peut être configuré automatiquement.',
          'web.email.queuePlanGuide': 'Repère du plan Workers Free',
          'web.email.queueResourceNote': 'Si activé, des files de logs sont ajoutées lors de la création des ressources. Les fonctions affectant la conformité OIDC restent désactivées par défaut.',
        },
        de: {
          'web.domain.bindingHint': 'Ausgewählte Domain binden an',
          'web.header.setupWizard': 'Setup-Assistent',
          'web.header.subtitle': 'OIDC Provider auf Cloudflare Workers',
          'web.domain.multiTenantMode': 'Multi-Tenant-Modus',
          'web.domain.livePreview': 'Live-Vorschau',
          'web.domain.uiDomains': 'UI-Domains',
          'web.domain.loginUiDomain': 'Login-UI-Domain',
          'web.domain.adminUiDomain': 'Admin-UI-Domain',
          'web.domain.defaultWhenEmpty': 'Standard bei leerem Feld:',
          'web.domain.corsNote': 'Cross-Origin-Anfragen von Login UI / Admin UI an die API werden automatisch erlaubt. Keine separate Konfiguration erforderlich.',
          'web.domain.deploymentPreview': 'Deployment-Vorschau',
          'web.domain.review': 'Prüfen',
          'web.domain.issuerInitialTenant': 'Issuer-URL (erster Tenant)',
          'web.domain.loginUiOrigin': 'Login-UI-Origin',
          'web.domain.adminUiApiMode': 'Admin-UI-API-Modus',
          'web.domain.previewHelp': 'Wenn eine Kombination problematisch ist, erscheinen Warnungen und Korrekturhinweise unten.',
          'web.basic.envIsolation': 'Jede Umgebung erhält eigene Workers, D1-Datenbanken und KV-Namespaces.',
          'web.basic.componentsNote': 'Die API ist immer enthalten. UIs sind optional, wenn Sie ein eigenes Frontend über das SDK verwenden.',
          'web.domain.workersDevFallback': 'Lassen Sie die Basis-Domain leer, um auf workers.dev zu deployen. Das ist für Evaluationen geeignet und erfordert keine DNS-Änderungen.',
          'web.domain.generateRandom': 'Zufällig erzeugen',
          'web.domain.primaryTenantNote': 'Wenn der Naked-Domain-Modus aktiv ist, geben Sie hier den Tenant an, der direkt auf der Basis-Domain läuft.',
          'web.domain.primaryTenantLabel': 'Tenant für die Domain ohne Tenant-Segment',
          'web.domain.primaryTenantPlaceholder': 'Leer lassen für den ersten Tenant',
          'web.domain.primaryTenantInitialHint': 'Tenant-ID für Zugriffe auf die Naked Domain. Leer lassen, um den ersten Tenant zu verwenden.',
          'web.domain.uiDomainsNote': 'Jede UI-Domain kann separat konfiguriert werden. Liegt sie in derselben Zone wie die Basis-Domain, kann DNS automatisch konfiguriert werden.',
          'web.email.queuePlanGuide': 'Hinweis zum Workers-Free-Plan',
          'web.email.queueResourceNote': 'Wenn aktiviert, werden Logging-Warteschlangen beim Erstellen der Ressourcen hinzugefügt. Funktionen mit Einfluss auf OIDC-Konformität bleiben standardmäßig deaktiviert.',
        },
        ko: {
          'web.domain.bindingHint': '선택한 도메인을 다음에 연결',
          'web.header.setupWizard': '설정 마법사',
          'web.header.subtitle': 'Cloudflare Workers 기반 OIDC Provider',
          'web.domain.multiTenantMode': '멀티 테넌트 모드',
          'web.domain.livePreview': '실시간 미리보기',
          'web.domain.uiDomains': 'UI 도메인',
          'web.domain.loginUiDomain': 'Login UI 도메인',
          'web.domain.adminUiDomain': 'Admin UI 도메인',
          'web.domain.defaultWhenEmpty': '비워 두면 기본값:',
          'web.domain.corsNote': 'Login UI / Admin UI에서 API로 보내는 교차 출처 요청은 자동으로 허용됩니다. 별도 설정은 필요 없습니다.',
          'web.domain.deploymentPreview': '배포 미리보기',
          'web.domain.review': '확인',
          'web.domain.issuerInitialTenant': 'Issuer URL(초기 테넌트)',
          'web.domain.loginUiOrigin': 'Login UI 출처',
          'web.domain.adminUiApiMode': 'Admin UI API 모드',
          'web.domain.previewHelp': '조합에 문제가 있으면 아래에 경고와 수정 힌트가 표시됩니다.',
          'web.basic.envIsolation': '각 환경은 전용 Workers, D1 데이터베이스, KV 네임스페이스를 사용합니다.',
          'web.basic.componentsNote': 'API는 항상 포함됩니다. SDK로 자체 프런트엔드를 사용하는 경우 UI는 선택 사항입니다.',
          'web.domain.workersDevFallback': '베이스 도메인을 비워 두면 workers.dev에 배포됩니다. 평가용으로 적합하며 DNS 변경이 필요 없습니다.',
          'web.domain.generateRandom': '무작위 생성',
          'web.domain.primaryTenantNote': '네이키드 도메인 모드를 켜면 베이스 도메인에서 직접 동작할 테넌트 ID를 여기서 지정합니다.',
          'web.domain.primaryTenantLabel': '테넌트 이름 없는 URL을 사용하는 테넌트',
          'web.domain.primaryTenantPlaceholder': '비워 두면 초기 테넌트 사용',
          'web.domain.primaryTenantInitialHint': '네이키드 도메인 접속 시 사용할 테넌트 ID입니다. 비워 두면 위의 첫 번째 테넌트를 사용합니다.',
          'web.domain.uiDomainsNote': '각 UI 도메인은 독립적으로 설정할 수 있습니다. 베이스 도메인과 같은 Zone이면 DNS도 자동 구성할 수 있습니다.',
          'web.email.queuePlanGuide': 'Workers Free 플랜 참고',
          'web.email.queueResourceNote': '활성화하면 리소스 생성 단계에서 로깅 큐가 추가됩니다. OIDC 적합성에 영향을 주는 기능은 기본적으로 비활성화됩니다.',
        },
        ru: {
          'web.domain.bindingHint': 'Привязать выбранный домен к',
          'web.header.setupWizard': 'Мастер настройки',
          'web.header.subtitle': 'OIDC Provider на Cloudflare Workers',
          'web.domain.multiTenantMode': 'Мультитенантный режим',
          'web.domain.livePreview': 'Предпросмотр',
          'web.domain.uiDomains': 'Домены UI',
          'web.domain.loginUiDomain': 'Домен Login UI',
          'web.domain.adminUiDomain': 'Домен Admin UI',
          'web.domain.defaultWhenEmpty': 'По умолчанию, если пусто:',
          'web.domain.corsNote': 'Cross-origin запросы из Login UI / Admin UI к API разрешаются автоматически. Отдельная настройка не нужна.',
          'web.domain.deploymentPreview': 'Предпросмотр деплоя',
          'web.domain.review': 'Проверка',
          'web.domain.issuerInitialTenant': 'Issuer URL (первый тенант)',
          'web.domain.loginUiOrigin': 'Источник Login UI',
          'web.domain.adminUiApiMode': 'Режим API Admin UI',
          'web.domain.previewHelp': 'Если в сочетании есть проблема, предупреждения и подсказки появятся ниже.',
          'web.basic.envIsolation': 'У каждой среды свои Workers, базы D1 и пространства KV.',
          'web.basic.componentsNote': 'API всегда включен. UI можно не разворачивать, если вы используете собственный фронтенд через SDK.',
          'web.domain.workersDevFallback': 'Оставьте базовый домен пустым, чтобы развернуть в workers.dev. Это удобно для проверки и не требует изменений DNS.',
          'web.domain.generateRandom': 'Сгенерировать',
          'web.domain.primaryTenantNote': 'При включенном naked-домене укажите здесь тенанта, который будет работать напрямую на базовом домене.',
          'web.domain.primaryTenantLabel': 'Тенант, использующий URL без имени тенанта',
          'web.domain.primaryTenantPlaceholder': 'Пусто = первый тенант',
          'web.domain.primaryTenantInitialHint': 'ID тенанта для доступа к naked-домену. Оставьте пустым, чтобы использовать первого тенанта выше.',
          'web.domain.uiDomainsNote': 'Каждый UI-домен можно настроить отдельно. Если зона совпадает с базовым доменом, DNS можно настроить автоматически.',
          'web.email.queuePlanGuide': 'Ориентир для плана Workers Free',
          'web.email.queueResourceNote': 'При включении очереди логирования добавляются на этапе создания ресурсов. Функции, влияющие на OIDC-соответствие, по умолчанию отключены.',
        },
        id: {
          'web.domain.bindingHint': 'Tautkan domain yang dipilih ke',
          'web.header.setupWizard': 'Wizard setup',
          'web.header.subtitle': 'OIDC Provider di Cloudflare Workers',
          'web.domain.multiTenantMode': 'Mode multi-tenant',
          'web.domain.livePreview': 'Pratinjau langsung',
          'web.domain.uiDomains': 'Domain UI',
          'web.domain.loginUiDomain': 'Domain Login UI',
          'web.domain.adminUiDomain': 'Domain Admin UI',
          'web.domain.defaultWhenEmpty': 'Default jika kosong:',
          'web.domain.corsNote': 'Permintaan cross-origin dari Login UI / Admin UI ke API diizinkan otomatis. Tidak perlu konfigurasi terpisah.',
          'web.domain.deploymentPreview': 'Pratinjau deploy',
          'web.domain.review': 'Tinjau',
          'web.domain.issuerInitialTenant': 'Issuer URL (tenant awal)',
          'web.domain.loginUiOrigin': 'Origin Login UI',
          'web.domain.adminUiApiMode': 'Mode API Admin UI',
          'web.domain.previewHelp': 'Jika kombinasi bermasalah, peringatan dan saran perbaikan muncul di bawah.',
          'web.basic.envIsolation': 'Setiap environment mendapat Workers, database D1, dan namespace KV sendiri.',
          'web.basic.componentsNote': 'API selalu disertakan. UI bersifat opsional jika Anda memakai frontend sendiri lewat SDK.',
          'web.domain.workersDevFallback': 'Kosongkan domain dasar untuk deploy ke workers.dev. Ini cocok untuk evaluasi dan tidak memerlukan perubahan DNS.',
          'web.domain.generateRandom': 'Buat acak',
          'web.domain.primaryTenantNote': 'Saat mode naked domain aktif, tentukan tenant yang berjalan langsung di domain dasar di sini.',
          'web.domain.primaryTenantLabel': 'Tenant yang menggunakan URL tanpa nama tenant',
          'web.domain.primaryTenantPlaceholder': 'Kosongkan untuk memakai tenant awal',
          'web.domain.primaryTenantInitialHint': 'ID tenant untuk akses naked domain. Kosongkan untuk memakai tenant pertama di atas.',
          'web.domain.uiDomainsNote': 'Setiap domain UI dapat dikonfigurasi terpisah. Jika zonenya sama dengan domain dasar, DNS dapat dikonfigurasi otomatis.',
          'web.email.queuePlanGuide': 'Panduan paket Workers Free',
          'web.email.queueResourceNote': 'Jika diaktifkan, antrean logging ditambahkan saat pembuatan resource. Fitur yang memengaruhi kepatuhan OIDC tetap nonaktif secara default.',
        },
      };
      const flowCopyByLocale = {
        'zh-CN': {
          'web.common.notSelected': '未选择',
          'web.prereq.environmentCheck': '环境检查',
          'web.prereq.recheck': '重新检查',
          'web.prereq.continueStart': '继续到开始',
          'web.loadConfig.kicker': '设置 - 加载配置',
          'web.loadConfig.heroAside': '选择已保存的 <b>authrim-config.json</b>。验证通过后，向导可从该配置继续。',
          'web.loadConfig.fileSelection': '文件选择',
          'web.loadConfig.dropConfigHere': '将 authrim-config.json 拖到这里',
          'web.loadConfig.chooseJsonOnly': '或点击选择文件 - 仅 .json',
          'web.loadConfig.validationOk': '验证通过',
          'web.loadConfig.validationOkDesc': '配置有效。请确认内容后继续。',
          'web.loadConfig.validationHelp': '如果验证发现问题，错误和修复提示会显示在这里。',
          'web.loadConfig.configurationFile': '配置文件',
          'web.loadConfig.loadedConfiguration': '已加载的配置',
          'web.loadConfig.validated': '已验证 ✓',
          'web.loadConfig.pendingValidation': '等待验证',
          'web.loadConfig.environment': '环境',
          'web.loadConfig.baseDomain': '基础域名',
          'web.loadConfig.multiTenant': '多租户',
          'web.loadConfig.enabledInitialTenant': '已启用（初始租户：{{tenant}}）',
          'web.loadConfig.components': '组件',
          'web.loadConfig.d1Regions': 'D1 区域',
          'web.loadConfig.emailProvider': '邮件服务商',
          'web.loadConfig.envConflictConfirm': '此配置使用了已有环境名称。\\n\\n环境：{{env}}\\nWorkers：{{workers}} / D1：{{d1}} / KV：{{kv}}\\n\\n继续并部署可能会覆盖现有环境。是否继续？',
          'web.loadConfig.validating': '验证中',
          'web.loadConfig.loadDeploy': '加载并部署',
          'web.loadConfig.provisionedValid': '配置有效。资源已创建，可从步骤08（部署）继续。',
          'web.envDetail.initialDeployRecoveryTitle': '初始部署未完成',
          'web.envDetail.initialDeployRecoveryDesc': '上次部署在验证前停止。继续时将重复使用已创建的资源。',
          'web.envDetail.initialDeployRecoveryAction': '继续初始部署',
          'web.deploy.retryDeploy': '重试部署',
          'web.loadConfig.checkingEnvironment': '正在检查环境',
          'web.provision.resourcesToCreate': '将创建的资源',
          'web.provision.queues': '队列',
          'web.provision.queuesDisabled': 'Cloudflare Queues 已禁用，因此不会创建队列。',
          'web.provision.durableObjectsNote': 'Durable Objects 会在下一步部署时定义，而不是在资源创建阶段定义。',
          'web.provision.progress': '进度',
          'web.provision.runningMigrations': '正在运行迁移',
          'web.provision.elapsedPending': '等待进度...',
          'web.provision.detailedLog': '详细日志',
          'web.provision.keyStorageTitle': '密钥保存位置 - 请谨慎处理',
          'web.provision.directory': '目录',
          'web.provision.keyStorageNote': '请安全保存此目录并加入 .gitignore。私钥也会上传为 Workers secrets，但本地副本是唯一恢复来源。',
          'web.provision.retrySafeNote': '已创建的资源会在重新运行时跳过，因此中断后可安全重试。完成后请保存配置再进入部署。',
          'web.provision.runningTasks': '任务 {{current}} / {{total}} 运行中',
          'web.provision.jwtSigning': 'JWT 签名',
          'web.provision.setupMachineAuth': '设置机器认证',
          'web.provision.aesSecrets': 'AES 密钥 x4',
          'web.provision.encryption': '加密',
          'web.deploy.progress': '进度',
          'web.deploy.elapsedPending': '等待进度...',
          'web.deploy.wranglerLog': 'wrangler 日志',
          'web.deploy.cancelDeploy': '取消部署',
          'web.deploy.continueComplete': '继续到完成',
          'web.deploy.manualWildcardTitle': '检查通配 DNS 设置',
          'web.deploy.manualWildcardSummary': '无法确认租户 URL 所需的通配 DNS 记录。如果已经创建，请点击重新检查 DNS；否则请添加下方显示的记录。',
          'web.deploy.manualWildcardStep1': '打开 Cloudflare Dashboard -> {{zone}} -> DNS > Records。',
          'web.deploy.manualWildcardStep2': '添加 CNAME：名称 {{record}}，目标 {{target}}，开启代理。',
          'web.deploy.manualWildcardStep3': '添加后点击本页面的重新检查 DNS。',
          'web.deploy.openCloudflareDns': '打开 Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'DNS 文档 ↗',
          'web.deploy.recheckDns': '重新检查 DNS',
          'web.complete.endpoints': '端点',
          'web.complete.verified': '已验证 ✓',
          'web.complete.progress': '设置完成 - 可以关闭此窗口',
          'web.complete.openEnvDetail': '打开环境详情',
          'web.complete.authorizationEndpoint': '授权端点',
          'web.complete.tokenEndpoint': '令牌端点',
          'web.complete.expiresOneHour': ' - 1小时后过期',
          'web.complete.adminSetupLabel': '管理员设置',
        },
        'zh-TW': {
          'web.common.notSelected': '未選擇',
          'web.prereq.environmentCheck': '環境檢查',
          'web.prereq.recheck': '重新檢查',
          'web.prereq.continueStart': '繼續到開始',
          'web.loadConfig.kicker': '設定 - 載入設定',
          'web.loadConfig.heroAside': '選擇已保存的 <b>authrim-config.json</b>。驗證通過後，精靈可從該設定繼續。',
          'web.loadConfig.fileSelection': '檔案選擇',
          'web.loadConfig.dropConfigHere': '將 authrim-config.json 拖到這裡',
          'web.loadConfig.chooseJsonOnly': '或點擊選擇檔案 - 僅 .json',
          'web.loadConfig.validationOk': '驗證通過',
          'web.loadConfig.validationOkDesc': '設定有效。請確認內容後繼續。',
          'web.loadConfig.validationHelp': '如果驗證發現問題，錯誤與修復提示會顯示在這裡。',
          'web.loadConfig.configurationFile': '設定檔',
          'web.loadConfig.loadedConfiguration': '已載入的設定',
          'web.loadConfig.validated': '已驗證 ✓',
          'web.loadConfig.pendingValidation': '等待驗證',
          'web.loadConfig.environment': '環境',
          'web.loadConfig.baseDomain': '基礎網域',
          'web.loadConfig.multiTenant': '多租戶',
          'web.loadConfig.enabledInitialTenant': '已啟用（初始租戶：{{tenant}}）',
          'web.loadConfig.components': '元件',
          'web.loadConfig.d1Regions': 'D1 區域',
          'web.loadConfig.emailProvider': '郵件服務商',
          'web.loadConfig.envConflictConfirm': '此設定使用了既有環境名稱。\\n\\n環境：{{env}}\\nWorkers：{{workers}} / D1：{{d1}} / KV：{{kv}}\\n\\n繼續並部署可能會覆蓋既有環境。是否繼續？',
          'web.loadConfig.validating': '驗證中',
          'web.loadConfig.loadDeploy': '載入並部署',
          'web.loadConfig.provisionedValid': '設定有效。資源已建立，可從步驟08（部署）繼續。',
          'web.envDetail.initialDeployRecoveryTitle': '初始部署尚未完成',
          'web.envDetail.initialDeployRecoveryDesc': '上次部署在驗證前停止。繼續時會重複使用已建立的資源。',
          'web.envDetail.initialDeployRecoveryAction': '繼續初始部署',
          'web.deploy.retryDeploy': '重試部署',
          'web.loadConfig.checkingEnvironment': '正在檢查環境',
          'web.provision.resourcesToCreate': '將建立的資源',
          'web.provision.queues': '佇列',
          'web.provision.queuesDisabled': 'Cloudflare Queues 已停用，因此不會建立佇列。',
          'web.provision.durableObjectsNote': 'Durable Objects 會在下一步部署時定義，而不是在資源建立階段定義。',
          'web.provision.progress': '進度',
          'web.provision.runningMigrations': '正在執行遷移',
          'web.provision.elapsedPending': '等待進度...',
          'web.provision.detailedLog': '詳細日誌',
          'web.provision.keyStorageTitle': '金鑰保存位置 - 請謹慎處理',
          'web.provision.directory': '目錄',
          'web.provision.keyStorageNote': '請安全保存此目錄並加入 .gitignore。私鑰也會上傳為 Workers secrets，但本機副本是唯一復原來源。',
          'web.provision.retrySafeNote': '已建立的資源會在重新執行時跳過，因此中斷後可安全重試。完成後請保存設定再進入部署。',
          'web.provision.runningTasks': '任務 {{current}} / {{total}} 執行中',
          'web.provision.jwtSigning': 'JWT 簽章',
          'web.provision.setupMachineAuth': '設定機器認證',
          'web.provision.aesSecrets': 'AES 金鑰 x4',
          'web.provision.encryption': '加密',
          'web.deploy.progress': '進度',
          'web.deploy.elapsedPending': '等待進度...',
          'web.deploy.wranglerLog': 'wrangler 日誌',
          'web.deploy.cancelDeploy': '取消部署',
          'web.deploy.continueComplete': '繼續到完成',
          'web.deploy.manualWildcardTitle': '檢查萬用 DNS 設定',
          'web.deploy.manualWildcardSummary': '無法確認租戶 URL 所需的萬用 DNS 記錄。如果已經建立，請點擊重新檢查 DNS；否則請新增下方顯示的記錄。',
          'web.deploy.manualWildcardStep1': '開啟 Cloudflare Dashboard -> {{zone}} -> DNS > Records。',
          'web.deploy.manualWildcardStep2': '新增 CNAME：名稱 {{record}}，目標 {{target}}，開啟代理。',
          'web.deploy.manualWildcardStep3': '新增後點擊本頁面的重新檢查 DNS。',
          'web.deploy.openCloudflareDns': '開啟 Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'DNS 文件 ↗',
          'web.deploy.recheckDns': '重新檢查 DNS',
          'web.complete.endpoints': '端點',
          'web.complete.verified': '已驗證 ✓',
          'web.complete.progress': '設定完成 - 可以關閉此視窗',
          'web.complete.openEnvDetail': '開啟環境詳細',
          'web.complete.authorizationEndpoint': '授權端點',
          'web.complete.tokenEndpoint': '權杖端點',
          'web.complete.expiresOneHour': ' - 1小時後到期',
          'web.complete.adminSetupLabel': '管理員設定',
        },
        es: {
          'web.common.notSelected': 'No seleccionado',
          'web.prereq.environmentCheck': 'Comprobación del entorno',
          'web.prereq.recheck': 'Volver a comprobar',
          'web.prereq.continueStart': 'Continuar al inicio',
          'web.loadConfig.kicker': 'Setup - Cargar configuración',
          'web.loadConfig.heroAside': 'Selecciona un <b>authrim-config.json</b> guardado. Tras validar, el asistente puede continuar con esa configuración.',
          'web.loadConfig.fileSelection': 'Selección de archivo',
          'web.loadConfig.dropConfigHere': 'Arrastra authrim-config.json aquí',
          'web.loadConfig.chooseJsonOnly': 'o haz clic para elegir un archivo - solo .json',
          'web.loadConfig.validationOk': 'Validación correcta',
          'web.loadConfig.validationOkDesc': 'La configuración es válida. Revísala y continúa.',
          'web.loadConfig.validationHelp': 'Si la validación encuentra problemas, los errores y sugerencias aparecerán aquí.',
          'web.loadConfig.configurationFile': 'Archivo de configuración',
          'web.loadConfig.loadedConfiguration': 'Configuración cargada',
          'web.loadConfig.validated': 'Validada ✓',
          'web.loadConfig.pendingValidation': 'Pendiente de validación',
          'web.loadConfig.environment': 'Entorno',
          'web.loadConfig.baseDomain': 'Dominio base',
          'web.loadConfig.multiTenant': 'Multi-tenant',
          'web.loadConfig.enabledInitialTenant': 'Activado (tenant inicial: {{tenant}})',
          'web.loadConfig.components': 'Componentes',
          'web.loadConfig.d1Regions': 'Regiones D1',
          'web.loadConfig.emailProvider': 'Proveedor de email',
          'web.loadConfig.envConflictConfirm': 'Esta configuración usa un nombre de entorno existente.\\n\\nEntorno: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nContinuar y desplegar puede sobrescribir el entorno existente. ¿Continuar?',
          'web.loadConfig.validating': 'Validando',
          'web.loadConfig.loadDeploy': 'Cargar y desplegar',
          'web.loadConfig.provisionedValid': 'La configuración es válida. Los recursos ya están creados, así que puedes continuar desde el paso 08 (Deploy).',
          'web.envDetail.initialDeployRecoveryTitle': 'El despliegue inicial está incompleto',
          'web.envDetail.initialDeployRecoveryDesc': 'El despliegue anterior se detuvo antes de la verificación. Al reanudar, se reutilizarán los recursos existentes.',
          'web.envDetail.initialDeployRecoveryAction': 'Reanudar despliegue inicial',
          'web.deploy.retryDeploy': 'Reintentar despliegue',
          'web.loadConfig.checkingEnvironment': 'Comprobando entorno',
          'web.provision.resourcesToCreate': 'Recursos a crear',
          'web.provision.queues': 'Colas',
          'web.provision.queuesDisabled': 'Cloudflare Queues está desactivado; no se crearán colas.',
          'web.provision.durableObjectsNote': 'Durable Objects se define durante el despliegue del siguiente paso, no durante la creación de recursos.',
          'web.provision.progress': 'Progreso',
          'web.provision.runningMigrations': 'Ejecutando migraciones',
          'web.provision.elapsedPending': 'Esperando progreso...',
          'web.provision.detailedLog': 'Log detallado',
          'web.provision.keyStorageTitle': 'Ubicación de claves - manejar con cuidado',
          'web.provision.directory': 'Directorio',
          'web.provision.keyStorageNote': 'Guarda este directorio de forma segura y añádelo a .gitignore. Las claves privadas también se suben como Workers secrets, pero la copia local es la única fuente de recuperación.',
          'web.provision.retrySafeNote': 'Los recursos ya creados se omiten al reintentar, por lo que puedes repetir la operación de forma segura. Guarda la configuración antes de desplegar.',
          'web.provision.runningTasks': 'Tarea {{current}} / {{total}} en ejecución',
          'web.provision.jwtSigning': 'Firma JWT',
          'web.provision.setupMachineAuth': 'autenticación de máquina de setup',
          'web.provision.aesSecrets': 'secretos AES x4',
          'web.provision.encryption': 'cifrado',
          'web.deploy.progress': 'Progreso',
          'web.deploy.elapsedPending': 'Esperando progreso...',
          'web.deploy.wranglerLog': 'log de wrangler',
          'web.deploy.cancelDeploy': 'Cancelar despliegue',
          'web.deploy.continueComplete': 'Continuar a finalización',
          'web.deploy.manualWildcardTitle': 'Comprobar la configuración del DNS wildcard',
          'web.deploy.manualWildcardSummary': 'No se pudo confirmar el registro DNS wildcard de las URLs de tenants. Si ya lo has creado, pulsa Revisar DNS. Si no, añade el registro que se muestra abajo.',
          'web.deploy.manualWildcardStep1': 'Abre Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Añade un CNAME: nombre {{record}}, destino {{target}}, proxy activado.',
          'web.deploy.manualWildcardStep3': 'Después, pulsa Re-check DNS en esta pantalla.',
          'web.deploy.openCloudflareDns': 'Abrir Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'Docs DNS ↗',
          'web.deploy.recheckDns': 'Revisar DNS',
          'web.complete.endpoints': 'Endpoints',
          'web.complete.verified': 'verificado ✓',
          'web.complete.progress': 'Setup completado - puedes cerrar esta ventana',
          'web.complete.openEnvDetail': 'Abrir detalle del entorno',
          'web.complete.authorizationEndpoint': 'Endpoint de autorización',
          'web.complete.tokenEndpoint': 'Endpoint de token',
          'web.complete.expiresOneHour': ' - caduca en 1 hora',
          'web.complete.adminSetupLabel': 'Setup de admin',
        },
        pt: {
          'web.common.notSelected': 'Não selecionado',
          'web.prereq.environmentCheck': 'Verificação do ambiente',
          'web.prereq.recheck': 'Verificar novamente',
          'web.prereq.continueStart': 'Continuar para início',
          'web.loadConfig.kicker': 'Setup - Carregar configuração',
          'web.loadConfig.heroAside': 'Selecione um <b>authrim-config.json</b> salvo. Após a validação, o assistente pode continuar dessa configuração.',
          'web.loadConfig.fileSelection': 'Seleção de arquivo',
          'web.loadConfig.dropConfigHere': 'Solte authrim-config.json aqui',
          'web.loadConfig.chooseJsonOnly': 'ou clique para escolher um arquivo - apenas .json',
          'web.loadConfig.validationOk': 'Validação OK',
          'web.loadConfig.validationOkDesc': 'A configuração é válida. Revise e continue.',
          'web.loadConfig.validationHelp': 'Se a validação encontrar problemas, erros e dicas aparecerão aqui.',
          'web.loadConfig.configurationFile': 'Arquivo de configuração',
          'web.loadConfig.loadedConfiguration': 'Configuração carregada',
          'web.loadConfig.validated': 'Validado ✓',
          'web.loadConfig.pendingValidation': 'Validação pendente',
          'web.loadConfig.environment': 'Ambiente',
          'web.loadConfig.baseDomain': 'Domínio base',
          'web.loadConfig.multiTenant': 'Multi-tenant',
          'web.loadConfig.enabledInitialTenant': 'Ativado (tenant inicial: {{tenant}})',
          'web.loadConfig.components': 'Componentes',
          'web.loadConfig.d1Regions': 'Regiões D1',
          'web.loadConfig.emailProvider': 'Provedor de email',
          'web.loadConfig.envConflictConfirm': 'Esta configuração usa um nome de ambiente existente.\\n\\nAmbiente: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nContinuar e fazer deploy pode sobrescrever o ambiente existente. Continuar?',
          'web.loadConfig.validating': 'Validando',
          'web.loadConfig.loadDeploy': 'Carregar e fazer deploy',
          'web.loadConfig.provisionedValid': 'A configuração é válida. Os recursos já foram criados; você pode continuar do passo 08 (Deploy).',
          'web.envDetail.initialDeployRecoveryTitle': 'O deploy inicial não foi concluído',
          'web.envDetail.initialDeployRecoveryDesc': 'O deploy anterior parou antes da verificação. Os recursos existentes serão reutilizados ao continuar.',
          'web.envDetail.initialDeployRecoveryAction': 'Continuar o deploy inicial',
          'web.deploy.retryDeploy': 'Tentar deploy novamente',
          'web.loadConfig.checkingEnvironment': 'Verificando ambiente',
          'web.provision.resourcesToCreate': 'Recursos a criar',
          'web.provision.queues': 'Filas',
          'web.provision.queuesDisabled': 'Cloudflare Queues está desativado; nenhuma fila será criada.',
          'web.provision.durableObjectsNote': 'Durable Objects são definidos no deploy do próximo passo, não durante a criação dos recursos.',
          'web.provision.progress': 'Progresso',
          'web.provision.runningMigrations': 'Executando migrações',
          'web.provision.elapsedPending': 'Aguardando progresso...',
          'web.provision.detailedLog': 'Log detalhado',
          'web.provision.keyStorageTitle': 'Local das chaves - manuseie com cuidado',
          'web.provision.directory': 'Diretório',
          'web.provision.keyStorageNote': 'Guarde este diretório com segurança e adicione-o ao .gitignore. As chaves privadas também são enviadas como Workers secrets, mas a cópia local é a única fonte de recuperação.',
          'web.provision.retrySafeNote': 'Recursos já criados são ignorados na nova execução, então você pode repetir a operação com segurança. Salve a configuração antes do deploy.',
          'web.provision.runningTasks': 'Tarefa {{current}} / {{total}} em execução',
          'web.provision.jwtSigning': 'Assinatura JWT',
          'web.provision.setupMachineAuth': 'autenticação de máquina de setup',
          'web.provision.aesSecrets': 'segredos AES x4',
          'web.provision.encryption': 'criptografia',
          'web.deploy.progress': 'Progresso',
          'web.deploy.elapsedPending': 'Aguardando progresso...',
          'web.deploy.wranglerLog': 'log do wrangler',
          'web.deploy.cancelDeploy': 'Cancelar deploy',
          'web.deploy.continueComplete': 'Continuar para conclusão',
          'web.deploy.manualWildcardTitle': 'Verificar a configuração do DNS wildcard',
          'web.deploy.manualWildcardSummary': 'Não foi possível confirmar o registro DNS wildcard das URLs dos tenants. Se você já o criou, clique em Verificar DNS novamente. Caso contrário, adicione o registro mostrado abaixo.',
          'web.deploy.manualWildcardStep1': 'Abra Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Adicione CNAME: nome {{record}}, destino {{target}}, proxy ativado.',
          'web.deploy.manualWildcardStep3': 'Depois, clique em verificar DNS novamente nesta tela.',
          'web.deploy.openCloudflareDns': 'Abrir Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'Docs DNS ↗',
          'web.deploy.recheckDns': 'Verificar DNS',
          'web.complete.endpoints': 'Endpoints',
          'web.complete.verified': 'verificado ✓',
          'web.complete.progress': 'Setup concluído - você pode fechar esta janela',
          'web.complete.openEnvDetail': 'Abrir detalhe do ambiente',
          'web.complete.authorizationEndpoint': 'Endpoint de autorização',
          'web.complete.tokenEndpoint': 'Endpoint de token',
          'web.complete.expiresOneHour': ' - expira em 1 hora',
          'web.complete.adminSetupLabel': 'Setup de admin',
        },
        fr: {
          'web.common.notSelected': 'Non sélectionné',
          'web.prereq.environmentCheck': 'Vérification de l’environnement',
          'web.prereq.recheck': 'Revérifier',
          'web.prereq.continueStart': 'Continuer vers le début',
          'web.loadConfig.kicker': 'Setup - Charger une configuration',
          'web.loadConfig.heroAside': 'Sélectionnez un <b>authrim-config.json</b> enregistré. Après validation, l’assistant peut reprendre avec cette configuration.',
          'web.loadConfig.fileSelection': 'Sélection du fichier',
          'web.loadConfig.dropConfigHere': 'Déposez authrim-config.json ici',
          'web.loadConfig.chooseJsonOnly': 'ou cliquez pour choisir un fichier - .json uniquement',
          'web.loadConfig.validationOk': 'Validation OK',
          'web.loadConfig.validationOkDesc': 'La configuration est valide. Vérifiez-la puis continuez.',
          'web.loadConfig.validationHelp': 'Si la validation trouve un problème, les erreurs et conseils apparaîtront ici.',
          'web.loadConfig.configurationFile': 'Fichier de configuration',
          'web.loadConfig.loadedConfiguration': 'Configuration chargée',
          'web.loadConfig.validated': 'Validée ✓',
          'web.loadConfig.pendingValidation': 'Validation en attente',
          'web.loadConfig.environment': 'Environnement',
          'web.loadConfig.baseDomain': 'Domaine de base',
          'web.loadConfig.multiTenant': 'Multi-tenant',
          'web.loadConfig.enabledInitialTenant': 'Activé (tenant initial : {{tenant}})',
          'web.loadConfig.components': 'Composants',
          'web.loadConfig.d1Regions': 'Régions D1',
          'web.loadConfig.emailProvider': 'Fournisseur email',
          'web.loadConfig.envConflictConfirm': 'Cette configuration utilise un nom d’environnement existant.\\n\\nEnvironnement : {{env}}\\nWorkers : {{workers}} / D1 : {{d1}} / KV : {{kv}}\\n\\nContinuer et déployer peut écraser l’environnement existant. Continuer ?',
          'web.loadConfig.validating': 'Validation',
          'web.loadConfig.loadDeploy': 'Charger et déployer',
          'web.loadConfig.provisionedValid': 'La configuration est valide. Les ressources existent déjà ; vous pouvez reprendre à l’étape 08 (Déploiement).',
          'web.envDetail.initialDeployRecoveryTitle': 'Le déploiement initial est incomplet',
          'web.envDetail.initialDeployRecoveryDesc': 'Le déploiement précédent s’est arrêté avant la vérification. Les ressources existantes seront réutilisées lors de la reprise.',
          'web.envDetail.initialDeployRecoveryAction': 'Reprendre le déploiement initial',
          'web.deploy.retryDeploy': 'Réessayer le déploiement',
          'web.loadConfig.checkingEnvironment': 'Vérification de l’environnement',
          'web.provision.resourcesToCreate': 'Ressources à créer',
          'web.provision.queues': 'Files',
          'web.provision.queuesDisabled': 'Cloudflare Queues est désactivé ; aucune file ne sera créée.',
          'web.provision.durableObjectsNote': 'Les Durable Objects sont définis au déploiement de l’étape suivante, pas pendant la création des ressources.',
          'web.provision.progress': 'Progression',
          'web.provision.runningMigrations': 'Exécution des migrations',
          'web.provision.elapsedPending': 'En attente de progression...',
          'web.provision.detailedLog': 'Journal détaillé',
          'web.provision.keyStorageTitle': 'Emplacement des clés - à manipuler avec soin',
          'web.provision.directory': 'Répertoire',
          'web.provision.keyStorageNote': 'Conservez ce répertoire en sécurité et ajoutez-le à .gitignore. Les clés privées sont aussi envoyées comme Workers secrets, mais la copie locale est la seule source de récupération.',
          'web.provision.retrySafeNote': 'Les ressources déjà créées sont ignorées à la relance, vous pouvez donc réessayer en sécurité. Enregistrez la configuration avant le déploiement.',
          'web.provision.runningTasks': 'Tâche {{current}} / {{total}} en cours',
          'web.provision.jwtSigning': 'Signature JWT',
          'web.provision.setupMachineAuth': 'authentification machine du setup',
          'web.provision.aesSecrets': 'secrets AES x4',
          'web.provision.encryption': 'chiffrement',
          'web.deploy.progress': 'Progression',
          'web.deploy.elapsedPending': 'En attente de progression...',
          'web.deploy.wranglerLog': 'journal wrangler',
          'web.deploy.cancelDeploy': 'Annuler le déploiement',
          'web.deploy.continueComplete': 'Continuer vers la fin',
          'web.deploy.manualWildcardTitle': 'Vérifier la configuration du DNS wildcard',
          'web.deploy.manualWildcardSummary': 'L’enregistrement DNS wildcard des URLs de tenants n’a pas pu être confirmé. S’il existe déjà, cliquez sur Revérifier DNS. Sinon, ajoutez l’enregistrement indiqué ci-dessous.',
          'web.deploy.manualWildcardStep1': 'Ouvrez Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Ajoutez un CNAME : nom {{record}}, cible {{target}}, proxy activé.',
          'web.deploy.manualWildcardStep3': 'Après ajout, cliquez sur Revérifier DNS sur cet écran.',
          'web.deploy.openCloudflareDns': 'Ouvrir Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'Docs DNS ↗',
          'web.deploy.recheckDns': 'Revérifier DNS',
          'web.complete.endpoints': 'Endpoints',
          'web.complete.verified': 'vérifié ✓',
          'web.complete.progress': 'Setup terminé - vous pouvez fermer cette fenêtre',
          'web.complete.openEnvDetail': 'Ouvrir le détail de l’environnement',
          'web.complete.authorizationEndpoint': 'Endpoint d’autorisation',
          'web.complete.tokenEndpoint': 'Endpoint de token',
          'web.complete.expiresOneHour': ' - expire dans 1 heure',
          'web.complete.adminSetupLabel': 'Setup admin',
        },
        de: {
          'web.common.notSelected': 'Nicht ausgewählt',
          'web.prereq.environmentCheck': 'Umgebungsprüfung',
          'web.prereq.recheck': 'Erneut prüfen',
          'web.prereq.continueStart': 'Weiter zum Start',
          'web.loadConfig.kicker': 'Setup - Konfiguration laden',
          'web.loadConfig.heroAside': 'Wählen Sie eine gespeicherte <b>authrim-config.json</b>. Nach der Prüfung kann der Assistent damit fortfahren.',
          'web.loadConfig.fileSelection': 'Dateiauswahl',
          'web.loadConfig.dropConfigHere': 'authrim-config.json hier ablegen',
          'web.loadConfig.chooseJsonOnly': 'oder klicken, um eine Datei zu wählen - nur .json',
          'web.loadConfig.validationOk': 'Validierung OK',
          'web.loadConfig.validationOkDesc': 'Die Konfiguration ist gültig. Prüfen Sie sie und fahren Sie fort.',
          'web.loadConfig.validationHelp': 'Wenn die Validierung ein Problem findet, erscheinen Fehler und Hinweise hier.',
          'web.loadConfig.configurationFile': 'Konfigurationsdatei',
          'web.loadConfig.loadedConfiguration': 'Geladene Konfiguration',
          'web.loadConfig.validated': 'Validiert ✓',
          'web.loadConfig.pendingValidation': 'Validierung ausstehend',
          'web.loadConfig.environment': 'Umgebung',
          'web.loadConfig.baseDomain': 'Basis-Domain',
          'web.loadConfig.multiTenant': 'Multi-Tenant',
          'web.loadConfig.enabledInitialTenant': 'Aktiviert (erster Tenant: {{tenant}})',
          'web.loadConfig.components': 'Komponenten',
          'web.loadConfig.d1Regions': 'D1-Regionen',
          'web.loadConfig.emailProvider': 'E-Mail-Anbieter',
          'web.loadConfig.envConflictConfirm': 'Diese Konfiguration verwendet einen bestehenden Umgebungsnamen.\\n\\nUmgebung: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nFortfahren und deployen kann die bestehende Umgebung überschreiben. Fortfahren?',
          'web.loadConfig.validating': 'Validierung',
          'web.loadConfig.loadDeploy': 'Laden und deployen',
          'web.loadConfig.provisionedValid': 'Die Konfiguration ist gültig. Ressourcen sind bereits erstellt; Sie können bei Schritt 08 (Deploy) fortfahren.',
          'web.envDetail.initialDeployRecoveryTitle': 'Das initiale Deployment ist unvollständig',
          'web.envDetail.initialDeployRecoveryDesc': 'Das vorherige Deployment wurde vor der Prüfung beendet. Vorhandene Ressourcen werden beim Fortsetzen wiederverwendet.',
          'web.envDetail.initialDeployRecoveryAction': 'Initiales Deployment fortsetzen',
          'web.deploy.retryDeploy': 'Deployment erneut versuchen',
          'web.loadConfig.checkingEnvironment': 'Umgebung wird geprüft',
          'web.provision.resourcesToCreate': 'Zu erstellende Ressourcen',
          'web.provision.queues': 'Queues',
          'web.provision.queuesDisabled': 'Cloudflare Queues ist deaktiviert; es werden keine Queues erstellt.',
          'web.provision.durableObjectsNote': 'Durable Objects werden beim Deployment im nächsten Schritt definiert, nicht beim Erstellen der Ressourcen.',
          'web.provision.progress': 'Fortschritt',
          'web.provision.runningMigrations': 'Migrationen laufen',
          'web.provision.elapsedPending': 'Warte auf Fortschritt...',
          'web.provision.detailedLog': 'Detail-Log',
          'web.provision.keyStorageTitle': 'Speicherort der Schlüssel - vorsichtig behandeln',
          'web.provision.directory': 'Verzeichnis',
          'web.provision.keyStorageNote': 'Bewahren Sie dieses Verzeichnis sicher auf und fügen Sie es zu .gitignore hinzu. Private Schlüssel werden auch als Workers secrets hochgeladen, die lokale Kopie ist aber die einzige Wiederherstellungsquelle.',
          'web.provision.retrySafeNote': 'Bereits erstellte Ressourcen werden beim erneuten Lauf übersprungen, daher können Sie sicher wiederholen. Speichern Sie die Konfiguration vor dem Deployment.',
          'web.provision.runningTasks': 'Aufgabe {{current}} / {{total}} läuft',
          'web.provision.jwtSigning': 'JWT-Signatur',
          'web.provision.setupMachineAuth': 'Setup-Maschinenauthentifizierung',
          'web.provision.aesSecrets': 'AES-Secrets x4',
          'web.provision.encryption': 'Verschlüsselung',
          'web.deploy.progress': 'Fortschritt',
          'web.deploy.elapsedPending': 'Warte auf Fortschritt...',
          'web.deploy.wranglerLog': 'wrangler-Log',
          'web.deploy.cancelDeploy': 'Deployment abbrechen',
          'web.deploy.continueComplete': 'Weiter zum Abschluss',
          'web.deploy.manualWildcardTitle': 'Wildcard-DNS-Einstellungen prüfen',
          'web.deploy.manualWildcardSummary': 'Der Wildcard-DNS-Eintrag für Tenant-URLs konnte nicht bestätigt werden. Wenn Sie ihn bereits erstellt haben, klicken Sie auf DNS erneut prüfen. Andernfalls fügen Sie den unten gezeigten Eintrag hinzu.',
          'web.deploy.manualWildcardStep1': 'Öffnen Sie Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'CNAME hinzufügen: Name {{record}}, Ziel {{target}}, Proxy an.',
          'web.deploy.manualWildcardStep3': 'Klicken Sie danach auf DNS erneut prüfen.',
          'web.deploy.openCloudflareDns': 'Cloudflare DNS öffnen ↗',
          'web.deploy.openDnsDocs': 'DNS-Doku ↗',
          'web.deploy.recheckDns': 'DNS erneut prüfen',
          'web.complete.endpoints': 'Endpoints',
          'web.complete.verified': 'geprüft ✓',
          'web.complete.progress': 'Setup abgeschlossen - Sie können dieses Fenster schließen',
          'web.complete.openEnvDetail': 'Umgebungsdetails öffnen',
          'web.complete.authorizationEndpoint': 'Autorisierungs-Endpoint',
          'web.complete.tokenEndpoint': 'Token-Endpoint',
          'web.complete.expiresOneHour': ' - läuft in 1 Stunde ab',
          'web.complete.adminSetupLabel': 'Admin-Setup',
        },
        ko: {
          'web.common.notSelected': '선택 안 됨',
          'web.prereq.environmentCheck': '환경 확인',
          'web.prereq.recheck': '다시 확인',
          'web.prereq.continueStart': '시작으로 계속',
          'web.loadConfig.kicker': '설정 - 구성 불러오기',
          'web.loadConfig.heroAside': '저장된 <b>authrim-config.json</b>을 선택하세요. 검증이 통과되면 해당 구성에서 마법사를 재개할 수 있습니다.',
          'web.loadConfig.fileSelection': '파일 선택',
          'web.loadConfig.dropConfigHere': 'authrim-config.json을 여기에 드롭',
          'web.loadConfig.chooseJsonOnly': '또는 클릭해서 파일 선택 - .json만',
          'web.loadConfig.validationOk': '검증 OK',
          'web.loadConfig.validationOkDesc': '구성이 유효합니다. 내용을 확인하고 계속하세요.',
          'web.loadConfig.validationHelp': '검증에서 문제가 발견되면 오류와 수정 힌트가 여기에 표시됩니다.',
          'web.loadConfig.configurationFile': '구성 파일',
          'web.loadConfig.loadedConfiguration': '불러온 구성',
          'web.loadConfig.validated': '검증됨 ✓',
          'web.loadConfig.pendingValidation': '검증 대기',
          'web.loadConfig.environment': '환경',
          'web.loadConfig.baseDomain': '베이스 도메인',
          'web.loadConfig.multiTenant': '멀티 테넌트',
          'web.loadConfig.enabledInitialTenant': '활성화됨(초기 테넌트: {{tenant}})',
          'web.loadConfig.components': '컴포넌트',
          'web.loadConfig.d1Regions': 'D1 리전',
          'web.loadConfig.emailProvider': '이메일 제공자',
          'web.loadConfig.envConflictConfirm': '이 구성은 기존 환경 이름을 사용합니다.\\n\\n환경: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\n계속 배포하면 기존 환경을 덮어쓸 수 있습니다. 계속할까요?',
          'web.loadConfig.validating': '검증 중',
          'web.loadConfig.loadDeploy': '불러오고 배포',
          'web.loadConfig.provisionedValid': '구성이 유효합니다. 리소스가 이미 생성되었으므로 08단계(배포)부터 재개할 수 있습니다.',
          'web.envDetail.initialDeployRecoveryTitle': '초기 배포가 완료되지 않았습니다',
          'web.envDetail.initialDeployRecoveryDesc': '이전 배포가 검증 전에 중단되었습니다. 계속하면 이미 생성된 리소스를 재사용합니다.',
          'web.envDetail.initialDeployRecoveryAction': '초기 배포 재개',
          'web.deploy.retryDeploy': '배포 재시도',
          'web.loadConfig.checkingEnvironment': '환경 확인 중',
          'web.provision.resourcesToCreate': '생성할 리소스',
          'web.provision.queues': 'Queues',
          'web.provision.queuesDisabled': 'Cloudflare Queues가 비활성화되어 큐를 생성하지 않습니다.',
          'web.provision.durableObjectsNote': 'Durable Objects는 리소스 생성이 아니라 다음 단계의 배포 중 정의됩니다.',
          'web.provision.progress': '진행 상황',
          'web.provision.runningMigrations': '마이그레이션 실행 중',
          'web.provision.elapsedPending': '진행 상황 대기 중...',
          'web.provision.detailedLog': '상세 로그',
          'web.provision.keyStorageTitle': '키 저장 위치 - 주의해서 관리',
          'web.provision.directory': '디렉터리',
          'web.provision.keyStorageNote': '이 디렉터리를 안전하게 보관하고 .gitignore에 추가하세요. 개인 키는 Workers secrets로도 업로드되지만 로컬 복사본이 유일한 복구 수단입니다.',
          'web.provision.retrySafeNote': '이미 생성된 리소스는 재실행 시 건너뛰므로 중단 후에도 안전하게 다시 시도할 수 있습니다. 배포 전 구성을 저장하세요.',
          'web.provision.runningTasks': '작업 {{current}} / {{total}} 실행 중',
          'web.provision.jwtSigning': 'JWT 서명',
          'web.provision.setupMachineAuth': '설정 머신 인증',
          'web.provision.aesSecrets': 'AES 시크릿 x4',
          'web.provision.encryption': '암호화',
          'web.deploy.progress': '진행 상황',
          'web.deploy.elapsedPending': '진행 상황 대기 중...',
          'web.deploy.wranglerLog': 'wrangler 로그',
          'web.deploy.cancelDeploy': '배포 취소',
          'web.deploy.continueComplete': '완료로 계속',
          'web.deploy.manualWildcardTitle': '와일드카드 DNS 설정 확인',
          'web.deploy.manualWildcardSummary': '테넌트 URL에 필요한 와일드카드 DNS 레코드를 확인할 수 없습니다. 이미 만들었다면 DNS 다시 확인을 누르고, 아직이라면 아래 레코드를 추가하세요.',
          'web.deploy.manualWildcardStep1': 'Cloudflare Dashboard -> {{zone}} -> DNS > Records를 엽니다.',
          'web.deploy.manualWildcardStep2': 'CNAME 추가: 이름 {{record}}, 대상 {{target}}, 프록시 켬.',
          'web.deploy.manualWildcardStep3': '추가 후 이 화면에서 DNS 다시 확인을 누릅니다.',
          'web.deploy.openCloudflareDns': 'Cloudflare DNS 열기 ↗',
          'web.deploy.openDnsDocs': 'DNS 문서 ↗',
          'web.deploy.recheckDns': 'DNS 다시 확인',
          'web.complete.endpoints': '엔드포인트',
          'web.complete.verified': '검증됨 ✓',
          'web.complete.progress': '설정 완료 - 이 창을 닫아도 됩니다',
          'web.complete.openEnvDetail': '환경 상세 열기',
          'web.complete.authorizationEndpoint': '인가 엔드포인트',
          'web.complete.tokenEndpoint': '토큰 엔드포인트',
          'web.complete.expiresOneHour': ' - 1시간 후 만료',
          'web.complete.adminSetupLabel': '관리자 설정',
        },
        ru: {
          'web.common.notSelected': 'Не выбрано',
          'web.prereq.environmentCheck': 'Проверка среды',
          'web.prereq.recheck': 'Проверить снова',
          'web.prereq.continueStart': 'Перейти к началу',
          'web.loadConfig.kicker': 'Setup - загрузка конфигурации',
          'web.loadConfig.heroAside': 'Выберите сохраненный <b>authrim-config.json</b>. После проверки мастер сможет продолжить с этой конфигурацией.',
          'web.loadConfig.fileSelection': 'Выбор файла',
          'web.loadConfig.dropConfigHere': 'Перетащите authrim-config.json сюда',
          'web.loadConfig.chooseJsonOnly': 'или нажмите, чтобы выбрать файл - только .json',
          'web.loadConfig.validationOk': 'Проверка пройдена',
          'web.loadConfig.validationOkDesc': 'Конфигурация корректна. Проверьте ее и продолжайте.',
          'web.loadConfig.validationHelp': 'Если проверка найдет проблему, ошибки и подсказки появятся здесь.',
          'web.loadConfig.configurationFile': 'Файл конфигурации',
          'web.loadConfig.loadedConfiguration': 'Загруженная конфигурация',
          'web.loadConfig.validated': 'Проверено ✓',
          'web.loadConfig.pendingValidation': 'Ожидает проверки',
          'web.loadConfig.environment': 'Среда',
          'web.loadConfig.baseDomain': 'Базовый домен',
          'web.loadConfig.multiTenant': 'Мультитенантность',
          'web.loadConfig.enabledInitialTenant': 'Включено (первый тенант: {{tenant}})',
          'web.loadConfig.components': 'Компоненты',
          'web.loadConfig.d1Regions': 'Регионы D1',
          'web.loadConfig.emailProvider': 'Провайдер почты',
          'web.loadConfig.envConflictConfirm': 'Эта конфигурация использует имя существующей среды.\\n\\nСреда: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nПродолжение и деплой могут перезаписать существующую среду. Продолжить?',
          'web.loadConfig.validating': 'Проверка',
          'web.loadConfig.loadDeploy': 'Загрузить и деплоить',
          'web.loadConfig.provisionedValid': 'Конфигурация корректна. Ресурсы уже созданы, можно продолжить с шага 08 (Deploy).',
          'web.envDetail.initialDeployRecoveryTitle': 'Первоначальный деплой не завершен',
          'web.envDetail.initialDeployRecoveryDesc': 'Предыдущий деплой остановился до проверки. При продолжении будут повторно использованы существующие ресурсы.',
          'web.envDetail.initialDeployRecoveryAction': 'Продолжить первоначальный деплой',
          'web.deploy.retryDeploy': 'Повторить деплой',
          'web.loadConfig.checkingEnvironment': 'Проверка среды',
          'web.provision.resourcesToCreate': 'Ресурсы для создания',
          'web.provision.queues': 'Очереди',
          'web.provision.queuesDisabled': 'Cloudflare Queues отключены, очереди созданы не будут.',
          'web.provision.durableObjectsNote': 'Durable Objects определяются при деплое на следующем шаге, а не при создании ресурсов.',
          'web.provision.progress': 'Прогресс',
          'web.provision.runningMigrations': 'Выполняются миграции',
          'web.provision.elapsedPending': 'Ожидание прогресса...',
          'web.provision.detailedLog': 'Подробный лог',
          'web.provision.keyStorageTitle': 'Место хранения ключей - обращаться осторожно',
          'web.provision.directory': 'Каталог',
          'web.provision.keyStorageNote': 'Храните этот каталог безопасно и добавьте его в .gitignore. Приватные ключи также загружаются как Workers secrets, но локальная копия является единственным источником восстановления.',
          'web.provision.retrySafeNote': 'Уже созданные ресурсы пропускаются при повторном запуске, поэтому операцию можно безопасно повторить. Сохраните конфигурацию перед деплоем.',
          'web.provision.runningTasks': 'Задача {{current}} / {{total}} выполняется',
          'web.provision.jwtSigning': 'JWT-подпись',
          'web.provision.setupMachineAuth': 'машинная аутентификация setup',
          'web.provision.aesSecrets': 'AES-секреты x4',
          'web.provision.encryption': 'шифрование',
          'web.deploy.progress': 'Прогресс',
          'web.deploy.elapsedPending': 'Ожидание прогресса...',
          'web.deploy.wranglerLog': 'лог wrangler',
          'web.deploy.cancelDeploy': 'Отменить деплой',
          'web.deploy.continueComplete': 'Перейти к завершению',
          'web.deploy.manualWildcardTitle': 'Проверка настройки wildcard DNS',
          'web.deploy.manualWildcardSummary': 'Не удалось подтвердить wildcard DNS-запись для URL тенантов. Если вы уже создали ее, нажмите «Проверить DNS снова». Иначе добавьте запись ниже.',
          'web.deploy.manualWildcardStep1': 'Откройте Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Добавьте CNAME: имя {{record}}, цель {{target}}, proxy включен.',
          'web.deploy.manualWildcardStep3': 'После добавления нажмите повторную проверку DNS на этом экране.',
          'web.deploy.openCloudflareDns': 'Открыть Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'Документация DNS ↗',
          'web.deploy.recheckDns': 'Проверить DNS снова',
          'web.complete.endpoints': 'Эндпоинты',
          'web.complete.verified': 'проверено ✓',
          'web.complete.progress': 'Setup завершен - это окно можно закрыть',
          'web.complete.openEnvDetail': 'Открыть детали среды',
          'web.complete.authorizationEndpoint': 'Эндпоинт авторизации',
          'web.complete.tokenEndpoint': 'Эндпоинт токена',
          'web.complete.expiresOneHour': ' - истекает через 1 час',
          'web.complete.adminSetupLabel': 'Настройка админа',
        },
        id: {
          'web.common.notSelected': 'Belum dipilih',
          'web.prereq.environmentCheck': 'Pemeriksaan environment',
          'web.prereq.recheck': 'Periksa ulang',
          'web.prereq.continueStart': 'Lanjut ke mulai',
          'web.loadConfig.kicker': 'Setup - Muat konfigurasi',
          'web.loadConfig.heroAside': 'Pilih <b>authrim-config.json</b> yang tersimpan. Setelah validasi lolos, wizard dapat dilanjutkan dari konfigurasi itu.',
          'web.loadConfig.fileSelection': 'Pilih file',
          'web.loadConfig.dropConfigHere': 'Letakkan authrim-config.json di sini',
          'web.loadConfig.chooseJsonOnly': 'atau klik untuk memilih file - hanya .json',
          'web.loadConfig.validationOk': 'Validasi OK',
          'web.loadConfig.validationOkDesc': 'Konfigurasi valid. Tinjau lalu lanjutkan.',
          'web.loadConfig.validationHelp': 'Jika validasi menemukan masalah, error dan saran perbaikan muncul di sini.',
          'web.loadConfig.configurationFile': 'File konfigurasi',
          'web.loadConfig.loadedConfiguration': 'Konfigurasi dimuat',
          'web.loadConfig.validated': 'Tervalidasi ✓',
          'web.loadConfig.pendingValidation': 'Menunggu validasi',
          'web.loadConfig.environment': 'Environment',
          'web.loadConfig.baseDomain': 'Domain dasar',
          'web.loadConfig.multiTenant': 'Multi-tenant',
          'web.loadConfig.enabledInitialTenant': 'Aktif (tenant awal: {{tenant}})',
          'web.loadConfig.components': 'Komponen',
          'web.loadConfig.d1Regions': 'Region D1',
          'web.loadConfig.emailProvider': 'Provider email',
          'web.loadConfig.envConflictConfirm': 'Konfigurasi ini memakai nama environment yang sudah ada.\\n\\nEnvironment: {{env}}\\nWorkers: {{workers}} / D1: {{d1}} / KV: {{kv}}\\n\\nMelanjutkan deployment dapat menimpa environment yang ada. Lanjutkan?',
          'web.loadConfig.validating': 'Memvalidasi',
          'web.loadConfig.loadDeploy': 'Muat & Deploy',
          'web.loadConfig.provisionedValid': 'Konfigurasi valid. Resource sudah dibuat, jadi setup dapat dilanjutkan dari langkah 08 (Deploy).',
          'web.envDetail.initialDeployRecoveryTitle': 'Deployment awal belum selesai',
          'web.envDetail.initialDeployRecoveryDesc': 'Deployment sebelumnya berhenti sebelum verifikasi. Resource yang sudah ada akan digunakan kembali saat dilanjutkan.',
          'web.envDetail.initialDeployRecoveryAction': 'Lanjutkan deployment awal',
          'web.deploy.retryDeploy': 'Coba deployment lagi',
          'web.loadConfig.checkingEnvironment': 'Memeriksa environment',
          'web.provision.resourcesToCreate': 'Resource yang dibuat',
          'web.provision.queues': 'Queue',
          'web.provision.queuesDisabled': 'Cloudflare Queues dinonaktifkan, jadi queue tidak akan dibuat.',
          'web.provision.durableObjectsNote': 'Durable Objects didefinisikan saat deploy di langkah berikutnya, bukan saat membuat resource.',
          'web.provision.progress': 'Progres',
          'web.provision.runningMigrations': 'Menjalankan migrasi',
          'web.provision.elapsedPending': 'Menunggu progres...',
          'web.provision.detailedLog': 'Log detail',
          'web.provision.keyStorageTitle': 'Lokasi penyimpanan kunci - tangani dengan hati-hati',
          'web.provision.directory': 'Direktori',
          'web.provision.keyStorageNote': 'Simpan direktori ini dengan aman dan tambahkan ke .gitignore. Private key juga diunggah sebagai Workers secrets, tetapi salinan lokal adalah satu-satunya sumber pemulihan.',
          'web.provision.retrySafeNote': 'Resource yang sudah dibuat akan dilewati saat dijalankan ulang, sehingga aman untuk mencoba lagi. Simpan konfigurasi sebelum deploy.',
          'web.provision.runningTasks': 'Tugas {{current}} / {{total}} berjalan',
          'web.provision.jwtSigning': 'Penandatanganan JWT',
          'web.provision.setupMachineAuth': 'autentikasi mesin setup',
          'web.provision.aesSecrets': 'secret AES x4',
          'web.provision.encryption': 'enkripsi',
          'web.deploy.progress': 'Progres',
          'web.deploy.elapsedPending': 'Menunggu progres...',
          'web.deploy.wranglerLog': 'log wrangler',
          'web.deploy.cancelDeploy': 'Batalkan deploy',
          'web.deploy.continueComplete': 'Lanjut ke selesai',
          'web.deploy.manualWildcardTitle': 'Periksa pengaturan DNS wildcard',
          'web.deploy.manualWildcardSummary': 'Record DNS wildcard untuk URL tenant belum dapat dikonfirmasi. Jika sudah dibuat, klik Periksa ulang DNS. Jika belum, tambahkan record yang ditampilkan di bawah.',
          'web.deploy.manualWildcardStep1': 'Buka Cloudflare Dashboard -> {{zone}} -> DNS > Records.',
          'web.deploy.manualWildcardStep2': 'Tambahkan CNAME: nama {{record}}, target {{target}}, proxy aktif.',
          'web.deploy.manualWildcardStep3': 'Setelah ditambahkan, klik Periksa ulang DNS di layar ini.',
          'web.deploy.openCloudflareDns': 'Buka Cloudflare DNS ↗',
          'web.deploy.openDnsDocs': 'Dokumentasi DNS ↗',
          'web.deploy.recheckDns': 'Periksa ulang DNS',
          'web.complete.endpoints': 'Endpoint',
          'web.complete.verified': 'terverifikasi ✓',
          'web.complete.progress': 'Setup selesai - jendela ini dapat ditutup',
          'web.complete.openEnvDetail': 'Buka detail environment',
          'web.complete.authorizationEndpoint': 'Endpoint otorisasi',
          'web.complete.tokenEndpoint': 'Endpoint token',
          'web.complete.expiresOneHour': ' - kedaluwarsa dalam 1 jam',
          'web.complete.adminSetupLabel': 'Setup admin',
        },
      };
      const envManagementCopyByLocale = {
        en: {
          'web.common.setupTool': 'Setup Tool',
          'web.env.scanLog': 'Scan log',
          'web.env.scanningEnvironments': 'Scanning environments',
          'web.env.detected': 'Detected',
          'web.env.environments': 'environments',
          'web.env.start': 'Start',
          'web.env.rescan': 'Rescan',
          'web.envDetail.overview': 'Overview',
          'web.envDetail.capacityTab': 'D1 Capacity',
          'web.envDetail.capacityTitle': 'Control Plane Capacity',
          'web.envDetail.capacityHint': 'Server-owned placement plan',
          'web.envDetail.capacityScope': 'Scope',
          'web.envDetail.capacityShared': 'Shared pool',
          'web.envDetail.capacityDedicated': 'Dedicated tenant',
          'web.envDetail.capacityTenant': 'Tenant',
          'web.envDetail.capacityProfile': 'Capacity profile',
          'web.envDetail.capacityMinimum': 'Minimum',
          'web.envDetail.capacityRecommended': 'Recommended',
          'web.envDetail.capacityExtra': 'Extra headroom',
          'web.envDetail.capacityPreview': 'Preview',
          'web.envDetail.capacityAdd': 'Add capacity',
          'web.envDetail.capacityPlan': 'Capacity plan',
          'web.envDetail.capacitySelectEnvironment': 'Select an environment first.',
          'web.envDetail.capacityNoTenant': 'No active dedicated tenant is available.',
          'web.envDetail.capacitySummary': '{{units}} unit(s) / {{d1}} D1 / {{total}} total',
          'web.envDetail.capacityPreviewState': 'preview',
          'web.envDetail.capacityLoading': 'Loading capacity plan...',
          'web.envDetail.capacityCreating': 'Creating capacity operations...',
          'web.envDetail.capacityRequestFailed': 'Capacity request failed.',
          'web.envDetail.capacityCreated': 'Canonical Control operations created. Pending setup actions are now available.',
          'web.envDetail.capacitySatisfied': 'Current capacity already satisfies this profile.',
          'web.envDetail.capacityReady': 'Capacity preview is ready.',
          'web.envDetail.workersUpdates': 'Workers / Updates',
          'web.envDetail.storage': 'Storage',
          'web.envDetail.migrations': 'Migrations',
          'web.envDetail.email': 'Email',
          'web.envDetail.resources': 'Resources',
          'web.envDetail.updates': 'Updates',
          'web.envDetail.releaseUpdateAvailable': 'A new Authrim version is available',
          'web.envDetail.releaseUpdateResume': 'Continue the interrupted update',
          'web.envDetail.releaseUpdateDesc': 'Setup will apply required database changes when present, update the services, and verify the result. Your settings and data are preserved.',
          'web.envDetail.releaseUpdateBlocked': 'This update cannot start until the previous operation is resolved.',
          'web.envDetail.releaseUpdateOlderTool': 'This setup source is older than the installed environment. Start setup again with the latest package.',
          'web.envDetail.releaseUpdateAction': 'Update now',
          'web.envDetail.releaseUpdateDatabaseOnlyAction': 'Update databases only (advanced)',
          'web.envDetail.releaseUpdateDatabaseOnlyConfirm': 'Update databases without updating Workers? This is allowed only when the release manifest explicitly declares the installed Worker version compatible with the new schema.',
          'web.envDetail.releaseUpdateResumeAction': 'Continue update',
          'web.envDetail.releaseUpdatePreparing': 'Preparing the update...',
          'web.envDetail.releaseUpdateDatabase': 'Updating databases...',
          'web.envDetail.releaseUpdateServices': 'Updating services...',
          'web.envDetail.releaseUpdateVerifying': 'Verifying the update...',
          'web.envDetail.releaseUpdateComplete': 'Authrim is up to date.',
          'web.envDetail.releaseUpdateContinuing': 'Database migration continues safely in Control. You can close Setup and monitor or retry from Admin UI.',
          'web.envDetail.releaseUpdateFailed': 'The update stopped. You can safely retry from this screen.',
          'web.envDetail.releaseUpdateDetails': 'Show update details',
          'web.envDetail.verified': 'Deployment verified ✓',
          'web.envDetail.deploymentChecking': 'Checking deployment status...',
          'web.envDetail.deploymentIncomplete': 'Deployment incomplete',
          'web.envDetail.deploymentStatusUnknown': 'Status not verified',
          'web.envDetail.adminAccount': 'Admin Account',
          'web.envDetail.workerUpdateHint': 'Compare deployed and local builds',
          'web.envDetail.serviceSiteFallback': 'Service Site Binding',
          'web.envDetail.serviceSiteFallbackHint': 'Bind ar-router to your service Worker',
          'web.envDetail.serviceSiteFallbackDesc': 'Use this when Authrim, Admin UI, Login UI, and the service site share one domain. This screen adds the Service Binding and deploys ar-router; enable the runtime fallback later from Admin UI > Login UI.',
          'web.envDetail.serviceSiteEnabled': 'Add Service Binding',
          'web.envDetail.serviceSiteEnabledHint': 'Adds the configured Worker as a Service Binding on ar-router. Runtime fallback remains controlled by Admin UI settings.',
          'web.envDetail.serviceSiteWorkerName': 'Service Worker name',
          'web.envDetail.serviceSiteBinding': 'Binding name',
          'web.envDetail.serviceSiteSaveDeploy': 'Save and Deploy Router',
          'web.envDetail.serviceSiteProgress': 'Service Site Progress',
          'web.envDetail.serviceSiteLoading': 'Loading Service Site binding status...',
          'web.envDetail.serviceSiteEnabledSummary': 'Binding configured: {{binding}} -> {{worker}}',
          'web.envDetail.serviceSiteDisabledSummary': 'No Service Site binding is configured on ar-router.',
          'web.envDetail.serviceSiteWorkerRequired': 'Enter the service Worker name before adding the binding.',
          'web.envDetail.serviceSiteWorkerInvalid': 'Worker name must use lowercase letters, numbers, and hyphens.',
          'web.envDetail.serviceSiteBindingInvalid': 'Binding name must use uppercase letters, numbers, and underscores.',
          'web.envDetail.serviceSiteConfirm': 'Save Service Site binding settings and deploy ar-router?',
          'web.envDetail.serviceSiteSaving': 'Saving Service Site binding settings...',
          'web.envDetail.serviceSiteDeployComplete': 'Service Site binding deployed.',
          'web.envDetail.appLoginGuideTitle': 'App Login next steps',
          'web.envDetail.appLoginGuideDesc': 'To send direct Login UI sign-ins into your service app, register the service as an OIDC Client in Admin UI, enable First Party App and App Login on that Client, then select App Login in Admin UI > Login UI post-login settings.',
          'web.envDetail.appLoginGuideLink': 'Open Admin UI Login UI settings',
          'web.envDetail.versionComparison': 'Version comparison',
          'web.envDetail.uiUpdates': 'UI Updates',
          'web.envDetail.origin': 'Origin',
          'web.envDetail.dedicatedR2Buckets': 'Dedicated R2 Buckets',
          'web.envDetail.loadingR2Status': 'Loading R2 bucket status...',
          'web.envDetail.r2ProvisionDesc': 'Create Authrim R2 buckets, record lock bindings, enable the R2 feature flag, and redeploy workers.',
          'web.envDetail.provisionR2Deploy': 'Provision R2 and Deploy',
          'web.envDetail.r2ProvisioningProgress': 'R2 Provisioning Progress',
          'web.envDetail.migrationTitle': 'Database Migrations',
          'web.envDetail.migrationLoading': 'Loading migration status...',
          'web.envDetail.migrationApplied': 'Applied',
          'web.envDetail.migrationPending': 'Pending',
          'web.envDetail.migrationChanged': 'Changed',
          'web.envDetail.migrationOrphaned': 'Orphaned',
          'web.envDetail.migrationRefresh': 'Refresh',
          'web.envDetail.migrationApplyAllPending': 'Apply All Pending',
          'web.envDetail.migrationProgress': 'Migration Progress:',
          'web.envDetail.migrationStatus': 'Status',
          'web.envDetail.migrationFile': 'Migration file',
          'web.envDetail.migrationAppliedAt': 'Applied At',
          'web.envDetail.migrationChecksum': 'Checksum',
          'web.envDetail.migrationApplyPending': 'Apply',
          'web.envDetail.migrationStatusApplied': 'Applied',
          'web.envDetail.migrationStatusPending': 'Pending',
          'web.envDetail.migrationStatusChanged': 'Changed',
          'web.envDetail.migrationStatusOrphaned': 'Orphaned',
          'web.envDetail.migrationChangedBlocked': 'Applied migration files have changed. Apply All is disabled; pending rows can be applied individually.',
          'web.envDetail.migrationPendingSummary': '{{count}} pending migration(s)',
          'web.envDetail.migrationMiniSummary': '{{applied}} applied / {{pending}} pending / {{changed}} changed',
          'web.envDetail.migrationNoPending': 'All migrations are applied.',
          'web.envDetail.migrationNoFiles': 'No migration files found.',
          'web.envDetail.migrationLoadFailed': 'Failed to load migration status.',
          'web.envDetail.migrationApplyConfirm': 'Apply all pending database migrations?',
          'web.envDetail.migrationApplying': 'Applying database migrations...',
          'web.envDetail.migrationComplete': 'Database migrations completed.',
          'web.delete.selectResourcesTitle': 'Select Resources to Delete',
          'web.delete.targetResources': 'Target Resources',
          'web.delete.workersDesc': 'Router, API, and UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, including user data',
          'web.delete.kvDesc': 'Settings, caches, and runtime registry',
          'web.delete.queuesDesc': 'Async audit and delivery queues',
          'web.delete.r2Desc': 'Dedicated storage buckets',
          'web.delete.pagesDesc': 'Legacy Pages projects',
          'web.delete.finalConfirmation': 'Final Confirmation',
          'web.delete.dnsNote': 'Custom domain DNS records are not deleted automatically. Remove them manually in Cloudflare if they are no longer needed.',
          'web.delete.deleteLog': 'Delete log',
          'web.delete.deleteTarget': 'Delete target',
          'web.delete.resourcesLabel': 'resources',
          'web.delete.deletePermanently': 'Delete permanently',
          'web.delete.manualR2Title': 'Large R2 buckets were not deleted automatically. Empty them in Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'Open R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'All other selected environment resources were deleted. One or more R2 buckets are waiting for the manual actions below; this is not an API failure.',
          'web.delete.manualControlTokensTitle': 'Control API token review',
          'web.delete.manualControlTokensSummary': 'Setup could not automatically revoke one or more setup-managed Control API tokens. Environment resource deletion continued using exact ownership evidence. Review exact token IDs when shown and candidate names in both Cloudflare token lists; do not delete a token based on its name alone.',
          'web.delete.manualControlTokenId': 'Token ID: {{tokenId}}',
          'web.delete.manualControlTokensAccountOpen': 'Open account API tokens ↗',
          'web.delete.manualControlTokensUserOpen': 'Open user API tokens ↗',
        },
        ja: {
          'web.common.setupTool': 'セットアップツール',
          'web.env.scanLog': 'スキャンログ',
          'web.env.scanningEnvironments': '環境をスキャン中',
          'web.env.detected': '検出',
          'web.env.environments': '環境',
          'web.env.start': '開始画面へ',
          'web.env.rescan': '再スキャン',
          'web.envDetail.overview': '概要',
          'web.envDetail.capacityTab': 'D1キャパシティ',
          'web.envDetail.capacityTitle': 'テナントD1キャパシティ',
          'web.envDetail.capacityHint': 'サーバー管理の配置プラン',
          'web.envDetail.capacityScope': '対象',
          'web.envDetail.capacityShared': '共有プール',
          'web.envDetail.capacityDedicated': '専用テナント',
          'web.envDetail.capacityTenant': 'テナント',
          'web.envDetail.capacityProfile': 'キャパシティプロファイル',
          'web.envDetail.capacityMinimum': '最小',
          'web.envDetail.capacityRecommended': '推奨',
          'web.envDetail.capacityExtra': '追加余力',
          'web.envDetail.capacityPreview': 'プレビュー',
          'web.envDetail.capacityAdd': 'キャパシティを追加',
          'web.envDetail.capacityPlan': 'キャパシティプラン',
          'web.envDetail.capacitySelectEnvironment': '先に環境を選択してください。',
          'web.envDetail.capacityNoTenant': '利用可能な有効な専用テナントがありません。',
          'web.envDetail.capacitySummary': '{{units}} unit / {{d1}} D1 / 合計 {{total}}',
          'web.envDetail.capacityPreviewState': 'プレビュー',
          'web.envDetail.capacityLoading': 'キャパシティプランを読み込み中...',
          'web.envDetail.capacityCreating': 'キャパシティoperationを作成中...',
          'web.envDetail.capacityRequestFailed': 'キャパシティ要求に失敗しました。',
          'web.envDetail.capacityCreated': '正規のControl operationを作成しました。setupで保留中の操作を実行できます。',
          'web.envDetail.capacitySatisfied': '現在のキャパシティはこのプロファイルを満たしています。',
          'web.envDetail.capacityReady': 'キャパシティプレビューを作成しました。',
          'web.envDetail.workersUpdates': 'Workers・更新',
          'web.envDetail.storage': 'ストレージ運用',
          'web.envDetail.migrations': 'マイグレーション',
          'web.envDetail.email': 'メール',
          'web.envDetail.resources': 'リソース一覧',
          'web.envDetail.updates': '更新可能',
          'web.envDetail.releaseUpdateAvailable': '新しいAuthrimがあります',
          'web.envDetail.releaseUpdateResume': '中断した更新を続けられます',
          'web.envDetail.releaseUpdateDesc': '必要なデータベース変更がある場合だけ先に適用し、サービスを更新して、最後に動作を確認します。設定とデータは維持されます。',
          'web.envDetail.releaseUpdateBlocked': '前回の処理を解決するまで、この更新は開始できません。',
          'web.envDetail.releaseUpdateOlderTool': 'セットアップソースが導入済み環境より古いため、最新のnpx @authrim/setupを起動してください。',
          'web.envDetail.releaseUpdateAction': '今すぐ更新',
          'web.envDetail.releaseUpdateDatabaseOnlyAction': 'データベースのみ更新（詳細設定）',
          'web.envDetail.releaseUpdateDatabaseOnlyConfirm': 'Workersを更新せずにデータベースだけ更新しますか？リリースmanifestが、現在のWorkerバージョンと更新後スキーマの互換性を明示している場合にのみ実行できます。',
          'web.envDetail.releaseUpdateResumeAction': '更新を続ける',
          'web.envDetail.releaseUpdatePreparing': '更新を準備しています…',
          'web.envDetail.releaseUpdateDatabase': 'データベースを更新しています…',
          'web.envDetail.releaseUpdateServices': 'サービスを更新しています…',
          'web.envDetail.releaseUpdateVerifying': '更新結果を確認しています…',
          'web.envDetail.releaseUpdateComplete': '最新バージョンになりました。',
          'web.envDetail.releaseUpdateContinuing': 'データベース更新はControlで安全に継続しています。Setupを閉じても、Admin UIから監視・再試行できます。',
          'web.envDetail.releaseUpdateFailed': '更新が途中で停止しました。この画面から安全に再開できます。',
          'web.envDetail.releaseUpdateDetails': '更新の詳細を表示',
          'web.envDetail.verified': 'デプロイ検証済み ✓',
          'web.envDetail.deploymentChecking': 'デプロイ状態を確認中…',
          'web.envDetail.deploymentIncomplete': 'デプロイ未完了',
          'web.envDetail.deploymentStatusUnknown': '状態未確認',
          'web.envDetail.adminAccount': '管理者アカウント',
          'web.envDetail.workerUpdateHint': 'デプロイ済みバージョンとローカルのビルドを比較',
          'web.envDetail.serviceSiteFallback': 'Service Site Binding',
          'web.envDetail.serviceSiteFallbackHint': 'ar-routerにサービス用Workerをbinding',
          'web.envDetail.serviceSiteFallbackDesc': 'Authrim、Admin UI、Login UI、サービスサイトを同一ドメインで共存させる場合に使います。この画面ではService Bindingを追加してar-routerをデプロイします。runtime fallbackの有効化はAdmin UI > Login UIで行います。',
          'web.envDetail.serviceSiteEnabled': 'Service Bindingを追加',
          'web.envDetail.serviceSiteEnabledHint': '設定したWorkerをar-routerのService Bindingとして追加します。runtime fallbackのON/OFFはAdmin UI設定で制御します。',
          'web.envDetail.serviceSiteWorkerName': 'サービスWorker名',
          'web.envDetail.serviceSiteBinding': 'Binding名',
          'web.envDetail.serviceSiteSaveDeploy': '保存してRouterをデプロイ',
          'web.envDetail.serviceSiteProgress': 'Service Siteの進行状況',
          'web.envDetail.serviceSiteLoading': 'Service Site binding の状態を読み込み中...',
          'web.envDetail.serviceSiteEnabledSummary': 'Binding設定済み: {{binding}} -> {{worker}}',
          'web.envDetail.serviceSiteDisabledSummary': 'ar-routerにService Site bindingは設定されていません。',
          'web.envDetail.serviceSiteWorkerRequired': 'bindingを追加する場合はサービスWorker名を入力してください。',
          'web.envDetail.serviceSiteWorkerInvalid': 'Worker名は英小文字、数字、ハイフンで入力してください。',
          'web.envDetail.serviceSiteBindingInvalid': 'Binding名は英大文字、数字、アンダースコアで入力してください。',
          'web.envDetail.serviceSiteConfirm': 'Service Site binding設定を保存し、ar-routerをデプロイしますか？',
          'web.envDetail.serviceSiteSaving': 'Service Site binding設定を保存中...',
          'web.envDetail.serviceSiteDeployComplete': 'Service Site bindingをデプロイしました。',
          'web.envDetail.appLoginGuideTitle': 'App Login の次の手順',
          'web.envDetail.appLoginGuideDesc': 'Login UIの直ログイン後にサービスアプリのsessionを作成したい場合は、Admin UIでサービスをOIDC Clientとして登録し、そのClientの First Party App と App Login を有効化してから、Admin UI > Login UI のログイン後設定で App Login を選択してください。',
          'web.envDetail.appLoginGuideLink': 'Admin UI の Login UI 設定を開く',
          'web.envDetail.versionComparison': 'バージョン比較',
          'web.envDetail.uiUpdates': 'UIの個別更新',
          'web.envDetail.origin': '配信元',
          'web.envDetail.dedicatedR2Buckets': '専用R2バケット',
          'web.envDetail.loadingR2Status': 'R2バケットの状態を読み込み中...',
          'web.envDetail.r2ProvisionDesc': 'AuthrimのR2バケットを作成し、ロック用バインディングを記録、R2機能フラグを有効化してWorkerを再デプロイします。',
          'web.envDetail.provisionR2Deploy': 'R2を作成してデプロイ',
          'web.envDetail.r2ProvisioningProgress': 'R2作成の進行状況',
          'web.envDetail.migrationTitle': 'データベースマイグレーション',
          'web.envDetail.migrationLoading': 'マイグレーション状態を読み込み中...',
          'web.envDetail.migrationApplied': '適用済み',
          'web.envDetail.migrationPending': '未適用',
          'web.envDetail.migrationChanged': '変更あり',
          'web.envDetail.migrationOrphaned': '孤立',
          'web.envDetail.migrationRefresh': '更新',
          'web.envDetail.migrationApplyAllPending': '未適用をすべて適用',
          'web.envDetail.migrationProgress': 'マイグレーション進行状況:',
          'web.envDetail.migrationStatus': '状態',
          'web.envDetail.migrationFile': 'マイグレーションファイル',
          'web.envDetail.migrationAppliedAt': '適用日時',
          'web.envDetail.migrationChecksum': 'チェックサム',
          'web.envDetail.migrationApplyPending': '適用',
          'web.envDetail.migrationStatusApplied': '適用済み',
          'web.envDetail.migrationStatusPending': '未適用',
          'web.envDetail.migrationStatusChanged': '変更あり',
          'web.envDetail.migrationStatusOrphaned': '孤立',
          'web.envDetail.migrationChangedBlocked': '適用済みのマイグレーションファイルが変更されています。一括適用は無効ですが、未適用の行は個別に適用できます。',
          'web.envDetail.migrationPendingSummary': '{{count}}件の未適用マイグレーションがあります',
          'web.envDetail.migrationMiniSummary': '適用済み {{applied}} / 未適用 {{pending}} / 変更 {{changed}}',
          'web.envDetail.migrationNoPending': 'すべてのマイグレーションが適用済みです。',
          'web.envDetail.migrationNoFiles': 'マイグレーションファイルがありません。',
          'web.envDetail.migrationLoadFailed': 'マイグレーション状態を読み込めませんでした。',
          'web.envDetail.migrationApplyConfirm': '未適用のデータベースマイグレーションをすべて適用しますか？',
          'web.envDetail.migrationApplying': 'データベースマイグレーションを適用中...',
          'web.envDetail.migrationComplete': 'データベースマイグレーションが完了しました。',
          'web.delete.selectResourcesTitle': '削除するリソースの選択',
          'web.delete.targetResources': '対象リソース',
          'web.delete.workersDesc': 'Router / API / UI Workers',
          'web.delete.d1Desc': 'core / pii / admin - ユーザーデータを含みます',
          'web.delete.kvDesc': '設定、キャッシュ、ランタイムレジストリ',
          'web.delete.queuesDesc': '非同期監査・配信キュー',
          'web.delete.r2Desc': '専用ストレージバケット',
          'web.delete.pagesDesc': '旧 Pages プロジェクト',
          'web.delete.finalConfirmation': '最終確認',
          'web.delete.dnsNote': 'カスタムドメインのDNSレコードは削除されません。不要であればCloudflareダッシュボードから手動で削除してください。',
          'web.delete.deleteLog': '削除ログ',
          'web.delete.deleteTarget': '削除対象',
          'web.delete.resourcesLabel': 'リソース',
          'web.delete.deletePermanently': '完全に削除する',
          'web.delete.manualR2Title': '大容量のR2バケットは自動削除していません。Cloudflare DashboardでEmpty Bucketを実行してください：',
          'web.delete.manualR2Open': 'R2 Dashboardを開く ↗',
          'web.delete.manualR2Summary': '選択したその他の環境リソースは削除済みです。以下のR2バケットだけが手動作業待ちです。APIエラーではありません。',
          'web.delete.manualControlTokensTitle': 'Control APIトークンの手動確認',
          'web.delete.manualControlTokensSummary': 'Setupが管理するControl APIトークンの一部を自動取消しできませんでした。正確な所有権情報で検証済みの環境リソース削除は続行しました。表示される場合は正確なトークンIDと候補名をCloudflareの両方の一覧で確認してください。名前だけを根拠に削除しないでください。',
          'web.delete.manualControlTokenId': 'トークンID: {{tokenId}}',
          'web.delete.manualControlTokensAccountOpen': 'アカウントAPIトークンを開く ↗',
          'web.delete.manualControlTokensUserOpen': 'ユーザーAPIトークンを開く ↗',
        },
        'zh-CN': {
          'web.common.setupTool': '设置工具',
          'web.env.scanLog': '扫描日志',
          'web.env.scanningEnvironments': '正在扫描环境',
          'web.env.detected': '已检测',
          'web.env.environments': '环境',
          'web.env.start': '开始',
          'web.env.rescan': '重新扫描',
          'web.envDetail.overview': '概览',
          'web.envDetail.workersUpdates': 'Workers / 更新',
          'web.envDetail.storage': '存储',
          'web.envDetail.email': '邮件',
          'web.envDetail.resources': '资源',
          'web.envDetail.updates': '更新',
          'web.envDetail.verified': '部署已验证 ✓',
          'web.envDetail.deploymentChecking': '正在检查部署状态…',
          'web.envDetail.deploymentIncomplete': '部署未完成',
          'web.envDetail.deploymentStatusUnknown': '状态未验证',
          'web.envDetail.adminAccount': '管理员账户',
          'web.envDetail.workerUpdateHint': '比较已部署版本和本地构建',
          'web.envDetail.versionComparison': '版本比较',
          'web.envDetail.uiUpdates': 'UI 更新',
          'web.envDetail.origin': '来源',
          'web.envDetail.dedicatedR2Buckets': '专用 R2 存储桶',
          'web.envDetail.loadingR2Status': '正在加载 R2 存储桶状态...',
          'web.envDetail.r2ProvisionDesc': '创建 Authrim R2 存储桶，记录锁定绑定，启用 R2 功能标志，并重新部署 Workers。',
          'web.envDetail.provisionR2Deploy': '创建 R2 并部署',
          'web.envDetail.r2ProvisioningProgress': 'R2 创建进度',
          'web.delete.selectResourcesTitle': '选择要删除的资源',
          'web.delete.targetResources': '目标资源',
          'web.delete.workersDesc': 'Router、API 和 UI Workers',
          'web.delete.d1Desc': 'core / pii / admin，包含用户数据',
          'web.delete.kvDesc': '设置、缓存和运行时注册表',
          'web.delete.queuesDesc': '异步审计和投递队列',
          'web.delete.r2Desc': '专用存储桶',
          'web.delete.pagesDesc': '旧版 Pages 项目',
          'web.delete.finalConfirmation': '最终确认',
          'web.delete.dnsNote': '自定义域名的 DNS 记录不会自动删除。如不再需要，请在 Cloudflare 手动删除。',
          'web.delete.deleteLog': '删除日志',
          'web.delete.deleteTarget': '删除目标',
          'web.delete.resourcesLabel': '资源',
          'web.delete.deletePermanently': '永久删除',
          'web.delete.manualR2Title': '大型 R2 存储桶不会自动删除。请在 Cloudflare Dashboard 中将其清空：',
          'web.delete.manualR2Open': '打开 R2 Dashboard ↗',
          'web.delete.manualR2Summary': '其他选中的环境资源已删除。以下 R2 存储桶正在等待手动操作；这不是 API 错误。',
        },
        'zh-TW': {
          'web.common.setupTool': '設定工具',
          'web.env.scanLog': '掃描日誌',
          'web.env.scanningEnvironments': '正在掃描環境',
          'web.env.detected': '已偵測',
          'web.env.environments': '環境',
          'web.env.start': '開始',
          'web.env.rescan': '重新掃描',
          'web.envDetail.overview': '概覽',
          'web.envDetail.workersUpdates': 'Workers / 更新',
          'web.envDetail.storage': '儲存',
          'web.envDetail.email': '郵件',
          'web.envDetail.resources': '資源',
          'web.envDetail.updates': '更新',
          'web.envDetail.verified': '部署已驗證 ✓',
          'web.envDetail.deploymentChecking': '正在檢查部署狀態…',
          'web.envDetail.deploymentIncomplete': '部署未完成',
          'web.envDetail.deploymentStatusUnknown': '狀態未驗證',
          'web.envDetail.adminAccount': '管理員帳戶',
          'web.envDetail.workerUpdateHint': '比較已部署版本與本機建置',
          'web.envDetail.versionComparison': '版本比較',
          'web.envDetail.uiUpdates': 'UI 更新',
          'web.envDetail.origin': '來源',
          'web.envDetail.dedicatedR2Buckets': '專用 R2 儲存桶',
          'web.envDetail.loadingR2Status': '正在載入 R2 儲存桶狀態...',
          'web.envDetail.r2ProvisionDesc': '建立 Authrim R2 儲存桶，記錄鎖定綁定，啟用 R2 功能旗標，並重新部署 Workers。',
          'web.envDetail.provisionR2Deploy': '建立 R2 並部署',
          'web.envDetail.r2ProvisioningProgress': 'R2 建立進度',
          'web.delete.selectResourcesTitle': '選擇要刪除的資源',
          'web.delete.targetResources': '目標資源',
          'web.delete.workersDesc': 'Router、API 與 UI Workers',
          'web.delete.d1Desc': 'core / pii / admin，包含使用者資料',
          'web.delete.kvDesc': '設定、快取與執行期登錄',
          'web.delete.queuesDesc': '非同步稽核與投遞佇列',
          'web.delete.r2Desc': '專用儲存桶',
          'web.delete.pagesDesc': '舊版 Pages 專案',
          'web.delete.finalConfirmation': '最終確認',
          'web.delete.dnsNote': '自訂網域的 DNS 記錄不會自動刪除。如不再需要，請在 Cloudflare 手動刪除。',
          'web.delete.deleteLog': '刪除日誌',
          'web.delete.deleteTarget': '刪除目標',
          'web.delete.resourcesLabel': '資源',
          'web.delete.deletePermanently': '永久刪除',
          'web.delete.manualR2Title': '大型 R2 儲存貯體不會自動刪除。請在 Cloudflare Dashboard 中將其清空：',
          'web.delete.manualR2Open': '開啟 R2 Dashboard ↗',
          'web.delete.manualR2Summary': '其他已選取的環境資源已刪除。以下 R2 儲存貯體正在等待手動操作；這不是 API 錯誤。',
        },
        es: {
          'web.common.setupTool': 'Herramienta de setup',
          'web.env.scanLog': 'Log de escaneo',
          'web.env.scanningEnvironments': 'Escaneando entornos',
          'web.env.detected': 'Detectados',
          'web.env.environments': 'entornos',
          'web.env.start': 'Inicio',
          'web.env.rescan': 'Reescanear',
          'web.envDetail.overview': 'Resumen',
          'web.envDetail.workersUpdates': 'Workers / Updates',
          'web.envDetail.storage': 'Almacenamiento',
          'web.envDetail.email': 'Email',
          'web.envDetail.resources': 'Recursos',
          'web.envDetail.updates': 'Updates',
          'web.envDetail.verified': 'Despliegue verificado ✓',
          'web.envDetail.deploymentChecking': 'Comprobando el estado del despliegue…',
          'web.envDetail.deploymentIncomplete': 'Despliegue incompleto',
          'web.envDetail.deploymentStatusUnknown': 'Estado sin verificar',
          'web.envDetail.adminAccount': 'Cuenta admin',
          'web.envDetail.workerUpdateHint': 'Comparar versiones desplegadas con la build local',
          'web.envDetail.versionComparison': 'Comparación de versiones',
          'web.envDetail.uiUpdates': 'Updates de UI',
          'web.envDetail.origin': 'Origen',
          'web.envDetail.dedicatedR2Buckets': 'Buckets R2 dedicados',
          'web.envDetail.loadingR2Status': 'Cargando estado de buckets R2...',
          'web.envDetail.r2ProvisionDesc': 'Crea buckets R2 de Authrim, registra bindings de lock, activa la feature R2 y redespliega workers.',
          'web.envDetail.provisionR2Deploy': 'Provisionar R2 y desplegar',
          'web.envDetail.r2ProvisioningProgress': 'Progreso de R2',
          'web.delete.selectResourcesTitle': 'Seleccionar recursos a eliminar',
          'web.delete.targetResources': 'Recursos objetivo',
          'web.delete.workersDesc': 'Router, API y UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, incluye datos de usuarios',
          'web.delete.kvDesc': 'Configuración, cachés y registro runtime',
          'web.delete.queuesDesc': 'Colas de auditoría y entrega asíncronas',
          'web.delete.r2Desc': 'Buckets de almacenamiento dedicados',
          'web.delete.pagesDesc': 'Proyectos Pages legacy',
          'web.delete.finalConfirmation': 'Confirmación final',
          'web.delete.dnsNote': 'Los registros DNS de dominios personalizados no se eliminan automáticamente. Elimínalos manualmente en Cloudflare si ya no son necesarios.',
          'web.delete.deleteLog': 'Log de eliminación',
          'web.delete.deleteTarget': 'Objetivo',
          'web.delete.resourcesLabel': 'recursos',
          'web.delete.deletePermanently': 'Eliminar definitivamente',
          'web.delete.manualR2Title': 'Los buckets R2 grandes no se eliminan automáticamente. Vacíelos en Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'Abrir R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'Los demás recursos seleccionados del entorno se eliminaron. Los siguientes buckets R2 esperan una acción manual; no es un error de la API.',
        },
        pt: {
          'web.common.setupTool': 'Ferramenta de setup',
          'web.env.scanLog': 'Log de varredura',
          'web.env.scanningEnvironments': 'Escaneando ambientes',
          'web.env.detected': 'Detectados',
          'web.env.environments': 'ambientes',
          'web.env.start': 'Início',
          'web.env.rescan': 'Escanear novamente',
          'web.envDetail.overview': 'Visão geral',
          'web.envDetail.workersUpdates': 'Workers / Updates',
          'web.envDetail.storage': 'Armazenamento',
          'web.envDetail.email': 'Email',
          'web.envDetail.resources': 'Recursos',
          'web.envDetail.updates': 'Updates',
          'web.envDetail.verified': 'Deploy verificado ✓',
          'web.envDetail.deploymentChecking': 'Verificando o status do deploy…',
          'web.envDetail.deploymentIncomplete': 'Deploy incompleto',
          'web.envDetail.deploymentStatusUnknown': 'Status não verificado',
          'web.envDetail.adminAccount': 'Conta admin',
          'web.envDetail.workerUpdateHint': 'Compare versões implantadas com o build local',
          'web.envDetail.versionComparison': 'Comparação de versões',
          'web.envDetail.uiUpdates': 'Updates da UI',
          'web.envDetail.origin': 'Origem',
          'web.envDetail.dedicatedR2Buckets': 'Buckets R2 dedicados',
          'web.envDetail.loadingR2Status': 'Carregando status dos buckets R2...',
          'web.envDetail.r2ProvisionDesc': 'Cria buckets R2 do Authrim, registra bindings de lock, ativa a flag R2 e faz redeploy dos workers.',
          'web.envDetail.provisionR2Deploy': 'Provisionar R2 e fazer deploy',
          'web.envDetail.r2ProvisioningProgress': 'Progresso do R2',
          'web.delete.selectResourcesTitle': 'Selecionar recursos para excluir',
          'web.delete.targetResources': 'Recursos alvo',
          'web.delete.workersDesc': 'Router, API e UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, inclui dados de usuários',
          'web.delete.kvDesc': 'Configurações, caches e registro runtime',
          'web.delete.queuesDesc': 'Filas assíncronas de auditoria e entrega',
          'web.delete.r2Desc': 'Buckets de storage dedicados',
          'web.delete.pagesDesc': 'Projetos Pages legados',
          'web.delete.finalConfirmation': 'Confirmação final',
          'web.delete.dnsNote': 'Registros DNS de domínios personalizados não são excluídos automaticamente. Remova manualmente no Cloudflare se não forem mais necessários.',
          'web.delete.deleteLog': 'Log de exclusão',
          'web.delete.deleteTarget': 'Alvo',
          'web.delete.resourcesLabel': 'recursos',
          'web.delete.deletePermanently': 'Excluir permanentemente',
          'web.delete.manualR2Title': 'Buckets R2 grandes não são excluídos automaticamente. Esvazie-os no Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'Abrir R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'Os outros recursos selecionados do ambiente foram excluídos. Os buckets R2 abaixo aguardam uma ação manual; isso não é um erro da API.',
        },
        fr: {
          'web.common.setupTool': 'Outil de setup',
          'web.env.scanLog': 'Journal de scan',
          'web.env.scanningEnvironments': 'Scan des environnements',
          'web.env.detected': 'Détectés',
          'web.env.environments': 'environnements',
          'web.env.start': 'Début',
          'web.env.rescan': 'Relancer le scan',
          'web.envDetail.overview': 'Vue d’ensemble',
          'web.envDetail.workersUpdates': 'Workers / mises à jour',
          'web.envDetail.storage': 'Stockage',
          'web.envDetail.email': 'Email',
          'web.envDetail.resources': 'Ressources',
          'web.envDetail.updates': 'Mises à jour',
          'web.envDetail.verified': 'Déploiement vérifié ✓',
          'web.envDetail.deploymentChecking': 'Vérification de l’état du déploiement…',
          'web.envDetail.deploymentIncomplete': 'Déploiement incomplet',
          'web.envDetail.deploymentStatusUnknown': 'État non vérifié',
          'web.envDetail.adminAccount': 'Compte admin',
          'web.envDetail.workerUpdateHint': 'Comparer les versions déployées et le build local',
          'web.envDetail.versionComparison': 'Comparaison des versions',
          'web.envDetail.uiUpdates': 'Mises à jour UI',
          'web.envDetail.origin': 'Origine',
          'web.envDetail.dedicatedR2Buckets': 'Buckets R2 dédiés',
          'web.envDetail.loadingR2Status': 'Chargement du statut R2...',
          'web.envDetail.r2ProvisionDesc': 'Crée les buckets R2 Authrim, enregistre les bindings de verrou, active le flag R2 et redéploie les workers.',
          'web.envDetail.provisionR2Deploy': 'Provisionner R2 et déployer',
          'web.envDetail.r2ProvisioningProgress': 'Progression R2',
          'web.delete.selectResourcesTitle': 'Sélectionner les ressources à supprimer',
          'web.delete.targetResources': 'Ressources ciblées',
          'web.delete.workersDesc': 'Router, API et UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, avec données utilisateur',
          'web.delete.kvDesc': 'Paramètres, caches et registre runtime',
          'web.delete.queuesDesc': 'Files d’audit et de livraison asynchrones',
          'web.delete.r2Desc': 'Buckets de stockage dédiés',
          'web.delete.pagesDesc': 'Projets Pages legacy',
          'web.delete.finalConfirmation': 'Confirmation finale',
          'web.delete.dnsNote': 'Les enregistrements DNS des domaines personnalisés ne sont pas supprimés automatiquement. Supprimez-les manuellement dans Cloudflare si nécessaire.',
          'web.delete.deleteLog': 'Journal de suppression',
          'web.delete.deleteTarget': 'Cible',
          'web.delete.resourcesLabel': 'ressources',
          'web.delete.deletePermanently': 'Supprimer définitivement',
          'web.delete.manualR2Title': 'Les grands buckets R2 ne sont pas supprimés automatiquement. Videz-les dans Cloudflare Dashboard :',
          'web.delete.manualR2Open': 'Ouvrir R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'Les autres ressources sélectionnées ont été supprimées. Les buckets R2 ci-dessous attendent une action manuelle ; il ne s’agit pas d’une erreur API.',
        },
        de: {
          'web.common.setupTool': 'Setup-Tool',
          'web.env.scanLog': 'Scan-Log',
          'web.env.scanningEnvironments': 'Umgebungen werden gescannt',
          'web.env.detected': 'Gefunden',
          'web.env.environments': 'Umgebungen',
          'web.env.start': 'Start',
          'web.env.rescan': 'Neu scannen',
          'web.envDetail.overview': 'Übersicht',
          'web.envDetail.workersUpdates': 'Workers / Updates',
          'web.envDetail.storage': 'Speicher',
          'web.envDetail.email': 'E-Mail',
          'web.envDetail.resources': 'Ressourcen',
          'web.envDetail.updates': 'Updates',
          'web.envDetail.verified': 'Bereitstellung verifiziert ✓',
          'web.envDetail.deploymentChecking': 'Bereitstellungsstatus wird geprüft…',
          'web.envDetail.deploymentIncomplete': 'Bereitstellung unvollständig',
          'web.envDetail.deploymentStatusUnknown': 'Status nicht verifiziert',
          'web.envDetail.adminAccount': 'Admin-Konto',
          'web.envDetail.workerUpdateHint': 'Deployte Versionen mit lokalem Build vergleichen',
          'web.envDetail.versionComparison': 'Versionsvergleich',
          'web.envDetail.uiUpdates': 'UI-Updates',
          'web.envDetail.origin': 'Origin',
          'web.envDetail.dedicatedR2Buckets': 'Dedizierte R2-Buckets',
          'web.envDetail.loadingR2Status': 'R2-Bucket-Status wird geladen...',
          'web.envDetail.r2ProvisionDesc': 'Erstellt Authrim-R2-Buckets, schreibt Lock-Bindings, aktiviert das R2-Feature-Flag und deployt Workers erneut.',
          'web.envDetail.provisionR2Deploy': 'R2 bereitstellen und deployen',
          'web.envDetail.r2ProvisioningProgress': 'R2-Fortschritt',
          'web.delete.selectResourcesTitle': 'Zu löschende Ressourcen auswählen',
          'web.delete.targetResources': 'Zielressourcen',
          'web.delete.workersDesc': 'Router-, API- und UI-Workers',
          'web.delete.d1Desc': 'core / pii / admin, inklusive Benutzerdaten',
          'web.delete.kvDesc': 'Einstellungen, Caches und Runtime-Registry',
          'web.delete.queuesDesc': 'Asynchrone Audit- und Delivery-Queues',
          'web.delete.r2Desc': 'Dedizierte Storage-Buckets',
          'web.delete.pagesDesc': 'Legacy-Pages-Projekte',
          'web.delete.finalConfirmation': 'Finale Bestätigung',
          'web.delete.dnsNote': 'DNS-Einträge für Custom Domains werden nicht automatisch gelöscht. Entfernen Sie sie bei Bedarf manuell in Cloudflare.',
          'web.delete.deleteLog': 'Löschprotokoll',
          'web.delete.deleteTarget': 'Ziel',
          'web.delete.resourcesLabel': 'Ressourcen',
          'web.delete.deletePermanently': 'Endgültig löschen',
          'web.delete.manualR2Title': 'Große R2-Buckets werden nicht automatisch gelöscht. Leeren Sie sie im Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'R2 Dashboard öffnen ↗',
          'web.delete.manualR2Summary': 'Die übrigen ausgewählten Umgebungsressourcen wurden gelöscht. Die folgenden R2-Buckets warten auf eine manuelle Aktion; dies ist kein API-Fehler.',
        },
        ko: {
          'web.common.setupTool': '설정 도구',
          'web.env.scanLog': '스캔 로그',
          'web.env.scanningEnvironments': '환경 스캔 중',
          'web.env.detected': '감지됨',
          'web.env.environments': '환경',
          'web.env.start': '시작',
          'web.env.rescan': '다시 스캔',
          'web.envDetail.overview': '개요',
          'web.envDetail.workersUpdates': 'Workers / 업데이트',
          'web.envDetail.storage': '스토리지',
          'web.envDetail.email': '이메일',
          'web.envDetail.resources': '리소스',
          'web.envDetail.updates': '업데이트',
          'web.envDetail.verified': '배포 검증 완료 ✓',
          'web.envDetail.deploymentChecking': '배포 상태 확인 중…',
          'web.envDetail.deploymentIncomplete': '배포 미완료',
          'web.envDetail.deploymentStatusUnknown': '상태 미확인',
          'web.envDetail.adminAccount': '관리자 계정',
          'web.envDetail.workerUpdateHint': '배포된 버전과 로컬 빌드 비교',
          'web.envDetail.versionComparison': '버전 비교',
          'web.envDetail.uiUpdates': 'UI 업데이트',
          'web.envDetail.origin': '출처',
          'web.envDetail.dedicatedR2Buckets': '전용 R2 버킷',
          'web.envDetail.loadingR2Status': 'R2 버킷 상태 로딩 중...',
          'web.envDetail.r2ProvisionDesc': 'Authrim R2 버킷을 만들고 lock binding을 기록하며 R2 기능 플래그를 켠 뒤 Workers를 다시 배포합니다.',
          'web.envDetail.provisionR2Deploy': 'R2 생성 후 배포',
          'web.envDetail.r2ProvisioningProgress': 'R2 생성 진행 상황',
          'web.delete.selectResourcesTitle': '삭제할 리소스 선택',
          'web.delete.targetResources': '대상 리소스',
          'web.delete.workersDesc': 'Router, API, UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, 사용자 데이터 포함',
          'web.delete.kvDesc': '설정, 캐시, 런타임 레지스트리',
          'web.delete.queuesDesc': '비동기 감사 및 전송 큐',
          'web.delete.r2Desc': '전용 스토리지 버킷',
          'web.delete.pagesDesc': '레거시 Pages 프로젝트',
          'web.delete.finalConfirmation': '최종 확인',
          'web.delete.dnsNote': '사용자 지정 도메인의 DNS 레코드는 자동 삭제되지 않습니다. 필요 없으면 Cloudflare에서 수동으로 삭제하세요.',
          'web.delete.deleteLog': '삭제 로그',
          'web.delete.deleteTarget': '삭제 대상',
          'web.delete.resourcesLabel': '리소스',
          'web.delete.deletePermanently': '영구 삭제',
          'web.delete.manualR2Title': '대용량 R2 버킷은 자동으로 삭제되지 않습니다. Cloudflare Dashboard에서 비워 주세요:',
          'web.delete.manualR2Open': 'R2 Dashboard 열기 ↗',
          'web.delete.manualR2Summary': '선택한 다른 환경 리소스는 삭제되었습니다. 아래 R2 버킷은 수동 작업을 기다리고 있으며 API 오류가 아닙니다.',
        },
        ru: {
          'web.common.setupTool': 'Инструмент setup',
          'web.env.scanLog': 'Лог сканирования',
          'web.env.scanningEnvironments': 'Сканирование сред',
          'web.env.detected': 'Найдено',
          'web.env.environments': 'среды',
          'web.env.start': 'Начало',
          'web.env.rescan': 'Сканировать снова',
          'web.envDetail.overview': 'Обзор',
          'web.envDetail.workersUpdates': 'Workers / обновления',
          'web.envDetail.storage': 'Хранилище',
          'web.envDetail.email': 'Почта',
          'web.envDetail.resources': 'Ресурсы',
          'web.envDetail.updates': 'Обновления',
          'web.envDetail.verified': 'Развертывание подтверждено ✓',
          'web.envDetail.deploymentChecking': 'Проверка состояния развертывания…',
          'web.envDetail.deploymentIncomplete': 'Развертывание не завершено',
          'web.envDetail.deploymentStatusUnknown': 'Статус не подтвержден',
          'web.envDetail.adminAccount': 'Аккаунт администратора',
          'web.envDetail.workerUpdateHint': 'Сравнить развернутые версии с локальной сборкой',
          'web.envDetail.versionComparison': 'Сравнение версий',
          'web.envDetail.uiUpdates': 'Обновления UI',
          'web.envDetail.origin': 'Источник',
          'web.envDetail.dedicatedR2Buckets': 'Выделенные R2 buckets',
          'web.envDetail.loadingR2Status': 'Загрузка статуса R2 bucket...',
          'web.envDetail.r2ProvisionDesc': 'Создает R2 buckets Authrim, записывает lock bindings, включает флаг R2 и повторно деплоит Workers.',
          'web.envDetail.provisionR2Deploy': 'Создать R2 и деплоить',
          'web.envDetail.r2ProvisioningProgress': 'Прогресс R2',
          'web.delete.selectResourcesTitle': 'Выберите ресурсы для удаления',
          'web.delete.targetResources': 'Целевые ресурсы',
          'web.delete.workersDesc': 'Router, API и UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, включая данные пользователей',
          'web.delete.kvDesc': 'Настройки, кэши и runtime registry',
          'web.delete.queuesDesc': 'Асинхронные очереди аудита и доставки',
          'web.delete.r2Desc': 'Выделенные storage buckets',
          'web.delete.pagesDesc': 'Legacy Pages projects',
          'web.delete.finalConfirmation': 'Финальное подтверждение',
          'web.delete.dnsNote': 'DNS-записи custom domains не удаляются автоматически. Удалите их вручную в Cloudflare, если они больше не нужны.',
          'web.delete.deleteLog': 'Лог удаления',
          'web.delete.deleteTarget': 'Цель удаления',
          'web.delete.resourcesLabel': 'ресурсов',
          'web.delete.deletePermanently': 'Удалить навсегда',
          'web.delete.manualR2Title': 'Большие бакеты R2 не удаляются автоматически. Очистите их в Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'Открыть R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'Остальные выбранные ресурсы окружения удалены. Указанные ниже бакеты R2 ожидают ручного действия; это не ошибка API.',
        },
        id: {
          'web.common.setupTool': 'Alat setup',
          'web.env.scanLog': 'Log pemindaian',
          'web.env.scanningEnvironments': 'Memindai environment',
          'web.env.detected': 'Terdeteksi',
          'web.env.environments': 'environment',
          'web.env.start': 'Mulai',
          'web.env.rescan': 'Pindai ulang',
          'web.envDetail.overview': 'Ringkasan',
          'web.envDetail.workersUpdates': 'Workers / update',
          'web.envDetail.storage': 'Storage',
          'web.envDetail.email': 'Email',
          'web.envDetail.resources': 'Resource',
          'web.envDetail.updates': 'Update',
          'web.envDetail.verified': 'Deployment terverifikasi ✓',
          'web.envDetail.deploymentChecking': 'Memeriksa status deployment…',
          'web.envDetail.deploymentIncomplete': 'Deployment belum selesai',
          'web.envDetail.deploymentStatusUnknown': 'Status belum diverifikasi',
          'web.envDetail.adminAccount': 'Akun admin',
          'web.envDetail.workerUpdateHint': 'Bandingkan versi deploy dengan build lokal',
          'web.envDetail.versionComparison': 'Perbandingan versi',
          'web.envDetail.uiUpdates': 'Update UI',
          'web.envDetail.origin': 'Origin',
          'web.envDetail.dedicatedR2Buckets': 'Bucket R2 khusus',
          'web.envDetail.loadingR2Status': 'Memuat status bucket R2...',
          'web.envDetail.r2ProvisionDesc': 'Membuat bucket R2 Authrim, mencatat lock binding, mengaktifkan flag R2, dan redeploy Workers.',
          'web.envDetail.provisionR2Deploy': 'Provision R2 dan deploy',
          'web.envDetail.r2ProvisioningProgress': 'Progres R2',
          'web.delete.selectResourcesTitle': 'Pilih resource untuk dihapus',
          'web.delete.targetResources': 'Resource target',
          'web.delete.workersDesc': 'Router, API, dan UI Workers',
          'web.delete.d1Desc': 'core / pii / admin, termasuk data pengguna',
          'web.delete.kvDesc': 'Settings, cache, dan runtime registry',
          'web.delete.queuesDesc': 'Queue audit dan pengiriman asinkron',
          'web.delete.r2Desc': 'Bucket storage khusus',
          'web.delete.pagesDesc': 'Project Pages legacy',
          'web.delete.finalConfirmation': 'Konfirmasi akhir',
          'web.delete.dnsNote': 'Record DNS domain kustom tidak dihapus otomatis. Hapus manual di Cloudflare jika tidak diperlukan.',
          'web.delete.deleteLog': 'Log penghapusan',
          'web.delete.deleteTarget': 'Target hapus',
          'web.delete.resourcesLabel': 'resource',
          'web.delete.deletePermanently': 'Hapus permanen',
          'web.delete.manualR2Title': 'Bucket R2 berukuran besar tidak dihapus secara otomatis. Kosongkan melalui Cloudflare Dashboard:',
          'web.delete.manualR2Open': 'Buka R2 Dashboard ↗',
          'web.delete.manualR2Summary': 'Resource environment lain yang dipilih sudah dihapus. Bucket R2 berikut menunggu tindakan manual; ini bukan error API.',
        },
      };
      const envManagementSupplementalLocaleOrder = [
        'zh-CN',
        'zh-TW',
        'es',
        'pt',
        'fr',
        'de',
        'ko',
        'ru',
        'id',
      ];
      const envManagementSupplementalRows = {
        'web.envDetail.capacityTab': ['D1 容量', 'D1 容量', 'Capacidad D1', 'Capacidade D1', 'Capacité D1', 'D1-Kapazität', 'D1 용량', 'Емкость D1', 'Kapasitas D1'],
        'web.envDetail.capacityTitle': ['控制平面容量', '控制平面容量', 'Capacidad del plano de control', 'Capacidade do plano de controle', 'Capacité du plan de contrôle', 'Kapazität der Steuerungsebene', '컨트롤 플레인 용량', 'Емкость плоскости управления', 'Kapasitas control plane'],
        'web.envDetail.capacityHint': ['由服务器管理的放置方案', '由伺服器管理的配置方案', 'Plan de ubicación administrado por el servidor', 'Plano de alocação gerenciado pelo servidor', 'Plan de placement géré par le serveur', 'Serververwalteter Platzierungsplan', '서버 관리 배치 계획', 'Управляемый сервером план размещения', 'Rencana penempatan yang dikelola server'],
        'web.envDetail.capacityScope': ['范围', '範圍', 'Ámbito', 'Escopo', 'Portée', 'Bereich', '범위', 'Область', 'Cakupan'],
        'web.envDetail.capacityShared': ['共享池', '共用集區', 'Grupo compartido', 'Pool compartilhado', 'Pool partagé', 'Gemeinsamer Pool', '공유 풀', 'Общий пул', 'Pool bersama'],
        'web.envDetail.capacityDedicated': ['专用租户', '專用租戶', 'Tenant dedicado', 'Tenant dedicado', 'Tenant dédié', 'Dedizierter Tenant', '전용 테넌트', 'Выделенный тенант', 'Tenant khusus'],
        'web.envDetail.capacityTenant': ['租户', '租戶', 'Tenant', 'Tenant', 'Tenant', 'Tenant', '테넌트', 'Тенант', 'Tenant'],
        'web.envDetail.capacityProfile': ['容量配置', '容量設定檔', 'Perfil de capacidad', 'Perfil de capacidade', 'Profil de capacité', 'Kapazitätsprofil', '용량 프로필', 'Профиль емкости', 'Profil kapasitas'],
        'web.envDetail.capacityMinimum': ['最低', '最低', 'Mínimo', 'Mínimo', 'Minimum', 'Minimum', '최소', 'Минимум', 'Minimum'],
        'web.envDetail.capacityRecommended': ['推荐', '建議', 'Recomendado', 'Recomendado', 'Recommandé', 'Empfohlen', '권장', 'Рекомендуется', 'Direkomendasikan'],
        'web.envDetail.capacityExtra': ['额外余量', '額外餘裕', 'Margen adicional', 'Margem adicional', 'Marge supplémentaire', 'Zusätzliche Reserve', '추가 여유', 'Дополнительный резерв', 'Cadangan tambahan'],
        'web.envDetail.capacityPreview': ['预览', '預覽', 'Vista previa', 'Prévia', 'Aperçu', 'Vorschau', '미리 보기', 'Предпросмотр', 'Pratinjau'],
        'web.envDetail.capacityAdd': ['增加容量', '新增容量', 'Añadir capacidad', 'Adicionar capacidade', 'Ajouter de la capacité', 'Kapazität hinzufügen', '용량 추가', 'Добавить емкость', 'Tambah kapasitas'],
        'web.envDetail.capacityPlan': ['容量方案', '容量方案', 'Plan de capacidad', 'Plano de capacidade', 'Plan de capacité', 'Kapazitätsplan', '용량 계획', 'План емкости', 'Rencana kapasitas'],
        'web.envDetail.capacitySelectEnvironment': ['请先选择环境。', '請先選擇環境。', 'Seleccione primero un entorno.', 'Selecione primeiro um ambiente.', 'Sélectionnez d’abord un environnement.', 'Wählen Sie zuerst eine Umgebung aus.', '먼저 환경을 선택하세요.', 'Сначала выберите среду.', 'Pilih environment terlebih dahulu.'],
        'web.envDetail.capacityNoTenant': ['没有可用的活动专用租户。', '沒有可用的有效專用租戶。', 'No hay ningún tenant dedicado activo disponible.', 'Nenhum tenant dedicado ativo está disponível.', 'Aucun tenant dédié actif n’est disponible.', 'Es ist kein aktiver dedizierter Tenant verfügbar.', '사용 가능한 활성 전용 테넌트가 없습니다.', 'Нет доступного активного выделенного тенанта.', 'Tidak ada tenant khusus aktif yang tersedia.'],
        'web.envDetail.capacitySummary': ['{{units}} 个单元 / {{d1}} 个 D1 / 共 {{total}} 个', '{{units}} 個單元 / {{d1}} 個 D1 / 共 {{total}} 個', '{{units}} unidad(es) / {{d1}} D1 / {{total}} en total', '{{units}} unidade(s) / {{d1}} D1 / {{total}} no total', '{{units}} unité(s) / {{d1}} D1 / {{total}} au total', '{{units}} Einheit(en) / {{d1}} D1 / {{total}} insgesamt', '{{units}}개 단위 / D1 {{d1}}개 / 총 {{total}}개', '{{units}} ед. / {{d1}} D1 / всего {{total}}', '{{units}} unit / {{d1}} D1 / total {{total}}'],
        'web.envDetail.capacityPreviewState': ['预览', '預覽', 'vista previa', 'prévia', 'aperçu', 'Vorschau', '미리 보기', 'предпросмотр', 'pratinjau'],
        'web.envDetail.capacityLoading': ['正在加载容量方案...', '正在載入容量方案...', 'Cargando el plan de capacidad...', 'Carregando o plano de capacidade...', 'Chargement du plan de capacité...', 'Kapazitätsplan wird geladen...', '용량 계획을 불러오는 중...', 'Загрузка плана емкости...', 'Memuat rencana kapasitas...'],
        'web.envDetail.capacityCreating': ['正在创建容量操作...', '正在建立容量作業...', 'Creando operaciones de capacidad...', 'Criando operações de capacidade...', 'Création des opérations de capacité...', 'Kapazitätsvorgänge werden erstellt...', '용량 작업을 생성하는 중...', 'Создание операций емкости...', 'Membuat operasi kapasitas...'],
        'web.envDetail.capacityRequestFailed': ['容量请求失败。', '容量要求失敗。', 'Error en la solicitud de capacidad.', 'Falha na solicitação de capacidade.', 'Échec de la demande de capacité.', 'Kapazitätsanfrage fehlgeschlagen.', '용량 요청에 실패했습니다.', 'Запрос емкости завершился ошибкой.', 'Permintaan kapasitas gagal.'],
        'web.envDetail.capacityCreated': ['已创建规范的 Control 操作。现在可以执行待处理的 Setup 操作。', '已建立正式的 Control 作業。現在可以執行待處理的 Setup 動作。', 'Se crearon las operaciones de Control canónicas. Las acciones pendientes de Setup ya están disponibles.', 'As operações canônicas do Control foram criadas. As ações pendentes do Setup já estão disponíveis.', 'Les opérations Control canoniques ont été créées. Les actions Setup en attente sont disponibles.', 'Die kanonischen Control-Vorgänge wurden erstellt. Ausstehende Setup-Aktionen sind jetzt verfügbar.', '정식 Control 작업을 생성했습니다. 이제 보류 중인 Setup 작업을 실행할 수 있습니다.', 'Созданы канонические операции Control. Ожидающие действия Setup теперь доступны.', 'Operasi Control kanonis telah dibuat. Tindakan Setup yang tertunda kini tersedia.'],
        'web.envDetail.capacitySatisfied': ['当前容量已满足此配置。', '目前容量已符合此設定檔。', 'La capacidad actual ya satisface este perfil.', 'A capacidade atual já atende a este perfil.', 'La capacité actuelle satisfait déjà ce profil.', 'Die aktuelle Kapazität erfüllt dieses Profil bereits.', '현재 용량이 이미 이 프로필을 충족합니다.', 'Текущая емкость уже соответствует этому профилю.', 'Kapasitas saat ini sudah memenuhi profil ini.'],
        'web.envDetail.capacityReady': ['容量预览已准备好。', '容量預覽已就緒。', 'La vista previa de capacidad está lista.', 'A prévia de capacidade está pronta.', 'L’aperçu de capacité est prêt.', 'Die Kapazitätsvorschau ist bereit.', '용량 미리 보기가 준비되었습니다.', 'Предпросмотр емкости готов.', 'Pratinjau kapasitas sudah siap.'],
        'web.envDetail.migrations': ['迁移', '移轉', 'Migraciones', 'Migrações', 'Migrations', 'Migrationen', '마이그레이션', 'Миграции', 'Migrasi'],
        'web.envDetail.releaseUpdateAvailable': ['有新的 Authrim 版本可用', '有新的 Authrim 版本可用', 'Hay una nueva versión de Authrim disponible', 'Uma nova versão do Authrim está disponível', 'Une nouvelle version d’Authrim est disponible', 'Eine neue Authrim-Version ist verfügbar', '새 Authrim 버전을 사용할 수 있습니다', 'Доступна новая версия Authrim', 'Versi Authrim baru tersedia'],
        'web.envDetail.releaseUpdateResume': ['继续中断的更新', '繼續中斷的更新', 'Continuar la actualización interrumpida', 'Continuar a atualização interrompida', 'Reprendre la mise à jour interrompue', 'Unterbrochenes Update fortsetzen', '중단된 업데이트 계속하기', 'Продолжить прерванное обновление', 'Lanjutkan update yang terhenti'],
        'web.envDetail.releaseUpdateDesc': ['Setup 会先应用所需的数据库更改，再更新服务并验证结果。您的设置和数据将被保留。', 'Setup 會先套用必要的資料庫變更，再更新服務並驗證結果。您的設定與資料都會保留。', 'Setup aplicará los cambios de base de datos necesarios, actualizará los servicios y verificará el resultado. Se conservarán la configuración y los datos.', 'O Setup aplicará as alterações de banco de dados necessárias, atualizará os serviços e verificará o resultado. Suas configurações e dados serão preservados.', 'Setup appliquera les modifications de base de données requises, mettra à jour les services et vérifiera le résultat. Vos paramètres et données seront conservés.', 'Setup wendet erforderliche Datenbankänderungen an, aktualisiert die Dienste und prüft das Ergebnis. Einstellungen und Daten bleiben erhalten.', 'Setup이 필요한 데이터베이스 변경을 적용하고 서비스를 업데이트한 뒤 결과를 확인합니다. 설정과 데이터는 유지됩니다.', 'Setup применит необходимые изменения базы данных, обновит сервисы и проверит результат. Настройки и данные будут сохранены.', 'Setup akan menerapkan perubahan database yang diperlukan, memperbarui layanan, lalu memverifikasi hasilnya. Pengaturan dan data Anda tetap dipertahankan.'],
        'web.envDetail.releaseUpdateBlocked': ['必须先解决上一个操作，才能开始此次更新。', '必須先解決上一個作業，才能開始此次更新。', 'Esta actualización no puede comenzar hasta resolver la operación anterior.', 'Esta atualização não pode começar até que a operação anterior seja resolvida.', 'Cette mise à jour ne peut pas démarrer avant la résolution de l’opération précédente.', 'Dieses Update kann erst nach Klärung des vorherigen Vorgangs gestartet werden.', '이전 작업을 해결하기 전에는 이 업데이트를 시작할 수 없습니다.', 'Обновление нельзя начать, пока не будет устранена предыдущая операция.', 'Update ini tidak dapat dimulai sebelum operasi sebelumnya diselesaikan.'],
        'web.envDetail.releaseUpdateOlderTool': ['此 Setup 源比已安装的环境旧。请使用最新的软件包重新启动 Setup。', '此 Setup 來源比已安裝的環境舊。請使用最新套件重新啟動 Setup。', 'Esta fuente de Setup es anterior al entorno instalado. Inicie Setup de nuevo con el paquete más reciente.', 'Esta fonte do Setup é mais antiga que o ambiente instalado. Inicie o Setup novamente com o pacote mais recente.', 'Cette source Setup est plus ancienne que l’environnement installé. Relancez Setup avec le paquet le plus récent.', 'Diese Setup-Quelle ist älter als die installierte Umgebung. Starten Sie Setup mit dem neuesten Paket neu.', '이 Setup 소스가 설치된 환경보다 오래되었습니다. 최신 패키지로 Setup을 다시 시작하세요.', 'Исходный пакет Setup старее установленной среды. Перезапустите Setup с последним пакетом.', 'Sumber Setup ini lebih lama daripada environment yang terpasang. Jalankan kembali Setup dengan paket terbaru.'],
        'web.envDetail.releaseUpdateAction': ['立即更新', '立即更新', 'Actualizar ahora', 'Atualizar agora', 'Mettre à jour maintenant', 'Jetzt aktualisieren', '지금 업데이트', 'Обновить сейчас', 'Update sekarang'],
        'web.envDetail.releaseUpdateDatabaseOnlyAction': ['仅更新数据库（高级）', '僅更新資料庫（進階）', 'Actualizar solo las bases de datos (avanzado)', 'Atualizar apenas bancos de dados (avançado)', 'Mettre à jour uniquement les bases de données (avancé)', 'Nur Datenbanken aktualisieren (erweitert)', '데이터베이스만 업데이트(고급)', 'Обновить только базы данных (расширенный режим)', 'Update database saja (lanjutan)'],
        'web.envDetail.releaseUpdateDatabaseOnlyConfirm': ['是否在不更新 Workers 的情况下仅更新数据库？只有发布清单明确声明已安装的 Worker 版本与新架构兼容时才允许这样做。', '是否在不更新 Workers 的情況下僅更新資料庫？只有發布資訊清單明確宣告已安裝的 Worker 版本與新結構相容時才允許。', '¿Actualizar las bases de datos sin actualizar Workers? Solo se permite si el manifiesto de la versión declara explícitamente que la versión de Worker instalada es compatible con el nuevo esquema.', 'Atualizar os bancos de dados sem atualizar os Workers? Isso só é permitido quando o manifesto da versão declara explicitamente que a versão instalada do Worker é compatível com o novo esquema.', 'Mettre à jour les bases de données sans mettre à jour les Workers ? Cela n’est permis que si le manifeste de version déclare explicitement la version Worker installée compatible avec le nouveau schéma.', 'Datenbanken aktualisieren, ohne Workers zu aktualisieren? Dies ist nur zulässig, wenn das Release-Manifest die installierte Worker-Version ausdrücklich als mit dem neuen Schema kompatibel erklärt.', 'Workers를 업데이트하지 않고 데이터베이스만 업데이트할까요? 릴리스 매니페스트가 설치된 Worker 버전과 새 스키마의 호환성을 명시한 경우에만 허용됩니다.', 'Обновить базы данных без обновления Workers? Это разрешено, только если манифест релиза явно указывает совместимость установленной версии Worker с новой схемой.', 'Update database tanpa memperbarui Workers? Ini hanya diizinkan jika manifes rilis secara eksplisit menyatakan versi Worker yang terpasang kompatibel dengan skema baru.'],
        'web.envDetail.releaseUpdateResumeAction': ['继续更新', '繼續更新', 'Continuar actualización', 'Continuar atualização', 'Reprendre la mise à jour', 'Update fortsetzen', '업데이트 계속', 'Продолжить обновление', 'Lanjutkan update'],
        'web.envDetail.releaseUpdatePreparing': ['正在准备更新...', '正在準備更新...', 'Preparando la actualización...', 'Preparando a atualização...', 'Préparation de la mise à jour...', 'Update wird vorbereitet...', '업데이트 준비 중...', 'Подготовка обновления...', 'Menyiapkan update...'],
        'web.envDetail.releaseUpdateDatabase': ['正在更新数据库...', '正在更新資料庫...', 'Actualizando las bases de datos...', 'Atualizando os bancos de dados...', 'Mise à jour des bases de données...', 'Datenbanken werden aktualisiert...', '데이터베이스 업데이트 중...', 'Обновление баз данных...', 'Memperbarui database...'],
        'web.envDetail.releaseUpdateServices': ['正在更新服务...', '正在更新服務...', 'Actualizando los servicios...', 'Atualizando os serviços...', 'Mise à jour des services...', 'Dienste werden aktualisiert...', '서비스 업데이트 중...', 'Обновление сервисов...', 'Memperbarui layanan...'],
        'web.envDetail.releaseUpdateVerifying': ['正在验证更新...', '正在驗證更新...', 'Verificando la actualización...', 'Verificando a atualização...', 'Vérification de la mise à jour...', 'Update wird überprüft...', '업데이트 확인 중...', 'Проверка обновления...', 'Memverifikasi update...'],
        'web.envDetail.releaseUpdateComplete': ['Authrim 已是最新版本。', 'Authrim 已是最新版本。', 'Authrim está actualizado.', 'O Authrim está atualizado.', 'Authrim est à jour.', 'Authrim ist auf dem neuesten Stand.', 'Authrim이 최신 상태입니다.', 'Authrim обновлен.', 'Authrim sudah terbaru.'],
        'web.envDetail.releaseUpdateContinuing': ['数据库迁移正在 Control 中安全地继续。您可以关闭 Setup，并在 Admin UI 中监控或重试。', '資料庫移轉正在 Control 中安全地繼續。您可以關閉 Setup，並在 Admin UI 中監控或重試。', 'La migración de la base de datos continúa de forma segura en Control. Puede cerrar Setup y supervisar o reintentar desde Admin UI.', 'A migração do banco de dados continua com segurança no Control. Você pode fechar o Setup e monitorar ou tentar novamente pela Admin UI.', 'La migration de la base de données se poursuit en toute sécurité dans Control. Vous pouvez fermer Setup et la surveiller ou la relancer depuis Admin UI.', 'Die Datenbankmigration wird sicher in Control fortgesetzt. Sie können Setup schließen und sie in der Admin UI überwachen oder erneut versuchen.', '데이터베이스 마이그레이션은 Control에서 안전하게 계속됩니다. Setup을 닫고 Admin UI에서 모니터링하거나 재시도할 수 있습니다.', 'Миграция базы данных безопасно продолжается в Control. Можно закрыть Setup и отслеживать или повторить операцию в Admin UI.', 'Migrasi database tetap berjalan dengan aman di Control. Anda dapat menutup Setup dan memantau atau mencoba lagi dari Admin UI.'],
        'web.envDetail.releaseUpdateFailed': ['更新已停止。您可以从此页面安全地重试。', '更新已停止。您可以從此畫面安全地重試。', 'La actualización se detuvo. Puede reintentarlo de forma segura desde esta pantalla.', 'A atualização parou. Você pode tentar novamente com segurança nesta tela.', 'La mise à jour s’est arrêtée. Vous pouvez la relancer en toute sécurité depuis cet écran.', 'Das Update wurde angehalten. Sie können es auf diesem Bildschirm sicher erneut versuchen.', '업데이트가 중지되었습니다. 이 화면에서 안전하게 다시 시도할 수 있습니다.', 'Обновление остановлено. Его можно безопасно повторить с этого экрана.', 'Update terhenti. Anda dapat mencoba lagi dengan aman dari layar ini.'],
        'web.envDetail.releaseUpdateDetails': ['显示更新详情', '顯示更新詳細資料', 'Mostrar detalles de la actualización', 'Mostrar detalhes da atualização', 'Afficher les détails de la mise à jour', 'Update-Details anzeigen', '업데이트 세부 정보 표시', 'Показать сведения об обновлении', 'Tampilkan detail update'],
        'web.envDetail.serviceSiteFallback': ['服务站点绑定', '服務網站繫結', 'Binding del sitio de servicio', 'Binding do site de serviço', 'Binding du site de service', 'Service-Site-Binding', '서비스 사이트 바인딩', 'Привязка сервисного сайта', 'Binding situs layanan'],
        'web.envDetail.serviceSiteFallbackHint': ['将 ar-router 绑定到您的服务 Worker', '將 ar-router 繫結至您的服務 Worker', 'Vincular ar-router a su Worker de servicio', 'Vincular o ar-router ao seu Worker de serviço', 'Lier ar-router à votre Worker de service', 'ar-router an Ihren Service-Worker binden', 'ar-router를 서비스 Worker에 바인딩', 'Привязать ar-router к сервисному Worker', 'Bind ar-router ke Worker layanan Anda'],
        'web.envDetail.serviceSiteFallbackDesc': ['当 Authrim、Admin UI、Login UI 和服务站点共用一个域名时使用。此页面会添加 Service Binding 并部署 ar-router；之后可在 Admin UI > Login UI 中启用运行时回退。', '當 Authrim、Admin UI、Login UI 與服務網站共用一個網域時使用。此畫面會新增 Service Binding 並部署 ar-router；之後可在 Admin UI > Login UI 中啟用執行階段後援。', 'Úselo cuando Authrim, Admin UI, Login UI y el sitio de servicio compartan un dominio. Esta pantalla añade el Service Binding y despliega ar-router; active después el fallback de runtime en Admin UI > Login UI.', 'Use quando Authrim, Admin UI, Login UI e o site de serviço compartilharem um domínio. Esta tela adiciona o Service Binding e implanta o ar-router; depois, ative o fallback de runtime em Admin UI > Login UI.', 'Utilisez cette option quand Authrim, Admin UI, Login UI et le site de service partagent un domaine. Cet écran ajoute le Service Binding et déploie ar-router ; activez ensuite le fallback runtime dans Admin UI > Login UI.', 'Verwenden Sie dies, wenn Authrim, Admin UI, Login UI und die Service-Site eine Domain teilen. Dieser Bildschirm fügt das Service Binding hinzu und stellt ar-router bereit; aktivieren Sie den Runtime-Fallback später unter Admin UI > Login UI.', 'Authrim, Admin UI, Login UI와 서비스 사이트가 하나의 도메인을 공유할 때 사용합니다. 이 화면은 Service Binding을 추가하고 ar-router를 배포합니다. 런타임 폴백은 나중에 Admin UI > Login UI에서 활성화하세요.', 'Используйте, когда Authrim, Admin UI, Login UI и сервисный сайт работают на одном домене. Этот экран добавляет Service Binding и разворачивает ar-router; затем включите runtime fallback в Admin UI > Login UI.', 'Gunakan saat Authrim, Admin UI, Login UI, dan situs layanan memakai satu domain. Layar ini menambahkan Service Binding dan men-deploy ar-router; aktifkan fallback runtime nanti dari Admin UI > Login UI.'],
        'web.envDetail.serviceSiteEnabled': ['添加 Service Binding', '新增 Service Binding', 'Añadir Service Binding', 'Adicionar Service Binding', 'Ajouter le Service Binding', 'Service Binding hinzufügen', 'Service Binding 추가', 'Добавить Service Binding', 'Tambahkan Service Binding'],
        'web.envDetail.serviceSiteEnabledHint': ['将配置的 Worker 作为 Service Binding 添加到 ar-router。运行时回退仍由 Admin UI 设置控制。', '將設定的 Worker 作為 Service Binding 新增至 ar-router。執行階段後援仍由 Admin UI 設定控制。', 'Añade el Worker configurado como Service Binding en ar-router. El fallback de runtime continúa bajo el control de Admin UI.', 'Adiciona o Worker configurado como Service Binding no ar-router. O fallback de runtime continua sendo controlado pela Admin UI.', 'Ajoute le Worker configuré comme Service Binding sur ar-router. Le fallback runtime reste contrôlé par les paramètres de l’Admin UI.', 'Fügt den konfigurierten Worker als Service Binding zu ar-router hinzu. Der Runtime-Fallback wird weiterhin über die Admin UI gesteuert.', '설정한 Worker를 ar-router의 Service Binding으로 추가합니다. 런타임 폴백은 계속 Admin UI 설정에서 제어합니다.', 'Добавляет настроенный Worker как Service Binding для ar-router. Runtime fallback по-прежнему управляется настройками Admin UI.', 'Menambahkan Worker yang dikonfigurasi sebagai Service Binding pada ar-router. Fallback runtime tetap dikendalikan oleh pengaturan Admin UI.'],
        'web.envDetail.serviceSiteWorkerName': ['服务 Worker 名称', '服務 Worker 名稱', 'Nombre del Worker de servicio', 'Nome do Worker de serviço', 'Nom du Worker de service', 'Name des Service-Workers', '서비스 Worker 이름', 'Имя сервисного Worker', 'Nama Worker layanan'],
        'web.envDetail.serviceSiteBinding': ['绑定名称', '繫結名稱', 'Nombre del binding', 'Nome do binding', 'Nom du binding', 'Binding-Name', '바인딩 이름', 'Имя привязки', 'Nama binding'],
        'web.envDetail.serviceSiteSaveDeploy': ['保存并部署 Router', '儲存並部署 Router', 'Guardar y desplegar Router', 'Salvar e implantar o Router', 'Enregistrer et déployer le Router', 'Speichern und Router bereitstellen', '저장 후 Router 배포', 'Сохранить и развернуть Router', 'Simpan dan deploy Router'],
        'web.envDetail.serviceSiteProgress': ['服务站点进度', '服務網站進度', 'Progreso del sitio de servicio', 'Progresso do site de serviço', 'Progression du site de service', 'Fortschritt der Service-Site', '서비스 사이트 진행 상황', 'Ход настройки сервисного сайта', 'Progres situs layanan'],
        'web.envDetail.serviceSiteLoading': ['正在加载服务站点绑定状态...', '正在載入服務網站繫結狀態...', 'Cargando el estado del binding del sitio de servicio...', 'Carregando o status do binding do site de serviço...', 'Chargement de l’état du binding du site de service...', 'Status des Service-Site-Bindings wird geladen...', '서비스 사이트 바인딩 상태를 불러오는 중...', 'Загрузка состояния привязки сервисного сайта...', 'Memuat status binding situs layanan...'],
        'web.envDetail.serviceSiteEnabledSummary': ['已配置绑定：{{binding}} -> {{worker}}', '已設定繫結：{{binding}} -> {{worker}}', 'Binding configurado: {{binding}} -> {{worker}}', 'Binding configurado: {{binding}} -> {{worker}}', 'Binding configuré : {{binding}} -> {{worker}}', 'Binding konfiguriert: {{binding}} -> {{worker}}', '바인딩 구성됨: {{binding}} -> {{worker}}', 'Привязка настроена: {{binding}} -> {{worker}}', 'Binding dikonfigurasi: {{binding}} -> {{worker}}'],
        'web.envDetail.serviceSiteDisabledSummary': ['ar-router 上未配置服务站点绑定。', 'ar-router 上未設定服務網站繫結。', 'No hay ningún binding del sitio de servicio configurado en ar-router.', 'Nenhum binding de site de serviço está configurado no ar-router.', 'Aucun binding de site de service n’est configuré sur ar-router.', 'Für ar-router ist kein Service-Site-Binding konfiguriert.', 'ar-router에 서비스 사이트 바인딩이 구성되어 있지 않습니다.', 'Для ar-router не настроена привязка сервисного сайта.', 'Tidak ada binding situs layanan yang dikonfigurasi pada ar-router.'],
        'web.envDetail.serviceSiteWorkerRequired': ['添加绑定前，请输入服务 Worker 名称。', '新增繫結前，請輸入服務 Worker 名稱。', 'Introduzca el nombre del Worker de servicio antes de añadir el binding.', 'Informe o nome do Worker de serviço antes de adicionar o binding.', 'Saisissez le nom du Worker de service avant d’ajouter le binding.', 'Geben Sie vor dem Hinzufügen des Bindings den Namen des Service-Workers ein.', '바인딩을 추가하기 전에 서비스 Worker 이름을 입력하세요.', 'Перед добавлением привязки введите имя сервисного Worker.', 'Masukkan nama Worker layanan sebelum menambahkan binding.'],
        'web.envDetail.serviceSiteWorkerInvalid': ['Worker 名称只能包含小写字母、数字和连字符。', 'Worker 名稱只能包含小寫字母、數字與連字號。', 'El nombre del Worker debe usar letras minúsculas, números y guiones.', 'O nome do Worker deve usar letras minúsculas, números e hífens.', 'Le nom du Worker doit contenir des lettres minuscules, des chiffres et des tirets.', 'Der Worker-Name darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten.', 'Worker 이름에는 소문자, 숫자, 하이픈만 사용할 수 있습니다.', 'Имя Worker должно содержать строчные буквы, цифры и дефисы.', 'Nama Worker harus menggunakan huruf kecil, angka, dan tanda hubung.'],
        'web.envDetail.serviceSiteBindingInvalid': ['绑定名称只能包含大写字母、数字和下划线。', '繫結名稱只能包含大寫字母、數字與底線。', 'El nombre del binding debe usar letras mayúsculas, números y guiones bajos.', 'O nome do binding deve usar letras maiúsculas, números e underscores.', 'Le nom du binding doit contenir des lettres majuscules, des chiffres et des tirets bas.', 'Der Binding-Name darf nur Großbuchstaben, Zahlen und Unterstriche enthalten.', '바인딩 이름에는 대문자, 숫자, 밑줄만 사용할 수 있습니다.', 'Имя привязки должно содержать заглавные буквы, цифры и символы подчеркивания.', 'Nama binding harus menggunakan huruf besar, angka, dan garis bawah.'],
        'web.envDetail.serviceSiteConfirm': ['是否保存服务站点绑定设置并部署 ar-router？', '是否儲存服務網站繫結設定並部署 ar-router？', '¿Guardar la configuración del binding del sitio de servicio y desplegar ar-router?', 'Salvar as configurações de binding do site de serviço e implantar o ar-router?', 'Enregistrer les paramètres du binding du site de service et déployer ar-router ?', 'Service-Site-Binding speichern und ar-router bereitstellen?', '서비스 사이트 바인딩 설정을 저장하고 ar-router를 배포할까요?', 'Сохранить настройки привязки сервисного сайта и развернуть ar-router?', 'Simpan pengaturan binding situs layanan dan deploy ar-router?'],
        'web.envDetail.serviceSiteSaving': ['正在保存服务站点绑定设置...', '正在儲存服務網站繫結設定...', 'Guardando la configuración del binding del sitio de servicio...', 'Salvando as configurações de binding do site de serviço...', 'Enregistrement des paramètres du binding du site de service...', 'Service-Site-Binding wird gespeichert...', '서비스 사이트 바인딩 설정 저장 중...', 'Сохранение настроек привязки сервисного сайта...', 'Menyimpan pengaturan binding situs layanan...'],
        'web.envDetail.serviceSiteDeployComplete': ['服务站点绑定已部署。', '服務網站繫結已部署。', 'Se desplegó el binding del sitio de servicio.', 'O binding do site de serviço foi implantado.', 'Le binding du site de service a été déployé.', 'Das Service-Site-Binding wurde bereitgestellt.', '서비스 사이트 바인딩을 배포했습니다.', 'Привязка сервисного сайта развернута.', 'Binding situs layanan telah di-deploy.'],
        'web.envDetail.appLoginGuideTitle': ['App Login 后续步骤', 'App Login 後續步驟', 'Siguientes pasos de App Login', 'Próximas etapas do App Login', 'Étapes suivantes pour App Login', 'Nächste Schritte für App Login', 'App Login 다음 단계', 'Следующие шаги App Login', 'Langkah berikutnya untuk App Login'],
        'web.envDetail.appLoginGuideDesc': ['要将 Login UI 的直接登录引导至服务应用，请在 Admin UI 中将服务注册为 OIDC Client，在该 Client 上启用 First Party App 和 App Login，然后在 Admin UI > Login UI 的登录后设置中选择 App Login。', '若要將 Login UI 的直接登入導向服務應用程式，請在 Admin UI 中將服務註冊為 OIDC Client，在該 Client 啟用 First Party App 與 App Login，然後在 Admin UI > Login UI 的登入後設定中選擇 App Login。', 'Para enviar los inicios de sesión directos de Login UI a su aplicación de servicio, registre el servicio como OIDC Client en Admin UI, active First Party App y App Login en ese Client y seleccione App Login en la configuración posterior al inicio de sesión de Admin UI > Login UI.', 'Para enviar logins diretos da Login UI ao aplicativo de serviço, registre o serviço como OIDC Client na Admin UI, ative First Party App e App Login nesse Client e selecione App Login nas configurações pós-login em Admin UI > Login UI.', 'Pour diriger les connexions directes de Login UI vers votre application de service, enregistrez le service comme OIDC Client dans Admin UI, activez First Party App et App Login sur ce Client, puis sélectionnez App Login dans les paramètres après connexion de Admin UI > Login UI.', 'Um direkte Anmeldungen der Login UI an Ihre Service-App weiterzuleiten, registrieren Sie den Dienst in der Admin UI als OIDC Client, aktivieren Sie First Party App und App Login für diesen Client und wählen Sie dann App Login in den Einstellungen unter Admin UI > Login UI.', 'Login UI의 직접 로그인을 서비스 앱으로 보내려면 Admin UI에서 서비스를 OIDC Client로 등록하고 해당 Client에서 First Party App과 App Login을 활성화한 다음 Admin UI > Login UI의 로그인 후 설정에서 App Login을 선택하세요.', 'Чтобы направлять прямые входы Login UI в сервисное приложение, зарегистрируйте сервис как OIDC Client в Admin UI, включите для этого Client параметры First Party App и App Login, затем выберите App Login в настройках после входа в Admin UI > Login UI.', 'Untuk mengarahkan login langsung dari Login UI ke aplikasi layanan, daftarkan layanan sebagai OIDC Client di Admin UI, aktifkan First Party App dan App Login pada Client tersebut, lalu pilih App Login di pengaturan setelah login pada Admin UI > Login UI.'],
        'web.envDetail.appLoginGuideLink': ['打开 Admin UI 的 Login UI 设置', '開啟 Admin UI 的 Login UI 設定', 'Abrir la configuración de Login UI en Admin UI', 'Abrir configurações da Login UI na Admin UI', 'Ouvrir les paramètres Login UI dans Admin UI', 'Login-UI-Einstellungen in der Admin UI öffnen', 'Admin UI의 Login UI 설정 열기', 'Открыть настройки Login UI в Admin UI', 'Buka pengaturan Login UI di Admin UI'],
        'web.envDetail.migrationTitle': ['数据库迁移', '資料庫移轉', 'Migraciones de base de datos', 'Migrações de banco de dados', 'Migrations de base de données', 'Datenbankmigrationen', '데이터베이스 마이그레이션', 'Миграции базы данных', 'Migrasi database'],
        'web.envDetail.migrationLoading': ['正在加载迁移状态...', '正在載入移轉狀態...', 'Cargando el estado de las migraciones...', 'Carregando o status das migrações...', 'Chargement de l’état des migrations...', 'Migrationsstatus wird geladen...', '마이그레이션 상태를 불러오는 중...', 'Загрузка состояния миграций...', 'Memuat status migrasi...'],
        'web.envDetail.migrationApplied': ['已应用', '已套用', 'Aplicadas', 'Aplicadas', 'Appliquées', 'Angewendet', '적용됨', 'Применено', 'Diterapkan'],
        'web.envDetail.migrationPending': ['待处理', '待處理', 'Pendientes', 'Pendentes', 'En attente', 'Ausstehend', '대기 중', 'Ожидает', 'Tertunda'],
        'web.envDetail.migrationChanged': ['已更改', '已變更', 'Modificadas', 'Alteradas', 'Modifiées', 'Geändert', '변경됨', 'Изменено', 'Diubah'],
        'web.envDetail.migrationOrphaned': ['已孤立', '已孤立', 'Huérfanas', 'Órfãs', 'Orphelines', 'Verwaist', '고립됨', 'Потеряно', 'Orphan'],
        'web.envDetail.migrationRefresh': ['刷新', '重新整理', 'Actualizar', 'Atualizar', 'Actualiser', 'Aktualisieren', '새로 고침', 'Обновить', 'Muat ulang'],
        'web.envDetail.migrationApplyAllPending': ['应用所有待处理项', '套用所有待處理項目', 'Aplicar todas las pendientes', 'Aplicar todas as pendentes', 'Appliquer toutes les migrations en attente', 'Alle ausstehenden anwenden', '대기 중인 항목 모두 적용', 'Применить все ожидающие', 'Terapkan semua yang tertunda'],
        'web.envDetail.migrationProgress': ['迁移进度：', '移轉進度：', 'Progreso de migración:', 'Progresso da migração:', 'Progression des migrations :', 'Migrationsfortschritt:', '마이그레이션 진행 상황:', 'Ход миграции:', 'Progres migrasi:'],
        'web.envDetail.migrationStatus': ['状态', '狀態', 'Estado', 'Status', 'État', 'Status', '상태', 'Состояние', 'Status'],
        'web.envDetail.migrationFile': ['迁移文件', '移轉檔案', 'Archivo de migración', 'Arquivo de migração', 'Fichier de migration', 'Migrationsdatei', '마이그레이션 파일', 'Файл миграции', 'File migrasi'],
        'web.envDetail.migrationAppliedAt': ['应用时间', '套用時間', 'Aplicada el', 'Aplicada em', 'Appliquée le', 'Angewendet am', '적용 시간', 'Время применения', 'Diterapkan pada'],
        'web.envDetail.migrationChecksum': ['校验和', '總和檢查碼', 'Suma de comprobación', 'Checksum', 'Somme de contrôle', 'Prüfsumme', '체크섬', 'Контрольная сумма', 'Checksum'],
        'web.envDetail.migrationApplyPending': ['应用', '套用', 'Aplicar', 'Aplicar', 'Appliquer', 'Anwenden', '적용', 'Применить', 'Terapkan'],
        'web.envDetail.migrationStatusApplied': ['已应用', '已套用', 'Aplicada', 'Aplicada', 'Appliquée', 'Angewendet', '적용됨', 'Применено', 'Diterapkan'],
        'web.envDetail.migrationStatusPending': ['待处理', '待處理', 'Pendiente', 'Pendente', 'En attente', 'Ausstehend', '대기 중', 'Ожидает', 'Tertunda'],
        'web.envDetail.migrationStatusChanged': ['已更改', '已變更', 'Modificada', 'Alterada', 'Modifiée', 'Geändert', '변경됨', 'Изменено', 'Diubah'],
        'web.envDetail.migrationStatusOrphaned': ['已孤立', '已孤立', 'Huérfana', 'Órfã', 'Orpheline', 'Verwaist', '고립됨', 'Потеряно', 'Orphan'],
        'web.envDetail.migrationChangedBlocked': ['已应用的迁移文件发生了更改。“全部应用”已禁用；仍可单独应用待处理的行。', '已套用的移轉檔案已變更。「全部套用」已停用；仍可逐筆套用待處理項目。', 'Los archivos de migración aplicados han cambiado. Aplicar todo está desactivado; las filas pendientes pueden aplicarse individualmente.', 'Os arquivos de migração aplicados foram alterados. Aplicar tudo está desativado; as linhas pendentes podem ser aplicadas individualmente.', 'Les fichiers de migration appliqués ont changé. Tout appliquer est désactivé ; les lignes en attente peuvent être appliquées séparément.', 'Angewendete Migrationsdateien wurden geändert. „Alle anwenden“ ist deaktiviert; ausstehende Zeilen können einzeln angewendet werden.', '적용된 마이그레이션 파일이 변경되었습니다. 모두 적용은 비활성화되지만 대기 중인 행은 개별 적용할 수 있습니다.', 'Примененные файлы миграции изменились. «Применить все» отключено; ожидающие строки можно применить отдельно.', 'File migrasi yang telah diterapkan berubah. Terapkan semua dinonaktifkan; baris tertunda dapat diterapkan satu per satu.'],
        'web.envDetail.migrationPendingSummary': ['{{count}} 个待处理迁移', '{{count}} 個待處理移轉', '{{count}} migración(es) pendiente(s)', '{{count}} migração(ões) pendente(s)', '{{count}} migration(s) en attente', '{{count}} ausstehende Migration(en)', '대기 중인 마이그레이션 {{count}}개', '{{count}} ожидающих миграций', '{{count}} migrasi tertunda'],
        'web.envDetail.migrationMiniSummary': ['已应用 {{applied}} / 待处理 {{pending}} / 已更改 {{changed}}', '已套用 {{applied}} / 待處理 {{pending}} / 已變更 {{changed}}', '{{applied}} aplicadas / {{pending}} pendientes / {{changed}} modificadas', '{{applied}} aplicadas / {{pending}} pendentes / {{changed}} alteradas', '{{applied}} appliquées / {{pending}} en attente / {{changed}} modifiées', '{{applied}} angewendet / {{pending}} ausstehend / {{changed}} geändert', '적용 {{applied}} / 대기 {{pending}} / 변경 {{changed}}', 'применено {{applied}} / ожидает {{pending}} / изменено {{changed}}', '{{applied}} diterapkan / {{pending}} tertunda / {{changed}} diubah'],
        'web.envDetail.migrationNoPending': ['所有迁移均已应用。', '所有移轉皆已套用。', 'Todas las migraciones están aplicadas.', 'Todas as migrações foram aplicadas.', 'Toutes les migrations sont appliquées.', 'Alle Migrationen wurden angewendet.', '모든 마이그레이션이 적용되었습니다.', 'Все миграции применены.', 'Semua migrasi telah diterapkan.'],
        'web.envDetail.migrationNoFiles': ['未找到迁移文件。', '找不到移轉檔案。', 'No se encontraron archivos de migración.', 'Nenhum arquivo de migração foi encontrado.', 'Aucun fichier de migration trouvé.', 'Keine Migrationsdateien gefunden.', '마이그레이션 파일을 찾을 수 없습니다.', 'Файлы миграции не найдены.', 'Tidak ada file migrasi.'],
        'web.envDetail.migrationLoadFailed': ['无法加载迁移状态。', '無法載入移轉狀態。', 'No se pudo cargar el estado de las migraciones.', 'Falha ao carregar o status das migrações.', 'Échec du chargement de l’état des migrations.', 'Migrationsstatus konnte nicht geladen werden.', '마이그레이션 상태를 불러오지 못했습니다.', 'Не удалось загрузить состояние миграций.', 'Gagal memuat status migrasi.'],
        'web.envDetail.migrationApplyConfirm': ['是否应用所有待处理的数据库迁移？', '是否套用所有待處理的資料庫移轉？', '¿Aplicar todas las migraciones de base de datos pendientes?', 'Aplicar todas as migrações de banco de dados pendentes?', 'Appliquer toutes les migrations de base de données en attente ?', 'Alle ausstehenden Datenbankmigrationen anwenden?', '대기 중인 데이터베이스 마이그레이션을 모두 적용할까요?', 'Применить все ожидающие миграции базы данных?', 'Terapkan semua migrasi database yang tertunda?'],
        'web.envDetail.migrationApplying': ['正在应用数据库迁移...', '正在套用資料庫移轉...', 'Aplicando migraciones de base de datos...', 'Aplicando migrações de banco de dados...', 'Application des migrations de base de données...', 'Datenbankmigrationen werden angewendet...', '데이터베이스 마이그레이션 적용 중...', 'Применение миграций базы данных...', 'Menerapkan migrasi database...'],
        'web.envDetail.migrationComplete': ['数据库迁移已完成。', '資料庫移轉已完成。', 'Las migraciones de base de datos se completaron.', 'As migrações de banco de dados foram concluídas.', 'Les migrations de base de données sont terminées.', 'Datenbankmigrationen abgeschlossen.', '데이터베이스 마이그레이션이 완료되었습니다.', 'Миграции базы данных завершены.', 'Migrasi database selesai.'],
        'web.envDetail.r2OwnershipRecoverySummary': ['{{count}} 个 R2 存储桶绑定只有旧版名称所有权信息。继续前请显式验证：{{command}}', '{{count}} 個 R2 儲存桶繫結只有舊版名稱擁有權資訊。繼續前請明確驗證：{{command}}', '{{count}} binding(s) de R2 solo tienen propiedad heredada por nombre. Verifíquelos explícitamente antes de continuar: {{command}}', '{{count}} binding(s) R2 têm apenas propriedade legada por nome. Verifique-os explicitamente antes de continuar: {{command}}', '{{count}} liaison(s) R2 ne disposent que d’une propriété héritée basée sur le nom. Vérifiez-les explicitement avant de continuer : {{command}}', '{{count}} R2-Bindung(en) besitzen nur veraltete namensbasierte Eigentumsdaten. Prüfen Sie sie vor dem Fortfahren ausdrücklich: {{command}}', '{{count}}개의 R2 버킷 바인딩에 레거시 이름 기반 소유권 정보만 있습니다. 계속하기 전에 명시적으로 확인하세요: {{command}}', 'Для {{count}} привязок R2 сохранены только устаревшие данные владения по имени. Перед продолжением явно проверьте их: {{command}}', '{{count}} binding bucket R2 hanya memiliki kepemilikan lama berbasis nama. Verifikasi secara eksplisit sebelum melanjutkan: {{command}}'],
        'web.envDetail.r2OwnershipRecreateSummary': ['{{count}} 个 R2 存储桶绑定的旧版所有权信息不完整，无法安全验证。请重新创建环境后再预配 R2。', '{{count}} 個 R2 儲存桶繫結的舊版擁有權資訊不完整，無法安全驗證。請重新建立環境後再佈建 R2。', 'La propiedad heredada de {{count}} binding(s) de R2 está incompleta y no se puede verificar con seguridad. Vuelva a crear el entorno antes de aprovisionar R2.', 'A propriedade legada de {{count}} binding(s) R2 está incompleta e não pode ser verificada com segurança. Recrie o ambiente antes de provisionar o R2.', 'Les données de propriété héritées de {{count}} liaison(s) R2 sont incomplètes et ne peuvent pas être vérifiées en toute sécurité. Recréez l’environnement avant de provisionner R2.', 'Die veralteten Eigentumsdaten für {{count}} R2-Bindung(en) sind unvollständig und können nicht sicher geprüft werden. Erstellen Sie die Umgebung vor der R2-Bereitstellung neu.', '{{count}}개의 R2 버킷 바인딩에 대한 레거시 소유권 정보가 불완전하여 안전하게 확인할 수 없습니다. R2를 프로비저닝하기 전에 환경을 다시 만드세요.', 'Устаревшие данные владения для {{count}} привязок R2 неполны, поэтому их нельзя безопасно проверить. Пересоздайте среду перед подготовкой R2.', 'Kepemilikan lama untuk {{count}} binding R2 tidak lengkap dan tidak dapat diverifikasi dengan aman. Buat ulang environment sebelum melakukan provisioning R2.'],
        'web.envDetail.r2IdentityMismatchSummary': ['检测到 {{count}} 个 R2 存储桶身份不匹配。继续前请检查 Cloudflare 存储桶和环境锁。', '偵測到 {{count}} 個 R2 儲存桶身分不相符。繼續前請檢查 Cloudflare 儲存桶與環境鎖定。', 'Se detectaron {{count}} discrepancia(s) de identidad de R2. Revise el bucket de Cloudflare y el bloqueo del entorno antes de continuar.', 'Foram detectadas {{count}} divergência(s) de identidade R2. Revise o bucket da Cloudflare e o bloqueio do ambiente antes de continuar.', '{{count}} incohérence(s) d’identité R2 ont été détectées. Vérifiez le bucket Cloudflare et le verrou d’environnement avant de continuer.', '{{count}} R2-Identitätsabweichung(en) wurden erkannt. Prüfen Sie vor dem Fortfahren den Cloudflare-Bucket und die Umgebungssperre.', '{{count}}개의 R2 버킷 ID 불일치를 감지했습니다. 계속하기 전에 Cloudflare 버킷과 환경 잠금을 확인하세요.', 'Обнаружено несоответствий идентификаторов R2: {{count}}. Перед продолжением проверьте бакет Cloudflare и блокировку среды.', 'Terdeteksi {{count}} ketidakcocokan identitas R2. Tinjau bucket Cloudflare dan kunci environment sebelum melanjutkan.'],
        'web.status.percentComplete': ['已完成 {{percent}}%', '已完成 {{percent}}%', '{{percent}} % completado', '{{percent}}% concluído', '{{percent}} % terminé', '{{percent}} % abgeschlossen', '{{percent}}% 완료', 'Выполнено {{percent}}%', '{{percent}}% selesai'],
        'web.status.resourceProgress': ['{{current}} / {{total}} 个资源', '{{current}} / {{total}} 個資源', '{{current}} / {{total}} recursos', '{{current}} / {{total}} recursos', '{{current}} / {{total}} ressources', '{{current}} / {{total}} Ressourcen', '{{current}} / {{total}}개 리소스', '{{current}} / {{total}} ресурсов', '{{current}} / {{total}} resource'],
        'web.status.ok': ['正常', '正常', 'Correcto', 'OK', 'OK', 'OK', '정상', 'Готово', 'OK'],
        'web.status.checkRequired': ['需要检查', '需要檢查', 'Revisión necesaria', 'Verificação necessária', 'Vérification requise', 'Prüfung erforderlich', '확인 필요', 'Требуется проверка', 'Perlu diperiksa'],
        'web.status.unknown': ['未知', '未知', 'Desconocido', 'Desconhecido', 'Inconnu', 'Unbekannt', '알 수 없음', 'Неизвестно', 'Tidak diketahui'],
        'web.env.updateBadge': ['更新到 v{{version}}', '更新至 v{{version}}', 'Actualizar a v{{version}}', 'Atualizar para v{{version}}', 'Mettre à jour vers v{{version}}', 'Auf v{{version}} aktualisieren', 'v{{version}}(으)로 업데이트', 'Обновить до v{{version}}', 'Perbarui ke v{{version}}'],
        'web.delete.manualReviewRequired': ['需要手动检查', '需要手動檢查', 'Se requiere revisión manual', 'Revisão manual necessária', 'Vérification manuelle requise', 'Manuelle Prüfung erforderlich', '수동 확인 필요', 'Требуется ручная проверка', 'Perlu peninjauan manual'],
        'web.envDetail.capacityTargetsUnavailable': ['无法获取租户容量目标。', '無法取得租戶容量目標。', 'Los destinos de capacidad del tenant no están disponibles.', 'Os destinos de capacidade do tenant não estão disponíveis.', 'Les cibles de capacité du tenant ne sont pas disponibles.', 'Mandanten-Kapazitätsziele sind nicht verfügbar.', '테넌트 용량 대상을 가져올 수 없습니다.', 'Целевые ресурсы емкости тенанта недоступны.', 'Target kapasitas tenant tidak tersedia.'],
        'web.control.pendingTenant': ['租户 {{tenantId}}', '租戶 {{tenantId}}', 'Tenant {{tenantId}}', 'Tenant {{tenantId}}', 'Tenant {{tenantId}}', 'Mandant {{tenantId}}', '테넌트 {{tenantId}}', 'Тенант {{tenantId}}', 'Tenant {{tenantId}}'],
        'web.control.pendingDisasterRecovery': ['灾难恢复', '災難復原', 'Recuperación ante desastres', 'Recuperação de desastres', 'Reprise après sinistre', 'Notfallwiederherstellung', '재해 복구', 'Аварийное восстановление', 'Pemulihan bencana'],
        'web.control.pendingVerifyRuntimeBindings': ['验证运行时绑定', '驗證執行階段繫結', 'Verificar bindings de runtime', 'Verificar bindings de runtime', 'Vérifier les liaisons d’exécution', 'Laufzeitbindungen prüfen', '런타임 바인딩 확인', 'Проверка привязок среды выполнения', 'Verifikasi binding runtime'],
        'web.control.pendingSharedPool': ['共享池', '共用集區', 'Pool compartido', 'Pool compartilhado', 'Pool partagé', 'Gemeinsamer Pool', '공유 풀', 'Общий пул', 'Pool bersama'],
        'web.control.pendingProvisioning': ['正在预配', '正在佈建', 'Aprovisionamiento', 'Provisionamento', 'Provisionnement', 'Bereitstellung', '프로비저닝', 'Подготовка ресурсов', 'Provisioning'],
        'web.control.pendingTitle': ['待处理的预配操作', '待處理的佈建操作', 'Operaciones de aprovisionamiento pendientes', 'Operações de provisionamento pendentes', 'Opérations de provisionnement en attente', 'Ausstehende Bereitstellungsvorgänge', '대기 중인 프로비저닝 작업', 'Ожидающие операции подготовки', 'Operasi provisioning tertunda'],
        'web.control.pendingDescription': ['Setup将执行需要操作员权限的步骤，并持续显示Control的验证进度。', 'Setup 將執行需要操作員權限的步驟，並持續顯示 Control 的驗證進度。', 'Setup ejecuta los pasos que requieren permisos de operador y sigue mostrando el progreso de verificación de Control.', 'O Setup executa as etapas que exigem permissões do operador e continua exibindo o progresso da verificação do Control.', 'Setup exécute les étapes nécessitant les droits de l’opérateur et continue d’afficher la progression de la vérification de Control.', 'Setup führt Schritte aus, die Operatorrechte erfordern, und zeigt den Prüfungsfortschritt von Control weiter an.', 'Setup은 운영자 권한이 필요한 단계를 실행하고 Control 검증 진행 상황을 계속 표시합니다.', 'Setup выполняет этапы, требующие прав оператора, и продолжает показывать ход проверки Control.', 'Setup menjalankan langkah yang memerlukan izin operator dan terus menampilkan progres verifikasi Control.'],
        'web.control.pendingRun': ['运行待处理操作', '執行待處理操作', 'Ejecutar operación pendiente', 'Executar operação pendente', 'Exécuter l’opération en attente', 'Ausstehenden Vorgang ausführen', '대기 중인 작업 실행', 'Выполнить ожидающую операцию', 'Jalankan operasi tertunda'],
        'web.control.pendingObserving': ['Control正在执行私有冒烟测试或稳定化。此状态将自动刷新。', 'Control 正在執行私有冒煙測試或穩定化。此狀態將自動重新整理。', 'Control está ejecutando la prueba privada o la estabilización. Este estado se actualizará automáticamente.', 'O Control está executando o smoke test privado ou a estabilização. Este status será atualizado automaticamente.', 'Control exécute le test privé ou la stabilisation. Cet état sera actualisé automatiquement.', 'Control führt den privaten Smoke-Test oder die Stabilisierung aus. Dieser Status wird automatisch aktualisiert.', 'Control이 비공개 스모크 테스트 또는 안정화를 실행 중입니다. 상태가 자동으로 새로 고쳐집니다.', 'Control выполняет закрытую проверку или стабилизацию. Состояние обновится автоматически.', 'Control sedang menjalankan smoke test privat atau stabilisasi. Status ini akan dimuat ulang secara otomatis.'],
        'web.control.operationRunning': ['正在执行预配操作...', '正在執行佈建操作...', 'Ejecutando la operación de aprovisionamiento...', 'Executando a operação de provisionamento...', 'Exécution de l’opération de provisionnement...', 'Bereitstellungsvorgang wird ausgeführt...', '프로비저닝 작업 실행 중...', 'Выполняется операция подготовки ресурсов...', 'Menjalankan operasi provisioning...'],
        'web.control.operationFailed': ['Control 操作失败。', 'Control 操作失敗。', 'La operación de Control falló.', 'A operação de Control falhou.', 'L’opération Control a échoué.', 'Control-Vorgang fehlgeschlagen.', 'Control 작업에 실패했습니다.', 'Операция Control завершилась ошибкой.', 'Operasi Control gagal.'],
        'web.control.operationAwaitingMigration': ['D1 已创建。迁移已准备好进入下一操作步骤。', 'D1 已建立。移轉已可進入下一個操作步驟。', 'D1 creado. La migración está lista para el siguiente paso del operador.', 'D1 criado. A migração está pronta para a próxima etapa do operador.', 'D1 créé. La migration est prête pour l’étape opérateur suivante.', 'D1 erstellt. Die Migration ist für den nächsten Bedienerschritt bereit.', 'D1을 만들었습니다. 다음 운영자 단계에서 마이그레이션을 실행할 수 있습니다.', 'D1 создана. Миграция готова к следующему шагу оператора.', 'D1 dibuat. Migrasi siap untuk langkah operator berikutnya.'],
        'web.control.operationAwaitingWorkerBindings': ['迁移已完成。Worker 绑定协调已准备好进入下一操作步骤。', '移轉已完成。Worker 繫結協調已可進入下一個操作步驟。', 'Migración completada. La conciliación de bindings de Worker está lista para el siguiente paso.', 'Migração concluída. A reconciliação de bindings do Worker está pronta para a próxima etapa.', 'Migration terminée. La réconciliation des liaisons Worker est prête pour l’étape suivante.', 'Migration abgeschlossen. Der Abgleich der Worker-Bindungen ist für den nächsten Schritt bereit.', '마이그레이션이 완료되었습니다. 다음 운영자 단계에서 Worker 바인딩을 조정할 수 있습니다.', 'Миграция завершена. Согласование привязок Worker готово к следующему шагу.', 'Migrasi selesai. Rekonsiliasi binding Worker siap untuk langkah berikutnya.'],
        'web.control.operationAwaitingSmoke': ['Worker 绑定已修补。正在运行私有冒烟测试和稳定化。', 'Worker 繫結已修補。正在執行私有冒煙測試與穩定化。', 'Bindings de Worker actualizados. Se ejecutan las pruebas privadas y la estabilización.', 'Bindings do Worker atualizados. O smoke test privado e a estabilização estão em execução.', 'Liaisons Worker mises à jour. Le test privé et la stabilisation sont en cours.', 'Worker-Bindungen aktualisiert. Privater Smoke-Test und Stabilisierung laufen.', 'Worker 바인딩을 패치했습니다. 비공개 스모크 테스트와 안정화가 진행 중입니다.', 'Привязки Worker обновлены. Выполняются закрытая проверка и стабилизация.', 'Binding Worker diperbarui. Smoke test privat dan stabilisasi sedang berjalan.'],
        'web.control.operationAwaitingQuarantine': ['资源清理正在等待隔离期结束。', '資源清理正在等待隔離期結束。', 'La limpieza de recursos espera a que termine el período de cuarentena.', 'A limpeza de recursos aguarda o fim do período de quarentena.', 'Le nettoyage des ressources attend la fin de la période de quarantaine.', 'Die Ressourcenbereinigung wartet auf das Ende der Quarantänefrist.', '리소스 정리가 격리 기간 종료를 기다리고 있습니다.', 'Очистка ресурсов ожидает окончания периода карантина.', 'Pembersihan resource menunggu periode karantina selesai.'],
        'web.control.operationRetryRequired': ['预配需要重试。', '佈建需要重試。', 'El aprovisionamiento requiere un reintento.', 'O provisionamento requer nova tentativa.', 'Le provisionnement doit être relancé.', 'Die Bereitstellung muss wiederholt werden.', '프로비저닝을 다시 시도해야 합니다.', 'Требуется повторить подготовку ресурсов.', 'Provisioning perlu dicoba lagi.'],
        'web.control.operationLeaseUnavailable': ['另一个执行器当前拥有此操作。', '另一個執行器目前擁有此操作。', 'Otro ejecutor controla actualmente esta operación.', 'Outro executor controla esta operação no momento.', 'Un autre exécuteur contrôle actuellement cette opération.', 'Ein anderer Executor besitzt diesen Vorgang derzeit.', '다른 실행자가 현재 이 작업을 처리 중입니다.', 'Операция сейчас принадлежит другому исполнителю.', 'Executor lain sedang menangani operasi ini.'],
        'web.control.operationSucceeded': ['预配成功完成。', '佈建已成功完成。', 'El aprovisionamiento se completó correctamente.', 'O provisionamento foi concluído com sucesso.', 'Le provisionnement s’est terminé avec succès.', 'Die Bereitstellung wurde erfolgreich abgeschlossen.', '프로비저닝이 완료되었습니다.', 'Подготовка ресурсов успешно завершена.', 'Provisioning berhasil diselesaikan.'],
        'web.control.operationBlocked': ['预配被阻止。请检查操作状态。', '佈建已被阻擋。請檢查操作狀態。', 'El aprovisionamiento está bloqueado. Revise el estado de la operación.', 'O provisionamento está bloqueado. Revise o status da operação.', 'Le provisionnement est bloqué. Vérifiez l’état de l’opération.', 'Die Bereitstellung ist blockiert. Prüfen Sie den Vorgangsstatus.', '프로비저닝이 차단되었습니다. 작업 상태를 확인하세요.', 'Подготовка ресурсов заблокирована. Проверьте состояние операции.', 'Provisioning diblokir. Tinjau status operasi.'],
        'web.control.tokenLinkFailed': ['无法创建 Cloudflare 令牌链接。', '無法建立 Cloudflare 權杖連結。', 'No se pudo crear el enlace del token de Cloudflare.', 'Não foi possível criar o link do token da Cloudflare.', 'Impossible de créer le lien du jeton Cloudflare.', 'Der Cloudflare-Token-Link konnte nicht erstellt werden.', 'Cloudflare 토큰 링크를 만들 수 없습니다.', 'Не удалось создать ссылку для токена Cloudflare.', 'Tidak dapat membuat tautan token Cloudflare.'],
        'web.control.preparationFailed': ['Control 准备失败。', 'Control 準備失敗。', 'La preparación de Control falló.', 'A preparação do Control falhou.', 'La préparation de Control a échoué.', 'Control-Vorbereitung fehlgeschlagen.', 'Control 준비에 실패했습니다.', 'Подготовка Control завершилась ошибкой.', 'Persiapan Control gagal.'],
        'web.control.deploymentFailed': ['Control 部署失败。', 'Control 部署失敗。', 'El despliegue de Control falló.', 'A implantação do Control falhou.', 'Le déploiement de Control a échoué.', 'Control-Bereitstellung fehlgeschlagen.', 'Control 배포에 실패했습니다.', 'Развертывание Control завершилось ошибкой.', 'Deployment Control gagal.'],
        'web.control.credentialBootstrapFailed': ['凭据引导失败。', '認證資訊啟動失敗。', 'La inicialización de credenciales falló.', 'A inicialização das credenciais falhou.', 'L’amorçage des identifiants a échoué.', 'Anmeldedaten-Bootstrap fehlgeschlagen.', '자격 증명 부트스트랩에 실패했습니다.', 'Инициализация учетных данных завершилась ошибкой.', 'Bootstrap kredensial gagal.'],
        'web.control.revocationInterrupted': ['上一次撤销响应被中断。', '上次撤銷回應遭到中斷。', 'La respuesta de revocación anterior se interrumpió.', 'A resposta de revogação anterior foi interrompida.', 'La réponse de révocation précédente a été interrompue.', 'Die vorherige Widerrufsantwort wurde unterbrochen.', '이전 취소 응답이 중단되었습니다.', 'Предыдущий ответ на отзыв был прерван.', 'Respons pencabutan sebelumnya terputus.'],
        'web.control.revocationRecoveryRequired': ['{{error}} 请创建新的一次性令牌，在此输入，然后选择“启用”以验证并完成清理。', '{{error}} 請建立新的單次權杖，在此輸入，然後選取「啟用」以驗證並完成清理。', '{{error}} Cree un nuevo token de un solo uso, introdúzcalo aquí y seleccione Activar para verificar y terminar la limpieza.', '{{error}} Crie um novo token de uso único, insira-o aqui e selecione Ativar para verificar e concluir a limpeza.', '{{error}} Créez un nouveau jeton à usage unique, saisissez-le ici, puis sélectionnez Activer pour vérifier et terminer le nettoyage.', '{{error}} Erstellen Sie ein neues Einmal-Token, geben Sie es hier ein und wählen Sie Aktivieren, um Prüfung und Bereinigung abzuschließen.', '{{error}} 새 일회용 토큰을 만들어 여기에 입력한 후 활성화를 선택하여 확인 및 정리를 완료하세요.', '{{error}} Создайте новый одноразовый токен, введите его здесь и выберите «Включить», чтобы проверить и завершить очистку.', '{{error}} Buat token sekali pakai baru, masukkan di sini, lalu pilih Aktifkan untuk memverifikasi dan menyelesaikan pembersihan.'],
        'web.control.cutoverPaused': ['自动预配切换已暂停。', '自動佈建切換已暫停。', 'La transición del aprovisionamiento automático está pausada.', 'A transição do provisionamento automático está pausada.', 'Le basculement du provisionnement automatique est en pause.', 'Die Umschaltung der automatischen Bereitstellung wurde angehalten.', '자동 프로비저닝 전환이 일시 중지되었습니다.', 'Переключение автоматической подготовки ресурсов приостановлено.', 'Peralihan provisioning otomatis dijeda.'],
        'web.control.cutoverResumeRequired': ['{{error}} 请再次选择“启用”以恢复持久化的切换。', '{{error}} 請再次選取「啟用」以繼續持久化的切換。', '{{error}} Seleccione Activar de nuevo para reanudar la transición persistente.', '{{error}} Selecione Ativar novamente para retomar a transição persistente.', '{{error}} Sélectionnez de nouveau Activer pour reprendre le basculement persistant.', '{{error}} Wählen Sie erneut Aktivieren, um die dauerhafte Umschaltung fortzusetzen.', '{{error}} 활성화를 다시 선택하여 영속 전환을 재개하세요.', '{{error}} Снова выберите «Включить», чтобы возобновить сохраненное переключение.', '{{error}} Pilih Aktifkan lagi untuk melanjutkan peralihan persisten.'],
        'web.control.automaticProvisioningPaused': ['自动预配设置已暂停。', '自動佈建設定已暫停。', 'La configuración del aprovisionamiento automático está pausada.', 'A configuração do provisionamento automático está pausada.', 'La configuration du provisionnement automatique est en pause.', 'Die Einrichtung der automatischen Bereitstellung wurde angehalten.', '자동 프로비저닝 설정이 일시 중지되었습니다.', 'Настройка автоматической подготовки ресурсов приостановлена.', 'Penyiapan provisioning otomatis dijeda.'],
        'web.control.automaticProvisioningFailed': ['自动预配设置失败。', '自動佈建設定失敗。', 'La configuración del aprovisionamiento automático falló.', 'A configuração do provisionamento automático falhou.', 'La configuration du provisionnement automatique a échoué.', 'Die Einrichtung der automatischen Bereitstellung ist fehlgeschlagen.', '자동 프로비저닝 설정에 실패했습니다.', 'Настройка автоматической подготовки ресурсов завершилась ошибкой.', 'Penyiapan provisioning otomatis gagal.'],
        'web.delete.manualControlTokensTitle': ['手动检查 Control API 令牌', '手動檢查 Control API 權杖', 'Revisión manual de tokens de la API de Control', 'Revisão manual dos tokens da API de Control', 'Vérification manuelle des jetons de l’API Control', 'Manuelle Prüfung der Control-API-Token', 'Control API 토큰 수동 확인', 'Ручная проверка токенов Control API', 'Pemeriksaan manual token Control API'],
        'web.delete.manualControlTokensSummary': ['Setup 无法自动撤销一个或多个由其管理的 Control API 令牌。已使用准确的所有权证据继续删除已验证的环境资源。如果显示了准确的令牌 ID，请同时在 Cloudflare 的两个令牌列表中核对它们和候选名称；切勿仅凭名称删除令牌。', 'Setup 無法自動撤銷一或多個由其管理的 Control API 權杖。已使用精確的擁有權證據繼續刪除已驗證的環境資源。如果顯示精確的權杖 ID，請同時在 Cloudflare 的兩個權杖清單中核對它們與候選名稱；切勿僅憑名稱刪除權杖。', 'Setup no pudo revocar automáticamente uno o más tokens de la API de Control administrados por Setup. La eliminación de recursos verificados continuó usando pruebas exactas de propiedad. Revise los ID exactos que se muestren y los nombres candidatos en ambas listas de tokens de Cloudflare; no elimine un token basándose solo en su nombre.', 'O Setup não conseguiu revogar automaticamente um ou mais tokens da API de Control gerenciados pelo Setup. A exclusão dos recursos verificados continuou usando evidências exatas de propriedade. Confira os IDs exatos exibidos e os nomes candidatos nas duas listas de tokens da Cloudflare; não exclua um token apenas pelo nome.', 'Setup n’a pas pu révoquer automatiquement un ou plusieurs jetons de l’API Control qu’il gère. La suppression des ressources vérifiées s’est poursuivie à partir de preuves de propriété exactes. Vérifiez les ID exacts affichés et les noms candidats dans les deux listes de jetons Cloudflare ; ne supprimez jamais un jeton d’après son seul nom.', 'Setup konnte mindestens ein von Setup verwaltetes Control-API-Token nicht automatisch widerrufen. Die Löschung verifizierter Umgebungsressourcen wurde anhand eindeutiger Eigentumsnachweise fortgesetzt. Prüfen Sie angezeigte exakte Token-IDs und mögliche Namen in beiden Cloudflare-Tokenlisten; löschen Sie ein Token nie allein anhand seines Namens.', 'Setup에서 관리하는 Control API 토큰 하나 이상을 자동으로 취소하지 못했습니다. 정확한 소유권 증거로 확인된 환경 리소스 삭제는 계속 진행했습니다. 표시된 정확한 토큰 ID와 후보 이름을 Cloudflare의 두 토큰 목록에서 모두 확인하세요. 이름만으로 토큰을 삭제하지 마세요.', 'Setup не удалось автоматически отозвать один или несколько управляемых им токенов Control API. Удаление проверенных ресурсов среды продолжилось на основе точных данных о владении. Сверьте показанные точные ID и возможные имена в обоих списках токенов Cloudflare; не удаляйте токен только по имени.', 'Setup tidak dapat mencabut otomatis satu atau beberapa token Control API yang dikelolanya. Penghapusan resource environment terverifikasi dilanjutkan berdasarkan bukti kepemilikan yang tepat. Cocokkan ID token persis yang ditampilkan dan nama kandidat di kedua daftar token Cloudflare; jangan hapus token hanya berdasarkan namanya.'],
        'web.delete.manualControlTokenId': ['令牌 ID：{{tokenId}}', '權杖 ID：{{tokenId}}', 'ID del token: {{tokenId}}', 'ID do token: {{tokenId}}', 'ID du jeton : {{tokenId}}', 'Token-ID: {{tokenId}}', '토큰 ID: {{tokenId}}', 'ID токена: {{tokenId}}', 'ID token: {{tokenId}}'],
        'web.delete.manualControlTokensAccountOpen': ['打开账户 API 令牌 ↗', '開啟帳戶 API 權杖 ↗', 'Abrir tokens de API de la cuenta ↗', 'Abrir tokens de API da conta ↗', 'Ouvrir les jetons API du compte ↗', 'Konto-API-Token öffnen ↗', '계정 API 토큰 열기 ↗', 'Открыть API-токены аккаунта ↗', 'Buka token API akun ↗'],
        'web.delete.manualControlTokensUserOpen': ['打开用户 API 令牌 ↗', '開啟使用者 API 權杖 ↗', 'Abrir tokens de API del usuario ↗', 'Abrir tokens de API do usuário ↗', 'Ouvrir les jetons API utilisateur ↗', 'Benutzer-API-Token öffnen ↗', '사용자 API 토큰 열기 ↗', 'Открыть пользовательские API-токены ↗', 'Buka token API pengguna ↗'],
        'web.envDetail.uiUpdatesHint': ['单独重新部署 Admin UI 或 Login UI', '個別重新部署 Admin UI 或 Login UI', 'Vuelva a desplegar Admin UI o Login UI por separado', 'Reimplante a Admin UI ou a Login UI separadamente', 'Redéployez Admin UI ou Login UI séparément', 'Admin UI oder Login UI einzeln erneut bereitstellen', 'Admin UI 또는 Login UI를 개별적으로 다시 배포', 'Повторно разверните Admin UI или Login UI отдельно', 'Deploy ulang Admin UI atau Login UI secara terpisah'],
      };
      const envManagementSupplementalCopyByLocale = Object.fromEntries(
        envManagementSupplementalLocaleOrder.map((language, localeIndex) => [
          language,
          Object.fromEntries(
            Object.entries(envManagementSupplementalRows).map(([key, translations]) => [
              key,
              translations[localeIndex],
            ])
          ),
        ])
      );
      const envDynamicCopyByLocale = {
        en: {
          'web.env.heroKicker': 'Environment Management',
          'web.env.heroListTitle': 'Environments',
          'web.env.heroListAside': 'Authrim environments detected in this Cloudflare account. Scan uses the <b>{env}-ar-*</b> naming convention.',
          'web.env.heroDetailKicker': 'Environment Management - Detail',
          'web.env.heroDetailTitle': 'Environment <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Mode {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Environment Management - Delete',
          'web.env.heroDeleteTitle': 'Delete {{env}}',
          'web.env.heroDeleteAside': '<b>Review your selection.</b> Selected resources will be deleted from Cloudflare.',
          'web.env.accountMeta': 'Account <b>{{account}}</b>',
          'web.env.modeSingle': 'Single tenant',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Mode',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Open details ->',
          'web.env.adminConfigured': 'Configured ✓',
          'web.env.adminNotConfigured': 'Not configured',
          'web.env.resourceSummary': 'Environment <b>{{env}}</b> - resources <b>{{total}}</b>',
          'env.name': 'Environment',
          'web.status.failed': 'Failed',
          'web.envDetail.generating': 'Generating...',
          'web.envDetail.tokenGenerated': 'Token generated',
          'web.envDetail.uiUpdatesHint': 'Admin UI / Login UI',
          'web.email.continueResources': 'Continue to Resources →',
          'web.domain.tenantIdInvalid': '{{label}} must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.',
          'web.config.saveFailed': 'Failed to save configuration: {{error}}',
          'web.config.noConfigurationToSave': 'No configuration to save.',
          'web.provision.reprovisionConfirm': 'Warning: Re-provisioning will delete all existing resources and create new ones.\\n\\nThis action will:\\n- Delete existing D1 databases. All data will be lost.\\n- Delete existing KV namespaces.\\n- Generate new encryption keys.\\n\\nContinue?',
          'web.envDetail.noEnvironmentSelected': 'No environment selected.',
          'web.envDetail.positiveSlotCountRequired': 'Enter a positive slot count.',
          'web.envDetail.tenantStorageLoadFailed': 'Failed to load tenant storage status.',
          'web.envDetail.r2StatusLoadFailed': 'Failed to load R2 bucket status.',
          'web.envDetail.r2ConfiguredSummary': 'R2 buckets are configured: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'R2 buckets need provisioning: {{configured}} / {{required}} configured.',
          'web.envDetail.r2OwnershipRecoverySummary': '{{count}} R2 bucket binding(s) have legacy name-only ownership. Verify them explicitly before continuing: {{command}}',
          'web.envDetail.r2OwnershipRecreateSummary': 'Legacy ownership for {{count}} R2 bucket binding(s) is incomplete and cannot be verified safely. Recreate the environment before provisioning R2.',
          'web.envDetail.r2IdentityMismatchSummary': '{{count}} R2 bucket identity mismatch(es) were detected. Review the Cloudflare bucket and the environment lock before continuing.',
          'web.envDetail.provisionR2Confirm': 'This will create missing R2 buckets, refresh Worker bindings, and redeploy workers. Continue?',
          'web.envDetail.r2Provisioning': 'Provisioning R2 buckets...',
          'web.envDetail.r2ConfiguredBuckets': 'Configured buckets: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2 bucket provisioning completed.',
          'web.envDetail.workerUpdateStarting': 'Starting worker update for {{env}}...',
          'web.envDetail.fullDeployTitle': 'Deploy Entire Environment',
          'web.envDetail.fullDeployScope': 'API Workers + UI Workers',
          'web.envDetail.fullDeployDesc': 'Build and deploy all API Workers and enabled UI Workers from the current source. Existing data and settings are preserved.',
          'web.envDetail.fullDeployAction': 'Deploy Entire Environment',
          'web.envDetail.fullDeployProgress': 'Deployment Progress',
          'web.envDetail.fullDeployStarting': 'Starting full environment deployment for {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Deploying all API Workers...',
          'web.envDetail.fullDeployUiComponent': 'Deploying {{component}}...',
          'web.envDetail.fullDeploySummary': 'Completed: {{success}} / {{total}} components',
          'web.envDetail.fullDeployComplete': 'Full environment deployment completed.',
          'web.envDetail.fullDeployFailed': 'Full environment deployment failed: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Update completed successfully.',
          'web.envDetail.workerUpdateSummary': 'Summary: {{success}} / {{total}} workers updated',
          'web.envDetail.updateFailedWithMessage': 'Update failed: {{error}}',
          'web.envDetail.updateThis': 'Update this component',
          'web.envDetail.componentUpdating': 'Updating {{component}} for {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} updated successfully.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'This may take a few minutes while building and deploying to Workers.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Version: {{value}}',
          'web.envDetail.logDeployedAt': 'Deployed at: {{value}}',
          'web.envDetail.logProject': 'Project: {{value}}',
          'web.envDetail.configKvNotFound': 'Could not find the AUTHRIM_CONFIG KV namespace for this environment.',
          'web.envDetail.routerBaseUrlPrompt': 'Enter the base URL for the router, for example https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Failed to generate token: {{error}}',
          'web.delete.starting': 'Starting deletion...',
          'web.delete.deletedItems': 'Deleted {{count}} items',
          'web.delete.complete': 'Deletion complete.',
          'web.delete.manualActionRequired': 'Manual action required.',
          'web.delete.success': 'Environment deleted successfully.',
          'web.delete.partialSuccess': 'Selected resources were deleted. The environment and remaining local state were preserved.',
          'web.delete.errorList': 'Some errors occurred: {{errors}}',
          'web.delete.inventoryUnavailable': 'Cloudflare resource inventory could not be verified, so deletion did not start. Check your connection and Cloudflare sign-in, then retry.',
          'web.status.errorWithMessage': 'Error: {{error}}',
          'web.status.unknownError': 'Unknown error',
          'web.status.percentComplete': '{{percent}}% complete',
          'web.status.resourceProgress': '{{current}} / {{total}} resources',
          'web.status.ok': 'OK',
          'web.status.checkRequired': 'Check required',
          'web.status.unknown': 'Unknown',
          'web.env.updateBadge': 'Update to v{{version}}',
          'web.delete.manualReviewRequired': 'Manual review required',
          'web.envDetail.capacityTargetsUnavailable': 'Tenant capacity targets are unavailable.',
          'web.control.pendingTenant': 'Tenant {{tenantId}}',
          'web.control.pendingDisasterRecovery': 'Disaster recovery',
          'web.control.pendingVerifyRuntimeBindings': 'Verify runtime bindings',
          'web.control.pendingSharedPool': 'Shared pool',
          'web.control.pendingProvisioning': 'Provisioning',
          'web.control.pendingTitle': 'Pending provisioning operations',
          'web.control.pendingDescription': 'Setup runs steps that require operator permissions and continues to show Control verification progress.',
          'web.control.pendingRun': 'Run pending operation',
          'web.control.pendingObserving': 'Control is running private smoke or stabilization. This status refreshes automatically.',
          'web.control.operationRunning': 'Running provisioning operation...',
          'web.control.operationFailed': 'Control operation failed.',
          'web.control.operationAwaitingMigration': 'D1 created. Migration is ready for the next operator step.',
          'web.control.operationAwaitingWorkerBindings': 'Migration completed. Worker binding reconciliation is ready for the next operator step.',
          'web.control.operationAwaitingSmoke': 'Worker bindings patched. Private smoke and stabilization are running.',
          'web.control.operationAwaitingQuarantine': 'Resource cleanup is waiting for the quarantine period to finish.',
          'web.control.operationRetryRequired': 'Provisioning requires a retry.',
          'web.control.operationLeaseUnavailable': 'Another executor currently owns this operation.',
          'web.control.operationSucceeded': 'Provisioning completed successfully.',
          'web.control.operationBlocked': 'Provisioning is blocked. Review the operation status.',
          'web.control.tokenLinkFailed': 'Could not create the Cloudflare token link.',
          'web.control.preparationFailed': 'Control preparation failed.',
          'web.control.deploymentFailed': 'Control deployment failed.',
          'web.control.credentialBootstrapFailed': 'Credential bootstrap failed.',
          'web.control.revocationInterrupted': 'The previous revocation response was interrupted.',
          'web.control.revocationRecoveryRequired': '{{error}} Create a new one-time token, enter it here, and select Enable to verify and finish cleanup.',
          'web.control.cutoverPaused': 'Automatic provisioning cutover paused.',
          'web.control.cutoverResumeRequired': '{{error}} Select Enable again to resume the durable cutover.',
          'web.control.automaticProvisioningPaused': 'Automatic provisioning setup paused.',
          'web.control.automaticProvisioningFailed': 'Automatic provisioning setup failed.',
          'web.delete.confirmExact': 'To delete this environment, type <b>{{env}}</b> exactly.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        ja: {
          'web.env.heroKicker': '環境管理',
          'web.env.heroListTitle': '環境一覧',
          'web.env.heroListAside': 'このCloudflareアカウントで検出されたAuthrim環境です。スキャンは <b>{env}-ar-*</b> の命名規則に基づきます。',
          'web.env.heroDetailKicker': '環境管理 - 詳細',
          'web.env.heroDetailTitle': '環境詳細 <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'モード {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': '環境管理 - 削除確認',
          'web.env.heroDeleteTitle': '環境 {{env}} を削除',
          'web.env.heroDeleteAside': '<b>選択内容を確認してください。</b>選択したリソースをCloudflareアカウントから削除します。',
          'web.env.accountMeta': 'アカウント <b>{{account}}</b>',
          'web.env.modeSingle': 'シングルテナント',
          'web.env.modeMulti': 'マルチテナント',
          'web.env.cardMode': 'モード',
          'web.env.cardAdmin': '管理者',
          'web.env.openDetails': '詳細を開く →',
          'web.env.adminConfigured': '設定済み ✓',
          'web.env.adminNotConfigured': '未設定',
          'web.env.resourceSummary': '環境 <b>{{env}}</b> - リソース合計 <b>{{total}}</b>',
          'env.name': '環境',
          'web.status.failed': '失敗',
          'web.envDetail.generating': '生成中...',
          'web.envDetail.tokenGenerated': 'トークン生成済み',
          'web.envDetail.uiUpdatesHint': 'Admin UI / Login UI',
          'web.email.continueResources': 'リソース作成へ →',
          'web.domain.tenantIdInvalid': '{{label}} は小文字の英字で始め、小文字英字・数字・ハイフンのみを使用してください。',
          'web.config.saveFailed': '設定の保存に失敗しました: {{error}}',
          'web.config.noConfigurationToSave': '保存する設定がありません。',
          'web.provision.reprovisionConfirm': '警告: 再作成すると既存リソースを削除して作り直します。\\n\\nこの操作では次を実行します。\\n- 既存のD1データベースを削除します。すべてのデータが失われます。\\n- 既存のKV名前空間を削除します。\\n- 新しい暗号鍵を生成します。\\n\\n続行しますか？',
          'web.envDetail.noEnvironmentSelected': '環境が選択されていません。',
          'web.envDetail.positiveSlotCountRequired': '追加するスロット数には1以上の数値を入力してください。',
          'web.envDetail.tenantStorageLoadFailed': 'テナントストレージの状態を読み込めませんでした。',
          'web.envDetail.r2StatusLoadFailed': 'R2バケットの状態を読み込めませんでした。',
          'web.envDetail.r2ConfiguredSummary': 'R2バケットは設定済みです: {{configured}} / {{required}}。',
          'web.envDetail.r2NeedsProvisioningSummary': 'R2バケットの作成が必要です: {{configured}} / {{required}} 設定済み。',
          'web.envDetail.r2OwnershipRecoverySummary': '{{count}}個のR2バケットが旧形式の名前のみの所有権情報です。続行前に明示的に検証してください: {{command}}',
          'web.envDetail.r2OwnershipRecreateSummary': '{{count}}個のR2バケットについて旧形式の所有権情報が不足しており、安全に検証できません。環境を再作成してからR2をプロビジョニングしてください。',
          'web.envDetail.r2IdentityMismatchSummary': '{{count}}個のR2バケットで所有権IDの不一致を検出しました。続行前にCloudflare上のバケットと環境ロックを確認してください。',
          'web.envDetail.provisionR2Confirm': '不足しているR2バケットを作成し、Workerバインディングを更新して再デプロイします。続行しますか？',
          'web.envDetail.r2Provisioning': 'R2バケットを作成中...',
          'web.envDetail.r2ConfiguredBuckets': '設定済みバケット: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2バケットの作成が完了しました。',
          'web.envDetail.workerUpdateStarting': '{{env}} のWorker更新を開始しています...',
          'web.envDetail.fullDeployTitle': '環境全体をデプロイ',
          'web.envDetail.fullDeployScope': 'API Worker + UI Worker',
          'web.envDetail.fullDeployDesc': '現在のソースからAPI Workerと有効なUI Workerをすべてビルド・デプロイします。既存のデータと設定は維持されます。',
          'web.envDetail.fullDeployAction': '環境全体をデプロイ',
          'web.envDetail.fullDeployProgress': 'デプロイ進捗',
          'web.envDetail.fullDeployStarting': '{{env}} の環境全体デプロイを開始しています...',
          'web.envDetail.fullDeployApiPhase': 'API Workerをすべてデプロイ中...',
          'web.envDetail.fullDeployUiComponent': '{{component}}をデプロイ中...',
          'web.envDetail.fullDeploySummary': '完了: {{success}} / {{total}} コンポーネント',
          'web.envDetail.fullDeployComplete': '環境全体のデプロイが完了しました。',
          'web.envDetail.fullDeployFailed': '環境全体のデプロイに失敗しました: {{error}}',
          'web.envDetail.updateCompletedSuccess': '更新が完了しました。',
          'web.envDetail.workerUpdateSummary': '概要: {{success}} / {{total}} Workers 更新済み',
          'web.envDetail.updateFailedWithMessage': '更新に失敗しました: {{error}}',
          'web.envDetail.updateThis': 'このコンポーネントを更新',
          'web.envDetail.componentUpdating': '{{env}} の {{component}} を更新中...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} を更新しました。',
          'web.envDetail.uiUpdateMayTakeMinutes': 'ビルドとWorkersへのデプロイに数分かかる場合があります。',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'バージョン: {{value}}',
          'web.envDetail.logDeployedAt': 'デプロイ日時: {{value}}',
          'web.envDetail.logProject': 'プロジェクト: {{value}}',
          'web.envDetail.configKvNotFound': 'この環境の AUTHRIM_CONFIG KV 名前空間が見つかりません。',
          'web.envDetail.routerBaseUrlPrompt': 'Router のベースURLを入力してください。例: https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'トークン生成に失敗しました: {{error}}',
          'web.delete.starting': '削除を開始しています...',
          'web.delete.deletedItems': '{{count}} 件削除しました',
          'web.delete.complete': '削除が完了しました。',
          'web.delete.manualActionRequired': '手動対応が必要です。',
          'web.delete.success': '環境を削除しました。',
          'web.delete.partialSuccess': '選択したリソースを削除しました。環境と残りのローカル状態は保持されています。',
          'web.delete.errorList': 'エラーが発生しました: {{errors}}',
          'web.delete.inventoryUnavailable': 'Cloudflareのリソース一覧を確認できなかったため、削除を開始しませんでした。接続とCloudflareへのログイン状態を確認して、再試行してください。',
          'web.status.errorWithMessage': 'エラー: {{error}}',
          'web.status.unknownError': '不明なエラー',
          'web.status.percentComplete': '{{percent}}% 完了',
          'web.status.resourceProgress': '{{current}} / {{total}} リソース',
          'web.status.ok': '正常',
          'web.status.checkRequired': '確認が必要',
          'web.status.unknown': '不明',
          'web.env.updateBadge': 'v{{version}}へ更新',
          'web.delete.manualReviewRequired': '手動確認が必要です',
          'web.envDetail.capacityTargetsUnavailable': 'テナント容量の対象を取得できません。',
          'web.control.pendingTenant': 'テナント {{tenantId}}',
          'web.control.pendingDisasterRecovery': '災害復旧',
          'web.control.pendingVerifyRuntimeBindings': 'ランタイムバインディングを検証',
          'web.control.pendingSharedPool': '共有プール',
          'web.control.pendingProvisioning': 'プロビジョニング',
          'web.control.pendingTitle': '保留中のプロビジョニング操作',
          'web.control.pendingDescription': 'Setupはオペレーター権限が必要な手順を実行し、Controlによる検証の進捗も継続して表示します。',
          'web.control.pendingRun': '保留中の操作を実行',
          'web.control.pendingObserving': 'Controlが非公開スモークテストまたは安定化を実行中です。この状態は自動更新されます。',
          'web.control.operationRunning': 'プロビジョニング操作を実行中...',
          'web.control.operationFailed': 'Control操作に失敗しました。',
          'web.control.operationAwaitingMigration': 'D1を作成しました。次のオペレーター操作でマイグレーションを実行できます。',
          'web.control.operationAwaitingWorkerBindings': 'マイグレーションが完了しました。次のオペレーター操作でWorkerバインディングを調整できます。',
          'web.control.operationAwaitingSmoke': 'Workerバインディングを更新しました。非公開スモークテストと安定化処理を実行中です。',
          'web.control.operationAwaitingQuarantine': 'リソースのクリーンアップは隔離期間の終了を待っています。',
          'web.control.operationRetryRequired': 'プロビジョニングを再試行する必要があります。',
          'web.control.operationLeaseUnavailable': '別の実行者がこの操作を処理中です。',
          'web.control.operationSucceeded': 'プロビジョニングが正常に完了しました。',
          'web.control.operationBlocked': 'プロビジョニングがブロックされています。操作状態を確認してください。',
          'web.control.tokenLinkFailed': 'Cloudflareトークン作成リンクを生成できませんでした。',
          'web.control.preparationFailed': 'Controlの準備に失敗しました。',
          'web.control.deploymentFailed': 'Controlのデプロイに失敗しました。',
          'web.control.credentialBootstrapFailed': '認証情報のブートストラップに失敗しました。',
          'web.control.revocationInterrupted': '前回の取消し応答が中断されました。',
          'web.control.revocationRecoveryRequired': '{{error}} 新しいワンタイムトークンを作成してここに入力し、「有効化」を選択して検証とクリーンアップを完了してください。',
          'web.control.cutoverPaused': '自動プロビジョニングの切替が一時停止しました。',
          'web.control.cutoverResumeRequired': '{{error}} もう一度「有効化」を選択して、永続化された切替処理を再開してください。',
          'web.control.automaticProvisioningPaused': '自動プロビジョニングの設定が一時停止しました。',
          'web.control.automaticProvisioningFailed': '自動プロビジョニングの設定に失敗しました。',
          'web.delete.confirmExact': '削除を実行するには、環境名 <b>{{env}}</b> を正確に入力してください。',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} キュー',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        'zh-CN': {
          'web.env.heroKicker': '环境管理',
          'web.env.heroListTitle': '环境列表',
          'web.env.heroListAside': '此 Cloudflare 账户中检测到的 Authrim 环境。扫描使用 <b>{env}-ar-*</b> 命名规则。',
          'web.env.heroDetailKicker': '环境管理 - 详情',
          'web.env.heroDetailTitle': '环境 <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': '模式 {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': '环境管理 - 删除确认',
          'web.env.heroDeleteTitle': '删除环境 {{env}}',
          'web.env.heroDeleteAside': '<b>请确认您的选择。</b>选中的资源将从 Cloudflare 中删除。',
          'web.env.accountMeta': '账户 <b>{{account}}</b>',
          'web.env.modeSingle': '单租户',
          'web.env.modeMulti': '多租户',
          'web.env.cardMode': '模式',
          'web.env.cardAdmin': '管理员',
          'web.env.openDetails': '打开详情 →',
          'web.env.adminConfigured': '已配置 ✓',
          'web.env.adminNotConfigured': '未配置',
          'web.env.resourceSummary': '环境 <b>{{env}}</b> - 资源 <b>{{total}}</b>',
          'env.name': '环境',
          'web.status.failed': '失败',
          'web.envDetail.generating': '正在生成...',
          'web.envDetail.tokenGenerated': '令牌已生成',
          'web.envDetail.uiUpdatesHint': 'Admin UI / Login UI',
          'web.email.continueResources': '继续到资源创建 →',
          'web.domain.tenantIdInvalid': '{{label}} 必须以小写字母开头，并且只能包含小写字母、数字和连字符。',
          'web.config.saveFailed': '保存配置失败：{{error}}',
          'web.config.noConfigurationToSave': '没有可保存的配置。',
          'web.provision.reprovisionConfirm': '警告：重新创建会删除所有现有资源并重新创建。\\n\\n此操作将：\\n- 删除现有 D1 数据库，所有数据都会丢失。\\n- 删除现有 KV 命名空间。\\n- 生成新的加密密钥。\\n\\n要继续吗？',
          'web.envDetail.noEnvironmentSelected': '未选择环境。',
          'web.envDetail.positiveSlotCountRequired': '请输入大于 0 的槽位数量。',
          'web.envDetail.tenantStorageLoadFailed': '无法加载租户存储状态。',
          'web.envDetail.r2StatusLoadFailed': '无法加载 R2 存储桶状态。',
          'web.envDetail.r2ConfiguredSummary': 'R2 存储桶已配置：{{configured}} / {{required}}。',
          'web.envDetail.r2NeedsProvisioningSummary': '需要创建 R2 存储桶：{{configured}} / {{required}} 已配置。',
          'web.envDetail.provisionR2Confirm': '这将创建缺失的 R2 存储桶，刷新 Worker 绑定并重新部署 Workers。要继续吗？',
          'web.envDetail.r2Provisioning': '正在创建 R2 存储桶...',
          'web.envDetail.r2ConfiguredBuckets': '已配置存储桶：{{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2 存储桶创建已完成。',
          'web.envDetail.workerUpdateStarting': '正在开始更新 {{env}} 的 Worker...',
          'web.envDetail.fullDeployTitle': '部署整个环境',
          'web.envDetail.fullDeployScope': 'API Workers + UI Workers',
          'web.envDetail.fullDeployDesc': '从当前源代码构建并部署所有 API Worker 和已启用的 UI Worker。现有数据和设置会保留。',
          'web.envDetail.fullDeployAction': '部署整个环境',
          'web.envDetail.fullDeployProgress': '部署进度',
          'web.envDetail.fullDeployStarting': '正在开始部署环境 {{env}}...',
          'web.envDetail.fullDeployApiPhase': '正在部署所有 API Worker...',
          'web.envDetail.fullDeployUiComponent': '正在部署 {{component}}...',
          'web.envDetail.fullDeploySummary': '已完成：{{success}} / {{total}} 个组件',
          'web.envDetail.fullDeployComplete': '整个环境部署已完成。',
          'web.envDetail.fullDeployFailed': '整个环境部署失败：{{error}}',
          'web.envDetail.updateCompletedSuccess': '更新已完成。',
          'web.envDetail.workerUpdateSummary': '摘要：{{success}} / {{total}} Workers 已更新',
          'web.envDetail.updateFailedWithMessage': '更新失败：{{error}}',
          'web.envDetail.updateThis': '更新此组件',
          'web.envDetail.componentUpdating': '正在更新 {{env}} 的 {{component}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} 已更新。',
          'web.envDetail.uiUpdateMayTakeMinutes': '构建并部署到 Workers 可能需要几分钟。',
          'web.envDetail.logWorker': 'Worker：{{value}}',
          'web.envDetail.logVersion': '版本：{{value}}',
          'web.envDetail.logDeployedAt': '部署时间：{{value}}',
          'web.envDetail.logProject': '项目：{{value}}',
          'web.envDetail.configKvNotFound': '找不到此环境的 AUTHRIM_CONFIG KV 命名空间。',
          'web.envDetail.routerBaseUrlPrompt': '请输入 Router 的基础 URL，例如 https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': '令牌生成失败：{{error}}',
          'web.delete.starting': '正在开始删除...',
          'web.delete.deletedItems': '已删除 {{count}} 项',
          'web.delete.complete': '删除已完成。',
          'web.delete.manualActionRequired': '需要手动处理。',
          'web.delete.success': '环境已删除。',
          'web.delete.partialSuccess': '已删除所选资源。环境和剩余本地状态已保留。',
          'web.delete.errorList': '发生错误：{{errors}}',
          'web.delete.inventoryUnavailable': '无法验证 Cloudflare 资源清单，因此未开始删除。请检查网络连接和 Cloudflare 登录状态后重试。',
          'web.status.errorWithMessage': '错误：{{error}}',
          'web.status.unknownError': '未知错误',
          'web.delete.confirmExact': '要删除此环境，请准确输入 <b>{{env}}</b>。',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} 队列',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        'zh-TW': {
          'web.env.heroKicker': '環境管理',
          'web.env.heroListTitle': '環境列表',
          'web.env.heroListAside': '此 Cloudflare 帳戶中偵測到的 Authrim 環境。掃描使用 <b>{env}-ar-*</b> 命名規則。',
          'web.env.heroDetailKicker': '環境管理 - 詳細',
          'web.env.heroDetailTitle': '環境 <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': '模式 {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': '環境管理 - 刪除確認',
          'web.env.heroDeleteTitle': '刪除環境 {{env}}',
          'web.env.heroDeleteAside': '<b>請確認您的選擇。</b>選取的資源將從 Cloudflare 刪除。',
          'web.env.accountMeta': '帳戶 <b>{{account}}</b>',
          'web.env.modeSingle': '單租戶',
          'web.env.modeMulti': '多租戶',
          'web.env.cardMode': '模式',
          'web.env.cardAdmin': '管理員',
          'web.env.openDetails': '開啟詳細 →',
          'web.env.adminConfigured': '已設定 ✓',
          'web.env.adminNotConfigured': '未設定',
          'web.env.resourceSummary': '環境 <b>{{env}}</b> - 資源 <b>{{total}}</b>',
          'env.name': '環境',
          'web.status.failed': '失敗',
          'web.envDetail.generating': '正在產生...',
          'web.envDetail.tokenGenerated': '權杖已產生',
          'web.envDetail.uiUpdatesHint': 'Admin UI / Login UI',
          'web.email.continueResources': '前往資源建立 →',
          'web.domain.tenantIdInvalid': '{{label}} 必須以小寫字母開頭，且只能包含小寫字母、數字與連字號。',
          'web.config.saveFailed': '保存設定失敗：{{error}}',
          'web.config.noConfigurationToSave': '沒有可保存的設定。',
          'web.provision.reprovisionConfirm': '警告：重新建立會刪除所有既有資源並重新建立。\\n\\n此操作將：\\n- 刪除既有 D1 資料庫，所有資料都會遺失。\\n- 刪除既有 KV 命名空間。\\n- 產生新的加密金鑰。\\n\\n要繼續嗎？',
          'web.envDetail.noEnvironmentSelected': '未選擇環境。',
          'web.envDetail.positiveSlotCountRequired': '請輸入大於 0 的槽位數量。',
          'web.envDetail.tenantStorageLoadFailed': '無法載入租戶儲存狀態。',
          'web.envDetail.r2StatusLoadFailed': '無法載入 R2 儲存桶狀態。',
          'web.envDetail.r2ConfiguredSummary': 'R2 儲存桶已設定：{{configured}} / {{required}}。',
          'web.envDetail.r2NeedsProvisioningSummary': '需要建立 R2 儲存桶：{{configured}} / {{required}} 已設定。',
          'web.envDetail.provisionR2Confirm': '這將建立缺少的 R2 儲存桶、刷新 Worker 綁定並重新部署 Workers。要繼續嗎？',
          'web.envDetail.r2Provisioning': '正在建立 R2 儲存桶...',
          'web.envDetail.r2ConfiguredBuckets': '已設定儲存桶：{{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2 儲存桶建立已完成。',
          'web.envDetail.workerUpdateStarting': '正在開始更新 {{env}} 的 Worker...',
          'web.envDetail.fullDeployTitle': '部署整個環境',
          'web.envDetail.fullDeployScope': 'API Workers + UI Workers',
          'web.envDetail.fullDeployDesc': '從目前的原始碼建置並部署所有 API Worker 與已啟用的 UI Worker。現有資料與設定會保留。',
          'web.envDetail.fullDeployAction': '部署整個環境',
          'web.envDetail.fullDeployProgress': '部署進度',
          'web.envDetail.fullDeployStarting': '正在開始部署環境 {{env}}...',
          'web.envDetail.fullDeployApiPhase': '正在部署所有 API Worker...',
          'web.envDetail.fullDeployUiComponent': '正在部署 {{component}}...',
          'web.envDetail.fullDeploySummary': '已完成：{{success}} / {{total}} 個元件',
          'web.envDetail.fullDeployComplete': '整個環境部署已完成。',
          'web.envDetail.fullDeployFailed': '整個環境部署失敗：{{error}}',
          'web.envDetail.updateCompletedSuccess': '更新已完成。',
          'web.envDetail.workerUpdateSummary': '摘要：{{success}} / {{total}} Workers 已更新',
          'web.envDetail.updateFailedWithMessage': '更新失敗：{{error}}',
          'web.envDetail.updateThis': '更新此元件',
          'web.envDetail.componentUpdating': '正在更新 {{env}} 的 {{component}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} 已更新。',
          'web.envDetail.uiUpdateMayTakeMinutes': '建置並部署到 Workers 可能需要幾分鐘。',
          'web.envDetail.logWorker': 'Worker：{{value}}',
          'web.envDetail.logVersion': '版本：{{value}}',
          'web.envDetail.logDeployedAt': '部署時間：{{value}}',
          'web.envDetail.logProject': '專案：{{value}}',
          'web.envDetail.configKvNotFound': '找不到此環境的 AUTHRIM_CONFIG KV 命名空間。',
          'web.envDetail.routerBaseUrlPrompt': '請輸入 Router 的基礎 URL，例如 https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': '權杖產生失敗：{{error}}',
          'web.delete.starting': '正在開始刪除...',
          'web.delete.deletedItems': '已刪除 {{count}} 項',
          'web.delete.complete': '刪除已完成。',
          'web.delete.manualActionRequired': '需要手動處理。',
          'web.delete.success': '環境已刪除。',
          'web.delete.partialSuccess': '已刪除所選資源。環境和剩餘本機狀態已保留。',
          'web.delete.errorList': '發生錯誤：{{errors}}',
          'web.delete.inventoryUnavailable': '無法驗證 Cloudflare 資源清單，因此未開始刪除。請檢查網路連線和 Cloudflare 登入狀態後重試。',
          'web.status.errorWithMessage': '錯誤：{{error}}',
          'web.status.unknownError': '未知錯誤',
          'web.delete.confirmExact': '若要刪除此環境，請正確輸入 <b>{{env}}</b>。',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} 佇列',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        es: {
          'web.env.heroKicker': 'Gestión de entornos',
          'web.env.heroListTitle': 'Entornos',
          'web.env.heroListAside': 'Entornos Authrim detectados en esta cuenta de Cloudflare. El escaneo usa la convención <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Gestión de entornos - Detalle',
          'web.env.heroDetailTitle': 'Entorno <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Modo {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Gestión de entornos - Eliminar',
          'web.env.heroDeleteTitle': 'Eliminar {{env}}',
          'web.env.heroDeleteAside': '<b>Revise su selección.</b> Los recursos seleccionados se eliminarán de Cloudflare.',
          'web.env.accountMeta': 'Cuenta <b>{{account}}</b>',
          'web.env.modeSingle': 'Tenant único',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Modo',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Abrir detalles →',
          'web.env.adminConfigured': 'Configurado ✓',
          'web.env.adminNotConfigured': 'No configurado',
          'web.env.resourceSummary': 'Entorno <b>{{env}}</b> - recursos <b>{{total}}</b>',
          'env.name': 'Entorno',
          'web.status.failed': 'Error',
          'web.envDetail.generating': 'Generando...',
          'web.envDetail.tokenGenerated': 'Token generado',
          'web.email.continueResources': 'Continuar a recursos →',
          'web.domain.tenantIdInvalid': '{{label}} debe empezar con una letra minúscula y solo puede contener minúsculas, números y guiones.',
          'web.config.saveFailed': 'No se pudo guardar la configuración: {{error}}',
          'web.config.noConfigurationToSave': 'No hay configuración para guardar.',
          'web.provision.reprovisionConfirm': 'Advertencia: volver a provisionar eliminará todos los recursos existentes y creará otros nuevos.\\n\\nEsta acción hará lo siguiente:\\n- Eliminar bases D1 existentes. Se perderán todos los datos.\\n- Eliminar namespaces KV existentes.\\n- Generar nuevas claves de cifrado.\\n\\n¿Continuar?',
          'web.envDetail.noEnvironmentSelected': 'No se seleccionó ningún entorno.',
          'web.envDetail.positiveSlotCountRequired': 'Introduce un número positivo de slots.',
          'web.envDetail.tenantStorageLoadFailed': 'No se pudo cargar el estado del almacenamiento de tenants.',
          'web.envDetail.r2StatusLoadFailed': 'No se pudo cargar el estado de buckets R2.',
          'web.envDetail.r2ConfiguredSummary': 'Buckets R2 configurados: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'Se deben provisionar buckets R2: {{configured}} / {{required}} configurados.',
          'web.envDetail.provisionR2Confirm': 'Esto creará los buckets R2 faltantes, refrescará los bindings de Workers y redesplegará workers. ¿Continuar?',
          'web.envDetail.r2Provisioning': 'Provisionando buckets R2...',
          'web.envDetail.r2ConfiguredBuckets': 'Buckets configurados: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'Provisionamiento R2 completado.',
          'web.envDetail.workerUpdateStarting': 'Iniciando actualización de workers para {{env}}...',
          'web.envDetail.fullDeployTitle': 'Desplegar todo el entorno',
          'web.envDetail.fullDeployScope': 'Workers API + Workers UI',
          'web.envDetail.fullDeployDesc': 'Compila y despliega todos los Workers API y los Workers UI habilitados desde el código actual. Los datos y la configuración existentes se conservan.',
          'web.envDetail.fullDeployAction': 'Desplegar todo el entorno',
          'web.envDetail.fullDeployProgress': 'Progreso del despliegue',
          'web.envDetail.fullDeployStarting': 'Iniciando el despliegue completo del entorno {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Desplegando todos los Workers API...',
          'web.envDetail.fullDeployUiComponent': 'Desplegando {{component}}...',
          'web.envDetail.fullDeploySummary': 'Completado: {{success}} / {{total}} componentes',
          'web.envDetail.fullDeployComplete': 'El despliegue completo del entorno ha terminado.',
          'web.envDetail.fullDeployFailed': 'El despliegue completo del entorno ha fallado: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Actualización completada.',
          'web.envDetail.workerUpdateSummary': 'Resumen: {{success}} / {{total}} workers actualizados',
          'web.envDetail.updateFailedWithMessage': 'La actualización falló: {{error}}',
          'web.envDetail.updateThis': 'Actualizar este componente',
          'web.envDetail.componentUpdating': 'Actualizando {{component}} para {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} actualizado.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Puede tardar unos minutos mientras se compila y despliega en Workers.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Versión: {{value}}',
          'web.envDetail.logDeployedAt': 'Desplegado: {{value}}',
          'web.envDetail.logProject': 'Proyecto: {{value}}',
          'web.envDetail.configKvNotFound': 'No se encontró el namespace KV AUTHRIM_CONFIG para este entorno.',
          'web.envDetail.routerBaseUrlPrompt': 'Introduce la URL base del router, por ejemplo https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'No se pudo generar el token: {{error}}',
          'web.delete.starting': 'Iniciando eliminación...',
          'web.delete.deletedItems': '{{count}} elementos eliminados',
          'web.delete.complete': 'Eliminación completada.',
          'web.delete.manualActionRequired': 'Se requiere una acción manual.',
          'web.delete.success': 'Entorno eliminado.',
          'web.delete.partialSuccess': 'Se eliminaron los recursos seleccionados. Se conservaron el entorno y el estado local restante.',
          'web.delete.errorList': 'Se produjeron errores: {{errors}}',
          'web.delete.inventoryUnavailable': 'No se pudo verificar el inventario de recursos de Cloudflare, por lo que no se inició la eliminación. Comprueba la conexión y la sesión de Cloudflare e inténtalo de nuevo.',
          'web.status.errorWithMessage': 'Error: {{error}}',
          'web.status.unknownError': 'Error desconocido',
          'web.delete.confirmExact': 'Para eliminar este entorno, escribe <b>{{env}}</b> exactamente.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        pt: {
          'web.env.heroKicker': 'Gerenciamento de ambientes',
          'web.env.heroListTitle': 'Ambientes',
          'web.env.heroListAside': 'Ambientes Authrim detectados nesta conta Cloudflare. A varredura usa a convenção <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Gerenciamento de ambientes - Detalhe',
          'web.env.heroDetailTitle': 'Ambiente <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Modo {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Gerenciamento de ambientes - Exclusão',
          'web.env.heroDeleteTitle': 'Excluir {{env}}',
          'web.env.heroDeleteAside': '<b>Revise sua seleção.</b> Os recursos selecionados serão removidos do Cloudflare.',
          'web.env.accountMeta': 'Conta <b>{{account}}</b>',
          'web.env.modeSingle': 'Tenant único',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Modo',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Abrir detalhes →',
          'web.env.adminConfigured': 'Configurado ✓',
          'web.env.adminNotConfigured': 'Não configurado',
          'web.env.resourceSummary': 'Ambiente <b>{{env}}</b> - recursos <b>{{total}}</b>',
          'env.name': 'Ambiente',
          'web.status.failed': 'Falhou',
          'web.envDetail.generating': 'Gerando...',
          'web.envDetail.tokenGenerated': 'Token gerado',
          'web.email.continueResources': 'Continuar para recursos →',
          'web.domain.tenantIdInvalid': '{{label}} deve começar com uma letra minúscula e conter apenas minúsculas, números e hífens.',
          'web.config.saveFailed': 'Falha ao salvar configuração: {{error}}',
          'web.config.noConfigurationToSave': 'Não há configuração para salvar.',
          'web.provision.reprovisionConfirm': 'Aviso: reprovisionar excluirá todos os recursos existentes e criará novos.\\n\\nEsta ação irá:\\n- Excluir bancos D1 existentes. Todos os dados serão perdidos.\\n- Excluir namespaces KV existentes.\\n- Gerar novas chaves de criptografia.\\n\\nContinuar?',
          'web.envDetail.noEnvironmentSelected': 'Nenhum ambiente selecionado.',
          'web.envDetail.positiveSlotCountRequired': 'Informe um número positivo de slots.',
          'web.envDetail.tenantStorageLoadFailed': 'Falha ao carregar o status do storage dos tenants.',
          'web.envDetail.r2StatusLoadFailed': 'Falha ao carregar status dos buckets R2.',
          'web.envDetail.r2ConfiguredSummary': 'Buckets R2 configurados: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'Buckets R2 precisam ser provisionados: {{configured}} / {{required}} configurados.',
          'web.envDetail.provisionR2Confirm': 'Isso criará os buckets R2 ausentes, atualizará bindings de Workers e fará redeploy. Continuar?',
          'web.envDetail.r2Provisioning': 'Provisionando buckets R2...',
          'web.envDetail.r2ConfiguredBuckets': 'Buckets configurados: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'Provisionamento R2 concluído.',
          'web.envDetail.workerUpdateStarting': 'Iniciando atualização de workers para {{env}}...',
          'web.envDetail.fullDeployTitle': 'Fazer deploy do ambiente inteiro',
          'web.envDetail.fullDeployScope': 'Workers de API + Workers de UI',
          'web.envDetail.fullDeployDesc': 'Compile e faça deploy de todos os Workers de API e Workers de UI habilitados a partir do código atual. Os dados e as configurações existentes serão preservados.',
          'web.envDetail.fullDeployAction': 'Fazer deploy do ambiente inteiro',
          'web.envDetail.fullDeployProgress': 'Progresso do deploy',
          'web.envDetail.fullDeployStarting': 'Iniciando o deploy completo do ambiente {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Fazendo deploy de todos os Workers de API...',
          'web.envDetail.fullDeployUiComponent': 'Fazendo deploy de {{component}}...',
          'web.envDetail.fullDeploySummary': 'Concluído: {{success}} / {{total}} componentes',
          'web.envDetail.fullDeployComplete': 'O deploy completo do ambiente foi concluído.',
          'web.envDetail.fullDeployFailed': 'Falha no deploy completo do ambiente: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Atualização concluída.',
          'web.envDetail.workerUpdateSummary': 'Resumo: {{success}} / {{total}} workers atualizados',
          'web.envDetail.updateFailedWithMessage': 'Falha na atualização: {{error}}',
          'web.envDetail.updateThis': 'Atualizar este componente',
          'web.envDetail.componentUpdating': 'Atualizando {{component}} para {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} atualizado.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Pode levar alguns minutos enquanto compila e faz deploy no Workers.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Versão: {{value}}',
          'web.envDetail.logDeployedAt': 'Deploy em: {{value}}',
          'web.envDetail.logProject': 'Projeto: {{value}}',
          'web.envDetail.configKvNotFound': 'Não foi encontrado o namespace KV AUTHRIM_CONFIG para este ambiente.',
          'web.envDetail.routerBaseUrlPrompt': 'Informe a URL base do router, por exemplo https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Falha ao gerar token: {{error}}',
          'web.delete.starting': 'Iniciando exclusão...',
          'web.delete.deletedItems': '{{count}} itens excluídos',
          'web.delete.complete': 'Exclusão concluída.',
          'web.delete.manualActionRequired': 'É necessária uma ação manual.',
          'web.delete.success': 'Ambiente excluído.',
          'web.delete.partialSuccess': 'Os recursos selecionados foram excluídos. O ambiente e o estado local restante foram preservados.',
          'web.delete.errorList': 'Ocorreram erros: {{errors}}',
          'web.delete.inventoryUnavailable': 'Não foi possível verificar o inventário de recursos da Cloudflare, portanto a exclusão não foi iniciada. Verifique a conexão e o login da Cloudflare e tente novamente.',
          'web.status.errorWithMessage': 'Erro: {{error}}',
          'web.status.unknownError': 'Erro desconhecido',
          'web.delete.confirmExact': 'Para excluir este ambiente, digite <b>{{env}}</b> exatamente.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        fr: {
          'web.env.heroKicker': 'Gestion des environnements',
          'web.env.heroListTitle': 'Environnements',
          'web.env.heroListAside': 'Environnements Authrim détectés dans ce compte Cloudflare. Le scan utilise la convention <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Gestion des environnements - Détail',
          'web.env.heroDetailTitle': 'Environnement <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Mode {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Gestion des environnements - Suppression',
          'web.env.heroDeleteTitle': 'Supprimer {{env}}',
          'web.env.heroDeleteAside': '<b>Vérifiez votre sélection.</b> Les ressources sélectionnées seront supprimées de Cloudflare.',
          'web.env.accountMeta': 'Compte <b>{{account}}</b>',
          'web.env.modeSingle': 'Tenant unique',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Mode',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Ouvrir les détails →',
          'web.env.adminConfigured': 'Configuré ✓',
          'web.env.adminNotConfigured': 'Non configuré',
          'web.env.resourceSummary': 'Environnement <b>{{env}}</b> - ressources <b>{{total}}</b>',
          'env.name': 'Environnement',
          'web.status.failed': 'Échec',
          'web.envDetail.generating': 'Génération...',
          'web.envDetail.tokenGenerated': 'Token généré',
          'web.email.continueResources': 'Continuer vers les ressources →',
          'web.domain.tenantIdInvalid': '{{label}} doit commencer par une lettre minuscule et ne contenir que des minuscules, chiffres et traits d’union.',
          'web.config.saveFailed': 'Échec de l’enregistrement de la configuration : {{error}}',
          'web.config.noConfigurationToSave': 'Aucune configuration à enregistrer.',
          'web.provision.reprovisionConfirm': 'Attention : reprovisionner supprimera toutes les ressources existantes et en créera de nouvelles.\\n\\nCette action va :\\n- Supprimer les bases D1 existantes. Toutes les données seront perdues.\\n- Supprimer les namespaces KV existants.\\n- Générer de nouvelles clés de chiffrement.\\n\\nContinuer ?',
          'web.envDetail.noEnvironmentSelected': 'Aucun environnement sélectionné.',
          'web.envDetail.positiveSlotCountRequired': 'Saisissez un nombre de slots positif.',
          'web.envDetail.tenantStorageLoadFailed': 'Échec du chargement de l’état du stockage des tenants.',
          'web.envDetail.r2StatusLoadFailed': 'Impossible de charger le statut des buckets R2.',
          'web.envDetail.r2ConfiguredSummary': 'Buckets R2 configurés : {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'Buckets R2 à provisionner : {{configured}} / {{required}} configurés.',
          'web.envDetail.provisionR2Confirm': 'Cela créera les buckets R2 manquants, rafraîchira les bindings Workers et redéploiera les workers. Continuer ?',
          'web.envDetail.r2Provisioning': 'Provisionnement des buckets R2...',
          'web.envDetail.r2ConfiguredBuckets': 'Buckets configurés : {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'Provisionnement R2 terminé.',
          'web.envDetail.workerUpdateStarting': 'Démarrage de la mise à jour des workers pour {{env}}...',
          'web.envDetail.fullDeployTitle': 'Déployer tout l’environnement',
          'web.envDetail.fullDeployScope': 'Workers API + Workers UI',
          'web.envDetail.fullDeployDesc': 'Construisez et déployez tous les Workers API et les Workers UI activés depuis le code actuel. Les données et paramètres existants sont conservés.',
          'web.envDetail.fullDeployAction': 'Déployer tout l’environnement',
          'web.envDetail.fullDeployProgress': 'Progression du déploiement',
          'web.envDetail.fullDeployStarting': 'Démarrage du déploiement complet de l’environnement {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Déploiement de tous les Workers API...',
          'web.envDetail.fullDeployUiComponent': 'Déploiement de {{component}}...',
          'web.envDetail.fullDeploySummary': 'Terminé : {{success}} / {{total}} composants',
          'web.envDetail.fullDeployComplete': 'Le déploiement complet de l’environnement est terminé.',
          'web.envDetail.fullDeployFailed': 'Échec du déploiement complet de l’environnement : {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Mise à jour terminée.',
          'web.envDetail.workerUpdateSummary': 'Résumé : {{success}} / {{total}} workers mis à jour',
          'web.envDetail.updateFailedWithMessage': 'Échec de la mise à jour : {{error}}',
          'web.envDetail.updateThis': 'Mettre à jour ce composant',
          'web.envDetail.componentUpdating': 'Mise à jour de {{component}} pour {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} mis à jour.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Cela peut prendre quelques minutes pendant le build et le déploiement vers Workers.',
          'web.envDetail.logWorker': 'Worker : {{value}}',
          'web.envDetail.logVersion': 'Version : {{value}}',
          'web.envDetail.logDeployedAt': 'Déployé le : {{value}}',
          'web.envDetail.logProject': 'Projet : {{value}}',
          'web.envDetail.configKvNotFound': 'Namespace KV AUTHRIM_CONFIG introuvable pour cet environnement.',
          'web.envDetail.routerBaseUrlPrompt': 'Saisissez l’URL de base du router, par exemple https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Échec de génération du token : {{error}}',
          'web.delete.starting': 'Suppression en cours...',
          'web.delete.deletedItems': '{{count}} éléments supprimés',
          'web.delete.complete': 'Suppression terminée.',
          'web.delete.manualActionRequired': 'Une action manuelle est requise.',
          'web.delete.success': 'Environnement supprimé.',
          'web.delete.partialSuccess': 'Les ressources sélectionnées ont été supprimées. L’environnement et l’état local restant ont été conservés.',
          'web.delete.errorList': 'Des erreurs sont survenues : {{errors}}',
          'web.delete.inventoryUnavailable': 'L’inventaire des ressources Cloudflare n’a pas pu être vérifié. La suppression n’a donc pas commencé. Vérifiez la connexion et la session Cloudflare, puis réessayez.',
          'web.status.errorWithMessage': 'Erreur : {{error}}',
          'web.status.unknownError': 'Erreur inconnue',
          'web.delete.confirmExact': 'Pour supprimer cet environnement, saisissez exactement <b>{{env}}</b>.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        de: {
          'web.env.heroKicker': 'Umgebungsverwaltung',
          'web.env.heroListTitle': 'Umgebungen',
          'web.env.heroListAside': 'Authrim-Umgebungen in diesem Cloudflare-Konto. Der Scan nutzt die Namenskonvention <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Umgebungsverwaltung - Detail',
          'web.env.heroDetailTitle': 'Umgebung <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Modus {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Umgebungsverwaltung - Löschen',
          'web.env.heroDeleteTitle': '{{env}} löschen',
          'web.env.heroDeleteAside': '<b>Prüfen Sie Ihre Auswahl.</b> Ausgewählte Ressourcen werden aus Cloudflare gelöscht.',
          'web.env.accountMeta': 'Konto <b>{{account}}</b>',
          'web.env.modeSingle': 'Single-Tenant',
          'web.env.modeMulti': 'Multi-Tenant',
          'web.env.cardMode': 'Modus',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Details öffnen →',
          'web.env.adminConfigured': 'Konfiguriert ✓',
          'web.env.adminNotConfigured': 'Nicht konfiguriert',
          'web.env.resourceSummary': 'Umgebung <b>{{env}}</b> - Ressourcen <b>{{total}}</b>',
          'env.name': 'Umgebung',
          'web.status.failed': 'Fehlgeschlagen',
          'web.envDetail.generating': 'Wird generiert...',
          'web.envDetail.tokenGenerated': 'Token generiert',
          'web.email.continueResources': 'Weiter zu Ressourcen →',
          'web.domain.tenantIdInvalid': '{{label}} muss mit einem Kleinbuchstaben beginnen und darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten.',
          'web.config.saveFailed': 'Konfiguration konnte nicht gespeichert werden: {{error}}',
          'web.config.noConfigurationToSave': 'Keine Konfiguration zum Speichern.',
          'web.provision.reprovisionConfirm': 'Warnung: Re-Provisionierung löscht alle vorhandenen Ressourcen und erstellt neue.\\n\\nDiese Aktion wird:\\n- Vorhandene D1-Datenbanken löschen. Alle Daten gehen verloren.\\n- Vorhandene KV-Namespaces löschen.\\n- Neue Verschlüsselungsschlüssel erzeugen.\\n\\nFortfahren?',
          'web.envDetail.noEnvironmentSelected': 'Keine Umgebung ausgewählt.',
          'web.envDetail.positiveSlotCountRequired': 'Geben Sie eine positive Slot-Anzahl ein.',
          'web.envDetail.tenantStorageLoadFailed': 'Tenant-Speicherstatus konnte nicht geladen werden.',
          'web.envDetail.r2StatusLoadFailed': 'R2-Bucket-Status konnte nicht geladen werden.',
          'web.envDetail.r2ConfiguredSummary': 'R2-Buckets konfiguriert: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'R2-Buckets müssen bereitgestellt werden: {{configured}} / {{required}} konfiguriert.',
          'web.envDetail.provisionR2Confirm': 'Dies erstellt fehlende R2-Buckets, aktualisiert Worker-Bindings und deployt Workers erneut. Fortfahren?',
          'web.envDetail.r2Provisioning': 'R2-Buckets werden bereitgestellt...',
          'web.envDetail.r2ConfiguredBuckets': 'Konfigurierte Buckets: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2-Bereitstellung abgeschlossen.',
          'web.envDetail.workerUpdateStarting': 'Worker-Update für {{env}} wird gestartet...',
          'web.envDetail.fullDeployTitle': 'Gesamte Umgebung bereitstellen',
          'web.envDetail.fullDeployScope': 'API-Worker + UI-Worker',
          'web.envDetail.fullDeployDesc': 'Alle API-Worker und aktivierten UI-Worker aus dem aktuellen Quellcode bauen und bereitstellen. Vorhandene Daten und Einstellungen bleiben erhalten.',
          'web.envDetail.fullDeployAction': 'Gesamte Umgebung bereitstellen',
          'web.envDetail.fullDeployProgress': 'Bereitstellungsfortschritt',
          'web.envDetail.fullDeployStarting': 'Gesamte Bereitstellung für {{env}} wird gestartet...',
          'web.envDetail.fullDeployApiPhase': 'Alle API-Worker werden bereitgestellt...',
          'web.envDetail.fullDeployUiComponent': '{{component}} wird bereitgestellt...',
          'web.envDetail.fullDeploySummary': 'Abgeschlossen: {{success}} / {{total}} Komponenten',
          'web.envDetail.fullDeployComplete': 'Die gesamte Umgebung wurde bereitgestellt.',
          'web.envDetail.fullDeployFailed': 'Die gesamte Bereitstellung ist fehlgeschlagen: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Update abgeschlossen.',
          'web.envDetail.workerUpdateSummary': 'Zusammenfassung: {{success}} / {{total}} Workers aktualisiert',
          'web.envDetail.updateFailedWithMessage': 'Update fehlgeschlagen: {{error}}',
          'web.envDetail.updateThis': 'Diese Komponente aktualisieren',
          'web.envDetail.componentUpdating': '{{component}} für {{env}} wird aktualisiert...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} aktualisiert.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Build und Deployment zu Workers können einige Minuten dauern.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Version: {{value}}',
          'web.envDetail.logDeployedAt': 'Deploy-Zeit: {{value}}',
          'web.envDetail.logProject': 'Projekt: {{value}}',
          'web.envDetail.configKvNotFound': 'Der KV-Namespace AUTHRIM_CONFIG wurde für diese Umgebung nicht gefunden.',
          'web.envDetail.routerBaseUrlPrompt': 'Geben Sie die Basis-URL des Routers ein, z. B. https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Token konnte nicht generiert werden: {{error}}',
          'web.delete.starting': 'Löschen wird gestartet...',
          'web.delete.deletedItems': '{{count}} Elemente gelöscht',
          'web.delete.complete': 'Löschen abgeschlossen.',
          'web.delete.manualActionRequired': 'Eine manuelle Aktion ist erforderlich.',
          'web.delete.success': 'Umgebung gelöscht.',
          'web.delete.partialSuccess': 'Die ausgewählten Ressourcen wurden gelöscht. Die Umgebung und der verbleibende lokale Status wurden beibehalten.',
          'web.delete.errorList': 'Es sind Fehler aufgetreten: {{errors}}',
          'web.delete.inventoryUnavailable': 'Der Cloudflare-Ressourcenbestand konnte nicht verifiziert werden. Die Löschung wurde daher nicht gestartet. Prüfen Sie die Verbindung und die Cloudflare-Anmeldung und versuchen Sie es erneut.',
          'web.status.errorWithMessage': 'Fehler: {{error}}',
          'web.status.unknownError': 'Unbekannter Fehler',
          'web.delete.confirmExact': 'Zum Löschen dieser Umgebung geben Sie <b>{{env}}</b> exakt ein.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        ko: {
          'web.env.heroKicker': '환경 관리',
          'web.env.heroListTitle': '환경 목록',
          'web.env.heroListAside': '이 Cloudflare 계정에서 감지된 Authrim 환경입니다. 스캔은 <b>{env}-ar-*</b> 이름 규칙을 사용합니다.',
          'web.env.heroDetailKicker': '환경 관리 - 상세',
          'web.env.heroDetailTitle': '환경 <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': '모드 {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': '환경 관리 - 삭제 확인',
          'web.env.heroDeleteTitle': '{{env}} 삭제',
          'web.env.heroDeleteAside': '<b>선택 내용을 확인하세요.</b> 선택한 리소스는 Cloudflare에서 삭제됩니다.',
          'web.env.accountMeta': '계정 <b>{{account}}</b>',
          'web.env.modeSingle': '단일 테넌트',
          'web.env.modeMulti': '멀티 테넌트',
          'web.env.cardMode': '모드',
          'web.env.cardAdmin': '관리자',
          'web.env.openDetails': '상세 열기 →',
          'web.env.adminConfigured': '설정됨 ✓',
          'web.env.adminNotConfigured': '미설정',
          'web.env.resourceSummary': '환경 <b>{{env}}</b> - 리소스 <b>{{total}}</b>',
          'env.name': '환경',
          'web.status.failed': '실패',
          'web.envDetail.generating': '생성 중...',
          'web.envDetail.tokenGenerated': '토큰 생성됨',
          'web.email.continueResources': '리소스 생성으로 이동 →',
          'web.domain.tenantIdInvalid': '{{label}}은(는) 소문자로 시작해야 하며 소문자, 숫자, 하이픈만 사용할 수 있습니다.',
          'web.config.saveFailed': '설정 저장 실패: {{error}}',
          'web.config.noConfigurationToSave': '저장할 설정이 없습니다.',
          'web.provision.reprovisionConfirm': '경고: 다시 생성하면 기존 리소스를 모두 삭제하고 새로 만듭니다.\\n\\n이 작업은 다음을 수행합니다.\\n- 기존 D1 데이터베이스를 삭제합니다. 모든 데이터가 손실됩니다.\\n- 기존 KV 네임스페이스를 삭제합니다.\\n- 새 암호화 키를 생성합니다.\\n\\n계속할까요?',
          'web.envDetail.noEnvironmentSelected': '선택된 환경이 없습니다.',
          'web.envDetail.positiveSlotCountRequired': '1 이상의 슬롯 수를 입력하세요.',
          'web.envDetail.tenantStorageLoadFailed': '테넌트 스토리지 상태를 불러오지 못했습니다.',
          'web.envDetail.r2StatusLoadFailed': 'R2 버킷 상태를 불러오지 못했습니다.',
          'web.envDetail.r2ConfiguredSummary': 'R2 버킷 설정됨: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'R2 버킷 생성 필요: {{configured}} / {{required}} 설정됨.',
          'web.envDetail.provisionR2Confirm': '누락된 R2 버킷을 만들고 Worker 바인딩을 새로고침한 뒤 Workers를 다시 배포합니다. 계속할까요?',
          'web.envDetail.r2Provisioning': 'R2 버킷 생성 중...',
          'web.envDetail.r2ConfiguredBuckets': '설정된 버킷: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'R2 버킷 생성이 완료되었습니다.',
          'web.envDetail.workerUpdateStarting': '{{env}}의 Worker 업데이트를 시작합니다...',
          'web.envDetail.fullDeployTitle': '전체 환경 배포',
          'web.envDetail.fullDeployScope': 'API Worker + UI Worker',
          'web.envDetail.fullDeployDesc': '현재 소스에서 모든 API Worker와 활성화된 UI Worker를 빌드하고 배포합니다. 기존 데이터와 설정은 유지됩니다.',
          'web.envDetail.fullDeployAction': '전체 환경 배포',
          'web.envDetail.fullDeployProgress': '배포 진행 상황',
          'web.envDetail.fullDeployStarting': '{{env}} 전체 환경 배포를 시작합니다...',
          'web.envDetail.fullDeployApiPhase': '모든 API Worker를 배포하는 중...',
          'web.envDetail.fullDeployUiComponent': '{{component}} 배포 중...',
          'web.envDetail.fullDeploySummary': '완료: {{success}} / {{total}}개 구성 요소',
          'web.envDetail.fullDeployComplete': '전체 환경 배포가 완료되었습니다.',
          'web.envDetail.fullDeployFailed': '전체 환경 배포에 실패했습니다: {{error}}',
          'web.envDetail.updateCompletedSuccess': '업데이트가 완료되었습니다.',
          'web.envDetail.workerUpdateSummary': '요약: {{success}} / {{total}} Workers 업데이트됨',
          'web.envDetail.updateFailedWithMessage': '업데이트 실패: {{error}}',
          'web.envDetail.updateThis': '이 컴포넌트 업데이트',
          'web.envDetail.componentUpdating': '{{env}}의 {{component}} 업데이트 중...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} 업데이트 완료.',
          'web.envDetail.uiUpdateMayTakeMinutes': '빌드와 Workers 배포에 몇 분이 걸릴 수 있습니다.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': '버전: {{value}}',
          'web.envDetail.logDeployedAt': '배포 시간: {{value}}',
          'web.envDetail.logProject': '프로젝트: {{value}}',
          'web.envDetail.configKvNotFound': '이 환경의 AUTHRIM_CONFIG KV 네임스페이스를 찾을 수 없습니다.',
          'web.envDetail.routerBaseUrlPrompt': 'Router의 기본 URL을 입력하세요. 예: https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': '토큰 생성 실패: {{error}}',
          'web.delete.starting': '삭제 시작 중...',
          'web.delete.deletedItems': '{{count}}개 항목 삭제됨',
          'web.delete.complete': '삭제가 완료되었습니다.',
          'web.delete.manualActionRequired': '수동 작업이 필요합니다.',
          'web.delete.success': '환경이 삭제되었습니다.',
          'web.delete.partialSuccess': '선택한 리소스를 삭제했습니다. 환경과 남은 로컬 상태는 유지되었습니다.',
          'web.delete.errorList': '오류가 발생했습니다: {{errors}}',
          'web.delete.inventoryUnavailable': 'Cloudflare 리소스 목록을 확인할 수 없어 삭제를 시작하지 않았습니다. 연결 및 Cloudflare 로그인 상태를 확인한 후 다시 시도하세요.',
          'web.status.errorWithMessage': '오류: {{error}}',
          'web.status.unknownError': '알 수 없는 오류',
          'web.delete.confirmExact': '이 환경을 삭제하려면 <b>{{env}}</b>를 정확히 입력하세요.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        ru: {
          'web.env.heroKicker': 'Управление средами',
          'web.env.heroListTitle': 'Среды',
          'web.env.heroListAside': 'Среды Authrim, найденные в этом аккаунте Cloudflare. Сканирование использует шаблон <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Управление средами - детали',
          'web.env.heroDetailTitle': 'Среда <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Режим {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Управление средами - удаление',
          'web.env.heroDeleteTitle': 'Удалить {{env}}',
          'web.env.heroDeleteAside': '<b>Проверьте выбранные элементы.</b> Выбранные ресурсы будут удалены из Cloudflare.',
          'web.env.accountMeta': 'Аккаунт <b>{{account}}</b>',
          'web.env.modeSingle': 'Single-tenant',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Режим',
          'web.env.cardAdmin': 'Админ',
          'web.env.openDetails': 'Открыть детали →',
          'web.env.adminConfigured': 'Настроено ✓',
          'web.env.adminNotConfigured': 'Не настроено',
          'web.env.resourceSummary': 'Среда <b>{{env}}</b> - ресурсы <b>{{total}}</b>',
          'env.name': 'Среда',
          'web.status.failed': 'Ошибка',
          'web.envDetail.generating': 'Генерация...',
          'web.envDetail.tokenGenerated': 'Токен создан',
          'web.email.continueResources': 'Перейти к ресурсам →',
          'web.domain.tenantIdInvalid': '{{label}} должен начинаться со строчной буквы и содержать только строчные буквы, цифры и дефисы.',
          'web.config.saveFailed': 'Не удалось сохранить конфигурацию: {{error}}',
          'web.config.noConfigurationToSave': 'Нет конфигурации для сохранения.',
          'web.provision.reprovisionConfirm': 'Предупреждение: повторное создание удалит все существующие ресурсы и создаст новые.\\n\\nБудет выполнено:\\n- Удаление существующих D1 databases. Все данные будут потеряны.\\n- Удаление существующих KV namespaces.\\n- Генерация новых ключей шифрования.\\n\\nПродолжить?',
          'web.envDetail.noEnvironmentSelected': 'Среда не выбрана.',
          'web.envDetail.positiveSlotCountRequired': 'Введите положительное число слотов.',
          'web.envDetail.tenantStorageLoadFailed': 'Не удалось загрузить состояние хранилища tenants.',
          'web.envDetail.r2StatusLoadFailed': 'Не удалось загрузить статус R2 buckets.',
          'web.envDetail.r2ConfiguredSummary': 'R2 buckets настроены: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'Требуется создать R2 buckets: {{configured}} / {{required}} настроено.',
          'web.envDetail.provisionR2Confirm': 'Будут созданы недостающие R2 buckets, обновлены Worker bindings и повторно развернуты Workers. Продолжить?',
          'web.envDetail.r2Provisioning': 'Создание R2 buckets...',
          'web.envDetail.r2ConfiguredBuckets': 'Настроенные buckets: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'Создание R2 buckets завершено.',
          'web.envDetail.workerUpdateStarting': 'Запуск обновления Workers для {{env}}...',
          'web.envDetail.fullDeployTitle': 'Развернуть всё окружение',
          'web.envDetail.fullDeployScope': 'API Workers + UI Workers',
          'web.envDetail.fullDeployDesc': 'Соберите и разверните все API Workers и включённые UI Workers из текущего исходного кода. Существующие данные и настройки сохраняются.',
          'web.envDetail.fullDeployAction': 'Развернуть всё окружение',
          'web.envDetail.fullDeployProgress': 'Прогресс развертывания',
          'web.envDetail.fullDeployStarting': 'Запуск полного развертывания окружения {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Развертывание всех API Workers...',
          'web.envDetail.fullDeployUiComponent': 'Развертывание {{component}}...',
          'web.envDetail.fullDeploySummary': 'Завершено: {{success}} / {{total}} компонентов',
          'web.envDetail.fullDeployComplete': 'Полное развертывание окружения завершено.',
          'web.envDetail.fullDeployFailed': 'Полное развертывание окружения не удалось: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Обновление завершено.',
          'web.envDetail.workerUpdateSummary': 'Итог: {{success}} / {{total}} Workers обновлено',
          'web.envDetail.updateFailedWithMessage': 'Обновление не удалось: {{error}}',
          'web.envDetail.updateThis': 'Обновить этот компонент',
          'web.envDetail.componentUpdating': 'Обновление {{component}} для {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} обновлен.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Сборка и deployment в Workers могут занять несколько минут.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Версия: {{value}}',
          'web.envDetail.logDeployedAt': 'Развернуто: {{value}}',
          'web.envDetail.logProject': 'Проект: {{value}}',
          'web.envDetail.configKvNotFound': 'KV namespace AUTHRIM_CONFIG для этой среды не найден.',
          'web.envDetail.routerBaseUrlPrompt': 'Введите базовый URL router, например https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Не удалось создать токен: {{error}}',
          'web.delete.starting': 'Запуск удаления...',
          'web.delete.deletedItems': 'Удалено элементов: {{count}}',
          'web.delete.complete': 'Удаление завершено.',
          'web.delete.manualActionRequired': 'Требуется ручное действие.',
          'web.delete.success': 'Среда удалена.',
          'web.delete.partialSuccess': 'Выбранные ресурсы удалены. Среда и оставшееся локальное состояние сохранены.',
          'web.delete.errorList': 'Произошли ошибки: {{errors}}',
          'web.delete.inventoryUnavailable': 'Не удалось проверить список ресурсов Cloudflare, поэтому удаление не было начато. Проверьте подключение и вход в Cloudflare, затем повторите попытку.',
          'web.status.errorWithMessage': 'Ошибка: {{error}}',
          'web.status.unknownError': 'Неизвестная ошибка',
          'web.delete.confirmExact': 'Чтобы удалить эту среду, введите <b>{{env}}</b> точно.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
        id: {
          'web.env.heroKicker': 'Manajemen environment',
          'web.env.heroListTitle': 'Environment',
          'web.env.heroListAside': 'Environment Authrim yang terdeteksi di akun Cloudflare ini. Pemindaian memakai konvensi nama <b>{env}-ar-*</b>.',
          'web.env.heroDetailKicker': 'Manajemen environment - Detail',
          'web.env.heroDetailTitle': 'Environment <code class="env-title-code">{{env}}</code>',
          'web.env.heroDetailAside': 'Mode {{mode}}<br>Issuer <b>{{issuer}}</b>',
          'web.env.heroDeleteKicker': 'Manajemen environment - Hapus',
          'web.env.heroDeleteTitle': 'Hapus {{env}}',
          'web.env.heroDeleteAside': '<b>Periksa pilihan Anda.</b> Resource yang dipilih akan dihapus dari Cloudflare.',
          'web.env.accountMeta': 'Akun <b>{{account}}</b>',
          'web.env.modeSingle': 'Single tenant',
          'web.env.modeMulti': 'Multi-tenant',
          'web.env.cardMode': 'Mode',
          'web.env.cardAdmin': 'Admin',
          'web.env.openDetails': 'Buka detail →',
          'web.env.adminConfigured': 'Terkonfigurasi ✓',
          'web.env.adminNotConfigured': 'Belum dikonfigurasi',
          'web.env.resourceSummary': 'Environment <b>{{env}}</b> - resource <b>{{total}}</b>',
          'env.name': 'Environment',
          'web.status.failed': 'Gagal',
          'web.envDetail.generating': 'Membuat...',
          'web.envDetail.tokenGenerated': 'Token dibuat',
          'web.email.continueResources': 'Lanjut ke resource →',
          'web.domain.tenantIdInvalid': '{{label}} harus diawali huruf kecil dan hanya boleh berisi huruf kecil, angka, dan tanda hubung.',
          'web.config.saveFailed': 'Gagal menyimpan konfigurasi: {{error}}',
          'web.config.noConfigurationToSave': 'Tidak ada konfigurasi untuk disimpan.',
          'web.provision.reprovisionConfirm': 'Peringatan: reprovision akan menghapus semua resource yang ada dan membuat yang baru.\\n\\nTindakan ini akan:\\n- Menghapus database D1 yang ada. Semua data akan hilang.\\n- Menghapus namespace KV yang ada.\\n- Membuat kunci enkripsi baru.\\n\\nLanjutkan?',
          'web.envDetail.noEnvironmentSelected': 'Belum ada environment yang dipilih.',
          'web.envDetail.positiveSlotCountRequired': 'Masukkan jumlah slot positif.',
          'web.envDetail.tenantStorageLoadFailed': 'Gagal memuat status storage tenant.',
          'web.envDetail.r2StatusLoadFailed': 'Gagal memuat status bucket R2.',
          'web.envDetail.r2ConfiguredSummary': 'Bucket R2 terkonfigurasi: {{configured}} / {{required}}.',
          'web.envDetail.r2NeedsProvisioningSummary': 'Bucket R2 perlu dibuat: {{configured}} / {{required}} terkonfigurasi.',
          'web.envDetail.provisionR2Confirm': 'Ini akan membuat bucket R2 yang belum ada, memperbarui binding Worker, dan redeploy Workers. Lanjutkan?',
          'web.envDetail.r2Provisioning': 'Membuat bucket R2...',
          'web.envDetail.r2ConfiguredBuckets': 'Bucket terkonfigurasi: {{count}}',
          'web.envDetail.r2ProvisioningComplete': 'Pembuatan bucket R2 selesai.',
          'web.envDetail.workerUpdateStarting': 'Memulai update Worker untuk {{env}}...',
          'web.envDetail.fullDeployTitle': 'Deploy seluruh environment',
          'web.envDetail.fullDeployScope': 'Worker API + Worker UI',
          'web.envDetail.fullDeployDesc': 'Build dan deploy semua Worker API serta Worker UI yang diaktifkan dari source saat ini. Data dan pengaturan yang ada tetap dipertahankan.',
          'web.envDetail.fullDeployAction': 'Deploy seluruh environment',
          'web.envDetail.fullDeployProgress': 'Progres deploy',
          'web.envDetail.fullDeployStarting': 'Memulai deploy seluruh environment {{env}}...',
          'web.envDetail.fullDeployApiPhase': 'Men-deploy semua Worker API...',
          'web.envDetail.fullDeployUiComponent': 'Men-deploy {{component}}...',
          'web.envDetail.fullDeploySummary': 'Selesai: {{success}} / {{total}} komponen',
          'web.envDetail.fullDeployComplete': 'Deploy seluruh environment selesai.',
          'web.envDetail.fullDeployFailed': 'Deploy seluruh environment gagal: {{error}}',
          'web.envDetail.updateCompletedSuccess': 'Update selesai.',
          'web.envDetail.workerUpdateSummary': 'Ringkasan: {{success}} / {{total}} Workers diperbarui',
          'web.envDetail.updateFailedWithMessage': 'Update gagal: {{error}}',
          'web.envDetail.updateThis': 'Update komponen ini',
          'web.envDetail.componentUpdating': 'Memperbarui {{component}} untuk {{env}}...',
          'web.envDetail.componentUpdatedSuccess': '{{component}} diperbarui.',
          'web.envDetail.uiUpdateMayTakeMinutes': 'Build dan deploy ke Workers dapat memakan waktu beberapa menit.',
          'web.envDetail.logWorker': 'Worker: {{value}}',
          'web.envDetail.logVersion': 'Versi: {{value}}',
          'web.envDetail.logDeployedAt': 'Dideploy pada: {{value}}',
          'web.envDetail.logProject': 'Project: {{value}}',
          'web.envDetail.configKvNotFound': 'Namespace KV AUTHRIM_CONFIG untuk environment ini tidak ditemukan.',
          'web.envDetail.routerBaseUrlPrompt': 'Masukkan base URL router, misalnya https://myenv-ar-router.subdomain.workers.dev',
          'web.envDetail.tokenGenerateFailed': 'Gagal membuat token: {{error}}',
          'web.delete.starting': 'Memulai penghapusan...',
          'web.delete.deletedItems': '{{count}} item dihapus',
          'web.delete.complete': 'Penghapusan selesai.',
          'web.delete.manualActionRequired': 'Diperlukan tindakan manual.',
          'web.delete.success': 'Environment dihapus.',
          'web.delete.partialSuccess': 'Resource yang dipilih telah dihapus. Environment dan status lokal yang tersisa dipertahankan.',
          'web.delete.errorList': 'Terjadi error: {{errors}}',
          'web.delete.inventoryUnavailable': 'Inventaris resource Cloudflare tidak dapat diverifikasi, sehingga penghapusan tidak dimulai. Periksa koneksi dan status login Cloudflare, lalu coba lagi.',
          'web.status.errorWithMessage': 'Error: {{error}}',
          'web.status.unknownError': 'Error tidak diketahui',
          'web.delete.confirmExact': 'Untuk menghapus environment ini, ketik <b>{{env}}</b> persis.',
          'web.delete.countWorkers': '{{count}} Workers',
          'web.delete.countDatabases': '{{count}} D1',
          'web.delete.countNamespaces': '{{count}} KV',
          'web.delete.countQueues': '{{count}} Queues',
          'web.delete.countBuckets': '{{count}} R2',
          'web.delete.countProjects': '{{count}} Pages',
        },
      };
      const deleteProgressCopyByLocale = {
        en: {
          'web.delete.progress.preparing': 'Preparing deletion...',
          'web.delete.progress.scanningResource': 'Scanning {{resource}}...',
          'web.delete.progress.inventoryReady': 'Resource inventory verified.',
          'web.delete.progress.deletingResource': 'Deleting {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Reconciling managed DNS records...',
          'web.delete.progress.revokingTokens': 'Revoking managed Control API tokens...',
          'web.delete.progress.verifyingInventory': 'Verifying Cloudflare inventory...',
        },
        ja: {
          'web.delete.progress.preparing': '削除の準備中...',
          'web.delete.progress.scanningResource': '{{resource}}をスキャン中...',
          'web.delete.progress.inventoryReady': 'リソース一覧を確認しました。',
          'web.delete.progress.deletingResource': '{{resource}}を削除中...',
          'web.delete.progress.reconcilingDns': '管理対象DNSレコードを確認中...',
          'web.delete.progress.revokingTokens': '管理対象Control APIトークンを取消中...',
          'web.delete.progress.verifyingInventory': 'Cloudflareの残存リソースを確認中...',
        },
        'zh-CN': {
          'web.delete.progress.preparing': '正在准备删除...',
          'web.delete.progress.scanningResource': '正在扫描 {{resource}}...',
          'web.delete.progress.inventoryReady': '资源清单已验证。',
          'web.delete.progress.deletingResource': '正在删除 {{resource}}...',
          'web.delete.progress.reconcilingDns': '正在核对托管的 DNS 记录...',
          'web.delete.progress.revokingTokens': '正在撤销托管的 Control API 令牌...',
          'web.delete.progress.verifyingInventory': '正在验证 Cloudflare 资源清单...',
        },
        'zh-TW': {
          'web.delete.progress.preparing': '正在準備刪除...',
          'web.delete.progress.scanningResource': '正在掃描 {{resource}}...',
          'web.delete.progress.inventoryReady': '資源清單已驗證。',
          'web.delete.progress.deletingResource': '正在刪除 {{resource}}...',
          'web.delete.progress.reconcilingDns': '正在核對受管理的 DNS 記錄...',
          'web.delete.progress.revokingTokens': '正在撤銷受管理的 Control API 權杖...',
          'web.delete.progress.verifyingInventory': '正在驗證 Cloudflare 資源清單...',
        },
        es: {
          'web.delete.progress.preparing': 'Preparando la eliminación...',
          'web.delete.progress.scanningResource': 'Escaneando {{resource}}...',
          'web.delete.progress.inventoryReady': 'Inventario de recursos verificado.',
          'web.delete.progress.deletingResource': 'Eliminando {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Conciliando los registros DNS administrados...',
          'web.delete.progress.revokingTokens': 'Revocando los tokens administrados de la API de Control...',
          'web.delete.progress.verifyingInventory': 'Verificando el inventario de Cloudflare...',
        },
        pt: {
          'web.delete.progress.preparing': 'Preparando a exclusão...',
          'web.delete.progress.scanningResource': 'Escaneando {{resource}}...',
          'web.delete.progress.inventoryReady': 'Inventário de recursos verificado.',
          'web.delete.progress.deletingResource': 'Excluindo {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Reconciliando registros DNS gerenciados...',
          'web.delete.progress.revokingTokens': 'Revogando tokens gerenciados da API de Control...',
          'web.delete.progress.verifyingInventory': 'Verificando o inventário da Cloudflare...',
        },
        fr: {
          'web.delete.progress.preparing': 'Préparation de la suppression...',
          'web.delete.progress.scanningResource': 'Analyse de {{resource}}...',
          'web.delete.progress.inventoryReady': 'Inventaire des ressources vérifié.',
          'web.delete.progress.deletingResource': 'Suppression de {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Réconciliation des enregistrements DNS gérés...',
          'web.delete.progress.revokingTokens': 'Révocation des jetons API Control gérés...',
          'web.delete.progress.verifyingInventory': 'Vérification de l’inventaire Cloudflare...',
        },
        de: {
          'web.delete.progress.preparing': 'Löschung wird vorbereitet...',
          'web.delete.progress.scanningResource': '{{resource}} wird geprüft...',
          'web.delete.progress.inventoryReady': 'Ressourcenbestand wurde geprüft.',
          'web.delete.progress.deletingResource': '{{resource}} wird gelöscht...',
          'web.delete.progress.reconcilingDns': 'Verwaltete DNS-Einträge werden abgeglichen...',
          'web.delete.progress.revokingTokens': 'Verwaltete Control-API-Token werden widerrufen...',
          'web.delete.progress.verifyingInventory': 'Cloudflare-Bestand wird überprüft...',
        },
        ko: {
          'web.delete.progress.preparing': '삭제 준비 중...',
          'web.delete.progress.scanningResource': '{{resource}} 스캔 중...',
          'web.delete.progress.inventoryReady': '리소스 인벤토리를 확인했습니다.',
          'web.delete.progress.deletingResource': '{{resource}} 삭제 중...',
          'web.delete.progress.reconcilingDns': '관리되는 DNS 레코드를 조정하는 중...',
          'web.delete.progress.revokingTokens': '관리되는 Control API 토큰을 취소하는 중...',
          'web.delete.progress.verifyingInventory': 'Cloudflare 인벤토리를 확인하는 중...',
        },
        ru: {
          'web.delete.progress.preparing': 'Подготовка к удалению...',
          'web.delete.progress.scanningResource': 'Сканирование {{resource}}...',
          'web.delete.progress.inventoryReady': 'Инвентаризация ресурсов проверена.',
          'web.delete.progress.deletingResource': 'Удаление {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Согласование управляемых записей DNS...',
          'web.delete.progress.revokingTokens': 'Отзыв управляемых токенов Control API...',
          'web.delete.progress.verifyingInventory': 'Проверка ресурсов Cloudflare...',
        },
        id: {
          'web.delete.progress.preparing': 'Menyiapkan penghapusan...',
          'web.delete.progress.scanningResource': 'Memindai {{resource}}...',
          'web.delete.progress.inventoryReady': 'Inventaris resource telah diverifikasi.',
          'web.delete.progress.deletingResource': 'Menghapus {{resource}}...',
          'web.delete.progress.reconcilingDns': 'Merekonsiliasi record DNS terkelola...',
          'web.delete.progress.revokingTokens': 'Mencabut token Control API terkelola...',
          'web.delete.progress.verifyingInventory': 'Memverifikasi inventaris Cloudflare...',
        },
      };
      const deployProgressCopyByLocale = {
        en: {
          'web.deploy.phase.preparation': 'Preparing deployment',
          'web.deploy.phase.schema': 'Applying database schema',
          'web.deploy.phase.configuration': 'Generating configuration',
          'web.deploy.phase.workers': 'Deploying API Workers',
          'web.deploy.phase.verification': 'Verifying Worker readiness',
          'web.deploy.phase.control': 'Reconciling the Control Plane',
          'web.deploy.phase.bootstrap': 'Bootstrapping tenant services',
          'web.deploy.phase.routing': 'Verifying tenant routing',
          'web.deploy.phase.integrations': 'Configuring optional integrations',
          'web.deploy.phase.ui': 'Deploying Login and Admin UI',
          'web.deploy.phase.progress': 'Phase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Deployment phase {{current}} of {{total}}',
          'web.deploy.phase.complete': 'Deployment complete!',
        },
        ja: {
          'web.deploy.phase.preparation': 'デプロイを準備しています',
          'web.deploy.phase.schema': 'データベーススキーマを適用しています',
          'web.deploy.phase.configuration': '設定を生成しています',
          'web.deploy.phase.workers': 'API Workerをデプロイしています',
          'web.deploy.phase.verification': 'Workerの準備状態を確認しています',
          'web.deploy.phase.control': 'コントロールプレーンを整合しています',
          'web.deploy.phase.bootstrap': 'テナントサービスを初期化しています',
          'web.deploy.phase.routing': 'テナントルーティングを確認しています',
          'web.deploy.phase.integrations': '任意の連携機能を設定しています',
          'web.deploy.phase.ui': 'Login UIとAdmin UIをデプロイしています',
          'web.deploy.phase.progress': 'フェーズ {{current}} / {{total}}',
          'web.deploy.phase.aria': 'デプロイフェーズ {{current}} / {{total}}',
          'web.deploy.phase.complete': 'デプロイが完了しました',
        },
        'zh-CN': {
          'web.deploy.phase.preparation': '正在准备部署',
          'web.deploy.phase.schema': '正在应用数据库架构',
          'web.deploy.phase.configuration': '正在生成配置',
          'web.deploy.phase.workers': '正在部署 API Workers',
          'web.deploy.phase.verification': '正在验证 Worker 就绪状态',
          'web.deploy.phase.control': '正在协调控制平面',
          'web.deploy.phase.bootstrap': '正在初始化租户服务',
          'web.deploy.phase.routing': '正在验证租户路由',
          'web.deploy.phase.integrations': '正在配置可选集成',
          'web.deploy.phase.ui': '正在部署 Login UI 和 Admin UI',
          'web.deploy.phase.progress': '阶段 {{current}} / {{total}}',
          'web.deploy.phase.aria': '部署阶段 {{current}}，共 {{total}} 个阶段',
          'web.deploy.phase.complete': '部署完成！',
        },
        'zh-TW': {
          'web.deploy.phase.preparation': '正在準備部署',
          'web.deploy.phase.schema': '正在套用資料庫結構',
          'web.deploy.phase.configuration': '正在產生設定',
          'web.deploy.phase.workers': '正在部署 API Workers',
          'web.deploy.phase.verification': '正在驗證 Worker 就緒狀態',
          'web.deploy.phase.control': '正在協調控制平面',
          'web.deploy.phase.bootstrap': '正在初始化租戶服務',
          'web.deploy.phase.routing': '正在驗證租戶路由',
          'web.deploy.phase.integrations': '正在設定選用整合',
          'web.deploy.phase.ui': '正在部署 Login UI 和 Admin UI',
          'web.deploy.phase.progress': '階段 {{current}} / {{total}}',
          'web.deploy.phase.aria': '部署階段 {{current}}，共 {{total}} 個階段',
          'web.deploy.phase.complete': '部署完成！',
        },
        es: {
          'web.deploy.phase.preparation': 'Preparando el despliegue',
          'web.deploy.phase.schema': 'Aplicando el esquema de la base de datos',
          'web.deploy.phase.configuration': 'Generando la configuración',
          'web.deploy.phase.workers': 'Desplegando los API Workers',
          'web.deploy.phase.verification': 'Verificando la disponibilidad de los Workers',
          'web.deploy.phase.control': 'Reconciliando el plano de control',
          'web.deploy.phase.bootstrap': 'Inicializando los servicios del tenant',
          'web.deploy.phase.routing': 'Verificando el enrutamiento del tenant',
          'web.deploy.phase.integrations': 'Configurando integraciones opcionales',
          'web.deploy.phase.ui': 'Desplegando Login UI y Admin UI',
          'web.deploy.phase.progress': 'Fase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Fase de despliegue {{current}} de {{total}}',
          'web.deploy.phase.complete': '¡Despliegue completado!',
        },
        pt: {
          'web.deploy.phase.preparation': 'Preparando o deploy',
          'web.deploy.phase.schema': 'Aplicando o schema do banco de dados',
          'web.deploy.phase.configuration': 'Gerando a configuração',
          'web.deploy.phase.workers': 'Fazendo deploy dos API Workers',
          'web.deploy.phase.verification': 'Verificando a disponibilidade dos Workers',
          'web.deploy.phase.control': 'Reconciliando o plano de controle',
          'web.deploy.phase.bootstrap': 'Inicializando os serviços do tenant',
          'web.deploy.phase.routing': 'Verificando o roteamento do tenant',
          'web.deploy.phase.integrations': 'Configurando integrações opcionais',
          'web.deploy.phase.ui': 'Fazendo deploy da Login UI e Admin UI',
          'web.deploy.phase.progress': 'Fase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Fase de deploy {{current}} de {{total}}',
          'web.deploy.phase.complete': 'Deploy concluído!',
        },
        fr: {
          'web.deploy.phase.preparation': 'Préparation du déploiement',
          'web.deploy.phase.schema': 'Application du schéma de base de données',
          'web.deploy.phase.configuration': 'Génération de la configuration',
          'web.deploy.phase.workers': 'Déploiement des API Workers',
          'web.deploy.phase.verification': 'Vérification de la disponibilité des Workers',
          'web.deploy.phase.control': 'Réconciliation du plan de contrôle',
          'web.deploy.phase.bootstrap': 'Initialisation des services du tenant',
          'web.deploy.phase.routing': 'Vérification du routage du tenant',
          'web.deploy.phase.integrations': 'Configuration des intégrations facultatives',
          'web.deploy.phase.ui': 'Déploiement de Login UI et Admin UI',
          'web.deploy.phase.progress': 'Phase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Phase de déploiement {{current}} sur {{total}}',
          'web.deploy.phase.complete': 'Déploiement terminé !',
        },
        de: {
          'web.deploy.phase.preparation': 'Deployment wird vorbereitet',
          'web.deploy.phase.schema': 'Datenbankschema wird angewendet',
          'web.deploy.phase.configuration': 'Konfiguration wird erzeugt',
          'web.deploy.phase.workers': 'API Workers werden bereitgestellt',
          'web.deploy.phase.verification': 'Worker-Bereitschaft wird geprüft',
          'web.deploy.phase.control': 'Control Plane wird abgeglichen',
          'web.deploy.phase.bootstrap': 'Tenant-Dienste werden initialisiert',
          'web.deploy.phase.routing': 'Tenant-Routing wird geprüft',
          'web.deploy.phase.integrations': 'Optionale Integrationen werden konfiguriert',
          'web.deploy.phase.ui': 'Login UI und Admin UI werden bereitgestellt',
          'web.deploy.phase.progress': 'Phase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Deployment-Phase {{current}} von {{total}}',
          'web.deploy.phase.complete': 'Deployment abgeschlossen!',
        },
        ko: {
          'web.deploy.phase.preparation': '배포를 준비하는 중',
          'web.deploy.phase.schema': '데이터베이스 스키마를 적용하는 중',
          'web.deploy.phase.configuration': '구성을 생성하는 중',
          'web.deploy.phase.workers': 'API Worker를 배포하는 중',
          'web.deploy.phase.verification': 'Worker 준비 상태를 확인하는 중',
          'web.deploy.phase.control': '컨트롤 플레인을 조정하는 중',
          'web.deploy.phase.bootstrap': '테넌트 서비스를 초기화하는 중',
          'web.deploy.phase.routing': '테넌트 라우팅을 확인하는 중',
          'web.deploy.phase.integrations': '선택적 연동을 구성하는 중',
          'web.deploy.phase.ui': 'Login UI와 Admin UI를 배포하는 중',
          'web.deploy.phase.progress': '단계 {{current}} / {{total}}',
          'web.deploy.phase.aria': '배포 단계 {{current}} / {{total}}',
          'web.deploy.phase.complete': '배포가 완료되었습니다!',
        },
        ru: {
          'web.deploy.phase.preparation': 'Подготовка развертывания',
          'web.deploy.phase.schema': 'Применение схемы базы данных',
          'web.deploy.phase.configuration': 'Создание конфигурации',
          'web.deploy.phase.workers': 'Развертывание API Workers',
          'web.deploy.phase.verification': 'Проверка готовности Workers',
          'web.deploy.phase.control': 'Согласование Control Plane',
          'web.deploy.phase.bootstrap': 'Инициализация сервисов тенанта',
          'web.deploy.phase.routing': 'Проверка маршрутизации тенанта',
          'web.deploy.phase.integrations': 'Настройка дополнительных интеграций',
          'web.deploy.phase.ui': 'Развертывание Login UI и Admin UI',
          'web.deploy.phase.progress': 'Этап {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Этап развертывания {{current}} из {{total}}',
          'web.deploy.phase.complete': 'Развертывание завершено!',
        },
        id: {
          'web.deploy.phase.preparation': 'Menyiapkan deployment',
          'web.deploy.phase.schema': 'Menerapkan skema database',
          'web.deploy.phase.configuration': 'Membuat konfigurasi',
          'web.deploy.phase.workers': 'Men-deploy API Workers',
          'web.deploy.phase.verification': 'Memverifikasi kesiapan Workers',
          'web.deploy.phase.control': 'Merekonsiliasi Control Plane',
          'web.deploy.phase.bootstrap': 'Menginisialisasi layanan tenant',
          'web.deploy.phase.routing': 'Memverifikasi routing tenant',
          'web.deploy.phase.integrations': 'Mengonfigurasi integrasi opsional',
          'web.deploy.phase.ui': 'Men-deploy Login UI dan Admin UI',
          'web.deploy.phase.progress': 'Fase {{current}} / {{total}}',
          'web.deploy.phase.aria': 'Fase deployment {{current}} dari {{total}}',
          'web.deploy.phase.complete': 'Deployment selesai!',
        },
      };
      const themeCopyByLocale = {
        en: {
          'web.theme.switchLight': 'Switch to light mode',
          'web.theme.switchDark': 'Switch to dark mode',
        },
        ja: {
          'web.theme.switchLight': 'ライトテーマに切り替え',
          'web.theme.switchDark': 'ダークテーマに切り替え',
        },
        'zh-CN': {
          'web.theme.switchLight': '切换到浅色主题',
          'web.theme.switchDark': '切换到深色主题',
        },
        'zh-TW': {
          'web.theme.switchLight': '切換到淺色主題',
          'web.theme.switchDark': '切換到深色主題',
        },
        es: {
          'web.theme.switchLight': 'Cambiar a tema claro',
          'web.theme.switchDark': 'Cambiar a tema oscuro',
        },
        pt: {
          'web.theme.switchLight': 'Mudar para tema claro',
          'web.theme.switchDark': 'Mudar para tema escuro',
        },
        fr: {
          'web.theme.switchLight': 'Passer au thème clair',
          'web.theme.switchDark': 'Passer au thème sombre',
        },
        de: {
          'web.theme.switchLight': 'Zum hellen Theme wechseln',
          'web.theme.switchDark': 'Zum dunklen Theme wechseln',
        },
        ko: {
          'web.theme.switchLight': '라이트 테마로 전환',
          'web.theme.switchDark': '다크 테마로 전환',
        },
        ru: {
          'web.theme.switchLight': 'Переключить на светлую тему',
          'web.theme.switchDark': 'Переключить на темную тему',
        },
        id: {
          'web.theme.switchLight': 'Beralih ke tema terang',
          'web.theme.switchDark': 'Beralih ke tema gelap',
        },
      };
      return {
        ...copyByLocale.en,
        ...(copyByLocale[language] || {}),
        ...flowCopyByLocale.en,
        ...(flowCopyByLocale[language] || {}),
        ...envManagementCopyByLocale.en,
        ...(envManagementCopyByLocale[language] || {}),
        ...envDynamicCopyByLocale.en,
        ...(envDynamicCopyByLocale[language] || {}),
        ...(envManagementSupplementalCopyByLocale[language] || {}),
        ...deleteProgressCopyByLocale.en,
        ...(deleteProgressCopyByLocale[language] || {}),
        ...deployProgressCopyByLocale.en,
        ...(deployProgressCopyByLocale[language] || {}),
        ...(themeCopyByLocale[language] || themeCopyByLocale.en),
      };
    }

    function getSetupUiRuntimeCopy(locale = _currentLocale) {
      const exact = _setupUiCopy[locale];
      if (exact) return exact;
      const normalized = String(locale || '').toLowerCase();
      if (normalized.startsWith('zh-tw')) return _setupUiCopy['zh-TW'];
      if (normalized.startsWith('zh')) return _setupUiCopy['zh-CN'];
      const language = normalized.split('-')[0];
      return _setupUiCopy[language] || _setupUiCopy.en;
    }

    function t(key, params = {}) {
      let text = _translations[key] || getSetupUiFallbackTranslation(key) || key;
      if (params) {
        Object.entries(params).forEach(([param, value]) => {
          text = text.replace(new RegExp('\\\\{\\\\{' + param + '\\\\}\\\\}', 'g'), String(value));
        });
      }
      return text;
    }

    function appendTranslatedRichText(parent, key, params = {}) {
      const template = _translations[key] || key;
      const parts = template.split(/(<strong>|<\\/strong>|\\{\\{[a-zA-Z0-9_]+\\}\\})/g);
      const stack = [parent];

      for (const part of parts) {
        if (!part) continue;
        if (part === '<strong>') {
          const strong = document.createElement('strong');
          stack[stack.length - 1].appendChild(strong);
          stack.push(strong);
          continue;
        }
        if (part === '</strong>') {
          if (stack.length > 1) stack.pop();
          continue;
        }

        const placeholderMatch = part.match(/^\\{\\{([a-zA-Z0-9_]+)\\}\\}$/);
        const text = placeholderMatch
          ? String(params[placeholderMatch[1]] ?? '')
          : part;
        stack[stack.length - 1].appendChild(document.createTextNode(text));
      }
    }

${DOMAIN_FORM_BROWSER_SCRIPT}

    function getApiDomainUiCopy() {
      const locale = String(_currentLocale || 'en').toLowerCase();
      const copyByLocale = {
        ja: {
          initialTenantLabel: '最初のテナントID',
          singleTenantLabel: 'テナントID',
          randomTenantButtonLabel: 'ランダムで決める',
          initialTenantHintGeneric:
            '最初に作成するテナント識別子です。1〜63文字で、先頭は小文字の英字、使用できるのは小文字英字・数字・ハイフンです。URLに使わない場合でも内部設定に使います。',
          singleTenantHintGeneric:
            'テナント識別子です。1〜63文字で、先頭は小文字の英字、使用できるのは小文字英字・数字・ハイフンです。URLに使わない場合でも内部設定に使います。',
          initialTenantHintSubdomain: (_tenantName, baseDomain, url) =>
            '最初のテナントは ' + url + ' を使います。',
          primaryTenantLabel: 'URLにテナント名を含めないテナント',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' で表示するテナントIDです。空欄なら ' + tenantName + ' を使います。',
          multiTenantHintNeedsDomain:
            'カスタムドメインを入力すると、テナントごとのURLを有効にできます。',
          multiTenantHintSingleTenant:
            '今は1つのURLだけを使います。必要になったらテナントごとのURLに切り替えられます。',
          multiTenantHintEnabled: (baseDomain) => baseDomain + ' 配下にテナントごとのURLを作成します。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '最初のテナントも ' + url + ' を使います。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' のURLは ' + url + ' になります。',
          examplesTitle: 'テナントURLの見え方',
          tableHeaderLabel: 'ケース',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '最初のテナント (' + tenantName + ') のURL',
          rowInitialTenantExplicit: (tenantName) =>
            '最初のテナント名をURLに含める場合 (' + tenantName + ')',
          rowOtherTenant: '他のテナントのURL',
        },
        de: {
          initialTenantLabel: 'ID des ersten Tenants',
          initialTenantHintGeneric:
            'Bezeichner für den ersten Tenant. Er bleibt erhalten, auch wenn die URL keinen Tenant-Teil anzeigt.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Der erste Tenant verwendet ' + url + '.',
          primaryTenantLabel: 'Tenant für die Domain ohne Tenant-Segment',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'Tenant-ID für ' + url + '. Leer lassen, um ' + tenantName + ' zu verwenden.',
          multiTenantHintNeedsDomain:
            'Geben Sie eine benutzerdefinierte Domain ein, um tenant-spezifische URLs zu aktivieren.',
          multiTenantHintSingleTenant:
            'Derzeit wird nur eine URL verwendet. Sie können später auf tenant-spezifische URLs umstellen.',
          multiTenantHintEnabled: (baseDomain) =>
            'Tenant-spezifische URLs werden unter ' + baseDomain + ' erstellt.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Der erste Tenant verwendet ebenfalls ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' verwendet ' + url + '.',
          examplesTitle: 'So sehen die Tenant-URLs aus',
          tableHeaderLabel: 'Fall',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL des ersten Tenants (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Erster Tenant, wenn das Tenant-Segment in der URL enthalten ist (' + tenantName + ')',
          rowOtherTenant: 'URL für andere Tenants',
        },
        es: {
          initialTenantLabel: 'ID del primer tenant',
          initialTenantHintGeneric:
            'Identificador del primer tenant que crea. Se conserva incluso si la URL no muestra un segmento de tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'El primer tenant usará ' + url + '.',
          primaryTenantLabel: 'Tenant que usa la URL sin nombre de tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID del tenant que se mostrará en ' + url + '. Déjelo vacío para usar ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Ingrese un dominio personalizado para habilitar URLs por tenant.',
          multiTenantHintSingleTenant:
            'Por ahora solo se usa una URL. Más tarde puede cambiar a URLs por tenant.',
          multiTenantHintEnabled: (baseDomain) =>
            'Las URLs por tenant se crearán bajo ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'El primer tenant también usará ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' usará ' + url + '.',
          examplesTitle: 'Cómo se verán las URLs de tenant',
          tableHeaderLabel: 'Caso',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL del primer tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Primer tenant cuando el segmento de tenant se incluye en la URL (' + tenantName + ')',
          rowOtherTenant: 'URL de otros tenants',
        },
        fr: {
          initialTenantLabel: 'ID du premier tenant',
          initialTenantHintGeneric:
            'Identifiant du premier tenant créé. Il est conservé même si l’URL n’affiche pas de segment tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Le premier tenant utilisera ' + url + '.',
          primaryTenantLabel: 'Tenant utilisant l’URL sans segment tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID du tenant servi sur ' + url + '. Laissez vide pour utiliser ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Saisissez un domaine personnalisé pour activer des URL par tenant.',
          multiTenantHintSingleTenant:
            'Une seule URL est utilisée pour le moment. Vous pourrez passer plus tard à des URL par tenant.',
          multiTenantHintEnabled: (baseDomain) =>
            'Des URL par tenant seront créées sous ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Le premier tenant utilisera aussi ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' utilisera ' + url + '.',
          examplesTitle: 'Apparence des URL de tenant',
          tableHeaderLabel: 'Cas',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL du premier tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Premier tenant lorsque le segment tenant est inclus dans l’URL (' + tenantName + ')',
          rowOtherTenant: 'URL des autres tenants',
        },
        id: {
          initialTenantLabel: 'ID tenant pertama',
          initialTenantHintGeneric:
            'Identifier untuk tenant pertama yang Anda buat. Tetap dipakai walaupun URL tidak menampilkan segmen tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Tenant pertama akan menggunakan ' + url + '.',
          primaryTenantLabel: 'Tenant yang menggunakan URL tanpa nama tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID tenant yang dilayani di ' + url + '. Kosongkan untuk menggunakan ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Masukkan domain kustom untuk mengaktifkan URL per tenant.',
          multiTenantHintSingleTenant:
            'Saat ini hanya satu URL yang digunakan. Anda bisa beralih ke URL per tenant nanti.',
          multiTenantHintEnabled: (baseDomain) =>
            'URL per tenant akan dibuat di bawah ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Tenant pertama juga akan menggunakan ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' akan menggunakan ' + url + '.',
          examplesTitle: 'Bentuk URL tenant',
          tableHeaderLabel: 'Kasus',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL tenant pertama (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Tenant pertama ketika segmen tenant disertakan di URL (' + tenantName + ')',
          rowOtherTenant: 'URL tenant lain',
        },
        ko: {
          initialTenantLabel: '첫 번째 테넌트 ID',
          initialTenantHintGeneric:
            '처음 생성하는 테넌트의 식별자입니다. URL에 테넌트 세그먼트가 없어도 내부 설정에 사용됩니다.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '첫 번째 테넌트는 ' + url + ' 를 사용합니다.',
          primaryTenantLabel: '테넌트 이름 없는 URL을 사용하는 테넌트',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 에서 사용할 테넌트 ID입니다. 비워 두면 ' + tenantName + ' 를 사용합니다.',
          multiTenantHintNeedsDomain:
            '테넌트별 URL을 사용하려면 사용자 지정 도메인을 입력하세요.',
          multiTenantHintSingleTenant:
            '현재는 하나의 URL만 사용합니다. 나중에 테넌트별 URL로 전환할 수 있습니다.',
          multiTenantHintEnabled: (baseDomain) => baseDomain + ' 아래에 테넌트별 URL이 생성됩니다.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '첫 번째 테넌트도 ' + url + ' 를 사용합니다.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 의 URL은 ' + url + ' 입니다.',
          examplesTitle: '테넌트 URL 예시',
          tableHeaderLabel: '구분',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '첫 번째 테넌트 URL (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'URL에 테넌트 세그먼트가 포함된 첫 번째 테넌트 (' + tenantName + ')',
          rowOtherTenant: '다른 테넌트 URL',
        },
        pt: {
          initialTenantLabel: 'ID do primeiro tenant',
          initialTenantHintGeneric:
            'Identificador do primeiro tenant que você criar. Ele continua sendo usado mesmo quando a URL não expõe um segmento de tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'O primeiro tenant usará ' + url + '.',
          primaryTenantLabel: 'Tenant que usa a URL sem nome de tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID do tenant servido em ' + url + '. Deixe em branco para usar ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Digite um domínio personalizado para habilitar URLs por tenant.',
          multiTenantHintSingleTenant:
            'No momento apenas uma URL é usada. Você pode mudar para URLs por tenant depois.',
          multiTenantHintEnabled: (baseDomain) =>
            'URLs por tenant serão criadas sob ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'O primeiro tenant também usará ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' usará ' + url + '.',
          examplesTitle: 'Como as URLs de tenant ficarão',
          tableHeaderLabel: 'Caso',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL do primeiro tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Primeiro tenant quando o segmento de tenant é incluído na URL (' + tenantName + ')',
          rowOtherTenant: 'URL de outros tenants',
        },
        ru: {
          initialTenantLabel: 'ID первого тенанта',
          initialTenantHintGeneric:
            'Идентификатор первого создаваемого тенанта. Он сохраняется, даже если URL не содержит сегмент тенанта.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Первый тенант будет использовать ' + url + '.',
          primaryTenantLabel: 'Тенант, использующий URL без имени тенанта',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID тенанта для ' + url + '. Оставьте пустым, чтобы использовать ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Введите пользовательский домен, чтобы включить URL для отдельных тенантов.',
          multiTenantHintSingleTenant:
            'Сейчас используется только один URL. Позже можно переключиться на URL для отдельных тенантов.',
          multiTenantHintEnabled: (baseDomain) =>
            'URL для отдельных тенантов будут созданы под ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Первый тенант также будет использовать ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' будет использовать ' + url + '.',
          examplesTitle: 'Как будут выглядеть URL тенантов',
          tableHeaderLabel: 'Случай',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL первого тенанта (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Первый тенант, когда сегмент тенанта включён в URL (' + tenantName + ')',
          rowOtherTenant: 'URL других тенантов',
        },
        'zh-cn': {
          initialTenantLabel: '第一个租户 ID',
          initialTenantHintGeneric:
            '这是您创建的第一个租户标识。即使 URL 不显示租户段，也会在内部配置中使用。',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '第一个租户将使用 ' + url + '。',
          primaryTenantLabel: '使用无租户名 URL 的租户',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 对应的租户 ID。留空则使用 ' + tenantName + '。',
          multiTenantHintNeedsDomain:
            '输入自定义域名后，才能启用按租户区分的 URL。',
          multiTenantHintSingleTenant:
            '当前只使用一个 URL，之后可以再切换为按租户区分的 URL。',
          multiTenantHintEnabled: (baseDomain) =>
            '将在 ' + baseDomain + ' 下创建按租户区分的 URL。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '第一个租户也会使用 ' + url + '。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 将使用 ' + url + '。',
          examplesTitle: '租户 URL 的显示方式',
          tableHeaderLabel: '场景',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '第一个租户的 URL（' + tenantName + '）',
          rowInitialTenantExplicit: (tenantName) =>
            '当 URL 中包含租户段时的第一个租户（' + tenantName + '）',
          rowOtherTenant: '其他租户的 URL',
        },
        'zh-tw': {
          initialTenantLabel: '第一個租戶 ID',
          initialTenantHintGeneric:
            '這是您建立的第一個租戶識別碼。即使 URL 不顯示租戶段，內部設定仍會使用它。',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '第一個租戶將使用 ' + url + '。',
          primaryTenantLabel: '使用無租戶名稱 URL 的租戶',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 對應的租戶 ID。留空則使用 ' + tenantName + '。',
          multiTenantHintNeedsDomain:
            '輸入自訂網域後，才能啟用依租戶區分的 URL。',
          multiTenantHintSingleTenant:
            '目前只使用一個 URL，之後可以再切換成依租戶區分的 URL。',
          multiTenantHintEnabled: (baseDomain) =>
            '將在 ' + baseDomain + ' 下建立依租戶區分的 URL。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '第一個租戶也會使用 ' + url + '。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 將使用 ' + url + '。',
          examplesTitle: '租戶 URL 的顯示方式',
          tableHeaderLabel: '情境',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '第一個租戶的 URL（' + tenantName + '）',
          rowInitialTenantExplicit: (tenantName) =>
            '當 URL 包含租戶段時的第一個租戶（' + tenantName + '）',
          rowOtherTenant: '其他租戶的 URL',
        },
        en: {
          initialTenantLabel: 'Initial Tenant ID',
          singleTenantLabel: 'Tenant ID',
          randomTenantButtonLabel: 'Generate Random',
          initialTenantHintGeneric:
            'Identifier for the first tenant you create. Use 1-63 characters, start with a lowercase letter, and use only lowercase letters, digits, and hyphens. It is kept even when the URL does not expose a tenant segment.',
          singleTenantHintGeneric:
            'Tenant identifier. Use 1-63 characters, start with a lowercase letter, and use only lowercase letters, digits, and hyphens. It is kept even when the URL does not expose a tenant segment.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'The first tenant will use ' + url + '.',
          primaryTenantLabel: 'Tenant that uses the naked URL',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'Tenant ID served at ' + url + '. Leave empty to use ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Enter a custom domain to enable tenant-specific URLs.',
          multiTenantHintSingleTenant:
            'Only one URL is used right now. You can switch to tenant-specific URLs later.',
          multiTenantHintEnabled: (baseDomain) =>
            'Tenant-specific URLs will be created under ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'The first tenant will also use ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' will use ' + url + '.',
          examplesTitle: 'How tenant URLs will look',
          tableHeaderLabel: 'Case',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'First tenant URL (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'First tenant when the tenant segment is included (' + tenantName + ')',
          rowOtherTenant: 'Other tenant URL',
        },
      };

      const selected =
        copyByLocale[locale] ||
        copyByLocale[locale.split('-')[0]] ||
        copyByLocale.en;

      return selected;
    }

    const PREREQ_CAPABILITY_COPY = ${JSON.stringify(SETUP_CAPABILITY_COPY)};
    const CLOUDFLARE_DNS_RECORDS_DOCS = ${JSON.stringify(CLOUDFLARE_DNS_RECORDS_DOCS_URL)};
    const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com/';

    function getPrereqCapabilityCopy() {
      const locale = String(_currentLocale || 'en');
      return (
        PREREQ_CAPABILITY_COPY[locale] ||
        PREREQ_CAPABILITY_COPY[locale.split('-')[0]] ||
        PREREQ_CAPABILITY_COPY.en
      );
    }

    function renderPrereqCapabilities(container, result) {
      if (!container) return;

      const statuses = result.capabilityStatuses || {};
      const diagnostics = result.capabilityDiagnostics || {};
      const copy = getPrereqCapabilityCopy();
      const wrapper = document.createElement('div');
      wrapper.className = 'prereq-capabilities';

      const title = document.createElement('div');
      title.className = 'prereq-capabilities-title';
      title.textContent = copy.title;
      wrapper.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'prereq-capabilities-hint';
      hint.textContent = copy.hint;
      wrapper.appendChild(hint);

      const list = document.createElement('div');
      list.className = 'prereq-capability-list';

      function getStatusMeta(status, okDescription, reviewDescription, ngDescription) {
        if (status === 'ok') {
          return { status: 'ok', description: okDescription, badgeLabel: copy.ok };
        }
        if (status === 'review') {
          return { status: 'review', description: reviewDescription, badgeLabel: copy.review };
        }
        return { status: 'ng', description: ngDescription, badgeLabel: copy.ng };
      }

      const items = [
        Object.assign(
          {
          label: copy.workersDeploy,
          },
          getStatusMeta(
            statuses.workersDeploy,
            copy.workersDeployOk,
            copy.workersDeployReview,
            copy.workersDeployNg
          )
        ),
        Object.assign(
          {
          label: copy.customDomain,
          },
          getStatusMeta(
            statuses.customDomain,
            copy.customDomainOk,
            copy.customDomainReviewZoneRead,
            diagnostics.zoneReadAvailable ? copy.customDomainNgNoZone : copy.workersDeployNg
          )
        ),
        Object.assign(
          {
          label: copy.pages,
          },
          getStatusMeta(
            statuses.pages,
            copy.pagesOk,
            copy.pagesReview,
            copy.workersDeployNg
          )
        ),
      ];

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'prereq-capability-item';

        const body = document.createElement('div');
        body.className = 'prereq-capability-body';

        const name = document.createElement('div');
        name.className = 'prereq-capability-name';
        name.textContent = item.label;

        if (item.status === 'ok') {
          const hint = document.createElement('span');
          hint.className = 'prereq-capability-hint';
          hint.textContent = '?';
          hint.setAttribute('data-tip', item.description);
          name.appendChild(hint);
        }

        body.appendChild(name);

        if (item.status !== 'ok') {
          const desc = document.createElement('div');
          desc.className = 'prereq-capability-desc';
          desc.textContent = item.description;
          body.appendChild(desc);
        }

        const right = document.createElement('div');
        right.style.cssText = 'display:flex; align-items:center; gap:0.4rem; flex:0 0 auto;';

        const pill = document.createElement('span');
        pill.className = 'prereq-capability-pill ' + item.status;
        pill.textContent = item.badgeLabel;
        right.appendChild(pill);

        row.appendChild(body);
        row.appendChild(right);
        list.appendChild(row);
      });

      wrapper.appendChild(list);

      if (statuses.customDomain === 'review') {
        wrapper.appendChild(createPrereqCustomDomainReviewAlert());
      }

      container.appendChild(wrapper);
    }

    function createZoneActionButton(action, onRetry) {
      if (action === 'run_wrangler_login' || action === 'check_cloudflare_permissions') {
        return null;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';

      if (action === 'retry_check') {
        button.textContent = t('domain.action.retryCheck');
        button.addEventListener('click', () => onRetry?.());
        return button;
      }

      if (action === 'reload_page') {
        button.textContent = t('domain.action.reloadPage');
        button.addEventListener('click', () => window.location.reload());
        return button;
      }

      if (action === 'open_cloudflare_dashboard') {
        button.textContent = t('domain.action.openCloudflareDashboard');
        button.addEventListener('click', () =>
          window.open(CLOUDFLARE_DASHBOARD_URL, '_blank', 'noopener,noreferrer')
        );
        return button;
      }

      return null;
    }

    function createZoneDiagnosticAlert(result, params) {
      const diagnostic = result?.diagnostic;
      if (!diagnostic) {
        return null;
      }

      const code = diagnostic.code;
      const alertType =
        diagnostic.severity === 'success'
          ? 'success'
          : diagnostic.severity === 'error'
            ? 'error'
            : 'warning';
      const alert = document.createElement('div');
      alert.className = 'alert alert-' + alertType + ' zone-diagnostic';

      const title = document.createElement('div');
      title.className = 'zone-diagnostic-title';
      title.textContent = t('domain.diagnostic.' + code + '.title', params);
      alert.appendChild(title);

      const body = document.createElement('div');
      body.className = 'zone-diagnostic-body';
      body.textContent = t('domain.diagnostic.' + code + '.body', params);
      alert.appendChild(body);

      const nextText = t('domain.diagnostic.' + code + '.next', params);
      if (nextText && nextText !== 'domain.diagnostic.' + code + '.next') {
        const next = document.createElement('div');
        next.className = 'zone-diagnostic-next';
        next.textContent = nextText;
        alert.appendChild(next);
      }

      const actionButtons = (diagnostic.actions || [])
        .map((action) => createZoneActionButton(action, params.onRetry))
        .filter(Boolean);

      if (actionButtons.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'zone-diagnostic-actions';
        actionButtons.forEach((button) => actions.appendChild(button));
        alert.appendChild(actions);
      }

      return alert;
    }

    function createPrereqCustomDomainReviewAlert() {
      const alert = document.createElement('div');
      alert.className = 'alert alert-warning zone-diagnostic';

      const title = document.createElement('div');
      title.className = 'zone-diagnostic-title';
      title.textContent = t('domain.prereq.reviewTitle');
      alert.appendChild(title);

      const body = document.createElement('div');
      body.className = 'zone-diagnostic-body';
      body.textContent = t('domain.prereq.reviewBody');
      alert.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'zone-diagnostic-actions';
      const retryButton = createZoneActionButton('retry_check', checkPrerequisites);
      const reloadButton = createZoneActionButton('reload_page');

      if (retryButton) actions.appendChild(retryButton);
      if (reloadButton) actions.appendChild(reloadButton);
      alert.appendChild(actions);

      return alert;
    }

    /**
     * Update all elements with data-i18n attribute
     */
    function updateAllTranslations() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const params = el.getAttribute('data-i18n-params');
        if (key) {
          const parsedParams = params ? JSON.parse(params) : {};
          el.textContent = t(key, parsedParams);
        }
      });
      // Update placeholders
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) {
          el.setAttribute('placeholder', t(key));
        }
      });
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) {
          el.setAttribute('title', t(key));
        }
      });
      document.querySelectorAll('.sw-state[data-on][data-off]').forEach(el => {
        el.dataset.on = t('config.enabled');
        el.dataset.off = t('config.disabled');
        const input = el.closest('.switchline')?.querySelector('input[type="checkbox"]');
        el.textContent = input?.checked ? el.dataset.on : el.dataset.off;
      });
      // Update html lang attribute
      document.documentElement.lang = _currentLocale;
      if (typeof window.refreshApiDomainUi === 'function') {
        window.refreshApiDomainUi();
      }
      if (typeof window.renderDeployManualWildcardWarning === 'function') {
        window.renderDeployManualWildcardWarning();
      }
      if (typeof refreshSetupStaticCopy === 'function') {
        refreshSetupStaticCopy();
      }
      if (typeof refreshDynamicLocaleContent === 'function') {
        refreshDynamicLocaleContent();
      }
      const completeSection = document.getElementById('section-complete');
      if (typeof showComplete === 'function' && lastCompleteResult && completeSection && !completeSection.classList.contains('hidden')) {
        showComplete(lastCompleteResult);
      }
    }

    /**
     * Change the current language without page reload
     * @param {string} locale - Locale code (e.g., 'en', 'ja')
     */
    async function changeLanguage(locale) {
      if (locale === _currentLocale) return;

      try {
        const response = await fetch('/api/translations/' + locale);
        if (!response.ok) throw new Error('Failed to fetch translations');

        const data = await response.json();
        _translations = data.translations;
        _currentLocale = locale;

        // Save preference
        localStorage.setItem('authrim_setup_lang', locale);

        // Update URL without reload (for sharing/bookmarking)
        const url = new URL(window.location.href);
        url.searchParams.set('lang', locale);
        window.history.replaceState({}, '', url.toString());

        // Update all translatable elements
        updateAllTranslations();

        // Update the language selector dropdown to reflect the new language
        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
          langSelect.value = locale;
        }
      } catch (error) {
        console.error('Failed to change language:', error);
        // Fallback: reload the page
        localStorage.setItem('authrim_setup_lang', locale);
        const url = new URL(window.location.href);
        url.searchParams.set('lang', locale);
        window.location.href = url.toString();
      }
    }

    // Initialize translations on page load (must wait for DOM to be ready)
    document.addEventListener('DOMContentLoaded', function() {
      const savedLang = localStorage.getItem('authrim_setup_lang');
      const url = new URL(window.location.href);
      const urlLang = url.searchParams.get('lang');

      // If URL has lang parameter, use it and save to localStorage (CLI passed language)
      if (urlLang && _availableLocales.some(l => l.code === urlLang)) {
        localStorage.setItem('authrim_setup_lang', urlLang);
        // Apply translations for the current locale immediately
        updateAllTranslations();
      } else if (savedLang && savedLang !== _currentLocale) {
        // If there's a saved language preference and no query param, switch to it
        url.searchParams.set('lang', savedLang);
        window.history.replaceState({}, '', url.toString());
        changeLanguage(savedLang);
      } else {
        // Apply translations for the current locale immediately
        updateAllTranslations();
      }

      // Ensure the language selector displays the current language
      // This is needed in case the HTML selected attribute isn't being honored
      const langSelect = document.getElementById('lang-select');
      if (langSelect) {
        langSelect.value = _currentLocale;
      }
    });
  </script>
</head>
<body>
  <!-- Background Typography -->
  <div class="bg-typography" aria-hidden="true">Authrim</div>

  <!-- Splash Screen -->
  <div id="splash" class="splash">
    <div class="splash-content">
      <h1 class="splash-title">Authrim</h1>
      <p class="splash-tagline">Identity & Access Platform</p>
      <div class="splash-loader"></div>
    </div>
  </div>

  <div class="container">
    <header class="setup-masthead">
      <div class="setup-wordmark">Authrim<sup>SETUP</sup></div>
      <div class="setup-meta">
        <span id="setup-primary-meta">${startCopy.target} <b>Cloudflare Workers</b></span>
        <button type="button" id="theme-toggle" class="theme-toggle" aria-label="Toggle theme">◐ <span data-setup-copy="startTheme">${startCopy.theme}</span></button>
        <div class="top-controls">
          <div class="lang-selector">
            <select id="lang-select" onchange="changeLanguage(this.value)" aria-label="Select language">
              ${localeOptionsHtml}
            </select>
          </div>
        </div>
      </div>
    </header>

    <div class="step-indicator" id="step-indicator">
      <div class="step step-active" id="step-1" data-label="${setupStepLabels[0]}">01</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-2" data-label="${setupStepLabels[1]}">02</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-3" data-label="${setupStepLabels[2]}">03</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-4" data-label="${setupStepLabels[3]}">04</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-5" data-label="${setupStepLabels[4]}">05</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-6" data-label="${setupStepLabels[5]}">06</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-7" data-label="${setupStepLabels[6]}">07</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-8" data-label="${setupStepLabels[7]}">08</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-9" data-label="${setupStepLabels[8]}">09</div>
    </div>

    <header class="setup-hero setup-enter">
      <div class="setup-hero-number" id="setup-hero-number">0<em>1</em></div>
      <div class="setup-hero-main">
        <p class="header-wizard" data-i18n="web.header.setupWizard">Setup Wizard</p>
        <h1 id="setup-hero-title">Authrim</h1>
        <p class="subtitle" data-i18n="web.header.subtitle">OIDC Provider on Cloudflare Workers</p>
      </div>
      <p class="setup-hero-aside" id="setup-hero-aside">
      </p>
    </header>

    <!-- Step 1: Prepare -->
    <div id="section-prerequisites" class="setup-prereq-section setup-section-enter">
      <section class="checksec">
        <div class="sechead">
          <h3 data-i18n="web.prereq.environmentCheck">Environment Check</h3>
        </div>
        <div class="checks" id="prereq-environment-checks">
          <div class="checkline">
            <span class="ix">01</span>
            <span class="nm"><span data-i18n="web.status.checking">Checking...</span><small data-i18n="web.prereq.checkingRequirements">Checking system requirements...</small></span>
            <span class="det">...</span>
            <span class="st" id="prereq-status" data-i18n="web.status.checking">Checking...</span>
          </div>
        </div>
      </section>

      <div id="prereq-content" class="setup-prereq-message"></div>

      <div class="actions setup-prereq-actions">
        <div class="progress" id="prereq-progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>01</b> / 09</div>
        <div class="spacer"></div>
        <button type="button" class="btn btn-back" id="btn-recheck-prereq">↻ <span data-i18n="web.prereq.recheck">Re-check</span></button>
        <button type="button" class="btn btn-next" id="btn-prereq-continue" disabled><span data-i18n="web.prereq.continueStart">Continue to Start</span> <span class="arr">→</span></button>
      </div>
    </div>

    <!-- Step 1.5: Top Menu (New Setup / Load Config / Manage) -->
    <div id="section-top-menu" class="setup-start-section hidden">
      <div class="setup-recap" id="setup-start-recap">
        <span><span data-setup-copy="startWrangler">${startCopy.wrangler}</span> <b id="setup-recap-wrangler">ok</b> <span class="ok">✓</span></span>
        <span><span data-setup-copy="startAccount">${startCopy.account}</span> <b id="setup-recap-account">${startCopy.unknown}</b> <span class="ok">✓</span></span>
        <span><span data-setup-copy="startSubdomain">${startCopy.subdomain}</span> <b id="setup-recap-subdomain">${startCopy.unknown}</b> <span class="ok">✓</span></span>
      </div>

      <section id="pending-control-operations" class="alert warn hidden" aria-live="polite">
        <div class="a-head" data-i18n="web.control.pendingTitle">Pending provisioning operations</div>
        <p data-i18n="web.control.pendingDescription">Setup runs steps that require operator permissions and continues to show Control verification progress.</p>
        <div id="pending-control-operation-items"></div>
        <p id="pending-control-operation-result" aria-live="polite"></p>
        <button type="button" class="btn btn-next" id="btn-open-pending-operation" data-i18n="web.control.pendingRun">Run pending operation</button>
      </section>

      <div class="modegrid setup-modegrid">
        <div class="modepanel primary" id="menu-new-setup" role="button" tabindex="0">
          <span class="mp-num">${startCopy.newNum}</span>
          <h3 data-setup-copy="startNewTitle">${startCopy.newTitle}</h3>
          <p data-setup-copy="startNewDesc">${startCopy.newDesc}</p>
          <span class="mp-go" data-setup-copy="startNewAction">${startCopy.newAction} <span class="arr">→</span></span>
        </div>

        <div class="modepanel" id="menu-load-config" role="button" tabindex="0">
          <span class="mp-num">${startCopy.loadNum}</span>
          <h3 data-setup-copy="startLoadTitle">${startCopy.loadTitle}</h3>
          <p data-setup-copy="startLoadDesc">${startCopy.loadDesc}</p>
          <span class="mp-go" data-setup-copy="startLoadAction">${startCopy.loadAction} <span class="arr">→</span></span>
        </div>

        <div class="modepanel" id="menu-manage-env" role="button" tabindex="0">
          <span class="mp-num">${startCopy.manageNum}</span>
          <h3 data-setup-copy="startManageTitle">${startCopy.manageTitle}</h3>
          <p data-setup-copy="startManageDesc">${startCopy.manageDesc}</p>
          <span class="mp-go" data-setup-copy="startManageAction">${startCopy.manageAction} <span class="arr">→</span></span>
        </div>
      </div>
    </div>

    <!-- Step 1.6: Load Config -->
    <div id="section-load-config" class="setup-load-section hidden">
      <section class="row load-file-row">
        <div class="rowlabel">
          <h2 data-i18n="web.loadConfig.fileSelection">File Selection</h2>
        </div>
        <div class="rowbody">
          <label class="dropzone" for="config-file">
            <span class="dz-main" data-i18n="web.loadConfig.dropConfigHere">Drop authrim-config.json here</span>
            <span class="dz-sub" data-i18n="web.loadConfig.chooseJsonOnly">or click to choose a file - .json only</span>
            <input type="file" id="config-file" accept=".json">
          </label>
          <div id="config-file-chip" class="filechip hidden">
            <span id="config-file-name"></span>
            <span class="sz" id="config-file-meta"></span>
          </div>
        </div>
      </section>

      <section class="row load-preview-row">
        <div class="rowlabel">
          <h2 data-i18n="web.loadConfig.preview">Configuration Preview</h2>
        </div>
        <div class="rowbody">
          <div id="config-preview-section" class="hidden">
            <div class="topo load-config-summary" id="config-summary-content"></div>
          </div>

          <div id="config-validation-error" class="alert error hidden">
            <div class="a-head" data-i18n="web.loadConfig.validationFailed">Configuration Validation Failed</div>
            <ul id="config-validation-errors"></ul>
          </div>

          <div id="config-validation-success" class="alert ok hidden">
            <div class="a-head" data-i18n="web.loadConfig.validationOk">Validation OK</div>
            <p id="config-validation-success-message" data-i18n="web.loadConfig.validationOkDesc">The configuration is valid. Review it and continue.</p>
          </div>
        </div>
        <div class="rownote" data-i18n="web.loadConfig.validationHelp">
          If validation finds a problem, errors and repair hints are shown here.
        </div>
      </section>

      <div class="actions setup-load-actions">
        <div class="progress"><span data-i18n="web.loadConfig.configurationFile">Configuration file</span> — <b id="config-load-progress" data-i18n="web.common.notSelected">Not selected</b></div>
        <div class="spacer"></div>
        <button class="btn btn-back" id="btn-back-top-2" data-i18n="web.btn.back">Back</button>
        <button class="btn btn-next" id="btn-load-config" disabled data-i18n="web.loadConfig.loadContinue">Load & Continue</button>
      </div>
    </div>

    <!-- Step 3: Basic Configuration -->
    <div id="section-config" class="setup-basic-section hidden">
      <div id="advanced-options" class="hidden">
        <section class="row">
          <div class="rowlabel">
            <h2 data-i18n="web.form.envName">Environment Name</h2>
            <span class="req" data-i18n="common.required">Required</span>
          </div>
          <div class="rowbody">
            <div class="fieldset">
            <label class="f-label" for="env" data-i18n="web.form.envName">Environment Name</label>
            <input class="f-input" type="text" id="env" placeholder="prod, main, tokyo, acme-dev" data-i18n-placeholder="web.form.envNamePlaceholder" required>
            <small class="f-help" data-i18n="web.form.envNameHint">Lowercase letters, numbers, and hyphens only</small>
            <span id="env-error" class="field-error" data-i18n="web.form.envNameError">Only lowercase letters, numbers, and hyphens are allowed (must start with a letter)</span>
            </div>
          </div>
          <div class="rownote">
            <span data-i18n="web.basic.envIsolation">Each environment gets its own Workers, D1 databases, and KV namespaces.</span>
          </div>
        </section>

        <section class="row">
          <div class="rowlabel">
            <h2 data-i18n="web.config.components">Components</h2>
          </div>
          <div class="rowbody">
            <div class="checklist">
              <div class="checkitem lock">
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.config.apiRequired">API (required)</span><small data-i18n="web.config.apiDesc">OIDC Provider endpoints: authorize, token, userinfo, discovery, management APIs.</small></span>
                <span class="st" data-i18n="common.required">required</span>
              </div>
              <label class="checkitem on" for="comp-login-ui">
                <input type="checkbox" id="comp-login-ui" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.comp.loginUi">Login UI</span><small data-i18n="web.comp.loginUiDesc">User-facing login, registration, consent, and account management pages.</small></span>
                <span class="st"></span>
              </label>
              <label class="checkitem on" for="comp-admin-ui">
                <input type="checkbox" id="comp-admin-ui" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.comp.adminUi">Admin UI</span><small data-i18n="web.comp.adminUiDesc">Administration dashboard for tenants, clients, users, and system settings.</small></span>
                <span class="st"></span>
              </label>
            </div>
          </div>
          <div class="rownote">
            <span data-i18n="web.basic.componentsNote">The API is always included. UIs are optional when using your own frontend through the SDK.</span>
          </div>
        </section>

        <section class="row">
          <div class="rowlabel">
            <h2 data-i18n="web.form.userIdFormat">User ID Format</h2>
          </div>
          <div class="rowbody">
            <select id="user-id-format" class="sr-control" aria-label="User ID Format">
              <option value="nanoid" selected data-i18n="web.form.userIdNanoid">NanoID (recommended)</option>
              <option value="uuid" data-i18n="web.form.userIdUuid">UUID v4</option>
            </select>
            <div class="radiocards" role="radiogroup" aria-label="User ID Format">
              <button type="button" class="radiocard on" data-user-id-format="nanoid">
                <span class="dot" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.form.userIdNanoid">NanoID (recommended)</span><small data-i18n="userId.nanoidDesc">URL-safe 21-character IDs, compact and secure</small><small class="user-id-format-example"><span data-i18n="web.form.userIdExample">Example:</span> <code class="inline">V1StGXR8_Z5jdHi6B-myT</code></small></span>
                <span class="st"></span>
              </button>
              <button type="button" class="radiocard" data-user-id-format="uuid">
                <span class="dot" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.form.userIdUuid">UUID v4</span><small data-i18n="userId.uuidDesc">Standard 36-character UUIDs with hyphens</small><small class="user-id-format-example"><span data-i18n="web.form.userIdExample">Example:</span> <code class="inline">550e8400-e29b-41d4-a716-446655440000</code></small></span>
                <span class="st"></span>
              </button>
            </div>
            <div class="alert basic-alert">
              <div class="a-head" data-i18n="web.form.userIdFormat">User ID Format</div>
              <p id="user-id-format-description" data-i18n="userId.nanoidDesc">URL-safe 21-character IDs, compact and secure</p>
              <p class="user-id-format-example"><span data-i18n="web.form.userIdExample">Example:</span> <code class="inline" id="user-id-format-example-value">V1StGXR8_Z5jdHi6B-myT</code></p>
              <p class="f-help" data-i18n="web.form.userIdFormatHint">Cannot be changed after users are created.</p>
            </div>
          </div>
        </section>
      </div>

      <div class="actions setup-basic-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>03</b> / 09</span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-mode">← <span data-i18n="web.btn.back">Back</span></button>
        <button class="btn btn-next" id="btn-configure"><span data-i18n="web.form.next">Next</span> <span class="arr">→</span></button>
      </div>
    </div>

    <div id="section-domain" class="setup-domain-section hidden">
      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.form.baseDomain">Base Domain (API Domain)</h2>
          <span class="opt" data-i18n="common.optional">Optional</span>
        </div>
        <div class="rowbody">
          <div class="fieldset">
            <label class="f-label" for="base-domain" data-i18n="web.form.baseDomain">Base Domain (API Domain)</label>
            <input class="f-input" type="text" id="base-domain" placeholder="id.example.com" data-i18n-placeholder="web.form.baseDomainPlaceholder" spellcheck="false">
            <div id="base-domain-depth-error" class="alert alert-warning" style="display: none;" role="alert"></div>
            <div id="domain-check-row" class="zonechip" style="display: none;">
              <button type="button" id="check-domain-btn" class="btn btn-ghost sm" data-i18n="domain.checkZoneButton">Check Zone</button>
              <div id="domain-check-status" class="domain-check-status" aria-live="polite"></div>
            </div>
          </div>

          <div class="fieldset">
            <label class="switchline" id="custom-domain-binding-row">
              <input type="checkbox" id="custom-domain-binding" checked>
              <span class="sw" aria-hidden="true"></span>
              <span class="sw-label">
                <span data-i18n="domain.configureBinding">Configure custom domain binding for Workers</span>
                <small><span data-i18n="web.domain.bindingHint">Bind the selected domain to</span> <span id="binding-router-name">router Worker</span></small>
                <small data-i18n="domain.configureBindingDesc">Assign the base domain directly to the router Worker so Cloudflare manages its DNS and TLS certificate. Tenant subdomains continue to use wildcard routing.</small>
              </span>
              <span class="sw-state" data-i18n="config.enabled">Enabled</span>
            </label>
            <label class="switchline" id="multi-tenant-label">
              <input type="checkbox" id="enable-multi-tenant" disabled>
              <span class="sw" aria-hidden="true"></span>
              <span class="sw-label">
                <span data-i18n="web.domain.multiTenantMode">Multi-tenant mode</span>
                <small id="multi-tenant-hint" data-i18n="web.form.multiTenantHint">Create tenant subdomains under your custom domain</small>
              </span>
              <span class="sw-state" data-i18n="config.enabled">Enabled</span>
            </label>
            <label class="switchline" id="naked-domain-label">
              <input type="checkbox" id="naked-domain">
              <span class="sw" aria-hidden="true"></span>
              <span class="sw-label">
                <span data-i18n="web.form.nakedDomain">Exclude tenant name from URL</span>
                <small id="naked-domain-hint" data-i18n="web.form.nakedDomainHint">Use https://example.com instead of https://{tenant}.example.com</small>
              </span>
              <span class="sw-state" data-i18n="config.disabled">Disabled</span>
            </label>
          </div>

          <div id="tenant-url-examples" class="topo" style="display: none;">
            <div class="cap"><span id="tenant-url-examples-title" data-i18n="web.form.multiTenantExamples">Tenant URL Examples</span><em data-i18n="web.domain.livePreview">Live preview</em></div>
            <table aria-live="polite">
              <thead class="sr-control">
                <tr>
                  <th id="tenant-url-examples-header-label">Case</th>
                  <th id="tenant-url-examples-header-url">URL</th>
                </tr>
              </thead>
              <tbody id="tenant-url-examples-body"></tbody>
            </table>
          </div>
        </div>
        <div class="rownote">
          <span><span data-i18n="web.domain.workersDevFallback">Leave the base domain empty to deploy to workers.dev. This is useful for evaluation and requires no DNS changes.</span> <span class="mono" id="router-default-note">prod-ar-router.workers.dev</span></span>
          <span id="workers-dev-note" class="warn" style="display: none;" data-i18n="web.form.nakedDomainWarning">
            Tenant subdomains require a custom domain. Workers.dev does not support wildcard subdomains.
          </span>
        </div>
      </section>

      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.form.tenantId">Initial Tenant ID</h2>
        </div>
        <div class="rowbody">
          <div class="fieldset" id="tenant-fields">
            <label class="f-label" for="tenant-name" id="tenant-id-label" data-i18n="web.form.tenantId">Initial Tenant ID</label>
            <div class="inline-input-row">
              <input class="f-input" type="text" id="tenant-name" placeholder="default" value="default" data-i18n-placeholder="web.form.tenantIdPlaceholder" spellcheck="false">
              <button type="button" id="tenant-name-random" class="btn btn-ghost sm" data-i18n="web.domain.generateRandom">Generate Random</button>
            </div>
            <div class="f-help" id="tenant-id-hint" data-i18n="web.form.tenantIdHint">First tenant identifier (lowercase, no spaces)</div>
            <div class="f-help" id="tenant-workers-note" style="display: none;" data-i18n="web.form.tenantIdWorkerNote">
              (Tenant ID is used internally. URL subdomain requires custom domain.)
            </div>
          </div>
          <div class="fieldset">
            <label class="f-label" for="tenant-display" data-i18n="web.form.tenantDisplay">Tenant Display Name</label>
            <input class="f-input sm" type="text" id="tenant-display" placeholder="My Company" value="" data-i18n-placeholder="web.form.tenantDisplayPlaceholder" spellcheck="false">
            <div class="f-help" data-i18n="web.form.tenantDisplayHint">Name shown on login page and consent screen</div>
          </div>
          <div class="fieldset" id="primary-tenant-row">
            <label class="f-label" for="primary-tenant" id="primary-tenant-label" data-i18n="web.domain.primaryTenantLabel">Tenant that uses the naked URL</label>
            <input class="f-input sm" type="text" id="primary-tenant" placeholder="Leave empty to use initial tenant" data-i18n-placeholder="web.domain.primaryTenantPlaceholder">
            <div class="f-help" id="primary-tenant-hint" data-i18n="web.domain.primaryTenantInitialHint">Tenant ID to use when accessing the naked domain. Leave empty to use the first tenant above.</div>
          </div>
        </div>
        <div class="rownote" data-i18n="web.domain.primaryTenantNote">
          When naked domain mode is enabled, specify the tenant that runs directly on the base domain.
        </div>
      </section>

      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.domain.uiDomains">UI Domains</h2>
          <span class="opt" data-i18n="common.optional">Optional</span>
        </div>
        <div class="rowbody">
          <div class="fieldset domain-row" id="login-domain-row">
            <label class="f-label" for="login-domain" data-i18n="web.domain.loginUiDomain">Login UI domain</label>
            <input class="f-input sm" type="text" id="login-domain" placeholder="login.example.com" data-i18n-placeholder="web.form.loginDomainPlaceholder" spellcheck="false">
            <div class="f-help domain-default"><span data-i18n="web.domain.defaultWhenEmpty">Default when empty:</span> <b id="login-default">{env}-ar-login-ui.workers.dev</b></div>
            <div id="login-domain-depth-error" class="alert alert-warning" style="display: none;" role="alert"></div>
            <div id="login-domain-zone-status" class="domain-check-status" aria-live="polite"></div>
          </div>
          <div class="fieldset domain-row" id="admin-domain-row">
            <label class="f-label" for="admin-domain" data-i18n="web.domain.adminUiDomain">Admin UI domain</label>
            <input class="f-input sm" type="text" id="admin-domain" placeholder="admin.example.com" data-i18n-placeholder="web.form.adminDomainPlaceholder" spellcheck="false">
            <div class="f-help domain-default"><span data-i18n="web.domain.defaultWhenEmpty">Default when empty:</span> <b id="admin-default">{env}-ar-admin-ui.workers.dev</b></div>
            <div id="admin-domain-depth-error" class="alert alert-warning" style="display: none;" role="alert"></div>
            <div id="admin-domain-zone-status" class="domain-check-status" aria-live="polite"></div>
          </div>
          <div class="alert info">
            <div class="a-head">CORS</div>
            <p data-i18n="web.domain.corsNote">Cross-origin requests from Login UI / Admin UI to the API are allowed automatically. No separate configuration is required.</p>
          </div>
        </div>
        <div class="rownote">
          <span data-i18n="web.domain.uiDomainsNote">Each UI domain can be configured independently. DNS can be configured automatically when the zone is available.</span>
        </div>
      </section>

      <section class="row wide">
        <div class="rowlabel">
          <h2 data-i18n="web.loadConfig.preview">Configuration Preview</h2>
        </div>
        <div class="rowbody">
          <div class="topo" id="config-preview">
            <div class="cap"><span data-i18n="web.domain.deploymentPreview">Deployment preview</span><em data-i18n="web.domain.review">Review</em></div>
            <table>
              <tr>
                <td class="k" data-i18n="web.config.components">Components</td>
                <td class="v preview-component-list" id="preview-components">
                  <span class="preview-component-badge">API</span>
                  <span class="preview-component-badge">Login UI</span>
                  <span class="preview-component-badge">Admin UI</span>
                </td>
              </tr>
              <tr id="preview-issuer-row"><td class="k" data-i18n="web.domain.issuerInitialTenant">Issuer URL (initial tenant)</td><td class="v" id="preview-issuer">https://{tenant}.{base-domain}</td></tr>
              <tr id="preview-login-row"><td class="k" data-i18n="web.domain.loginUiOrigin">Login UI origin</td><td class="v" id="preview-login">{env}-ar-login-ui.workers.dev</td></tr>
              <tr id="preview-tenant-discover-table-row"><td class="k" data-i18n="web.preview.tenantDiscover">Tenant Selection (Common Entry):</td><td class="v" id="preview-tenant-discover-table">{env}-ar-login-ui.workers.dev/discover</td></tr>
              <tr id="preview-admin-row"><td class="k" data-i18n="web.preview.adminAccess">Admin UI Access:</td><td class="v" id="preview-admin">{env}-ar-admin-ui.workers.dev</td></tr>
              <tr id="preview-admin-api-mode-row"><td class="k" data-i18n="web.domain.adminUiApiMode">Admin UI API mode</td><td class="v" id="preview-admin-api-mode">cross-site-proxy</td></tr>
            </table>
            <div id="preview-multi-tenant-section" style="display:none;">
              <div id="preview-mt-rows" aria-live="polite"></div>
              <div class="infra-item" id="preview-login-pages-row">
                <span class="infra-label" data-i18n="web.preview.pagesUrl">Login UI Origin:</span>
                <span class="infra-value" id="preview-login-pages">{env}-ar-login-ui.workers.dev</span>
              </div>
              <div class="infra-item" id="preview-tenant-discover-row">
                <span class="infra-label" data-i18n="web.preview.tenantDiscover">Tenant Selection (Common Entry):</span>
                <span class="infra-value" id="preview-tenant-discover">{env}-ar-login-ui.workers.dev/discover</span>
              </div>
              <div class="infra-item" id="preview-admin-access-row">
                <span class="infra-label" data-i18n="web.preview.adminAccess">Admin UI Access:</span>
                <span class="infra-value" id="preview-admin-access">https://{env}-ar-admin-ui.workers.dev/admin</span>
              </div>
            </div>
            <div id="preview-config-warning" class="hint-box error-hint" style="display:none;" role="alert">
              <strong id="preview-warning-title" data-i18n="web.preview.conflictWarningTitle">Configuration issue</strong>
              <div id="preview-warning-message"></div>
              <div id="preview-warning-action"></div>
            </div>
          </div>
          <div class="f-help" data-i18n="web.domain.previewHelp">If a combination has an issue, warnings and repair hints appear below.</div>
        </div>
      </section>

      <div class="actions setup-domain-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>04</b> / 09</span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-domain">← <span data-i18n="web.btn.back">Back</span></button>
        <button class="btn btn-next" id="btn-domain-continue"><span data-i18n="web.form.next">Next</span> <span class="arr">→</span></button>
      </div>
    </div>

    <div id="section-database" class="setup-database-section hidden">
      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.db.controlPlaneTitle">D1 Control Plane</h2>
        </div>
        <div class="rowbody">
          <p data-i18n="web.db.controlPlaneWorkerDesc">Control Worker, Control DB, Lookup, and the signed Runtime Registry are always provisioned.</p>
          <p class="f-help" data-i18n="web.db.controlPlaneTenantPlacement">The initial tenant uses <code>tenant_exclusive</code> placement. Tenant placement can later be selected per tenant.</p>
        </div>
        <div class="rownote">
          <span data-i18n="web.db.controlPlaneResolverNote">Single and multiple D1 assignments use the same runtime resolver.</span>
        </div>
      </section>

      <section class="row" id="automatic-provisioning-row">
        <div class="rowlabel">
          <h2 data-i18n="web.db.automaticProvisioningTitle">Automatic provisioning</h2>
        </div>
        <div class="rowbody">
          <div class="radiocards db-profile-cards">
            <label class="radiocard db-profile-card">
              <input type="radio" name="automatic-provisioning" value="on" checked>
              <span class="dot" aria-hidden="true"></span>
              <span class="nm">
                <span data-i18n="web.db.automaticProvisioningOn">On</span>
                <small data-i18n="web.db.automaticProvisioningOnDesc">Control creates capacity automatically with separate scoped Cloudflare tokens.</small>
                <strong class="db-profile-security-note" data-i18n="web.db.automaticProvisioningTokenNote">A dedicated Control Worker stores and uses the scoped Cloudflare API token needed to create tenant databases.</strong>
              </span>
              <span class="st"></span>
            </label>
            <label class="radiocard db-profile-card">
              <input type="radio" name="automatic-provisioning" value="off">
              <span class="dot" aria-hidden="true"></span>
              <span class="nm">
                <span data-i18n="web.db.automaticProvisioningOff">Off</span>
                <small data-i18n="web.db.automaticProvisioningOffDesc">No Cloudflare API token is stored on Control. Setup executes pending operations.</small>
              </span>
              <span class="st"></span>
            </label>
          </div>
        </div>
        <div class="rownote" data-i18n="web.db.automaticProvisioningNote">This can be skipped without changing tenant physical isolation.</div>
      </section>

      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.db.coreTitle">Core Database</h2>
          <span class="opt" data-i18n="web.db.coreNonPii">Non-PII</span>
        </div>
        <div class="rowbody">
          <div class="dbnote">
            <div class="f-help"><span data-i18n="web.db.name">Name</span>: <code id="core-db-name-preview">prod-authrim-core-db</code> — <span data-i18n="web.db.coreDataDesc">Stores non-personal application data including:</span></div>
            <ul class="dbnote-list">
              <li data-i18n="web.db.coreData1">OAuth clients and their configurations</li>
              <li data-i18n="web.db.coreData2">Authorization codes and access tokens</li>
              <li data-i18n="web.db.coreData3">User sessions and login state</li>
              <li data-i18n="web.db.coreData4">Tenant settings and configurations</li>
              <li data-i18n="web.db.coreData5">Audit logs and security events</li>
            </ul>
          </div>

          <label class="f-label" data-i18n="web.db.region">Region</label>
          <div class="regiongrid">
            <label class="region auto-region"><input type="radio" name="db-core-location" value="auto" checked><span class="dot"></span><span data-i18n="web.db.autoNearest">Automatic (nearest to you)</span><span class="code">auto</span></label>
            <span class="regionsep" data-i18n="web.db.locationHints">Location Hints</span>
            <label class="region"><input type="radio" name="db-core-location" value="wnam"><span class="dot"></span><span data-i18n="web.db.northAmericaWest">North America (West)</span><span class="code">wnam</span></label>
            <label class="region"><input type="radio" name="db-core-location" value="enam"><span class="dot"></span><span data-i18n="web.db.northAmericaEast">North America (East)</span><span class="code">enam</span></label>
            <label class="region"><input type="radio" name="db-core-location" value="weur"><span class="dot"></span><span data-i18n="web.db.europeWest">Europe (West)</span><span class="code">weur</span></label>
            <label class="region"><input type="radio" name="db-core-location" value="eeur"><span class="dot"></span><span data-i18n="web.db.europeEast">Europe (East)</span><span class="code">eeur</span></label>
            <label class="region"><input type="radio" name="db-core-location" value="apac"><span class="dot"></span><span data-i18n="web.db.asiaPacific">Asia Pacific</span><span class="code">apac</span></label>
            <label class="region"><input type="radio" name="db-core-location" value="oc"><span class="dot"></span><span data-i18n="web.db.oceania">Oceania</span><span class="code">oc</span></label>
            <span class="regionsep" data-i18n="web.db.jurisdiction">Jurisdiction (Compliance)</span>
            <label class="region"><input type="radio" name="db-core-location" value="eu"><span class="dot"></span><span data-i18n="web.db.euJurisdiction">EU Jurisdiction (GDPR compliance)</span><span class="code">eu</span></label>
          </div>
        </div>
        <div class="rownote" data-i18n="web.db.coreHint">
          This database handles all authentication flows and should be placed close to your primary user base.
        </div>
      </section>

      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.db.piiTitle">PII Database</h2>
          <span class="req" data-i18n="web.db.piiLabel">Personal Identifiable Information</span>
        </div>
        <div class="rowbody">
          <div class="dbnote">
            <div class="f-help"><span data-i18n="web.db.name">Name</span>: <code id="pii-db-name-preview">prod-authrim-pii-db</code> — <span data-i18n="web.db.piiDataDesc">Stores personal user data including:</span></div>
            <ul class="dbnote-list">
              <li data-i18n="web.db.piiData1">User profiles (name, email, phone)</li>
              <li data-i18n="web.db.piiData2">Passkey/WebAuthn credentials</li>
              <li data-i18n="web.db.piiData3">User preferences and settings</li>
              <li data-i18n="web.db.piiData4">Any custom user attributes</li>
            </ul>
          </div>

          <label class="f-label" data-i18n="web.db.region">Region</label>
          <div class="regiongrid">
            <label class="region auto-region"><input type="radio" name="db-pii-location" value="auto" checked><span class="dot"></span><span data-i18n="web.db.autoNearest">Automatic (nearest to you)</span><span class="code">auto</span></label>
            <span class="regionsep" data-i18n="web.db.locationHints">Location Hints</span>
            <label class="region"><input type="radio" name="db-pii-location" value="wnam"><span class="dot"></span><span data-i18n="web.db.northAmericaWest">North America (West)</span><span class="code">wnam</span></label>
            <label class="region"><input type="radio" name="db-pii-location" value="enam"><span class="dot"></span><span data-i18n="web.db.northAmericaEast">North America (East)</span><span class="code">enam</span></label>
            <label class="region"><input type="radio" name="db-pii-location" value="weur"><span class="dot"></span><span data-i18n="web.db.europeWest">Europe (West)</span><span class="code">weur</span></label>
            <label class="region"><input type="radio" name="db-pii-location" value="eeur"><span class="dot"></span><span data-i18n="web.db.europeEast">Europe (East)</span><span class="code">eeur</span></label>
            <label class="region"><input type="radio" name="db-pii-location" value="apac"><span class="dot"></span><span data-i18n="web.db.asiaPacific">Asia Pacific</span><span class="code">apac</span></label>
            <label class="region"><input type="radio" name="db-pii-location" value="oc"><span class="dot"></span><span data-i18n="web.db.oceania">Oceania</span><span class="code">oc</span></label>
            <span class="regionsep" data-i18n="web.db.jurisdiction">Jurisdiction (Compliance)</span>
            <label class="region"><input type="radio" name="db-pii-location" value="eu"><span class="dot"></span><span data-i18n="web.db.euJurisdiction">EU Jurisdiction (GDPR compliance)</span><span class="code">eu</span></label>
          </div>
        </div>
        <div class="rownote" data-i18n="web.db.piiHint">
          This database contains personal data. Consider placing it in a region that complies with your data protection requirements.
        </div>
      </section>

      <div class="actions setup-database-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>05</b> / 09</span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-database">← <span data-i18n="web.btn.back">Back</span></button>
        <button class="btn btn-next" id="btn-continue-database"><span data-i18n="web.form.next">Next</span> <span class="arr">→</span></button>
      </div>
    </div>

    <!-- Step 6: Optional Features and Email Provider Configuration -->
    <div id="section-email" class="setup-email-section hidden">
      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="features.title">Feature Flags</h2>
        </div>
        <div class="rowbody">
          <label class="switchline" id="feature-queue-row">
            <input type="checkbox" id="feature-queue-enabled">
            <span class="sw" aria-hidden="true"></span>
            <span class="sw-label">
              <span>Cloudflare Queues</span>
              <small data-i18n="features.queuePrompt">Enable Cloudflare Queues? Disabled by default.</small>
            </span>
            <span class="sw-state" data-on="${translations['config.enabled'] ?? 'Enabled'}" data-off="${translations['config.disabled'] ?? 'Disabled'}" data-i18n="config.disabled">Disabled</span>
          </label>

          <div class="alert info">
            <div class="a-head" data-i18n="web.email.queuePlanGuide">Workers Free plan guide</div>
            <p data-i18n="features.queuePrompt">Enable Cloudflare Queues? Disabled by default.</p>
          </div>
        </div>
        <div class="rownote" data-i18n="web.email.queueResourceNote">
          When enabled, logging queues are added during resource creation. Features that affect OIDC conformance remain disabled by default.
        </div>
      </section>

      <section class="row">
        <div class="rowlabel">
          <h2 data-i18n="web.email.title">Email Provider</h2>
        </div>
        <div class="rowbody">
          <div class="radiocards email-choice-cards">
            <label class="radiocard email-choice-card">
              <input type="radio" name="email-setup-choice" value="later" checked>
              <span class="dot" aria-hidden="true"></span>
              <span class="nm">
                <span data-i18n="web.email.configureLater">Configure later</span>
                <small data-i18n="web.email.configureLaterHint">Skip for now and configure later.</small>
              </span>
              <span class="st"></span>
            </label>
            <label class="radiocard email-choice-card">
              <input type="radio" name="email-setup-choice" value="cloudflare">
              <span class="dot" aria-hidden="true"></span>
              <span class="nm">
                <span data-i18n="web.email.configureCloudflare">Configure Cloudflare Email Service</span>
                <small data-i18n="web.email.configureCloudflareHint">Use the native Workers Email Service binding. Requires a Workers Paid plan and Cloudflare DNS.</small>
              </span>
              <span class="st"></span>
            </label>
            <label class="radiocard email-choice-card">
              <input type="radio" name="email-setup-choice" value="resend">
              <span class="dot" aria-hidden="true"></span>
              <span class="nm">
                <span data-i18n="web.email.configureResend">Configure Resend</span>
                <small data-i18n="web.email.configureResendHint">Set up email sending with Resend (recommended for production).</small>
              </span>
              <span class="st"></span>
            </label>
          </div>

          <div id="cloudflare-config-form" class="email-provider-form hidden">
            <div class="alert info">
              <div class="a-head" data-i18n="web.email.cloudflareRequirements">Requirements</div>
              <ul class="classic-list">
                <li data-i18n="web.email.cloudflareRequirementPaid">Workers Paid Plan is required</li>
                <li data-i18n="web.email.cloudflareRequirementDns">Cloudflare DNS/domain onboarding is required</li>
                <li data-i18n="web.email.cloudflareRequirementManual">Domain setup in the Cloudflare dashboard is still manual</li>
              </ul>
            </div>

            <div class="fieldset">
              <label class="f-label" for="cloudflare-from-address" data-i18n="web.email.fromEmailAddress">From Email Address</label>
              <input class="f-input sm" type="email" id="cloudflare-from-address" placeholder="noreply@yourdomain.com" autocomplete="off" spellcheck="false">
              <div class="f-help" data-i18n="web.email.cloudflareFromHint">Must be from a domain onboarded to Cloudflare Email Service</div>
            </div>

            <div class="fieldset">
              <label class="f-label" for="cloudflare-from-name" data-i18n="web.email.fromDisplayName">From Display Name (optional)</label>
              <input class="f-input sm" type="text" id="cloudflare-from-name" placeholder="Authrim" autocomplete="off" spellcheck="false">
              <div class="f-help" data-i18n="web.email.fromDisplayHint">Displayed as the sender name in email clients</div>
            </div>
          </div>

          <div id="resend-config-form" class="email-provider-form">
            <div class="alert info">
              <div class="a-head" data-i18n="web.email.beforeBegin">Before you begin:</div>
              <ol class="classic-list">
                <li><span data-i18n="web.email.step1">Create a Resend account at</span> <span class="mono">resend.com</span></li>
                <li><span data-i18n="web.email.step2">Add and verify your domain at</span> <span class="mono">Domains Dashboard</span></li>
                <li><span data-i18n="web.email.step3">Create an API key at</span> <span class="mono">API Keys</span></li>
              </ol>
            </div>

            <div class="fieldset">
              <label class="f-label" for="resend-api-key" data-i18n="web.email.resendApiKey">Resend API Key</label>
              <input class="f-input sm" type="password" id="resend-api-key" placeholder="re_xxxxxxxxxx" autocomplete="off" spellcheck="false">
              <div class="f-help" data-i18n="web.email.resendApiKeyHint">Your API key starts with "re_"</div>
            </div>

            <div class="fieldset">
              <label class="f-label" for="email-from-address" data-i18n="web.email.fromEmailAddress">From Email Address</label>
              <input class="f-input sm" type="email" id="email-from-address" placeholder="noreply@yourdomain.com" autocomplete="off" spellcheck="false">
              <div class="f-help" data-i18n="web.email.fromEmailHint">Must be from a verified domain in your Resend account</div>
            </div>

            <div class="fieldset">
              <label class="f-label" for="email-from-name" data-i18n="web.email.fromDisplayName">From Display Name (optional)</label>
              <input class="f-input sm" type="text" id="email-from-name" placeholder="Authrim" autocomplete="off" spellcheck="false">
              <div class="f-help" data-i18n="web.email.fromDisplayHint">Displayed as the sender name in email clients</div>
            </div>

            <div class="alert">
              <div class="a-head" data-i18n="web.email.domainVerificationTitle">Domain Verification Required</div>
              <p data-i18n="web.email.domainVerificationDesc">
                Before your domain is verified, emails can only be sent from onboarding@resend.dev (for testing).
              </p>
            </div>
          </div>
        </div>
        <div class="rownote" data-i18n="web.email.introDesc">
          Configure the email provider used for password reset, Mail OTP, and verification emails.
        </div>
      </section>

      <div class="actions setup-email-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>06</b> / 09</span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-email">← <span data-i18n="web.btn.back">Back</span></button>
        <button class="btn btn-next" id="btn-continue-email"><span data-i18n="web.form.next">Next</span> <span class="arr">→</span></button>
      </div>
    </div>

    <!-- Step 7: Resource Provisioning -->
    <div id="section-provision" class="setup-provision-section hidden">
      <section class="row" id="provision-preflight-row" data-setup-progress-prelude>
        <div class="rowlabel">
          <h2 data-i18n="web.provision.resourcesToCreate">Resources to Create</h2>
        </div>
        <div class="rowbody rowbody-tight">
          <div id="resource-preview" class="provision-resource-preview">
            <div class="resgrid">
              <div class="bigtable">
                <div class="cap"><span data-i18n="web.provision.d1Databases">D1 Databases:</span><em id="preview-d1-count">${D1_DATABASES.length + 3}</em></div>
                <table><tbody id="preview-d1"></tbody></table>
              </div>

              <div class="bigtable">
                <div class="cap"><span data-i18n="web.provision.cryptoKeys">Cryptographic Keys:</span><em>RSA-3072 / AES</em></div>
                <table><tbody id="preview-keys"></tbody></table>
              </div>

              <div class="bigtable kv-table">
                <div class="cap"><span data-i18n="web.provision.kvNamespaces">KV Namespaces:</span><em id="preview-kv-count">9</em></div>
                <table><tbody id="preview-kv"></tbody></table>
              </div>

              <div class="bigtable queues-table hidden" id="preview-queues-category">
                <div class="cap"><span data-i18n="web.provision.queues">Queues</span><em id="preview-queues-count">0</em></div>
                <table><tbody id="preview-queues"></tbody></table>
              </div>
            </div>

            <div class="alert info" id="preview-queues-disabled-note">
              <div class="a-head" data-i18n="web.provision.queues">Queues</div>
              <p data-i18n="web.provision.queuesDisabled">Cloudflare Queues is disabled, so queues will not be created.</p>
            </div>
          </div>
        </div>
        <div class="rownote" data-i18n="web.provision.durableObjectsNote">
          Durable Objects such as SessionStore and KeyManager are defined during deployment in the next step, not during resource creation.
        </div>
      </section>

      <section class="row wide">
        <div class="rowlabel">
          <h2 data-i18n="web.provision.progress">Progress</h2>
        </div>
        <div class="rowbody rowbody-tight">
          <div class="provgrid provgrid-progress-only">
            <div class="progress-side provision-progress-wide">
              <div id="provision-progress-ui" class="provision-progress-panel">
                <div class="percent"><span id="provision-percent">46</span><small>%</small></div>
                <div class="percentbar setup-progress-track" role="progressbar" aria-labelledby="provision-current-task" aria-valuemin="0" aria-valuemax="100" aria-valuenow="46">
                  <i id="provision-progress-bar" class="setup-progress-fill" style="width: 46%"></i>
                </div>
                <div class="elapsed">
                  <span id="provision-current-task" data-i18n="web.provision.runningMigrations">Running migrations</span>
                  <span id="provision-progress-text" data-i18n="web.provision.elapsedPending">Waiting for progress...</span>
                </div>
                <div class="spinner sr-control" id="provision-spinner"></div>
              </div>

              <button type="button" class="log-toggle standalone open" id="provision-log-toggle">
                <span class="arrow">▶</span>
                <span data-log-toggle-label data-i18n="web.provision.hideLog">Hide detailed log</span>
              </button>

              <div class="logbox" id="provision-log">
                <div class="cap">
                  <span data-log-toggle-label data-i18n="web.provision.detailedLog">Detailed log</span>
                  <button type="button" id="provision-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
                </div>
                <pre id="provision-output">→ <b>prod-authrim-core-db</b>
  <span class="ok">✓ created</span> (apac)
→ <b>prod-authrim-pii-db</b>
  <span class="ok">✓ created</span> (apac)
→ migrations
  0001_init.sql <span class="ok">✓</span>
  0002_clients.sql <span class="ok">✓</span>
  …
  0031_saml_metadata.sql <span class="hot">▮</span></pre>
              </div>
            </div>
          </div>

          <div id="keys-saved-info" class="cred">
            <div class="c-head" data-i18n="web.provision.keyStorageTitle">Key storage location - handle carefully</div>
            <div class="c-row">
              <span class="c-k" data-i18n="web.provision.directory">Directory</span>
              <span class="c-v" id="keys-path">.authrim-keys/prod/</span>
              <button type="button" class="copy" id="keys-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
            </div>
            <div class="c-note" data-i18n="web.provision.keyStorageNote">
              Keep this directory safe and add it to .gitignore. Private keys are also uploaded as Workers secrets, but the local copy is the only recovery source.
            </div>
          </div>

          <div class="provnote" data-i18n="web.provision.retrySafeNote">
            Already-created resources are skipped on rerun, so you can safely retry the same operation after an interruption. Save the configuration before moving to deploy.
          </div>
        </div>
      </section>

      <div class="actions setup-provision-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>07</b> / 09 — <span id="provision-status" data-i18n="web.provision.ready">Ready</span></span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-config" data-i18n="web.btn.back">Back</button>
        <button class="btn btn-next" id="btn-provision" data-i18n="web.provision.createResources">Create Resources</button>
        <button class="btn btn-ghost hidden" id="btn-save-config-provision" title="Save configuration to file" data-i18n-title="web.config.saveToFileTitle" data-i18n="web.provision.saveConfig">Save Config</button>
        <button class="btn btn-next hidden" id="btn-goto-deploy" data-i18n="web.provision.continueDeploy">Continue to Deploy →</button>
      </div>
    </div>

    <!-- Step 8: Deployment -->
    <div id="section-deploy" class="hidden setup-step-surface">
      <section class="row wide hidden" id="control-token-bootstrap-row" data-setup-progress-prelude>
        <div class="rowlabel">
          <h2 data-i18n="web.deploy.controlCredentialsTitle">Cloudflare connection</h2>
        </div>
        <div class="rowbody">
          <div class="cred">
            <div class="c-head" data-i18n="web.deploy.bootstrapTokenTitle">Temporary Cloudflare token for automatic setup</div>
            <div class="c-note" data-i18n="web.deploy.cloudflareLoginNote">Cloudflare Dashboard login is separate from Wrangler OAuth and may ask you to sign in again.</div>
            <div class="c-note" data-i18n="web.deploy.bootstrapTokenDescription">This one-time token lets Authrim set up automatic tenant database provisioning. It needs account token management permission. Setup uses it to create narrowly scoped API tokens for D1, Workers, KV, and R2, registers them with the Control Worker, and then revokes the one-time token.</div>
            <button type="button" class="btn btn-ghost sm" id="btn-create-control-bootstrap-token" data-i18n="web.deploy.createBootstrapToken">Create one-time Cloudflare token</button>
            <label class="f-label" for="control-bootstrap-token" data-i18n="web.deploy.bootstrapTokenLabel">Temporary token</label>
            <input
              class="f-input sm"
              type="password"
              id="control-bootstrap-token"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              aria-describedby="control-bootstrap-token-status"
              data-i18n-placeholder="web.deploy.bootstrapTokenPlaceholder"
            >
            <div class="f-help" id="control-bootstrap-token-status" aria-live="polite" data-i18n="web.deploy.bootstrapTokenHelp">The token is used once and revoked after split tokens are registered.</div>
          </div>
        </div>
      </section>

      <section class="row wide hidden" id="deploy-manual-wildcard-warning" data-setup-progress-prelude>
        <div class="rowlabel">
          <h2 data-i18n="web.deploy.manualDnsSectionTitle">DNS settings</h2>
        </div>
        <div class="rowbody">
          <div class="alert manual-wildcard-warning">
            <div class="a-head" id="deploy-manual-wildcard-title"></div>
            <p id="deploy-manual-wildcard-summary"></p>
            <p id="deploy-manual-wildcard-timing" class="manual-guide-timing"></p>
            <div id="deploy-manual-wildcard-steps" class="manual-guide-steps"></div>
            <div class="manual-guide-visual hidden">
              <img
                id="deploy-manual-wildcard-example-image"
                alt="Cloudflare DNS Add record example"
                src=${cloudflareDnsAddRecordImageDataUriJson}
              >
            </div>
            <p id="deploy-manual-wildcard-retry" class="manual-guide-retry"></p>
            <div class="manual-guide-actions">
              <a id="deploy-manual-wildcard-dashboard-link" class="btn btn-ghost sm hidden" target="_blank" rel="noreferrer">Open Cloudflare DNS</a>
              <a id="deploy-manual-wildcard-docs-link" class="btn btn-ghost sm" target="_blank" rel="noreferrer">Open DNS docs</a>
              <button type="button" id="deploy-manual-wildcard-recheck" class="btn btn-ghost sm">↻ <span data-i18n="web.deploy.recheckDns">Re-check DNS</span></button>
            </div>
          </div>
        </div>
      </section>

      <section class="row wide">
        <div class="rowlabel">
          <h2 data-i18n="web.deploy.progress">Progress</h2>
        </div>
        <div class="rowbody rowbody-tight">
          <div class="deploygrid deploygrid-progress-only">
            <div class="progress-side deploy-progress-wide">
              <div id="deploy-ready-text" class="deploy-ready-card" data-i18n="web.deploy.readyText">
                Ready to deploy Authrim workers to Cloudflare.
              </div>

              <div id="deploy-progress-ui" class="deploy-progress-panel hidden">
                <div class="percent"><span id="deploy-percent">0</span><small>%</small></div>
                <div class="percentbar setup-progress-track" aria-hidden="true"><i id="deploy-progress-bar" class="setup-progress-fill" style="width: 0%"></i></div>
                <div id="deploy-phase-rail" class="deploy-phase-rail" role="progressbar" aria-valuemin="1" aria-valuemax="10" aria-valuenow="1">
                  ${Array.from({ length: 10 }, (_, index) => `<span data-deploy-phase="${index + 1}" aria-hidden="true"></span>`).join('')}
                </div>
                <div class="elapsed">
                  <span id="deploy-current-task" data-i18n="web.status.initializing">Initializing...</span>
                  <span id="deploy-progress-text" data-i18n="web.deploy.elapsedPending">Waiting for progress...</span>
                  <div id="deploy-current-message-line" class="deploy-current-message running" role="status" aria-live="polite" aria-atomic="true">
                    <span id="deploy-spinner" class="ora-frame" aria-hidden="true">⠋</span>
                    <span id="deploy-current-message">Initializing...</span>
                  </div>
                </div>
                <button type="button" class="log-toggle" id="deploy-log-toggle">
                  <span class="arrow">▶</span>
                  <span data-i18n="web.provision.showLog">Show detailed log</span>
                </button>
              </div>

              <div class="logbox hidden" id="deploy-log">
                <div class="cap">
                  <span data-i18n="web.deploy.wranglerLog">wrangler log</span>
                  <button type="button" id="deploy-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
                </div>
                <div id="deploy-log-ora" class="ora-log-line">
                  <span id="deploy-log-ora-frame" class="ora-frame" aria-hidden="true">⠋</span>
                  <span id="deploy-log-ora-text">Preparing deployment...</span>
                </div>
                <pre id="deploy-output"></pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="actions setup-deploy-actions">
        <span class="progress"><span data-setup-copy="stepKicker">${setupCopy.stepKicker}</span> <b>08</b> / 09 — <span id="deploy-status">Worker <b>6</b> / 14</span></span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-provision" data-i18n="web.btn.back">Back</button>
        <button class="btn btn-next" id="btn-deploy" data-i18n="web.deploy.startDeploy">Start Deploy</button>
        <button class="btn btn-danger hidden" id="btn-cancel-deploy" data-i18n="web.deploy.cancelDeploy">Cancel Deploy</button>
        <button class="btn btn-next hidden" id="btn-goto-complete" disabled><span data-i18n="web.deploy.continueComplete">Continue to Complete</span> <span class="arr">→</span></button>
      </div>
    </div>

    <!-- Complete -->
    <div id="section-complete" class="hidden setup-step-surface">
      <div class="results">
        <div>
          <div class="bigtable">
            <div class="cap"><span data-i18n="web.complete.endpoints">Endpoints</span><em data-i18n="web.complete.verified">verified ✓</em></div>
            <table>
              <tbody id="urls"></tbody>
            </table>
          </div>
          <div id="complete-admin-setup-anchor"></div>
        </div>

      </div>

      <div class="actions setup-complete-actions">
        <span class="progress" data-i18n="web.complete.progress">Setup complete - you can close this window</span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-save-config-complete" title="Save configuration to file" data-i18n-title="web.config.saveToFileTitle" data-i18n="web.complete.saveConfig">Save Configuration</button>
        <button class="btn btn-back" id="btn-back-to-main" title="Return to main screen" data-i18n-title="web.complete.backToMainTitle" data-i18n="web.complete.backToMain">Back to Main</button>
        <button class="btn btn-next" id="btn-open-env-detail" type="button"><span data-i18n="web.complete.openEnvDetail">Open environment detail</span> <span class="arr">→</span></button>
      </div>
    </div>

    <!-- Environment Management: List -->
    <div id="section-env-list" class="hidden setup-step-surface env-management-surface">
      <div id="env-list-loading" class="logbox">
        <div class="cap"><span data-i18n="web.env.scanLog">Scan log</span><em id="env-list-status" data-i18n="web.env.loading">Loading...</em></div>
        <div class="env-loading-indicator" role="status" aria-live="polite">
          <span class="env-loading-spinner" aria-hidden="true"></span>
          <span data-i18n="web.env.scanningEnvironments">Scanning environments</span>
        </div>
        <pre id="env-scan-output"></pre>
      </div>

      <div id="env-list-content" class="hidden">
        <div id="env-cards" class="envgrid">
          <!-- Environment cards will be inserted here -->
        </div>

        <div id="no-envs-message" class="alert alert-info hidden" data-i18n="web.env.noEnvsDetected">
          No Authrim environments detected in this Cloudflare account.
        </div>
      </div>

      <div class="actions setup-env-actions">
        <span class="progress" id="env-list-progress-summary"><span data-i18n="web.env.detected">Detected</span> <b id="env-list-count">0</b> <span data-i18n="web.env.environments">environments</span></span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-env-list"><span class="setup-action-icon" aria-hidden="true">←</span><span data-i18n="web.env.start">Start</span></button>
        <button class="btn btn-ghost" id="btn-refresh-env-list"><span class="setup-action-icon" aria-hidden="true">↻</span><span data-i18n="web.env.rescan">Rescan</span></button>
      </div>
    </div>

    <!-- Environment Management: Details -->
    <div id="section-env-detail" class="hidden setup-step-surface env-management-surface">
      <nav class="tabs env-detail-tabs">
        <button type="button" class="tab on" data-env-tab="overview" data-i18n="web.envDetail.overview">Overview</button>
        <button type="button" class="tab" data-env-tab="email" data-i18n="web.envDetail.email">Email</button>
        <button type="button" class="tab" data-env-tab="storage" data-i18n="web.envDetail.storage">Storage</button>
        <button type="button" class="tab" data-env-tab="capacity" data-i18n="web.envDetail.capacityTab">D1 Capacity</button>
        <button type="button" class="tab" data-env-tab="workers"><span data-i18n="web.envDetail.workersUpdates">Workers / Updates</span> <span class="cnt" id="detail-workers-tab-count">0</span></button>
        <button type="button" class="tab" data-env-tab="migrations"><span data-i18n="web.envDetail.migrations">Migrations</span> <span class="cnt" id="detail-migrations-tab-count">0</span></button>
        <button type="button" class="tab" data-env-tab="resources"><span data-i18n="web.envDetail.resources">Resources</span> <span class="cnt" id="detail-resource-tab-count">0</span></button>
      </nav>

      <div id="pane-overview" class="tabpane on" data-env-pane="overview">
        <div class="stats">
          <div class="stat"><div class="s-k">Workers</div><div class="s-v" id="detail-stat-workers">0</div></div>
          <div class="stat"><div class="s-k">D1 / KV</div><div class="s-v"><span id="detail-stat-d1">0</span> <small>/ <span id="detail-stat-kv">0</span></small></div></div>
          <div class="stat"><div class="s-k" data-i18n="web.envDetail.updates">Updates</div><div class="s-v hot" id="detail-stat-updates">0</div></div>
          <div class="stat"><div class="s-k" data-i18n="web.loadConfig.environment">Environment</div><div class="s-v env-code" id="detail-env-name">-</div></div>
        </div>

        <div id="env-release-update" class="release-update-card hidden" aria-live="polite">
          <div class="release-update-main">
            <div>
              <div class="release-version-flow"><span id="release-current-version">—</span><span aria-hidden="true">→</span><strong id="release-target-version">—</strong></div>
              <div class="a-head" id="release-update-title" data-i18n="web.envDetail.releaseUpdateAvailable">A new Authrim version is available</div>
              <p id="release-update-message" data-i18n="web.envDetail.releaseUpdateDesc">Setup will apply required database changes when present, update the services, and verify the result. Your settings and data are preserved.</p>
            </div>
            <button type="button" class="btn btn-next" id="btn-start-release-update" aria-busy="false">
              <span class="inline-action-spinner hidden" aria-hidden="true"></span>
              <span data-release-update-label data-i18n="web.envDetail.releaseUpdateAction">Update now</span>
              <span class="arr" aria-hidden="true">→</span>
            </button>
            <button type="button" class="btn sm hidden" id="btn-start-database-only-update" aria-busy="false" data-i18n="web.envDetail.releaseUpdateDatabaseOnlyAction">Update databases only (advanced)</button>
          </div>
          <div id="release-update-progress" class="release-update-progress hidden">
            <div class="release-progress-line">
              <span id="release-update-stage" data-i18n="web.envDetail.releaseUpdatePreparing">Preparing the update...</span>
              <div class="setup-progress-track release-progress-track" role="progressbar" aria-labelledby="release-update-stage">
                <i id="release-update-progress-bar" class="setup-progress-fill indeterminate"></i>
              </div>
            </div>
            <details>
              <summary data-i18n="web.envDetail.releaseUpdateDetails">Show update details</summary>
              <pre id="release-update-log"></pre>
            </details>
          </div>
        </div>

        <div id="env-initial-deploy-recovery" class="alert warn hidden">
          <div class="a-head" data-i18n="web.envDetail.initialDeployRecoveryTitle">Initial deployment incomplete</div>
          <p id="env-initial-deploy-recovery-message" data-i18n="web.envDetail.initialDeployRecoveryDesc">The previous deployment stopped before verification. Existing resources will be reused when you resume.</p>
          <button type="button" class="btn btn-next sm" id="btn-resume-initial-deploy" aria-busy="false">
            <span class="inline-action-spinner hidden" aria-hidden="true"></span>
            <span data-resume-label data-i18n="web.envDetail.initialDeployRecoveryAction">Resume initial deployment</span>
          </button>
        </div>

        <div class="sechead"><span class="idx">URL</span><h3 data-i18n="web.complete.endpoints">Endpoints</h3></div>
        <div class="bigtable">
          <div class="cap"><span>URLs</span><em id="detail-url-deployment-status">Checking deployment status...</em></div>
          <table><tbody id="detail-url-list"></tbody></table>
        </div>

        <div id="env-control-automatic-provisioning" class="hidden">
          <div class="sechead"><span class="idx">D1</span><h3 data-i18n="web.envDetail.automaticProvisioningTitle">Automatic provisioning</h3><span class="hint" id="env-control-automatic-status" data-i18n="web.envDetail.automaticProvisioningChecking">Checking...</span></div>
          <div id="env-control-automatic-inputs" class="inline-form">
            <button type="button" class="btn btn-ghost sm" id="btn-env-create-control-bootstrap-token" data-i18n="web.envDetail.createOneTimeCloudflareToken">Create one-time Cloudflare token</button>
            <input
              class="f-input sm"
              type="password"
              id="env-control-bootstrap-token"
              autocomplete="off"
              spellcheck="false"
              aria-label="One-time Cloudflare bootstrap token"
              placeholder="One-time bootstrap token"
              data-i18n-placeholder="web.envDetail.oneTimeBootstrapTokenPlaceholder"
            >
            <button type="button" class="btn btn-next sm" id="btn-env-enable-control-automatic" data-i18n="web.envDetail.enableAutomaticProvisioning">Enable</button>
          </div>
          <div class="f-help" id="env-control-automatic-message" aria-live="polite"></div>
        </div>

        <div class="sechead"><span class="idx">ADMIN</span><h3 data-i18n="web.envDetail.adminAccount">Admin Account</h3></div>
        <div id="admin-setup-section" class="hidden alert ok">
          <div class="a-head" data-i18n="web.envDetail.adminNotConfigured">Admin Account Not Configured</div>
          <p data-i18n="web.envDetail.adminNotConfiguredDesc">Initial administrator has not been set up for this environment.</p>
          <div class="inline-actions">
            <button class="btn btn-ghost sm" id="btn-start-admin-setup" data-i18n="web.envDetail.startPasskey">Start Admin Account Setup with Passkey</button>
          </div>
          <div id="admin-setup-result" class="hidden cred">
            <div class="c-head" data-i18n="web.envDetail.setupUrlGenerated">Setup URL Generated:</div>
            <div class="c-row">
              <span class="c-k" data-i18n="web.complete.adminSetupLabel">Admin Setup</span>
              <input class="c-v f-input sm" type="text" id="admin-setup-url" readonly>
              <button class="copy" id="btn-copy-setup-url"><span data-i18n="web.envDetail.copyBtn">Copy</span></button>
            </div>
            <div class="inline-actions">
              <a id="btn-open-setup-url" href="#" target="_blank" class="btn btn-ghost sm"><span data-i18n="web.envDetail.openSetup">Open Setup</span></a>
            </div>
            <div class="c-note" data-i18n="web.envDetail.urlValidFor">This URL is valid for 1 hour. Open it in a browser to register the first admin account.</div>
          </div>
        </div>
      </div>

      <div id="pane-workers" class="tabpane" data-env-pane="workers">
        <div class="bigtable env-full-deploy-card" id="full-environment-deploy-card">
          <div class="cap">
            <span data-i18n="web.envDetail.fullDeployTitle">Deploy Entire Environment</span>
            <em data-i18n="web.envDetail.fullDeployScope">API Workers + UI Workers</em>
          </div>
          <div class="secdesc" data-i18n="web.envDetail.fullDeployDesc">
            Build and deploy all API Workers and enabled UI Workers from the current source. Existing data and settings are preserved.
          </div>
          <div class="inline-form env-full-deploy-actions">
            <button class="btn btn-next" id="btn-deploy-full-environment">
              <span data-i18n="web.envDetail.fullDeployAction">Deploy Entire Environment</span><span class="arr">→</span>
            </button>
          </div>
        </div>
        <div id="full-environment-deploy-progress" class="hidden logbox">
          <div class="cap">
            <span data-i18n="web.envDetail.fullDeployProgress">Deployment Progress</span>
            <button type="button" id="full-environment-deploy-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
          </div>
          <pre id="full-environment-deploy-log"></pre>
        </div>
        <div class="sechead">
          <span class="idx">UPDATE</span><h3 data-i18n="web.envDetail.workerUpdate">Update Workers</h3>
          <span class="hint" data-i18n="web.envDetail.workerUpdateHint">Compare deployed and local builds</span>
        </div>
        <div class="bigtable" id="worker-version-table">
          <div class="cap"><span data-i18n="web.envDetail.versionComparison">Version comparison</span><em id="update-summary">—</em></div>
          <table>
            <thead>
              <tr>
                <th data-i18n="web.envDetail.workerName">Worker</th>
                <th data-i18n="web.envDetail.deployedVersion">Deployed</th>
                <th data-i18n="web.envDetail.localVersion">Local</th>
                <th data-i18n="web.envDetail.updateStatus">Status</th>
                <th data-i18n="web.envDetail.action" style="text-align:right;">Action</th>
              </tr>
            </thead>
            <tbody id="worker-version-tbody">
              <tr><td colspan="5" data-i18n="web.status.loading">Loading...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="inline-form env-update-actions">
          <div class="env-update-options">
            <label class="switchline on">
              <input type="checkbox" id="update-only-changed" checked>
              <span class="sw"></span>
              <span class="sw-label" data-i18n="web.envDetail.updateOnlyChanged">Update only changed versions</span>
            </label>
            <label class="switchline on">
              <input type="checkbox" id="update-include-ui-workers" checked>
              <span class="sw"></span>
              <span class="sw-label" data-i18n="web.envDetail.updateIncludeUiWorkers">Update Admin UI / Login UI</span>
            </label>
          </div>
          <div class="env-update-buttons">
            <button class="btn btn-ghost" id="btn-refresh-versions"><span data-i18n="web.envDetail.refreshVersions">Refresh</span></button>
            <button class="worker-update-button" id="btn-update-workers" disabled><span data-i18n="web.envDetail.updateAllWorkers">Update All Workers</span> <span class="arr">→</span></button>
          </div>
        </div>
        <div id="worker-update-progress" class="hidden logbox">
          <div class="cap">
            <span data-i18n="web.envDetail.updateProgress">Update Progress:</span>
            <button type="button" id="worker-update-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
          </div>
          <pre id="worker-update-log"></pre>
        </div>

        <div class="sechead"><span class="idx">UI</span><h3 data-i18n="web.envDetail.uiUpdates">UI Updates</h3><span class="hint" data-i18n="web.envDetail.uiUpdatesHint">Admin UI / Login UI</span></div>
        <div class="twocol ui-update-grid" id="ui-update-section">
          <div class="bigtable ui-update-card">
            <div class="cap"><span>ADMIN UI</span><em>ar-admin-ui</em></div>
            <div class="ui-update-card-actions">
              <button class="btn btn-ghost sm" id="btn-update-admin-ui"><span data-i18n="web.envDetail.updateNow">Update</span></button>
            </div>
          </div>
          <div class="bigtable ui-update-card">
            <div class="cap"><span>LOGIN UI</span><em>ar-login-ui</em></div>
            <div class="ui-update-card-actions">
              <button class="btn btn-ghost sm" id="btn-update-login-ui"><span data-i18n="web.envDetail.updateNow">Update</span></button>
            </div>
          </div>
        </div>
        <div id="ui-update-progress" class="hidden logbox">
          <div class="cap">
            <span data-i18n="web.envDetail.updateProgress">Update Progress:</span>
            <button type="button" id="ui-update-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
          </div>
          <pre id="ui-update-log"></pre>
        </div>

        <div class="sechead">
          <span class="idx">APP</span><h3 data-i18n="web.envDetail.serviceSiteFallback">Service Site Binding</h3>
          <span class="hint" id="env-service-site-summary" data-i18n="web.envDetail.serviceSiteLoading">Loading Service Site binding status...</span>
        </div>
        <div class="secdesc" data-i18n="web.envDetail.serviceSiteFallbackDesc">
          Use this when Authrim, Admin UI, Login UI, and the service site share one domain. This screen adds the Service Binding and deploys ar-router; enable the runtime fallback later from Admin UI > Login UI.
        </div>
        <div class="twocol service-site-form">
          <label class="switchline" id="env-service-site-enabled-line">
            <input type="checkbox" id="env-service-site-enabled">
            <span class="sw"></span>
            <span class="nm">
              <span data-i18n="web.envDetail.serviceSiteEnabled">Add Service Binding</span>
              <small data-i18n="web.envDetail.serviceSiteEnabledHint">Adds the configured Worker as a Service Binding on ar-router. Runtime fallback remains controlled by Admin UI settings.</small>
            </span>
          </label>
          <div>
            <label class="f-label" for="env-service-site-worker-name" data-i18n="web.envDetail.serviceSiteWorkerName">Service Worker name</label>
            <input class="f-input sm" type="text" id="env-service-site-worker-name" placeholder="customer-service-site" autocomplete="off" spellcheck="false">
          </div>
          <div>
            <label class="f-label" for="env-service-site-binding" data-i18n="web.envDetail.serviceSiteBinding">Binding name</label>
            <input class="f-input sm" type="text" id="env-service-site-binding" value="SERVICE_SITE" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="inline-form service-site-actions">
          <button class="btn btn-next" id="btn-save-service-site"><span data-i18n="web.envDetail.serviceSiteSaveDeploy">Save and Deploy Router</span> <span class="arr">→</span></button>
          <button class="btn btn-ghost" id="btn-refresh-service-site" data-i18n="web.envDetail.refreshVersions">Refresh</button>
        </div>
        <div class="secdesc">
          <strong data-i18n="web.envDetail.appLoginGuideTitle">App Login next steps</strong><br>
          <span data-i18n="web.envDetail.appLoginGuideDesc">To send direct Login UI sign-ins into your service app, register the service as an OIDC Client in Admin UI, enable First Party App and App Login on that Client, then select App Login in Admin UI &gt; Login UI post-login settings.</span>
          <a href="/admin/login-ui#post-login" target="_blank" rel="noopener noreferrer" data-i18n="web.envDetail.appLoginGuideLink">Open Admin UI Login UI settings</a>
        </div>
        <div id="env-service-site-progress" class="hidden logbox"><div class="cap"><span data-i18n="web.envDetail.serviceSiteProgress">Service Site Progress</span></div><pre id="env-service-site-log"></pre></div>
      </div>

      <div id="pane-storage" class="tabpane" data-env-pane="storage">
        <div id="env-r2-provision-section">
          <div class="sechead"><span class="idx">R2</span><h3 data-i18n="web.envDetail.dedicatedR2Buckets">Dedicated R2 Buckets</h3><span class="hint" id="env-r2-provision-summary" data-i18n="web.envDetail.loadingR2Status">Loading R2 bucket status...</span></div>
          <div class="secdesc" data-i18n="web.envDetail.r2ProvisionDesc">Create Authrim R2 buckets, record lock bindings, enable the R2 feature flag, and redeploy workers.</div>
          <div id="env-r2-provision-actions" class="inline-form">
            <button class="btn btn-next" id="btn-provision-r2-buckets"><span data-i18n="web.envDetail.provisionR2Deploy">Provision R2 and Deploy</span> <span class="arr">→</span></button>
            <button class="btn btn-ghost" id="btn-refresh-r2-buckets" data-i18n="web.envDetail.refreshVersions">Refresh</button>
          </div>
          <div id="env-r2-provision-progress" class="hidden logbox"><div class="cap"><span data-i18n="web.envDetail.r2ProvisioningProgress">R2 Provisioning Progress</span></div><pre id="env-r2-provision-log"></pre></div>
        </div>
      </div>

      <div id="pane-capacity" class="tabpane" data-env-pane="capacity">
        <div class="sechead">
          <span class="idx">D1</span><h3 data-i18n="web.envDetail.capacityTitle">Control Plane Capacity</h3>
          <span class="hint" data-i18n="web.envDetail.capacityHint">Server-owned placement plan</span>
        </div>
        <div class="twocol">
          <div>
            <label class="f-label" for="control-capacity-scope" data-i18n="web.envDetail.capacityScope">Scope</label>
            <select class="f-input sm" id="control-capacity-scope">
              <option value="shared_pool" data-i18n="web.envDetail.capacityShared">Shared pool</option>
              <option value="tenant_exclusive" data-i18n="web.envDetail.capacityDedicated">Dedicated tenant</option>
            </select>
          </div>
          <div id="control-capacity-tenant-field" class="hidden">
            <label class="f-label" for="control-capacity-tenant" data-i18n="web.envDetail.capacityTenant">Tenant</label>
            <select class="f-input sm" id="control-capacity-tenant"></select>
          </div>
          <div>
            <label class="f-label" for="control-capacity-profile" data-i18n="web.envDetail.capacityProfile">Capacity profile</label>
            <select class="f-input sm" id="control-capacity-profile">
              <option value="minimum" data-i18n="web.envDetail.capacityMinimum">Minimum</option>
              <option value="recommended" selected data-i18n="web.envDetail.capacityRecommended">Recommended</option>
              <option value="extra_headroom" data-i18n="web.envDetail.capacityExtra">Extra headroom</option>
            </select>
          </div>
        </div>
        <div class="inline-form">
          <button type="button" class="btn btn-ghost" id="btn-control-capacity-preview" data-i18n="web.envDetail.capacityPreview">Preview</button>
          <button type="button" class="btn btn-next" id="btn-control-capacity-request" disabled><span data-i18n="web.envDetail.capacityAdd">Add capacity</span> <span class="arr">→</span></button>
        </div>
        <div id="control-capacity-result" class="bigtable hidden" aria-live="polite">
          <div class="cap"><span data-i18n="web.envDetail.capacityPlan">Capacity plan</span><em id="control-capacity-summary"></em></div>
          <table><tbody id="control-capacity-targets"></tbody></table>
        </div>
        <p id="control-capacity-status" aria-live="polite"></p>
      </div>

      <div id="pane-migrations" class="tabpane" data-env-pane="migrations">
        <div class="sechead">
          <span class="idx">D1</span><h3 data-i18n="web.envDetail.migrationTitle">Database Migrations</h3>
          <span class="hint" id="env-migration-summary" data-i18n="web.envDetail.migrationLoading">Loading migration status...</span>
        </div>
        <div class="stats migration-stats">
          <div class="stat"><div class="s-k" data-i18n="web.envDetail.migrationApplied">Applied</div><div class="s-v" id="migration-stat-applied">0</div></div>
          <div class="stat"><div class="s-k" data-i18n="web.envDetail.migrationPending">Pending</div><div class="s-v hot" id="migration-stat-pending">0</div></div>
          <div class="stat"><div class="s-k" data-i18n="web.envDetail.migrationChanged">Changed</div><div class="s-v hot" id="migration-stat-changed">0</div></div>
          <div class="stat"><div class="s-k" data-i18n="web.envDetail.migrationOrphaned">Orphaned</div><div class="s-v" id="migration-stat-orphaned">0</div></div>
        </div>
        <div id="migration-status-list" class="migration-status-list"></div>
        <div class="inline-form env-migration-actions">
          <button class="btn btn-ghost" id="btn-refresh-migrations" data-i18n="web.envDetail.migrationRefresh">Refresh</button>
          <button class="btn btn-next" id="btn-apply-all-migrations" disabled><span data-i18n="web.envDetail.migrationApplyAllPending">Apply All Pending</span> <span class="arr">→</span></button>
        </div>
        <div id="migration-progress" class="hidden logbox"><div class="cap"><span data-i18n="web.envDetail.migrationProgress">Migration Progress:</span></div><pre id="migration-log"></pre></div>
      </div>

      <div id="pane-email" class="tabpane" data-env-pane="email">
        <div id="env-email-section">
          <div class="sechead"><span class="idx">EMAIL</span><h3 data-i18n="web.envDetail.emailSettings">Email Settings</h3><span class="hint" data-i18n="web.envDetail.emailDesc">Enable Cloudflare Email Service later for this environment.</span></div>
          <div class="stats email-stats">
            <div class="stat"><div class="s-k" data-i18n="web.envDetail.emailCurrentProvider">Current Provider</div><div class="s-v compact" id="env-email-provider">-</div></div>
            <div class="stat"><div class="s-k" data-i18n="web.envDetail.emailCurrentStatus">Status</div><div class="s-v compact" id="env-email-status">-</div></div>
            <div class="stat"><div class="s-k" data-i18n="web.envDetail.emailCurrentFrom">From Address</div><div class="s-v mono-compact" id="env-email-from">-</div></div>
          </div>
          <div class="twocol">
            <div>
              <label class="f-label" for="env-email-from-address" data-i18n="web.envDetail.emailFromAddress">From Email Address</label>
              <input class="f-input sm" type="email" id="env-email-from-address" placeholder="noreply@yourdomain.com" autocomplete="off">
              <div class="f-help email-from-help">
                <div><span data-i18n="web.envDetail.emailCloudflareFromHint">When using Cloudflare Email Service, the address must belong to an onboarded domain.</span> <a href="https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting" target="_blank" rel="noopener noreferrer" data-i18n="web.envDetail.emailCloudflareSettingsLink">Cloudflare Email Routing settings</a></div>
                <div><span data-i18n="web.envDetail.emailResendFromHint">When using Resend, the domain must be added to Resend.</span> <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" data-i18n="web.envDetail.emailResendDomainsLink">Resend Domains</a></div>
              </div>
            </div>
            <div><label class="f-label" for="env-email-from-name" data-i18n="web.envDetail.emailFromName">From Display Name (optional)</label><input class="f-input sm" type="text" id="env-email-from-name" placeholder="Authrim" autocomplete="off"></div>
          </div>
          <div class="email-provider-update-grid">
            <div class="bigtable email-provider-card">
              <div class="cap"><span>Cloudflare</span><em>Email Service</em></div>
              <div class="email-provider-card-body">
                <div class="alert"><div class="a-head" data-i18n="web.envDetail.emailCloudflareRequirements">Requirements</div><ul><li data-i18n="web.envDetail.emailCloudflareRequirementPaid">Workers Paid Plan is required</li><li data-i18n="web.envDetail.emailCloudflareRequirementDns">Cloudflare DNS/domain onboarding is required</li><li data-i18n="web.envDetail.emailCloudflareRequirementManual">Domain setup in the Cloudflare dashboard is still manual</li></ul></div>
                <div class="inline-actions"><button class="btn btn-next" id="btn-enable-cloudflare-email"><span data-i18n="web.envDetail.emailEnableCloudflare">Enable Cloudflare Email Service</span> <span class="arr">→</span></button></div>
              </div>
            </div>
            <div class="bigtable email-provider-card">
              <div class="cap"><span>Resend</span><em>API</em></div>
              <div class="email-provider-card-body">
                <label class="f-label" for="env-email-resend-api-key" data-i18n="web.email.resendApiKey">Resend API Key</label>
                <input class="f-input sm" type="password" id="env-email-resend-api-key" placeholder="re_xxxxxxxxxx" autocomplete="off" spellcheck="false">
                <div class="f-help" data-i18n="web.email.resendApiKeyHint">Your API key starts with "re_"</div>
                <div class="inline-actions"><button class="btn btn-next" id="btn-enable-resend-email"><span data-i18n="web.email.configureResend">Resend</span> <span class="arr">→</span></button></div>
              </div>
            </div>
          </div>
          <div id="env-email-progress" class="hidden logbox"><div class="cap"><span data-i18n="web.envDetail.emailProgress">Email Setup Progress:</span></div><pre id="env-email-log"></pre></div>
        </div>
      </div>

      <div id="pane-resources" class="tabpane" data-env-pane="resources">
        <div id="detail-resources" class="twocol">
          <div>
            <div class="bigtable"><div class="cap"><span data-i18n="web.envDetail.workers">Workers</span><em id="detail-workers-count">(0)</em></div><table><tbody id="detail-workers-list"></tbody></table></div>
            <div class="bigtable resource-table"><div class="cap"><span data-i18n="web.envDetail.d1Databases">D1 Databases</span><em id="detail-d1-count">(0)</em></div><table><tbody id="detail-d1-list"></tbody></table></div>
            <div class="bigtable resource-table" id="detail-queues-section"><div class="cap"><span data-i18n="web.envDetail.queues">Queues</span><em id="detail-queues-count">(0)</em></div><table><tbody id="detail-queues-list"></tbody></table></div>
          </div>
          <div>
            <div class="bigtable"><div class="cap"><span data-i18n="web.envDetail.kvNamespaces">KV Namespaces</span><em id="detail-kv-count">(0)</em></div><table><tbody id="detail-kv-list"></tbody></table></div>
            <div class="bigtable resource-table" id="detail-r2-section"><div class="cap"><span data-i18n="web.envDetail.r2Buckets">R2 Buckets</span><em id="detail-r2-count">(0)</em></div><table><tbody id="detail-r2-list"></tbody></table></div>
            <div class="bigtable resource-table" id="detail-pages-section"><div class="cap"><span data-i18n="web.envDetail.pagesProjects">Legacy Pages Projects</span><em id="detail-pages-count">(0)</em></div><table><tbody id="detail-pages-list"></tbody></table></div>
          </div>
        </div>
      </div>

      <div class="actions setup-env-actions">
        <span class="progress"><span data-i18n="web.loadConfig.environment">Environment</span> <b id="detail-env-progress-name">-</b></span>
        <span class="spacer"></span>
        <button class="btn-secondary" id="btn-back-env-detail" data-i18n="web.env.backToList">← Back to List</button>
        <button class="btn-danger" id="btn-delete-from-detail"><span data-i18n="web.env.deleteEnv">Delete Environment...</span></button>
      </div>
    </div>

    <!-- Environment Management: Delete Confirmation -->
    <div id="section-env-delete" class="hidden setup-step-surface env-management-surface">
      <section class="row delete-row">
        <div class="rowlabel">
          <h2 data-i18n="web.delete.selectResourcesTitle">Select Resources to Delete</h2>
        </div>
        <div class="rowbody">
          <div id="delete-options-section">
            <div class="danger-frame">
              <div class="cap"><span data-i18n="web.delete.targetResources">Target Resources</span> — <span id="delete-env-name"></span></div>
              <label class="delitem delete-option">
                <input type="checkbox" id="delete-workers" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.workers">Workers</span><small data-i18n="web.delete.workersDesc">Router, API, and UI Workers</small></span>
                <span class="cnt" id="delete-workers-count">(0 workers)</span>
              </label>
              <label class="delitem delete-option">
                <input type="checkbox" id="delete-d1" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.d1Databases">D1 Databases</span><small data-i18n="web.delete.d1Desc">core / pii / admin, including user data</small></span>
                <span class="cnt" id="delete-d1-count">(0 databases)</span>
              </label>
              <label class="delitem delete-option">
                <input type="checkbox" id="delete-kv" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.kvNamespaces">KV Namespaces</span><small data-i18n="web.delete.kvDesc">Settings, caches, and runtime registry</small></span>
                <span class="cnt" id="delete-kv-count">(0 namespaces)</span>
              </label>
              <label class="delitem delete-option" id="delete-queues-option">
                <input type="checkbox" id="delete-queues" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.queues">Queues</span><small data-i18n="web.delete.queuesDesc">Async audit and delivery queues</small></span>
                <span class="cnt" id="delete-queues-count">(0 queues)</span>
              </label>
              <label class="delitem delete-option" id="delete-r2-option">
                <input type="checkbox" id="delete-r2" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.r2Buckets">R2 Buckets</span><small data-i18n="web.delete.r2Desc">Dedicated storage buckets</small></span>
                <span class="cnt" id="delete-r2-count">(0 buckets)</span>
              </label>
              <label class="delitem delete-option" id="delete-pages-option">
                <input type="checkbox" id="delete-pages" checked>
                <span class="sq" aria-hidden="true"></span>
                <span class="nm"><span data-i18n="web.delete.pagesProjects">Legacy Pages Projects</span><small data-i18n="web.delete.pagesDesc">Legacy Pages projects</small></span>
                <span class="cnt" id="delete-pages-count">(0 projects)</span>
              </label>
            </div>
          </div>

          <div class="alert danger-alert">
            <div class="a-head" data-i18n="web.delete.finalConfirmation">Final Confirmation</div>
            <p id="delete-confirm-copy"><span data-i18n="web.delete.warning">The selected resources will be deleted from this environment.</span></p>
            <div class="delete-confirm-input-wrap">
              <input class="f-input sm" id="delete-confirm-input" type="text" autocomplete="off">
            </div>
          </div>
        </div>
        <div class="rownote" data-i18n="web.delete.dnsNote">
          Custom domain DNS records are not deleted automatically. Remove them manually in Cloudflare if they are no longer needed.
        </div>
      </section>

      <!-- Progress UI (shown during deletion) -->
      <div id="delete-progress-ui" class="progress-container hidden">
        <div class="progress-status">
          <div class="spinner" id="delete-spinner"></div>
          <span id="delete-current-task" data-i18n="web.provision.initializing">Initializing...</span>
        </div>
        <div class="progress-bar-wrapper setup-progress-track" role="progressbar" aria-labelledby="delete-current-task" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="delete-progress-bar" class="progress-bar setup-progress-fill" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="delete-progress-text" data-i18n="web.status.resourceProgress" data-i18n-params='{"current":0,"total":0}'>0 / 0 resources</div>

        <div class="log-toggle" id="delete-log-toggle">
          <span class="arrow">▶</span>
          <span data-i18n="web.provision.showLog">Show detailed log</span>
        </div>
      </div>

      <div class="logbox hidden" id="delete-log">
        <div class="cap">
          <span data-i18n="web.delete.deleteLog">Delete log</span>
          <button type="button" id="delete-log-copy-btn"><span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span></button>
        </div>
        <pre id="delete-output"></pre>
      </div>

      <div id="delete-result" class="hidden"></div>

      <div class="actions setup-env-actions">
        <span class="progress" id="delete-progress-summary"><span data-i18n="web.delete.deleteTarget">Delete target</span> <b id="delete-total-count">0</b> <span data-i18n="web.delete.resourcesLabel">resources</span></span>
        <span class="spacer"></span>
        <button class="btn btn-back" id="btn-back-env-delete">← <span id="delete-back-label" data-i18n="common.cancel">Cancel</span></button>
        <button class="btn-danger-solid" id="btn-confirm-delete" disabled><span data-i18n="web.delete.deletePermanently">Delete permanently</span></button>
      </div>
    </div>

    <footer class="colophon">
      <span>AUTHRIM — IDENTITY &amp; ACCESS PLATFORM</span>
      <span><span data-i18n="web.common.setupTool">Setup Tool</span> v${escapeTemplateHtml(setupVersion)}</span>
    </footer>
  </div>

  <!-- Save Config Modal -->
  <div id="save-config-modal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h3 style="margin: 0 0 1rem 0;"><span data-i18n="web.modal.saveTitle">Save Configuration?</span></h3>
      <p style="color: var(--text-muted); margin-bottom: 1.5rem;" data-i18n="web.modal.saveQuestion">
        Would you like to save your configuration to a file before proceeding?
      </p>
      <p style="color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.9rem;" data-i18n="web.modal.saveReason">
        This allows you to resume setup later or use the same settings for another deployment.
      </p>
      <div class="button-group" style="justify-content: flex-end;">
        <button class="btn-secondary" id="modal-skip-save" data-i18n="web.modal.skipBtn">Skip</button>
        <button class="btn-primary" id="modal-save-config" data-i18n="web.modal.saveBtn">Save Configuration</button>
      </div>
    </div>
  </div>

  <script>
    // ========================================
    // THEME MANAGEMENT
    // ========================================
    let themeTransitionCleanupTimer = null;

    function initTheme() {
      const savedTheme = localStorage.getItem('authrim-theme');
      const theme = savedTheme || 'light';
      document.documentElement.setAttribute('data-theme', theme);
      updateThemeToggle(theme);
    }

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      runThemeTransition(newTheme);
    }

    function runThemeTransition(newTheme) {
      const root = document.documentElement;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const applyTheme = () => {
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('authrim-theme', newTheme);
        updateThemeToggle(newTheme);
      };

      if (themeTransitionCleanupTimer) window.clearTimeout(themeTransitionCleanupTimer);
      root.classList.remove(
        'theme-transitioning',
        'theme-transition-to-dark',
        'theme-transition-to-light'
      );
      if (reduceMotion) {
        applyTheme();
        return;
      }

      void root.offsetWidth;
      root.classList.add(
        'theme-transitioning',
        newTheme === 'dark' ? 'theme-transition-to-dark' : 'theme-transition-to-light'
      );
      window.requestAnimationFrame(applyTheme);
      themeTransitionCleanupTimer = window.setTimeout(() => {
        root.classList.remove(
          'theme-transitioning',
          'theme-transition-to-dark',
          'theme-transition-to-light'
        );
        themeTransitionCleanupTimer = null;
      }, 2460);
    }

    function updateThemeToggle(theme) {
      const toggle = document.getElementById('theme-toggle');
      if (toggle) {
        toggle.textContent = '◐ ' + t('setup.start.theme');
        toggle.setAttribute(
          'aria-label',
          theme === 'dark' ? t('web.theme.switchLight') : t('web.theme.switchDark')
        );
      }
    }

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!localStorage.getItem('authrim-theme')) {
        const theme = 'light';
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeToggle(theme);
      }
    });

    // Initialize theme immediately
    initTheme();

    // Theme toggle event
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // ========================================
    // SPLASH SCREEN
    // ========================================
    function hideSplash() {
      const splash = document.getElementById('splash');
      if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => {
          splash.style.display = 'none';
        }, 600);
      }
    }

    // Hide splash after 2500ms
    setTimeout(hideSplash, 2500);

    // ========================================
    // MAIN APPLICATION
    // ========================================
    // Session token for API authentication (embedded by server)
    const SESSION_TOKEN = '${safeToken}';
    const CONTROL_OPERATION_RESULT_TRANSLATION_KEYS = ${controlOperationResultTranslationKeysJson};
    const MANAGE_ONLY = ${manageOnlyFlag};

    // State
    let currentStep = 1;
    let config = {};
    let loadedConfig = null;
    let lastLoadedConfigSummary = null;
    let lastLoadedConfigSummaryValid = false;
    let provisioningCompleted = false;
    let provisionPollInterval = null;
    let lastPrerequisitesResult = null;

    function buildProfilesConfig() {
      return {
        defaults: {
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:default',
        },
        registry: {
          backend: 'kv',
        },
        references: {
          hyperdrive: {},
        },
        seed: {
          audit: [],
          residency: [],
        },
      };
    }

    let resumeControlBootstrapReady = false;
    let resumeWorkerOwnershipRecovery = false;

    function automaticProvisioningEnabled() {
      return document.querySelector('input[name="automatic-provisioning"]:checked')?.value !== 'off';
    }

    function setAutomaticProvisioningEnabled(enabled) {
      document.querySelectorAll('input[name="automatic-provisioning"]').forEach((input) => {
        input.checked = input.value === (enabled ? 'on' : 'off');
      });
      syncAutomaticProvisioningUi();
    }

    function syncAutomaticProvisioningUi() {
      document
        .getElementById('control-token-bootstrap-row')
        ?.classList.toggle(
          'hidden',
          !automaticProvisioningEnabled() || resumeControlBootstrapReady
        );
    }
    document.querySelectorAll('input[name="automatic-provisioning"]').forEach((input) => {
      input.addEventListener('change', syncAutomaticProvisioningUi);
    });
    syncAutomaticProvisioningUi();

    function getConfiguredWorkerCount() {
      const apiWorkers = ${WORKER_COMPONENTS.length};
      const loginUi = config?.components?.loginUi !== false ? 1 : 0;
      const adminUi = config?.components?.adminUi !== false ? 1 : 0;
      return apiWorkers + loginUi + adminUi;
    }

    const deployedWorkerNames = new Set();

    function updateDeployedWorkerCount(messages) {
      for (const message of Array.isArray(messages) ? messages : []) {
        const apiMatch = message.match(
          /(?:^|\\s)✓\\s+([a-z0-9-]+-ar-[a-z0-9-]+)\\s+(?:re)?deployed successfully\\b/iu
        );
        const uiMatch = message.match(
          /(?:^|\\s)✓\\s+(ar-(?:admin|login)-ui)\\s+deployed as UI Worker:/iu
        );
        const workerName = apiMatch?.[1] || uiMatch?.[1];
        if (workerName) deployedWorkerNames.add(workerName);
      }

      const status = document.getElementById('deploy-status');
      if (!status) return;
      status.innerHTML =
        escapeHtml(t('web.envDetail.workers')) +
        ' <b>' +
        deployedWorkerNames.size +
        '</b> / ' +
        getConfiguredWorkerCount();
    }

    function getCompleteWorkerSummary() {
      const api = lastCompleteResult?.summary || {};
      const ui = lastCompleteResult?.uiWorkersResult || {};
      const hasApiSummary = Number.isFinite(Number(api.totalComponents)) && Number(api.totalComponents) > 0;
      const hasUiSummary =
        (Number.isFinite(Number(ui.totalComponents)) && Number(ui.totalComponents) > 0) ||
        (Array.isArray(ui.results) && ui.results.length > 0);
      const apiTotal = Number(api.totalComponents || 0);
      const apiSuccess = Number(api.successCount || 0);
      const apiFailed = Number(api.failedCount || 0);
      const uiTotal = Number(ui.totalComponents || ui.results?.length || 0);
      const uiSuccess = Number(ui.successCount || 0);
      const uiFailed = Number(ui.failedCount || 0);
      const hasDeploySummary = hasApiSummary || hasUiSummary;
      const total = hasDeploySummary ? apiTotal + uiTotal : getConfiguredWorkerCount();
      const success = hasDeploySummary ? apiSuccess + uiSuccess : 0;
      const failed = apiFailed + uiFailed;
      return { total, success, failed, hasDeploySummary };
    }

    function getCompleteD1Count() {
      const baseCount = ${D1_DATABASES.length};
      return baseCount + 3;
    }

    function getCompleteKvCount() {
      return ${KV_NAMESPACES.length};
    }

    function getCompleteHeroAside() {
      const workers = getCompleteWorkerSummary();
      const d1Count = getCompleteD1Count();
      const kvCount = getCompleteKvCount();
      const workerLabel = t('web.envDetail.workers');
      const completeLabel = t('web.status.complete').replace(/\\.\\.\\.$/, '');
      const failedLabel = t('web.status.failed').replace(/\\.\\.\\.$/, '');

      if (!workers.hasDeploySummary) {
        return workerLabel + ' ' + workers.total + ' · D1 ' + d1Count + ' · KV ' + kvCount;
      }

      if (workers.failed > 0) {
        return (
          workerLabel +
          ' ' +
          workers.success +
          ' / ' +
          workers.total +
          ' · ' +
          failedLabel +
          ' ' +
          workers.failed +
          ' · D1 ' +
          d1Count +
          ' · KV ' +
          kvCount
        );
      }

      return (
        workerLabel +
        ' ' +
        workers.success +
        ' / ' +
        workers.total +
        ' · D1 ' +
        d1Count +
        ' · KV ' +
        kvCount +
        ' · ' +
        completeLabel
      );
    }

    // Elements
    const steps = {
      1: document.getElementById('step-1'),
      2: document.getElementById('step-2'),
      3: document.getElementById('step-3'),
      4: document.getElementById('step-4'),
      5: document.getElementById('step-5'),
      6: document.getElementById('step-6'),
      7: document.getElementById('step-7'),
      8: document.getElementById('step-8'),
      9: document.getElementById('step-9'),
    };
    function getSetupStepCopy(step) {
      const copy = getSetupUiRuntimeCopy();

      const index = Math.max(1, Math.min(9, step)) - 1;
      const translatedPrereqTitle = t('web.prereq.title');
      const envForHero = config?.env || 'prod';
      const aside =
        step === 9
          ? getCompleteHeroAside()
          : copy.stepAsides?.[index] || getSetupUiRuntimeCopy('en').stepAsides[index] || '';
      const title =
        step === 8
          ? copy.stepTitles[7].replace('{env}', envForHero)
          : step === 9
            ? copy.stepTitles[8].replace('{env}', envForHero)
          : step === 1
            ? translatedPrereqTitle
            : copy.stepTitles[index];
      return {
        label: step === 1 ? translatedPrereqTitle : copy.stepLabels[index],
        title,
        aside,
        kicker:
          copy.stepKicker +
          ' ' +
          String(step).padStart(2, '0') +
          ' / 09' +
          (step === 7 || step === 8
              ? ' — ' + t('web.status.running').replace(/\\.\\.\\.$/, '')
              : ''),
      };
    }

    const sections = {
      prerequisites: document.getElementById('section-prerequisites'),
      topMenu: document.getElementById('section-top-menu'),
      loadConfig: document.getElementById('section-load-config'),
      config: document.getElementById('section-config'),
      domain: document.getElementById('section-domain'),
      database: document.getElementById('section-database'),
      email: document.getElementById('section-email'),
      provision: document.getElementById('section-provision'),
      deploy: document.getElementById('section-deploy'),
      complete: document.getElementById('section-complete'),
      envList: document.getElementById('section-env-list'),
      envDetail: document.getElementById('section-env-detail'),
      envDelete: document.getElementById('section-env-delete'),
    };

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    // Environment management state
    let detectedEnvironments = [];
    let pendingControlOperations = [];
    let pendingControlPollTimer = null;
    let selectedEnvForDetail = null;
    let selectedEnvDetailConfig = null;
    let selectedEnvRecoveryStatus = null;
    let envControlBootstrapOwnership = null;
    let envControlBootstrapPhase = 'unknown';
    let controlCapacityPreview = null;
    let selectedEnvForDelete = null;
    let envCardRenderGeneration = 0;
    let environmentScanState = 'idle';
    let environmentScanGeneration = 0;
    let migrationStatusLoadGeneration = 0;
    let migrationApplyInProgress = false;
    let inFlightMutationRequests = 0;
    let workingDirectory = '';
    let workersSubdomain = ''; // e.g., 'sgrastar' for {worker}.sgrastar.workers.dev

    // API helpers (with session token authentication)
    async function api(endpoint, options = {}) {
      const { headers: customHeaders, body, ...restOptions } = options;
      const method = String(restOptions.method || 'GET').toUpperCase();
      const isMutation = method !== 'GET' && method !== 'HEAD';
      if (isMutation) inFlightMutationRequests += 1;
      try {
        const response = await fetch('/api' + endpoint, {
          ...restOptions,
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': SESSION_TOKEN,
            ...(customHeaders || {}),
          },
          body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        });
        const result = await response.json();
        if (result?.errorCode === 'setup_operation_in_progress') {
          result.error = t('web.status.operationInProgress');
        }
        if (result?.errorCode === 'environment_inventory_unavailable') {
          result.error = t('web.delete.inventoryUnavailable');
          result.errors = [result.error];
        }
        if (result?.errorCode === 'r2_legacy_ownership_requires_explicit_adoption') {
          result.error = t('web.envDetail.r2OwnershipRecoverySummary', {
            count: Array.isArray(result.bindings) ? result.bindings.length : 0,
            command: result.requiredCommand || '',
          });
        }
        if (result?.errorCode === 'r2_legacy_ownership_requires_environment_recreation') {
          result.error = t('web.envDetail.r2OwnershipRecreateSummary', {
            count: Array.isArray(result.bindings) ? result.bindings.length : 0,
          });
        }
        return result;
      } finally {
        if (isMutation) inFlightMutationRequests = Math.max(0, inFlightMutationRequests - 1);
      }
    }

    function apiErrorMessages(result) {
      const messages = Array.isArray(result?.errors)
        ? result.errors.filter(message => typeof message === 'string' && message.trim())
        : [];
      const summary = typeof result?.error === 'string' ? result.error.trim() : '';
      if (summary && !messages.includes(summary) && summary !== messages.join(', ')) {
        messages.push(summary);
      }
      return messages.length > 0 ? messages : [t('web.status.unknownError')];
    }

    const WILDCARD_DNS_MANUAL_COPY_DATA = ${wildcardDnsManualCopyJson};

    function getWildcardDnsManualCopy() {
      const locale = String(_currentLocale || 'en');
      return (
        WILDCARD_DNS_MANUAL_COPY_DATA[locale] ||
        WILDCARD_DNS_MANUAL_COPY_DATA[locale.split('-')[0]] ||
        WILDCARD_DNS_MANUAL_COPY_DATA.en
      );
    }

    function buildWildcardDnsManualMessage(baseDomain, includeConfirmSuffix = false) {
      const copy = getWildcardDnsManualCopy();
      const recordName = '*.' + baseDomain;
      const zoneName = getManualWildcardDnsZoneName(baseDomain);
      const dashboardRecordName = getManualWildcardDnsRecordName(baseDomain, zoneName);
      const summary = copy.summaryTemplate.replaceAll('{baseDomain}', baseDomain);
      const steps = copy.stepsTemplate.map((step) =>
        step
          .replaceAll('*.{baseDomain}', recordName)
          .replaceAll('{baseDomain}', baseDomain)
          .replaceAll('{zoneName}', zoneName)
          .replaceAll('{dashboardRecordName}', dashboardRecordName)
      );
      const lines = [
        copy.title,
        copy.timing,
        '',
        ...steps.map((step, index) => (index + 1) + '. ' + step),
        '',
        copy.retryHint,
        copy.continueHint,
      ];

      if (summary) {
        lines.splice(1, 0, summary);
      }

      if (includeConfirmSuffix) {
        lines.push('', copy.confirmSuffix);
      }

      return lines.join('\\n');
    }

    function getManualWildcardDnsBaseDomain() {
      if (config?.manualAction?.kind === 'wildcard-dns' && config.manualAction.baseDomain) {
        return config.manualAction.baseDomain;
      }
      return config?.tenant?.multiTenant === true ? config.tenant.baseDomain : '';
    }

    function getManualWildcardDnsZoneName(domain) {
      const normalized = String(domain || '').trim().toLowerCase();
      if (!normalized) return '';
      const parts = normalized.split('.').filter(Boolean);
      const twoPartTlds = new Set([
        'co.uk',
        'org.uk',
        'gov.uk',
        'ac.uk',
        'co.jp',
        'or.jp',
        'ne.jp',
        'co.nz',
        'org.nz',
        'net.nz',
        'co.kr',
        'or.kr',
        'ne.kr',
        'co.in',
        'firm.in',
        'net.in',
        'org.in',
        'gen.in',
        'co.id',
        'web.id',
        'ac.id',
        'or.id',
        'co.za',
        'org.za',
        'net.za',
        'com.au',
        'net.au',
        'org.au',
        'com.br',
        'net.br',
        'org.br',
      ]);
      const lastTwo = parts.slice(-2).join('.');
      if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
      return parts.length >= 2 ? parts.slice(-2).join('.') : normalized;
    }

    function getManualWildcardDnsRecordName(baseDomain, zoneName) {
      if (baseDomain === zoneName) {
        return '*';
      }

      const suffix = '.' + zoneName;
      if (baseDomain.endsWith(suffix)) {
        return '*.' + baseDomain.slice(0, -suffix.length);
      }

      return '*.' + baseDomain;
    }

    function getManualWildcardDnsDashboardUrl() {
      const accountId = lastPrerequisitesResult?.auth?.accountId || null;
      const baseDomain = getManualWildcardDnsBaseDomain();
      return ${getCloudflareDnsRecordsDashboardUrl.toString()}(accountId, baseDomain);
    }

    function shouldPromptManualWildcardDnsBeforeDeploy() {
      const baseDomain = getManualWildcardDnsBaseDomain();
      if (config?.manualAction?.kind === 'wildcard-dns' && config.manualAction.baseDomain) {
        return true;
      }
      const status = lastPrerequisitesResult?.capabilityStatuses?.multiTenant;
      return !!baseDomain && status && status !== 'ok';
    }

    function renderDeployManualWildcardWarning() {
      const warning = document.getElementById('deploy-manual-wildcard-warning');
      const baseDomain = getManualWildcardDnsBaseDomain();

      if (!shouldPromptManualWildcardDnsBeforeDeploy()) {
        warning.classList.add('hidden');
        return;
      }

      const copy = getWildcardDnsManualCopy();
      const recordName = '*.' + baseDomain;
      const zoneName = getManualWildcardDnsZoneName(baseDomain);
      const dashboardRecordName = getManualWildcardDnsRecordName(baseDomain, zoneName);
      const dashboardUrl = getManualWildcardDnsDashboardUrl();
      // The canonical manual action aliases the wildcard to the API base custom domain. Do not
      // show the router workers.dev hostname here: that disagrees with deploy/CLI validation and
      // can leave the operator with a record the retry path will reject.
      const target = config?.manualAction?.target || baseDomain;
      document.getElementById('deploy-manual-wildcard-title').textContent =
        t('web.deploy.manualWildcardTitle') || copy.title;
      const summaryEl = document.getElementById('deploy-manual-wildcard-summary');
      summaryEl.innerHTML = t('web.deploy.manualWildcardSummary', {
        zone: '<b>' + escapeHtml(zoneName) + '</b>',
      });
      summaryEl.style.display = '';
      document.getElementById('deploy-manual-wildcard-timing').textContent = '';
      document.getElementById('deploy-manual-wildcard-retry').textContent = '';

      const steps = document.getElementById('deploy-manual-wildcard-steps');
      steps.textContent = '';
      const list = document.createElement('ol');
      const stepTexts = [
        t('web.deploy.manualWildcardStep1', { zone: zoneName }),
        t('web.deploy.manualWildcardStep2', { record: dashboardRecordName, target }),
        t('web.deploy.manualWildcardStep3'),
      ];
      stepTexts.forEach((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
      });
      steps.appendChild(list);

      const dashboardLink = document.getElementById('deploy-manual-wildcard-dashboard-link');
      dashboardLink.textContent = t('web.deploy.openCloudflareDns');
      if (dashboardUrl) {
        dashboardLink.href = dashboardUrl;
      } else {
        dashboardLink.href = 'https://dash.cloudflare.com/';
      }
      dashboardLink.classList.remove('hidden');

      const docsLink = document.getElementById('deploy-manual-wildcard-docs-link');
      docsLink.textContent = t('web.deploy.openDnsDocs');
      docsLink.href = CLOUDFLARE_DNS_RECORDS_DOCS;

      const recheckButton = document.getElementById('deploy-manual-wildcard-recheck');
      recheckButton.textContent = '↻ ' + t('web.deploy.recheckDns');
      recheckButton.disabled = false;

      warning.classList.remove('hidden');
    }

    // Step navigation
    function setStep(step) {
      currentStep = step;
      for (let i = 1; i <= 9; i++) {
        const el = steps[i];
        if (!el) continue;
        el.setAttribute('data-label', getSetupStepCopy(i).label);
        el.className = 'step ' + (i < step ? 'step-complete' : i === step ? 'step-active' : 'step-pending');
      }

      const heroNumber = document.getElementById('setup-hero-number');
      if (heroNumber) {
        heroNumber.classList.toggle('complete-number', step === 9);
        heroNumber.innerHTML = step === 9 ? '✓' : '0<em>' + step + '</em>';
      }

      const heroTitle = document.getElementById('setup-hero-title');
      const copy = getSetupStepCopy(step);
      if (heroTitle) {
        heroTitle.innerHTML = copy.title;
      }

      const heroKicker = document.querySelector('.setup-hero .header-wizard');
      if (heroKicker) {
        heroKicker.textContent = copy.kicker;
      }

      const heroAside = document.getElementById('setup-hero-aside');
      if (heroAside) {
        heroAside.textContent = copy.aside;
      }

      updateSetupPrimaryMeta(step);
    }

    function updateSetupPrimaryMeta(step = currentStep) {
      const primaryMeta = document.getElementById('setup-primary-meta');
      if (!primaryMeta) return;

      const copy = getSetupUiRuntimeCopy();
      const envName = config?.env || config?.environment?.prefix || 'prod';
      if (step >= 4) {
        primaryMeta.innerHTML = escapeHtml(t('env.name')) + ' <b>' + escapeHtml(envName) + '</b>';
      } else {
        primaryMeta.innerHTML = escapeHtml(copy.startTarget) + ' <b>Cloudflare Workers</b>';
      }
    }

    function refreshSetupCopyElements() {
      const copy = getSetupUiRuntimeCopy();
      document.querySelectorAll('[data-setup-copy]').forEach((el) => {
        const key = el.getAttribute('data-setup-copy');
        const value = key ? copy[key] : '';
        if (!value) return;
        if (key.endsWith('Title')) {
          el.innerHTML = value;
          return;
        }
        if (key.endsWith('Action')) {
          el.textContent = '';
          el.appendChild(document.createTextNode(value + ' '));
          const arrow = document.createElement('span');
          arrow.className = 'arr';
          arrow.textContent = '→';
          el.appendChild(arrow);
          return;
        }
        el.textContent = value;
      });

      const unknownValues = new Set(
        Object.values(_setupUiCopy || {})
          .map((entry) => entry?.startUnknown)
          .filter(Boolean)
      );
      ['setup-recap-account', 'setup-recap-subdomain'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && unknownValues.has(el.textContent.trim())) {
          el.textContent = copy.startUnknown;
        }
      });
    }

    function refreshSetupStaticCopy() {
      refreshSetupCopyElements();
      const activeEnvSection = sections.envList && !sections.envList.classList.contains('hidden')
        ? 'envList'
        : sections.envDetail && !sections.envDetail.classList.contains('hidden')
          ? 'envDetail'
          : sections.envDelete && !sections.envDelete.classList.contains('hidden')
            ? 'envDelete'
            : null;
      if (activeEnvSection) {
        setEnvManagementHero(activeEnvSection);
      } else {
        setStep(currentStep || 1);
      }

      const prereqCopy = getPrereqUiCopy();
      const prereqSection = document.getElementById('section-prerequisites');
      if (prereqSection) {
        const environmentHead = prereqSection.querySelector('.checksec:nth-of-type(1) .sechead');

        const environmentTitle = environmentHead?.querySelector('h3');
        if (environmentTitle) environmentTitle.textContent = prereqCopy.envSectionTitle;
        const environmentHint = environmentHead?.querySelector('.hint');
        if (environmentHint) environmentHint.textContent = prereqCopy.envSectionHint;
      }

      const recheckButton = document.getElementById('btn-recheck-prereq');
      if (recheckButton) recheckButton.textContent = '↻ ' + prereqCopy.recheck;

      const continueButton = document.getElementById('btn-prereq-continue');
      if (continueButton) {
        continueButton.textContent = '';
        continueButton.appendChild(document.createTextNode(prereqCopy.continueToStart + ' '));
        const arrow = document.createElement('span');
        arrow.className = 'arr';
        arrow.textContent = '→';
        continueButton.appendChild(arrow);
      }

      if (lastPrerequisitesResult) {
        renderPrereqCheckRows(lastPrerequisitesResult);
      }

      if (sections.loadConfig && !sections.loadConfig.classList.contains('hidden')) {
        setLoadConfigHero();
      }
    }

    function refreshDynamicLocaleContent() {
      if (
        lastPrerequisitesResult &&
        sections.prerequisites &&
        !sections.prerequisites.classList.contains('hidden')
      ) {
        renderPrereqCheckRows(lastPrerequisitesResult);
      }

      if (sections.config && !sections.config.classList.contains('hidden')) {
        if (typeof updatePreview === 'function') updatePreview();
        if (typeof syncUserIdFormatCards === 'function') syncUserIdFormatCards();
      }

      if (sections.domain && !sections.domain.classList.contains('hidden')) {
        if (typeof updatePreview === 'function') updatePreview();
        if (typeof window.refreshApiDomainUi === 'function') window.refreshApiDomainUi();
      }

      if (
        sections.loadConfig &&
        !sections.loadConfig.classList.contains('hidden') &&
        lastLoadedConfigSummary
      ) {
        renderLoadedConfigSummary(lastLoadedConfigSummary, lastLoadedConfigSummaryValid);
      }

      if (sections.email && !sections.email.classList.contains('hidden')) {
        if (typeof syncFeatureQueueUi === 'function') syncFeatureQueueUi();
        if (typeof syncEmailChoiceUi === 'function') syncEmailChoiceUi();
      }

      if (
        Array.isArray(detectedEnvironments) &&
        sections.envList &&
        !sections.envList.classList.contains('hidden')
      ) {
        renderEnvironmentCards();
      }

      if (
        selectedEnvForDetail &&
        sections.envDetail &&
        !sections.envDetail.classList.contains('hidden')
      ) {
        showEnvDetail(selectedEnvForDetail);
      }

      if (
        selectedEnvForDelete &&
        sections.envDelete &&
        !sections.envDelete.classList.contains('hidden')
      ) {
        showDeleteConfirmation(selectedEnvForDelete, false);
      }

      renderEnvironmentListSummary(
        environmentScanState === 'complete' ? detectedEnvironments.length : null,
        environmentScanState
      );
    }

    function setLoadConfigHero() {
      const title = document.getElementById('setup-hero-title');
      const kicker = document.querySelector('.setup-hero .header-wizard');
      const aside = document.getElementById('setup-hero-aside');
      const heroNumber = document.getElementById('setup-hero-number');
      if (heroNumber) {
        heroNumber.classList.remove('complete-number');
        heroNumber.innerHTML = '0<em>2</em><span class="suffix">b</span>';
      }
      if (title) title.textContent = t('web.loadConfig.title');
      if (kicker) kicker.textContent = t('web.loadConfig.kicker');
      if (aside) {
        aside.innerHTML = t('web.loadConfig.heroAside');
      }
    }

    function setEnvManagementHero(name) {
      const envNameForDetail = escapeHtml(selectedEnvForDetail?.env || '');
      const envNameForDelete = escapeHtml(selectedEnvForDelete?.env || '');
      const detailEnv = selectedEnvForDetail || { env: '', workers: [] };
      const mode = escapeHtml(getEnvironmentModePreview(detailEnv));
      const issuer = escapeHtml(getEnvironmentIssuerPreview(detailEnv));
      const map = {
        envList: {
          number: 'M<em>1</em>',
          kicker: t('web.env.heroKicker'),
          title: t('web.env.heroListTitle'),
          aside: t('web.env.heroListAside'),
        },
        envDetail: {
          number: 'M<em>2</em>',
          kicker: t('web.env.heroDetailKicker'),
          title: t('web.env.heroDetailTitle', { env: envNameForDetail }),
          aside: t('web.env.heroDetailAside', { mode, issuer }),
        },
        envDelete: {
          number: 'M<em>3</em>',
          kicker: t('web.env.heroDeleteKicker'),
          title: t('web.env.heroDeleteTitle', { env: envNameForDelete }),
          aside: t('web.env.heroDeleteAside'),
        },
      };
      const copy = map[name];
      if (!copy) return;

      document.getElementById('step-indicator')?.classList.add('hidden');
      const primaryMeta = document.getElementById('setup-primary-meta');
      if (primaryMeta) {
        const directAccount =
          lastPrerequisitesResult?.auth?.email ||
          lastPrerequisitesResult?.auth?.accountEmail ||
          lastPrerequisitesResult?.auth?.accountId ||
          '';
        const recapAccount = document.getElementById('setup-recap-account')?.textContent?.trim() || '';
        const unknownAccountValues = new Set(
          Object.values(_setupUiCopy || {})
            .map((entry) => entry?.startUnknown)
            .filter(Boolean)
        );
        const account = directAccount || (unknownAccountValues.has(recapAccount) ? '' : recapAccount);
        primaryMeta.innerHTML = account
          ? t('web.env.accountMeta', { account: escapeHtml(String(account).toUpperCase()) })
          : t('web.env.accountMeta', { account: 'Cloudflare' });
      }
      const number = document.getElementById('setup-hero-number');
      if (number) {
        number.classList.toggle('danger-number', name === 'envDelete');
        number.classList.remove('complete-number');
        number.innerHTML = copy.number;
      }
      const kicker = document.querySelector('.setup-hero .header-wizard');
      if (kicker) {
        kicker.classList.toggle('danger-kicker', name === 'envDelete');
        kicker.textContent = copy.kicker;
      }
      const title = document.getElementById('setup-hero-title');
      if (title) title.innerHTML = copy.title;
      const aside = document.getElementById('setup-hero-aside');
      if (aside) aside.innerHTML = copy.aside;
    }

    function replaySetupEntrance(section) {
      const hero = document.querySelector('.setup-hero');
      if (hero) {
        hero.classList.remove('setup-enter');
        void hero.offsetWidth;
        hero.classList.add('setup-enter');
      }

      if (section) {
        section.classList.remove('setup-section-enter');
        void section.offsetWidth;
        section.classList.add('setup-section-enter');
      }
    }

    const setupProgressPreludeHideTimers = new Map();

    function dismissSetupProgressPreludes(ids) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      ids.forEach((id) => {
        const element = document.getElementById(id);
        if (!element || element.classList.contains('hidden')) return;

        const existingTimer = setupProgressPreludeHideTimers.get(element);
        if (existingTimer) clearTimeout(existingTimer);
        element.dataset.setupProgressPreludeWasVisible = 'true';

        if (reduceMotion) {
          element.classList.add('hidden');
          return;
        }

        element.classList.add('setup-progress-prelude-exit');
        const timer = setTimeout(() => {
          element.classList.remove('setup-progress-prelude-exit');
          element.classList.add('hidden');
          setupProgressPreludeHideTimers.delete(element);
        }, 220);
        setupProgressPreludeHideTimers.set(element, timer);
      });
    }

    function restoreSetupProgressPreludes(ids) {
      ids.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;

        const existingTimer = setupProgressPreludeHideTimers.get(element);
        if (existingTimer) clearTimeout(existingTimer);
        setupProgressPreludeHideTimers.delete(element);
        element.classList.remove('setup-progress-prelude-exit');
        if (element.dataset.setupProgressPreludeWasVisible === 'true') {
          element.classList.remove('hidden');
        }
        delete element.dataset.setupProgressPreludeWasVisible;
      });
    }

    function showSection(name) {
      if (name !== 'topMenu' && pendingControlPollTimer !== null) {
        clearTimeout(pendingControlPollTimer);
        pendingControlPollTimer = null;
      }
      Object.values(sections).forEach(s => {
        s.classList.add('hidden');
        s.classList.remove('setup-section-enter');
      });
      sections[name].classList.remove('hidden');
      if (['envList', 'envDetail', 'envDelete'].includes(name)) {
        document.body.classList.add('env-management-mode');
        setEnvManagementHero(name);
      } else {
        document.body.classList.remove('env-management-mode');
        document.getElementById('step-indicator')?.classList.remove('hidden');
        document.getElementById('setup-hero-number')?.classList.remove('danger-number');
        document.querySelector('.setup-hero .header-wizard')?.classList.remove('danger-kicker');
        setStep(currentStep || 1);
        if (name === 'loadConfig') {
          setLoadConfigHero();
        }
      }
      replaySetupEntrance(sections[name]);
      window.scrollTo(0, 0);
    }

    // Auto-scroll helper for progress logs
    function scrollToBottom(element) {
      if (element) {
        const target = element.querySelector?.('pre') || element;
        target.scrollTop = target.scrollHeight;
        element.scrollTop = element.scrollHeight;
      }
    }

    function formatProgressMessageForDisplay(message) {
      return String(message || '')
        .replaceAll('✅', '✓')
        .replaceAll('❌', '✕')
        .replaceAll('⚠️', t('web.status.warning'))
        .replaceAll('⚠', t('web.status.warning'))
        .replaceAll('📁', '')
        .replaceAll('📝', 'Log:')
        .replaceAll('☁️', '')
        .replaceAll('🔐', '')
        .replaceAll('🔧', '')
        .replaceAll('🚀', '')
        .replaceAll('🎉', '')
        .replaceAll('💾', '')
        .replaceAll('🗑️', '')
        .replaceAll('  ', ' ')
        .trimEnd();
    }

    async function copyTextWithFeedback(button, text, copyKey = 'web.envDetail.copyBtn') {
      if (!button || !text) return;

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const tempInput = document.createElement('input');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
      }

      const label = button.querySelector('[data-copy-label]') || button;
      label.textContent = t('web.complete.copied');
      button.disabled = true;

      setTimeout(() => {
        label.textContent = t(copyKey);
        button.disabled = false;
      }, 2000);
    }

    // Log toggle functionality
    function setLogVisibility(toggleId, logId, visible) {
      const toggle = document.getElementById(toggleId);
      const log = document.getElementById(logId);
      if (!toggle || !log) return;

      log.classList.toggle('hidden', !visible);
      toggle.classList.toggle('open', visible);
      const label = toggle.querySelector('[data-log-toggle-label]') || toggle.querySelector('span:last-child');
      if (label) {
        label.textContent = visible ? t('web.provision.hideLog') : t('web.provision.showLog');
      }
    }

    function setupLogToggle(toggleId, logId) {
      const toggle = document.getElementById(toggleId);
      const log = document.getElementById(logId);
      if (toggle && log) {
        toggle.addEventListener('click', () => {
          const isHidden = log.classList.contains('hidden');
          setLogVisibility(toggleId, logId, isHidden);
        });
      }
    }

    function setupLogCopyButton(buttonId, outputId) {
      const button = document.getElementById(buttonId);
      const output = document.getElementById(outputId);
      if (!button || !output) return;

      button.addEventListener('click', async () => {
        await copyTextWithFeedback(button, output.textContent || '');
      });
    }

    // Setup all log toggles
    setupLogToggle('deploy-log-toggle', 'deploy-log');
    setupLogToggle('provision-log-toggle', 'provision-log');
    setupLogToggle('delete-log-toggle', 'delete-log');
    setupLogCopyButton('deploy-log-copy-btn', 'deploy-output');
    setupLogCopyButton('provision-log-copy-btn', 'provision-output');
    setupLogCopyButton('delete-log-copy-btn', 'delete-output');
    setupLogCopyButton('full-environment-deploy-log-copy-btn', 'full-environment-deploy-log');
    setupLogCopyButton('worker-update-log-copy-btn', 'worker-update-log');
    setupLogCopyButton('ui-update-log-copy-btn', 'ui-update-log');

    const WEB_ORA_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const DEPLOY_PHASE_LABEL_KEYS = {
      preparation: 'web.deploy.phase.preparation',
      schema: 'web.deploy.phase.schema',
      configuration: 'web.deploy.phase.configuration',
      workers: 'web.deploy.phase.workers',
      verification: 'web.deploy.phase.verification',
      control: 'web.deploy.phase.control',
      bootstrap: 'web.deploy.phase.bootstrap',
      routing: 'web.deploy.phase.routing',
      integrations: 'web.deploy.phase.integrations',
      ui: 'web.deploy.phase.ui',
    };
    const DEPLOY_PHASE_IDS = Object.keys(DEPLOY_PHASE_LABEL_KEYS);
    let deployOraTimer = null;
    let deployOraFrameIndex = 0;
    let lastRenderedDeployStep = 1;

    function stopDeployOraTimer() {
      if (deployOraTimer) window.clearInterval(deployOraTimer);
      deployOraTimer = null;
    }

    function paintDeployOraFrame(frame) {
      const mainFrame = document.getElementById('deploy-spinner');
      const logFrame = document.getElementById('deploy-log-ora-frame');
      if (mainFrame) mainFrame.textContent = frame;
      if (logFrame) logFrame.textContent = frame;
    }

    function startDeployOraTimer() {
      stopDeployOraTimer();
      deployOraFrameIndex = 0;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        paintDeployOraFrame('•');
        return;
      }
      paintDeployOraFrame(WEB_ORA_FRAMES[deployOraFrameIndex]);
      deployOraFrameIndex += 1;
      deployOraTimer = window.setInterval(() => {
        paintDeployOraFrame(WEB_ORA_FRAMES[deployOraFrameIndex % WEB_ORA_FRAMES.length]);
        deployOraFrameIndex += 1;
      }, 80);
    }

    function updateProgressBarVisual(progressBar, percent, status = 'running', indeterminate = false) {
      if (!progressBar) return;
      const normalizedPercent = Math.min(100, Math.max(0, Number(percent) || 0));
      progressBar.classList.toggle('indeterminate', indeterminate);
      progressBar.classList.toggle('is-complete', status === 'complete');
      progressBar.classList.toggle('is-error', status === 'error');
      progressBar.style.width = indeterminate ? '28%' : normalizedPercent + '%';

      const track = progressBar.closest('.setup-progress-track');
      if (!track || track.getAttribute('role') !== 'progressbar') return;
      if (indeterminate) {
        track.removeAttribute('aria-valuenow');
        track.setAttribute('aria-busy', 'true');
      } else {
        track.setAttribute('aria-valuenow', String(normalizedPercent));
        track.removeAttribute('aria-busy');
      }
    }

    function markProgressBarError(prefix) {
      const progressBar = document.getElementById(prefix + '-progress-bar');
      const currentWidth = Number.parseFloat(progressBar?.style.width || '0');
      updateProgressBarVisual(progressBar, currentWidth, 'error');
    }

    function renderDeploymentSnapshot(snapshot) {
      if (!snapshot || snapshot.operation !== 'deploy') return;
      const total = Math.max(1, Number(snapshot.totalSteps) || 10);
      const step = Math.min(
        total,
        Math.max(lastRenderedDeployStep, Math.max(1, Number(snapshot.step) || 1))
      );
      lastRenderedDeployStep = step;
      const terminal =
        snapshot.status === 'complete' ||
        snapshot.status === 'error' ||
        snapshot.terminal === true;
      const percent = snapshot.status === 'complete'
        ? 100
        : Math.min(99, Math.round(((step - 0.5) / total) * 100));
      const progressBar = document.getElementById('deploy-progress-bar');
      const percentEl = document.getElementById('deploy-percent');
      const currentTask = document.getElementById('deploy-current-task');
      const progressText = document.getElementById('deploy-progress-text');
      const rail = document.getElementById('deploy-phase-rail');
      const currentMessageLine = document.getElementById('deploy-current-message-line');
      const currentMessage = document.getElementById('deploy-current-message');
      const oraLine = document.getElementById('deploy-log-ora');
      const oraText = document.getElementById('deploy-log-ora-text');

      updateProgressBarVisual(progressBar, percent, snapshot.status);
      if (percentEl) percentEl.textContent = String(percent);
      const renderedPhase = DEPLOY_PHASE_IDS[step - 1] || snapshot.phase;
      const phaseLabelKey = DEPLOY_PHASE_LABEL_KEYS[renderedPhase];
      const phaseLabel = phaseLabelKey ? t(phaseLabelKey) : renderedPhase;
      if (currentTask && currentTask.textContent !== phaseLabel) {
        currentTask.textContent = phaseLabel;
      }
      if (progressText) {
        progressText.textContent = t('web.deploy.phase.progress', { current: step, total });
      }
      if (rail) {
        rail.setAttribute('aria-valuemax', String(total));
        rail.setAttribute('aria-valuenow', String(step));
        rail.setAttribute(
          'aria-label',
          t('web.deploy.phase.aria', { current: step, total })
        );
        rail.setAttribute('aria-valuetext', phaseLabel);
        rail.querySelectorAll('[data-deploy-phase]').forEach((item) => {
          const itemStep = Number(item.getAttribute('data-deploy-phase'));
          item.className = itemStep < step
            ? 'complete'
            : itemStep === step
              ? snapshot.status
              : '';
        });
      }
      if (oraLine) oraLine.className = 'ora-log-line ' + snapshot.status;
      if (currentMessageLine) {
        currentMessageLine.className = 'deploy-current-message ' + snapshot.status;
      }
      const oraMessage = snapshot.message || phaseLabel || '';
      if (currentMessage && currentMessage.textContent !== oraMessage) {
        currentMessage.textContent = oraMessage;
      }
      if (oraText && oraText.textContent !== oraMessage) {
        oraText.textContent = oraMessage;
      }

      if (terminal) {
        stopDeployOraTimer();
        paintDeployOraFrame(
          snapshot.status === 'complete' ? '✓' : snapshot.status === 'error' ? '✕' : '!'
        );
      } else if (!deployOraTimer) {
        startDeployOraTimer();
      }
    }

    // Progress UI update helper
    function updateProgressUI(prefix, current, total, currentTask) {
      const progressBar = document.getElementById(prefix + '-progress-bar');
      const progressText = document.getElementById(prefix + '-progress-text');
      const currentTaskEl = document.getElementById(prefix + '-current-task');
      const spinner = document.getElementById(prefix + '-spinner');
      const percentEl = document.getElementById(prefix + '-percent');

      if (progressBar && total > 0) {
        const isIndeterminate = prefix === 'delete' && current === 0;
        const percent = Math.min(Math.round((current / total) * 100), 100);
        updateProgressBarVisual(
          progressBar,
          percent,
          current >= total ? 'complete' : 'running',
          isIndeterminate
        );
        if (!isIndeterminate && percentEl) percentEl.textContent = String(percent);
      }
      if (progressText) {
        // Deploy is percentage-based, provisioning tracks logical tasks, and deletion tracks
        // concrete resources. Keep those units explicit so an 8-step provisioning operation is
        // never presented as though the environment only contained eight Cloudflare resources.
        if (prefix === 'deploy') {
          const percent = Math.min(Math.round((current / total) * 100), 100);
          progressText.textContent = t('web.status.percentComplete', { percent });
        } else if (prefix === 'provision') {
          const displayCurrent = Math.min(current, total);
          progressText.textContent = t('web.provision.runningTasks', {
            current: displayCurrent,
            total,
          });
        } else {
          const displayCurrent = Math.min(current, total);
          progressText.textContent = t('web.status.resourceProgress', {
            current: displayCurrent,
            total,
          });
        }
      }
      if (currentTaskEl && currentTask) {
        currentTaskEl.textContent = currentTask;
      }
      // Hide spinner when complete
      if (spinner) {
        spinner.style.display = (current >= total && total > 0) ? 'none' : 'block';
      }
    }

    // Parse progress message to extract current task
    function parseProgressMessage(message) {
      // Match patterns like "Deploying xxx...", "Creating xxx...", "Deleting xxx..."
      if (message.includes('Deploying ')) {
        const parts = message.split('Deploying ')[1];
        if (parts) {
          const name = parts.split('.')[0].split(' ')[0];
          if (name) return 'Deploying ' + name + '...';
        }
      }

      if (message.includes('Creating ')) {
        const parts = message.split('Creating ')[1];
        if (parts) {
          const name = parts.split(' ')[0].split('.')[0];
          if (name) return 'Creating ' + name + '...';
        }
      }

      if (message.includes('Deleting')) {
        const parts = message.split('Deleting')[1];
        if (parts) {
          const name = parts.trim().split(' ')[0].replace(':', '');
          if (name) return 'Deleting ' + name + '...';
        }
      }

      if (message.includes('✓')) {
        const parts = message.split('✓')[1];
        if (parts) {
          const text = parts.trim().substring(0, 40);
          return '✓ ' + text;
        }
      }

      if (message.includes('Level ')) {
        const parts = message.split('Level ')[1];
        if (parts) {
          const num = parts.trim().split(' ')[0];
          if (num) return 'Deployment Level ' + num;
        }
      }

      if (message.includes('Generating')) {
        const parts = message.split('Generating')[1];
        if (parts) {
          const text = parts.trim().substring(0, 30);
          return 'Generating ' + text + '...';
        }
      }

      if (message.includes('Uploading')) return 'Uploading secrets...';
      if (message.toLowerCase().includes('building')) return 'Building packages...';

      return null;
    }

    function getDeleteProgressTask(message) {
      const normalized = String(message || '')
        .trimStart()
        .replace(/^[⚠️✕✓✅⏳🧹🌐📊🗄️🔎]+/u, '')
        .trim();
      if (!normalized) return null;

      if (
        normalized.startsWith('Preparing to delete environment:') ||
        normalized.startsWith('Using ')
      ) {
        return t('web.delete.progress.preparing');
      }

      const scanningResources = [
        ['Scanning Workers', 'Workers'],
        ['Scanning D1 databases', 'D1'],
        ['Scanning KV namespaces', 'KV'],
        ['Scanning Queues', 'Queues'],
        ['Scanning R2 buckets', 'R2'],
        ['Scanning legacy Pages projects', 'Legacy Pages'],
      ];
      for (const [prefix, resource] of scanningResources) {
        if (normalized.startsWith(prefix)) {
          return t('web.delete.progress.scanningResource', { resource });
        }
      }

      if (normalized.startsWith('Found ') && normalized.includes(' environment(s)')) {
        return t('web.delete.progress.inventoryReady');
      }
      if (normalized.startsWith('Reconciling Setup-managed DNS records')) {
        return t('web.delete.progress.reconcilingDns');
      }
      if (normalized.startsWith('Revoking setup-managed Control API tokens')) {
        return t('web.delete.progress.revokingTokens');
      }
      if (normalized.startsWith('Verifying Cloudflare inventory after deletion')) {
        return t('web.delete.progress.verifyingInventory');
      }

      const deletingResources = [
        ['Deleting Workers', 'Workers'],
        ['Deleting D1 Databases', 'D1'],
        ['Deleting KV Namespaces', 'KV'],
        ['Deleting Queues', 'Queues'],
        ['Deleting R2 Buckets', 'R2'],
        ['Deleting legacy Pages Projects', 'Legacy Pages'],
      ];
      for (const [prefix, resource] of deletingResources) {
        if (normalized.startsWith(prefix)) {
          return t('web.delete.progress.deletingResource', { resource });
        }
      }

      return null;
    }

    function createProvisionProgressTracker(totalResources) {
      const completedMilestones = new Set();
      let completed = false;
      const milestonePatterns = [
        { key: 'keys', test: (message) => message.includes('Admin secrets generated') },
        { key: 'd1', test: (message) => /D1 Databases\\s*\\([^)]*\\)\\s*✓/.test(message) },
        { key: 'kv', test: (message) => /KV Namespaces\\s*\\([^)]*\\)\\s*✓/.test(message) },
        { key: 'queues', test: (message) => /Queues\\s*\\([^)]*\\)\\s*✓/.test(message) },
        { key: 'r2', test: (message) => /R2 Buckets\\s*\\([^)]*\\)\\s*✓/.test(message) },
        { key: 'migrations', test: (message) => /Migrations?\\s*(complete|completed|✓)/i.test(message) },
        { key: 'config', test: (message) => /Config(?:uration)?\\s*(saved|written|✓)/i.test(message) },
      ];

      function current() {
        return Math.min(completedMilestones.size, Math.max(totalResources - 1, 0));
      }

      function handle(message) {
        if (completed) return;
        if (message.includes('Provisioning complete')) {
          completed = true;
          updateProgressUI('provision', totalResources, totalResources, t('web.status.complete'));
          return;
        }

        for (const milestone of milestonePatterns) {
          if (milestone.test(message)) {
            completedMilestones.add(milestone.key);
            break;
          }
        }

        const taskInfo = parseProgressMessage(message);
        if (taskInfo || completedMilestones.size > 0) {
          updateProgressUI(
            'provision',
            current(),
            totalResources,
            taskInfo || t('web.provision.runningTasks', { current: current(), total: totalResources })
          );
        }
      }

      function complete() {
        completed = true;
        updateProgressUI('provision', totalResources, totalResources, t('web.status.complete'));
      }

      return { handle, complete };
    }

    // Safe DOM element creation helpers
    function createAlert(type, content) {
      const div = document.createElement('div');
      div.className = 'alert alert-' + type;
      if (typeof content === 'string') {
        div.textContent = content;
      } else {
        div.appendChild(content);
      }
      return div;
    }

    function appendManualR2CleanupNotice(parent, targets) {
      if (!Array.isArray(targets) || targets.length === 0) return;

      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = t('web.delete.manualR2Title');
      content.appendChild(title);

      const list = document.createElement('ul');
      for (const target of targets) {
        const item = document.createElement('li');
        item.textContent =
          target.bucketName +
          ' (' +
          Number(target.objectCount || 0).toLocaleString() +
          ' objects) ';
        if (target.dashboardUrl) {
          const link = document.createElement('a');
          link.href = target.dashboardUrl;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = t('web.delete.manualR2Open');
          item.appendChild(link);
        }
        list.appendChild(item);
      }
      content.appendChild(list);
      parent.appendChild(createAlert('warning', content));
    }

    function appendManualDnsCleanupNotice(parent, issues) {
      if (!Array.isArray(issues) || issues.length === 0) return;

      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = t('web.deploy.manualDnsSectionTitle');
      content.appendChild(title);

      const list = document.createElement('ul');
      for (const issue of issues) {
        const item = document.createElement('li');
        item.textContent =
          String(issue.name || issue.role || 'DNS') +
          ': ' +
          String(issue.reason || t('web.delete.manualReviewRequired'));
        list.appendChild(item);
      }
      content.appendChild(list);

      const dashboardLink = document.createElement('a');
      dashboardLink.href =
        issues.find((issue) => issue && issue.dashboardUrl)?.dashboardUrl ||
        getManualWildcardDnsDashboardUrl() ||
        'https://dash.cloudflare.com/';
      dashboardLink.target = '_blank';
      dashboardLink.rel = 'noreferrer';
      dashboardLink.textContent = t('web.deploy.openCloudflareDns');
      content.appendChild(dashboardLink);

      parent.appendChild(createAlert('warning', content));
    }

    function appendManualControlTokenCleanupNotice(parent, targets) {
      if (!Array.isArray(targets) || targets.length === 0) return;

      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = t('web.delete.manualControlTokensTitle');
      content.appendChild(title);

      const summary = document.createElement('p');
      summary.textContent = t('web.delete.manualControlTokensSummary');
      content.appendChild(summary);

      const exactTokenIds = Array.from(
        new Set(targets.flatMap((target) => Array.isArray(target.targetTokenIds) ? target.targetTokenIds : []))
      );
      if (exactTokenIds.length > 0) {
        const list = document.createElement('ul');
        for (const tokenId of exactTokenIds) {
          const item = document.createElement('li');
          item.textContent = t('web.delete.manualControlTokenId', { tokenId: String(tokenId) });
          list.appendChild(item);
        }
        content.appendChild(list);
      }

      const candidateNames = Array.from(
        new Set(targets.flatMap((target) => Array.isArray(target.expectedTokenNames) ? target.expectedTokenNames : []))
      );
      if (candidateNames.length > 0) {
        const list = document.createElement('ul');
        for (const tokenName of candidateNames) {
          const item = document.createElement('li');
          item.textContent = String(tokenName);
          list.appendChild(item);
        }
        content.appendChild(list);
      }

      const accountLink = document.createElement('a');
      accountLink.href = targets.find((target) => target && target.accountTokensDashboardUrl)?.accountTokensDashboardUrl || 'https://dash.cloudflare.com/';
      accountLink.target = '_blank';
      accountLink.rel = 'noreferrer';
      accountLink.textContent = t('web.delete.manualControlTokensAccountOpen');
      content.appendChild(accountLink);
      content.appendChild(document.createTextNode(' '));

      const userLink = document.createElement('a');
      userLink.href = targets.find((target) => target && target.userTokensDashboardUrl)?.userTokensDashboardUrl || 'https://dash.cloudflare.com/profile/api-tokens';
      userLink.target = '_blank';
      userLink.rel = 'noreferrer';
      userLink.textContent = t('web.delete.manualControlTokensUserOpen');
      content.appendChild(userLink);

      parent.appendChild(createAlert('warning', content));
    }

    function createUrlItem(label, text, href) {
      const row = document.createElement('tr');
      row.className = 'endpoint-row';

      const labelCell = document.createElement('td');
      labelCell.className = 'k';
      labelCell.textContent = label.replace(/:$/, '');

      const valueCell = document.createElement('td');
      valueCell.className = 'v endpoint-value';
      let valueEl;
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.textContent = text;
        valueEl = link;
      } else {
        const span = document.createElement('span');
        span.textContent = text;
        valueEl = span;
      }

      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'copy';
      copyButton.textContent = t('web.complete.copy');
      copyButton.addEventListener('click', async () => {
        await navigator.clipboard.writeText(text);
        copyButton.textContent = t('web.complete.copied');
        setTimeout(() => {
          copyButton.textContent = t('web.complete.copy');
        }, 2000);
      });

      valueCell.appendChild(valueEl);
      valueCell.appendChild(copyButton);
      row.appendChild(labelCell);
      row.appendChild(valueCell);
      return row;
    }

    async function resetServerState() {
      try {
        await api('/reset', { method: 'POST' });
      } catch (error) {
        console.warn('Failed to reset setup state:', error);
      }
    }

    function resetLogToggle(toggleId, logId) {
      setLogVisibility(toggleId, logId, false);
    }

    function resetProgressContainer(prefix) {
      const progressBar = document.getElementById(prefix + '-progress-bar');
      const progressText = document.getElementById(prefix + '-progress-text');
      const currentTaskEl = document.getElementById(prefix + '-current-task');
      const spinner = document.getElementById(prefix + '-spinner');
      const progressDiv = document.getElementById(prefix + '-progress-ui');
      const percentEl = document.getElementById(prefix + '-percent');

      updateProgressBarVisual(progressBar, 0);
      if (percentEl) percentEl.textContent = '0';
      if (spinner) spinner.style.display = 'block';
      if (progressDiv) progressDiv.classList.add('hidden');

      if (currentTaskEl) {
        currentTaskEl.textContent = t('web.provision.initializing');
      }

      if (progressText) {
        progressText.textContent =
          prefix === 'deploy'
            ? t('web.status.percentComplete', { percent: 0 })
            : t('web.status.resourceProgress', { current: 0, total: 0 });
      }
    }

    function resetDynamicCompleteSections() {
      const dynamicSection = document.getElementById('complete-admin-setup-section');
      if (dynamicSection) {
        dynamicSection.remove();
      }
    }

    function resetLoadConfigUI() {
      loadedConfig = null;
      lastLoadedConfigSummary = null;
      lastLoadedConfigSummaryValid = false;

      const configFile = document.getElementById('config-file');
      if (configFile) configFile.value = '';

      document.getElementById('config-file-name').textContent = '';
      document.getElementById('config-file-meta').textContent = '';
      document.getElementById('config-file-chip').classList.add('hidden');
      document.getElementById('config-load-progress').textContent = t('web.common.notSelected');
      document.getElementById('config-validation-error').classList.add('hidden');
      document.getElementById('config-validation-success').classList.add('hidden');
      document.getElementById('config-preview-section').classList.add('hidden');
      document.getElementById('config-summary-content').textContent = '';
      document.getElementById('config-validation-success-message').textContent = t('web.loadConfig.validationOkDesc');
      document.getElementById('btn-load-config').disabled = true;
      document.getElementById('btn-load-config').textContent = t('web.loadConfig.loadContinue');

      const errorList = document.getElementById('config-validation-errors');
      while (errorList.firstChild) {
        errorList.removeChild(errorList.firstChild);
      }
    }

    function formatConfigFileSize(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatConfigFileDate(timestamp) {
      if (!timestamp) return '';
      return new Date(timestamp).toLocaleString(_currentLocale || undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function getEnvironmentNameFromDetection(envInfo) {
      return String(envInfo?.env || envInfo?.name || '').trim();
    }

    async function findDetectedEnvironment(envName) {
      const normalized = String(envName || '').trim().toLowerCase();
      if (!normalized) return null;

      const envResult = await api('/environments');
      if (!envResult.success || !Array.isArray(envResult.environments)) {
        return null;
      }

      return (
        envResult.environments.find((envInfo) => {
          return getEnvironmentNameFromDetection(envInfo).toLowerCase() === normalized;
        }) || null
      );
    }

    async function confirmLoadedConfigEnvironmentConflict(envName) {
      const existingEnv = await findDetectedEnvironment(envName);
      if (!existingEnv) return true;

      const workers = existingEnv.workers?.length || 0;
      const d1 = existingEnv.d1?.length || 0;
      const kv = existingEnv.kv?.length || 0;
      const message = t('web.loadConfig.envConflictConfirm', { env: envName, workers, d1, kv });

      return window.confirm(message);
    }

    function renderLoadedConfigSummary(config, valid) {
      lastLoadedConfigSummary = config;
      lastLoadedConfigSummaryValid = valid;
      const summary = document.getElementById('config-summary-content');
      summary.textContent = '';

      const raw = config.__raw || config;
      const isNewFormat = config.version === '1.0.0' || config.environment?.prefix || raw.environment?.prefix;
      const env = isNewFormat ? config.environment?.prefix || raw.environment?.prefix : config.env || raw.env;
      const rawApiDomain = isNewFormat
        ? config.urls?.api?.custom || raw.urls?.api?.custom || config.urls?.api?.auto || raw.urls?.api?.auto
        : config.apiDomain || raw.apiDomain;
      const apiDomain = rawApiDomain ? String(rawApiDomain).replace(/^https?:\\/\\//, '') : '';
      const multiTenant = raw.tenant?.multiTenant ?? config.tenant?.multiTenant === true;
      const tenantName = raw.tenant?.name || config.tenant?.name || 'default';
      const components = { ...(config.components || {}), ...(raw.components || {}) };
      const componentNames = [
        components.api !== false ? 'API' : null,
        components.loginUi !== false ? 'Login UI' : null,
        components.adminUi !== false ? 'Admin UI' : null,
      ].filter(Boolean);
      const placement = raw.tenant?.placementPolicy || config.tenant?.placementPolicy || 'tenant_exclusive';
      const coreRegion =
        raw.residency?.core?.location ||
        config.residency?.core?.location ||
        raw.database?.core?.location ||
        config.database?.core?.location ||
        raw.coreRegion ||
        config.coreRegion ||
        'auto';
      const piiRegion =
        raw.residency?.pii?.location ||
        config.residency?.pii?.location ||
        raw.database?.pii?.location ||
        config.database?.pii?.location ||
        raw.piiRegion ||
        config.piiRegion ||
        'auto';
      const email = { ...(config.features?.email || {}), ...(raw.features?.email || {}) };
      const emailProvider = email.provider || (email.enabled ? 'configured' : 'none');

      const cap = document.createElement('div');
      cap.className = 'cap';
      const capTitle = document.createElement('span');
      capTitle.textContent = t('web.loadConfig.loadedConfiguration');
      const capStatus = document.createElement('em');
      capStatus.textContent = valid ? t('web.loadConfig.validated') : t('web.loadConfig.pendingValidation');
      cap.append(capTitle, capStatus);
      summary.appendChild(cap);

      const rows = [
        [t('web.loadConfig.environment'), env || '-'],
        [t('web.loadConfig.baseDomain'), apiDomain || '-'],
        [
          t('web.loadConfig.multiTenant'),
          multiTenant
            ? t('web.loadConfig.enabledInitialTenant', { tenant: tenantName })
            : t('config.disabled'),
        ],
        [t('web.loadConfig.components'), componentNames.join(' + ') || '-'],
        ['D1 routing', 'Control Plane'],
        ['Initial tenant placement', placement],
        [t('web.loadConfig.d1Regions'), 'core: ' + coreRegion + ' / pii: ' + piiRegion],
        [
          t('web.loadConfig.emailProvider'),
          email.fromEmail && emailProvider !== 'none'
            ? emailProvider + ' (' + email.fromEmail + ')'
            : emailProvider,
        ],
      ];

      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      for (const [key, value] of rows) {
        const tr = document.createElement('tr');
        const keyCell = document.createElement('td');
        keyCell.className = 'k';
        keyCell.textContent = key;
        const valueCell = document.createElement('td');
        valueCell.className = 'v';
        valueCell.textContent = value;
        tr.append(keyCell, valueCell);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      summary.appendChild(table);
    }

    function resetConfigurationForm() {
      config = {};
      provisioningCompleted = false;
      domainZoneId = null;

      document.getElementById('advanced-options').classList.remove('hidden');

      document.getElementById('env').value = '';
      document.getElementById('base-domain').value = '';
      document.getElementById('login-domain').value = '';
      document.getElementById('admin-domain').value = '';
      document.getElementById('tenant-name').value = 'default';
      document.getElementById('tenant-display').value = '';
      document.getElementById('primary-tenant').value = '';
      document.getElementById('enable-multi-tenant').checked = false;
      document.getElementById('naked-domain').checked = false;
      document.getElementById('user-id-format').value = 'nanoid';

      document.getElementById('domain-check-row').style.display = 'none';
      document.getElementById('domain-check-status').replaceChildren();
      document.getElementById('login-domain-zone-status').replaceChildren();
      document.getElementById('admin-domain-zone-status').replaceChildren();
      document.getElementById('custom-domain-binding-row').style.display = 'none';
      document.getElementById('custom-domain-binding').checked = true;

      const envInput = document.getElementById('env');
      const envError = document.getElementById('env-error');
      envInput.style.borderColor = '';
      if (envError) envError.style.display = 'none';

      updateBaseDomainUI();

      const loginDomainRow = document.getElementById('login-domain-row');
      const adminDomainRow = document.getElementById('admin-domain-row');
      loginDomainRow.style.opacity = '1';
      adminDomainRow.style.opacity = '1';
      document.getElementById('login-domain').disabled = false;
      document.getElementById('admin-domain').disabled = false;

      updatePreview();
    }

    function resetDatabaseAndEmailForm() {
      setAutomaticProvisioningEnabled(true);
      document.getElementById('feature-queue-enabled').checked = false;

      document.querySelectorAll('input[name="db-core-location"]').forEach((input) => {
        input.checked = input.value === 'auto';
      });
      document.querySelectorAll('input[name="db-pii-location"]').forEach((input) => {
        input.checked = input.value === 'auto';
      });

      document.querySelectorAll('input[name="email-setup-choice"]').forEach((input) => {
        input.checked = input.value === 'later';
      });
      document.getElementById('cloudflare-config-form').classList.add('hidden');
      document.getElementById('resend-config-form').classList.remove('hidden');
      document.getElementById('cloudflare-from-address').value = '';
      document.getElementById('cloudflare-from-name').value = '';
      document.getElementById('resend-api-key').value = '';
      document.getElementById('email-from-address').value = '';
      document.getElementById('email-from-name').value = '';
      document.getElementById('btn-continue-email').disabled = false;
      document.getElementById('btn-continue-email').textContent = t('web.email.continueResources');
      syncEmailChoiceUi();
      syncFeatureQueueUi();
    }

    function resetProvisionSection() {
      if (provisionPollInterval) {
        clearInterval(provisionPollInterval);
        provisionPollInterval = null;
      }

      document.getElementById('provision-status').textContent = t('web.provision.ready');
      document.getElementById('provision-status').className = '';
      document.getElementById('resource-preview').classList.remove('hidden');
      document.getElementById('keys-saved-info').classList.add('hidden');
      document.getElementById('keys-path').textContent = '';
      document.getElementById('provision-output').textContent = '';
      document.getElementById('btn-provision').disabled = false;
      resetProgressContainer('provision');
      resetLogToggle('provision-log-toggle', 'provision-log');
      updateProvisionButtons();
    }

    function resetDeploySection() {
      document.getElementById('deploy-status').textContent = t('web.provision.ready');
      document.getElementById('deploy-status').className = '';
      document.getElementById('deploy-ready-text').classList.remove('hidden');
      document.getElementById('deploy-output').textContent = '';
      document.getElementById('btn-deploy').disabled = false;
      document.getElementById('btn-deploy').classList.remove('hidden');
      document.getElementById('btn-back-provision').classList.remove('hidden');
      document.getElementById('btn-cancel-deploy').classList.add('hidden');
      document.getElementById('btn-goto-complete').classList.add('hidden');
      document.getElementById('btn-goto-complete').disabled = true;
      resetProgressContainer('deploy');
      resetLogToggle('deploy-log-toggle', 'deploy-log');
    }

    function resetCompleteSection() {
      document.getElementById('urls').textContent = '';
      resetDynamicCompleteSections();
    }

    function resetDeleteSection() {
      document.getElementById('delete-output').textContent = '';
      document.getElementById('delete-result').classList.add('hidden');
      document.getElementById('delete-result').textContent = '';
      document.getElementById('delete-options-section').classList.remove('hidden');
      document.getElementById('btn-confirm-delete').classList.remove('hidden');
      document.getElementById('btn-confirm-delete').disabled = false;
      const backLabel = document.getElementById('delete-back-label');
      if (backLabel) backLabel.textContent = t('common.cancel');
      resetProgressContainer('delete');
      resetLogToggle('delete-log-toggle', 'delete-log');
    }

    function markDeleteNavigationComplete() {
      const backLabel = document.getElementById('delete-back-label');
      if (backLabel) {
        backLabel.textContent = t('web.env.backToList').replace(/^←[ ]*/u, '');
      }
    }

    async function resetSetupFlowState() {
      await resetServerState();
      resetLoadConfigUI();
      resetConfigurationForm();
      resetDatabaseAndEmailForm();
      resetProvisionSection();
      resetDeploySection();
      resetCompleteSection();
      resetDeleteSection();
      selectedEnvForDetail = null;
      selectedEnvForDelete = null;
      setStep(1);
    }

    function getPrereqUiCopy() {
      const locale = String(_currentLocale || '').toLowerCase();
      if (locale.startsWith('ja')) {
        return {
            checking: '確認中',
            pass: '合格',
            available: '利用可',
            review: '未確認',
            fail: '失敗',
            installed: 'インストール済み',
            loggedInAs: 'としてログイン中',
            notLoggedIn: '未ログイン',
            notInstalled: '未インストール',
            unknown: '未取得',
            stepProgress: 'ステップ <b>01</b> / 09',
            completeProgress: 'ステップ <b>01</b> / 09',
            errorProgress: 'ステップ <b>01</b> / 09 — 確認が必要です',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Workersのデプロイに使用',
            authName: 'Cloudflare 認証',
            authDesc: 'wrangler login の状態',
            subdomainName: 'workers.dev サブドメイン',
            subdomainDesc: 'カスタムドメイン未設定時の配信元',
            cwdName: '作業ディレクトリ',
            cwdDesc: '設定・鍵の保存先（.authrim/）',
            envSectionTitle: '環境チェック',
            envSectionHint: '',
            recheck: '再チェック',
            continueToStart: '開始へ進む',
          };
      }

      if (locale.startsWith('es')) {
        return {
            checking: 'Verificando',
            pass: 'Aprobado',
            available: 'Disponible',
            review: 'Revisar',
            fail: 'Error',
            installed: 'Instalado',
            loggedInAs: 'conectado como',
            notLoggedIn: 'Sin iniciar sesión',
            notInstalled: 'No instalado',
            unknown: 'No cargado',
            stepProgress: 'Paso <b>01</b> / 09',
            completeProgress: 'Paso <b>01</b> / 09',
            errorProgress: 'Paso <b>01</b> / 09 — Revisión requerida',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Usado para desplegar Workers',
            authName: 'Autenticación de Cloudflare',
            authDesc: 'Estado de wrangler login',
            subdomainName: 'Subdominio workers.dev',
            subdomainDesc: 'Origen de reserva sin dominios personalizados',
            cwdName: 'Directorio de trabajo',
            cwdDesc: 'Configuración y claves (.authrim/)',
            envSectionTitle: 'Verificación del entorno',
            envSectionHint: '',
            recheck: 'Volver a verificar',
            continueToStart: 'Continuar al inicio',
          };
      }

      if (locale.startsWith('zh-tw')) {
        return {
            checking: '檢查中',
            pass: '通過',
            available: '可用',
            review: '未確認',
            fail: '失敗',
            installed: '已安裝',
            loggedInAs: '登入身分',
            notLoggedIn: '未登入',
            notInstalled: '未安裝',
            unknown: '未載入',
            stepProgress: '步驟 <b>01</b> / 09',
            completeProgress: '步驟 <b>01</b> / 09',
            errorProgress: '步驟 <b>01</b> / 09 — 需要確認',
            wranglerName: 'wrangler CLI',
            wranglerDesc: '用於部署 Workers',
            authName: 'Cloudflare 認證',
            authDesc: 'wrangler login 狀態',
            subdomainName: 'workers.dev 子網域',
            subdomainDesc: '未設定自訂網域時的備用來源',
            cwdName: '工作目錄',
            cwdDesc: '設定與金鑰儲存位置（.authrim/）',
            envSectionTitle: '環境檢查',
            envSectionHint: '',
            recheck: '重新檢查',
            continueToStart: '前往開始',
          };
      }

      if (locale.startsWith('zh')) {
        return {
            checking: '检查中',
            pass: '通过',
            available: '可用',
            review: '未确认',
            fail: '失败',
            installed: '已安装',
            loggedInAs: '登录身份',
            notLoggedIn: '未登录',
            notInstalled: '未安装',
            unknown: '未加载',
            stepProgress: '步骤 <b>01</b> / 09',
            completeProgress: '步骤 <b>01</b> / 09',
            errorProgress: '步骤 <b>01</b> / 09 — 需要确认',
            wranglerName: 'wrangler CLI',
            wranglerDesc: '用于部署 Workers',
            authName: 'Cloudflare 认证',
            authDesc: 'wrangler login 状态',
            subdomainName: 'workers.dev 子域名',
            subdomainDesc: '未配置自定义域名时的备用来源',
            cwdName: '工作目录',
            cwdDesc: '配置与密钥存储位置（.authrim/）',
            envSectionTitle: '环境检查',
            envSectionHint: '',
            recheck: '重新检查',
            continueToStart: '前往开始',
          };
      }

      if (locale.startsWith('pt')) {
        return {
            checking: 'Verificando',
            pass: 'Aprovado',
            available: 'Disponível',
            review: 'Revisar',
            fail: 'Falha',
            installed: 'Instalado',
            loggedInAs: 'conectado como',
            notLoggedIn: 'Não conectado',
            notInstalled: 'Não instalado',
            unknown: 'Não carregado',
            stepProgress: 'Etapa <b>01</b> / 09',
            completeProgress: 'Etapa <b>01</b> / 09',
            errorProgress: 'Etapa <b>01</b> / 09 — Revisão necessária',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Usado para fazer deploy de Workers',
            authName: 'Autenticação Cloudflare',
            authDesc: 'Status do wrangler login',
            subdomainName: 'Subdomínio workers.dev',
            subdomainDesc: 'Origem de fallback quando domínios customizados não estão configurados',
            cwdName: 'Diretório de trabalho',
            cwdDesc: 'Armazenamento de configuração e chaves (.authrim/)',
            envSectionTitle: 'Verificação do ambiente',
            envSectionHint: '',
            recheck: 'Verificar novamente',
            continueToStart: 'Continuar para início',
          };
      }

      if (locale.startsWith('fr')) {
        return {
            checking: 'Vérification',
            pass: 'Réussi',
            available: 'Disponible',
            review: 'À vérifier',
            fail: 'Échec',
            installed: 'Installé',
            loggedInAs: 'connecté en tant que',
            notLoggedIn: 'Non connecté',
            notInstalled: 'Non installé',
            unknown: 'Non chargé',
            stepProgress: 'Étape <b>01</b> / 09',
            completeProgress: 'Étape <b>01</b> / 09',
            errorProgress: 'Étape <b>01</b> / 09 — Vérification requise',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Utilisé pour déployer les Workers',
            authName: 'Authentification Cloudflare',
            authDesc: 'État de wrangler login',
            subdomainName: 'Sous-domaine workers.dev',
            subdomainDesc: 'Origine de secours sans domaines personnalisés',
            cwdName: 'Répertoire de travail',
            cwdDesc: 'Stockage de configuration et de clés (.authrim/)',
            envSectionTitle: 'Vérification de l’environnement',
            envSectionHint: '',
            recheck: 'Revérifier',
            continueToStart: 'Continuer au début',
          };
      }

      if (locale.startsWith('de')) {
        return {
            checking: 'Prüfung läuft',
            pass: 'Bestanden',
            available: 'Verfügbar',
            review: 'Prüfen',
            fail: 'Fehlgeschlagen',
            installed: 'Installiert',
            loggedInAs: 'angemeldet als',
            notLoggedIn: 'Nicht angemeldet',
            notInstalled: 'Nicht installiert',
            unknown: 'Nicht geladen',
            stepProgress: 'Schritt <b>01</b> / 09',
            completeProgress: 'Schritt <b>01</b> / 09',
            errorProgress: 'Schritt <b>01</b> / 09 — Prüfung erforderlich',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Zum Deployen von Workers',
            authName: 'Cloudflare-Authentifizierung',
            authDesc: 'Status von wrangler login',
            subdomainName: 'workers.dev-Subdomain',
            subdomainDesc: 'Fallback-Origin, wenn keine Custom Domains konfiguriert sind',
            cwdName: 'Arbeitsverzeichnis',
            cwdDesc: 'Konfiguration und Schlüsselspeicher (.authrim/)',
            envSectionTitle: 'Umgebungsprüfung',
            envSectionHint: '',
            recheck: 'Erneut prüfen',
            continueToStart: 'Weiter zum Start',
          };
      }

      if (locale.startsWith('ko')) {
        return {
            checking: '확인 중',
            pass: '통과',
            available: '사용 가능',
            review: '미확인',
            fail: '실패',
            installed: '설치됨',
            loggedInAs: '로그인 계정',
            notLoggedIn: '로그인 안 됨',
            notInstalled: '설치 안 됨',
            unknown: '불러오지 않음',
            stepProgress: '단계 <b>01</b> / 09',
            completeProgress: '단계 <b>01</b> / 09',
            errorProgress: '단계 <b>01</b> / 09 — 확인 필요',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Workers 배포에 사용',
            authName: 'Cloudflare 인증',
            authDesc: 'wrangler login 상태',
            subdomainName: 'workers.dev 서브도메인',
            subdomainDesc: '사용자 지정 도메인이 없을 때의 기본 origin',
            cwdName: '작업 디렉터리',
            cwdDesc: '설정 및 키 저장 위치(.authrim/)',
            envSectionTitle: '환경 확인',
            envSectionHint: '',
            recheck: '다시 확인',
            continueToStart: '시작으로 이동',
          };
      }

      if (locale.startsWith('ru')) {
        return {
            checking: 'Проверка',
            pass: 'Пройдено',
            available: 'Доступно',
            review: 'Проверить',
            fail: 'Ошибка',
            installed: 'Установлено',
            loggedInAs: 'вход как',
            notLoggedIn: 'Нет входа',
            notInstalled: 'Не установлено',
            unknown: 'Не загружено',
            stepProgress: 'Шаг <b>01</b> / 09',
            completeProgress: 'Шаг <b>01</b> / 09',
            errorProgress: 'Шаг <b>01</b> / 09 — требуется проверка',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Используется для деплоя Workers',
            authName: 'Аутентификация Cloudflare',
            authDesc: 'Состояние wrangler login',
            subdomainName: 'Субдомен workers.dev',
            subdomainDesc: 'Fallback origin без custom domains',
            cwdName: 'Рабочий каталог',
            cwdDesc: 'Хранилище конфигурации и ключей (.authrim/)',
            envSectionTitle: 'Проверка окружения',
            envSectionHint: '',
            recheck: 'Проверить снова',
            continueToStart: 'Перейти к началу',
          };
      }

      if (locale.startsWith('id')) {
        return {
            checking: 'Memeriksa',
            pass: 'Lulus',
            available: 'Tersedia',
            review: 'Periksa',
            fail: 'Gagal',
            installed: 'Terinstal',
            loggedInAs: 'login sebagai',
            notLoggedIn: 'Belum login',
            notInstalled: 'Belum terinstal',
            unknown: 'Belum dimuat',
            stepProgress: 'Langkah <b>01</b> / 09',
            completeProgress: 'Langkah <b>01</b> / 09',
            errorProgress: 'Langkah <b>01</b> / 09 — Perlu diperiksa',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Digunakan untuk deploy Workers',
            authName: 'Autentikasi Cloudflare',
            authDesc: 'Status wrangler login',
            subdomainName: 'Subdomain workers.dev',
            subdomainDesc: 'Origin fallback saat domain kustom belum dikonfigurasi',
            cwdName: 'Direktori kerja',
            cwdDesc: 'Penyimpanan konfigurasi dan kunci (.authrim/)',
            envSectionTitle: 'Pemeriksaan environment',
            envSectionHint: '',
            recheck: 'Periksa ulang',
            continueToStart: 'Lanjut ke awal',
          };
      }

      return {
            checking: 'Checking',
            pass: 'Pass',
            available: 'Available',
            review: 'Review',
            fail: 'Failed',
            installed: 'Installed',
            loggedInAs: 'logged in as',
            notLoggedIn: 'Not logged in',
            notInstalled: 'Not installed',
            unknown: 'Not loaded',
            stepProgress: 'Step <b>01</b> / 09',
            completeProgress: 'Step <b>01</b> / 09',
            errorProgress: 'Step <b>01</b> / 09 — Review required',
            wranglerName: 'wrangler CLI',
            wranglerDesc: 'Used to deploy Workers',
            authName: 'Cloudflare authentication',
            authDesc: 'wrangler login state',
            subdomainName: 'workers.dev subdomain',
            subdomainDesc: 'Fallback origin when custom domains are not configured',
            cwdName: 'Working directory',
            cwdDesc: 'Configuration and key storage (.authrim/)',
            envSectionTitle: 'Environment Check',
            envSectionHint: '',
            recheck: 'Re-check',
            continueToStart: 'Continue to Start',
          };
    }

    function createPrereqCheckLine(index, name, description, detail, status) {
      const copy = getPrereqUiCopy();
      const statusClass =
        status === 'pass' ? 'pass' : status === 'warn' ? 'warn' : status === 'loading' ? 'loading' : 'fail';
      const statusText = status === 'loading' ? copy.checking : '';
      const row = document.createElement('div');
      row.className = 'checkline ' + statusClass;

      const ix = document.createElement('span');
      ix.className = 'ix';
      ix.textContent = String(index).padStart(2, '0');
      row.appendChild(ix);

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.appendChild(document.createTextNode(name));
      const small = document.createElement('small');
      small.textContent = description;
      nm.appendChild(small);
      row.appendChild(nm);

      const det = document.createElement('span');
      det.className = 'det';
      det.textContent = detail || copy.unknown;
      row.appendChild(det);

      const st = document.createElement('span');
      st.className = 'st';
      if (status === 'loading') {
        const spinner = document.createElement('span');
        spinner.className = 'check-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        st.appendChild(spinner);
        st.appendChild(document.createTextNode(statusText));
      } else {
        st.textContent = statusText;
      }
      row.appendChild(st);

      return row;
    }

    function renderPrereqCheckRows(result) {
      const copy = getPrereqUiCopy();
      const envChecks = document.getElementById('prereq-environment-checks');
      const progress = document.getElementById('prereq-progress');
      const continueButton = document.getElementById('btn-prereq-continue');
      const status = document.getElementById('prereq-status');
      const wranglerOk = result?.wranglerInstalled === true;
      const authOk = result?.auth?.isLoggedIn === true;
      const baseOk = wranglerOk && authOk;

      envChecks.replaceChildren(
        createPrereqCheckLine(
          1,
          copy.wranglerName,
          copy.wranglerDesc,
          wranglerOk ? copy.installed : copy.notInstalled,
          wranglerOk ? 'pass' : 'fail'
        ),
        createPrereqCheckLine(
          2,
          copy.authName,
          copy.authDesc,
          authOk
            ? result.auth.email
              ? t('web.prereq.loggedInAs', { email: result.auth.email })
              : copy.loggedInAs
            : copy.notLoggedIn,
          authOk ? 'pass' : 'fail'
        ),
        createPrereqCheckLine(
          3,
          copy.subdomainName,
          copy.subdomainDesc,
          result?.workersSubdomain || copy.unknown,
          result?.workersSubdomain ? 'pass' : 'warn'
        ),
        createPrereqCheckLine(
          4,
          copy.cwdName,
          copy.cwdDesc,
          result?.cwd || copy.unknown,
          result?.cwd ? 'pass' : 'warn'
        )
      );

      progress.innerHTML = baseOk ? copy.completeProgress : copy.errorProgress;
      continueButton.disabled = !baseOk;
      if (status) {
        status.textContent = '';
        status.className = 'st ' + (baseOk ? 'pass' : 'fail');
      }
    }

    function renderPrereqFailureMessage(message) {
      const content = document.getElementById('prereq-content');
      content.textContent = '';
      if (!message) return;
      const alert = document.createElement('div');
      alert.className = 'alert error';
      const head = document.createElement('div');
      head.className = 'a-head';
      head.textContent = t('web.status.error');
      const body = document.createElement('p');
      body.textContent = message;
      alert.appendChild(head);
      alert.appendChild(body);
      content.appendChild(alert);
    }

    async function loadRuntimeContext() {
      const result = await api('/prerequisites');
      lastPrerequisitesResult = result;
      workingDirectory = result.cwd || '';
      workersSubdomain = result.workersSubdomain || '';
      updateStartRecap();
      return result;
    }

    // Check prerequisites
    async function checkPrerequisites() {
      setStep(1);
      const copy = getPrereqUiCopy();
      const progress = document.getElementById('prereq-progress');
      const continueButton = document.getElementById('btn-prereq-continue');
      const envChecks = document.getElementById('prereq-environment-checks');

      progress.innerHTML = copy.stepProgress;
      continueButton.disabled = true;
      renderPrereqFailureMessage('');
      envChecks.replaceChildren(
        createPrereqCheckLine(1, copy.checking, copy.wranglerDesc, '...', 'loading')
      );

      try {
        const result = await loadRuntimeContext();
        renderPrereqCheckRows(result);

        if (!result.wranglerInstalled) {
          renderPrereqFailureMessage(t('web.error.wranglerNotInstalled') + ' npm install -g wrangler');
          return false;
        }

        if (!result.auth.isLoggedIn) {
          renderPrereqFailureMessage(t('web.error.notLoggedIn') + ' wrangler login');
          return false;
        }

        return true;
      } catch (error) {
        renderPrereqFailureMessage(t('web.error.checkingPrereq') + ' ' + error.message);
        progress.innerHTML = copy.errorProgress;
        return false;
      }
    }

    // Show top menu
    async function loadPendingControlOperations() {
      const panel = document.getElementById('pending-control-operations');
      const items = document.getElementById('pending-control-operation-items');
      const button = document.getElementById('btn-open-pending-operation');
      const status = document.getElementById('pending-control-operation-result');
      if (!panel || !items) return [];
      if (pendingControlPollTimer !== null) {
        clearTimeout(pendingControlPollTimer);
        pendingControlPollTimer = null;
      }
      try {
        const result = await api('/control/pending-operations');
        const operations = result.success && Array.isArray(result.operations) ? result.operations : [];
        if (operations.length === 0) {
          panel.classList.add('hidden');
          items.replaceChildren();
          if (button) button.classList.remove('hidden');
          if (status) status.textContent = '';
          return [];
        }
        items.replaceChildren();
        for (const operation of operations.slice(0, 5)) {
          const row = document.createElement('p');
          if (operation.operationKind === 'tenant_disaster_recovery') {
            row.textContent = operation.environmentId + ' / ' +
              t('web.control.pendingTenant', { tenantId: operation.tenantId }) + ' / ' +
              t('web.control.pendingDisasterRecovery') + ' / ' +
              (operation.currentStep || t('web.control.pendingVerifyRuntimeBindings'));
          } else {
            const owner = operation.scope === 'tenant_exclusive'
              ? t('web.control.pendingTenant', { tenantId: operation.tenantId })
              : t('web.control.pendingSharedPool');
            row.textContent = operation.environmentId + ' / ' + owner + ' / ' +
              operation.dataRole + ' / ' +
              (operation.currentStep || t('web.control.pendingProvisioning'));
          }
          items.appendChild(row);
        }
        const executable = operations.find(isPendingControlOperationExecutable);
        if (button) button.classList.toggle('hidden', !executable);
        if (status) status.textContent = executable ? '' : t('web.control.pendingObserving');
        panel.classList.remove('hidden');
        if (!sections.topMenu.classList.contains('hidden')) {
          pendingControlPollTimer = setTimeout(async () => {
            pendingControlPollTimer = null;
            if (!sections.topMenu.classList.contains('hidden')) {
              pendingControlOperations = await loadPendingControlOperations();
            }
          }, 5000);
        }
        return operations;
      } catch {
        if (!sections.topMenu.classList.contains('hidden')) {
          pendingControlPollTimer = setTimeout(async () => {
            pendingControlPollTimer = null;
            if (!sections.topMenu.classList.contains('hidden')) {
              pendingControlOperations = await loadPendingControlOperations();
            }
          }, 5000);
        }
        return pendingControlOperations;
      }
    }

    function isPendingControlOperationExecutable(operation) {
      if (!operation || typeof operation !== 'object') return false;
      if (
        operation.operationKind === 'provision_plugin_resources' ||
        operation.operationKind === 'cleanup_plugin_resources'
      ) return true;
      return ['create_d1', 'apply_migrations', 'reconcile_worker_bindings'].includes(
        operation.currentStep
      );
    }

    async function showTopMenu() {
      setStep(2);
      updateStartRecap();
      showSection('topMenu');
      pendingControlOperations = await loadPendingControlOperations();
    }

    function updateStartRecap() {
      const result = lastPrerequisitesResult;
      const account = document.getElementById('setup-recap-account');
      if (account) {
        account.textContent = result?.auth?.email || result?.auth?.accountId || account.textContent;
      }

      const subdomain = document.getElementById('setup-recap-subdomain');
      if (subdomain) {
        subdomain.textContent = result?.workersSubdomain || subdomain.textContent;
      }

      const wrangler = document.getElementById('setup-recap-wrangler');
      if (wrangler) {
        wrangler.textContent = result?.wranglerInstalled
          ? t('web.status.ok')
          : t('web.status.checkRequired');
      }
    }

    // Top menu handlers
    document.getElementById('btn-recheck-prereq').addEventListener('click', checkPrerequisites);
    document.getElementById('btn-prereq-continue').addEventListener('click', showTopMenu);

    const menuNewSetup = document.getElementById('menu-new-setup');
    const menuLoadConfig = document.getElementById('menu-load-config');
    const menuManageEnv = document.getElementById('menu-manage-env');

    document.getElementById('btn-open-pending-operation')?.addEventListener('click', async () => {
      const pending = pendingControlOperations.find(isPendingControlOperationExecutable);
      if (!pending) return;
      const button = document.getElementById('btn-open-pending-operation');
      const status = document.getElementById('pending-control-operation-result');
      if (button) button.disabled = true;
      if (status) status.textContent = t('web.control.operationRunning');
      try {
        const result = await api('/control/pending-operations/execute', {
          method: 'POST',
          body: {
            environmentId: pending.environmentId,
            operationId: pending.operationId,
          },
        });
        if (!result.success) throw new Error(result.error || t('web.control.operationFailed'));
        pendingControlOperations = await loadPendingControlOperations();
        if (status) {
          const resultKey =
            CONTROL_OPERATION_RESULT_TRANSLATION_KEYS[result.result?.state] ||
            CONTROL_OPERATION_RESULT_TRANSLATION_KEYS.blocked;
          status.textContent = t(resultKey);
        }
      } catch (error) {
        if (status) {
          status.textContent = error instanceof Error ? error.message : t('web.control.operationFailed');
        }
      } finally {
        if (button) button.disabled = false;
      }
    });

    function activatePanelWithKeyboard(element) {
      element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        element.click();
      });
    }

    [menuNewSetup, menuLoadConfig, menuManageEnv].forEach(activatePanelWithKeyboard);

    menuNewSetup.addEventListener('click', async () => {
      await resetSetupFlowState();
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(3);
      showSection('config');
      updatePreview();
    });

    menuLoadConfig.addEventListener('click', () => {
      setStep(2);
      setLoadConfigHero();
      showSection('loadConfig');
    });

    document.getElementById('btn-back-top-2').addEventListener('click', () => {
      setStep(2);
      showSection('topMenu');
    });

    // Load config handlers
    document.getElementById('config-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      document.getElementById('config-file-name').textContent = file.name;
      document.getElementById('config-file-meta').textContent =
        [formatConfigFileSize(file.size), formatConfigFileDate(file.lastModified)].filter(Boolean).join(' — ');
      document.getElementById('config-file-chip').classList.remove('hidden');
      document.getElementById('config-load-progress').textContent = t('web.loadConfig.validating');

      // Reset validation display
      document.getElementById('config-validation-error').classList.add('hidden');
      document.getElementById('config-validation-success').classList.add('hidden');
      document.getElementById('config-preview-section').classList.add('hidden');
      document.getElementById('config-summary-content').textContent = '';
      document.getElementById('btn-load-config').disabled = true;
      document.getElementById('btn-load-config').textContent = t('web.loadConfig.loadContinue');

      const reader = new FileReader();
      reader.onload = async (event) => {
        let rawConfig;
        try {
          rawConfig = JSON.parse(event.target.result);
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = t('web.error.invalidJson') + ' ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
          lastLoadedConfigSummary = null;
          lastLoadedConfigSummaryValid = false;
          document.getElementById('config-load-progress').textContent = t('web.status.error');
          return;
        }

        // Show a mock-aligned summary preview first; validation status is updated below.
        renderLoadedConfigSummary(rawConfig, false);
        document.getElementById('config-preview-section').classList.remove('hidden');

        // Validate via API
        try {
          const response = await api('/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawConfig),
          });

          if (response.valid) {
            loadedConfig = response.config;
            renderLoadedConfigSummary(
              response.config ? { ...rawConfig, ...response.config, __raw: rawConfig } : rawConfig,
              true
            );
            document.getElementById('config-validation-success').classList.remove('hidden');
            document.getElementById('btn-load-config').disabled = false;
            const rawProgressStatus = String(rawConfig.status || rawConfig.progress?.status || '').toLowerCase();
            const successMessage = document.getElementById('config-validation-success-message');
            if (rawProgressStatus === 'provisioned') {
              document.getElementById('btn-load-config').textContent = t('web.loadConfig.loadDeploy');
              successMessage.textContent = t('web.loadConfig.provisionedValid');
            } else {
              successMessage.textContent = t('web.loadConfig.validationOkDesc');
            }
            document.getElementById('config-load-progress').textContent = t('web.loadConfig.valid');
          } else {
            document.getElementById('config-validation-error').classList.remove('hidden');
            const errorList = document.getElementById('config-validation-errors');
            while (errorList.firstChild) errorList.removeChild(errorList.firstChild);

            if (response.errors) {
              for (const err of response.errors) {
                const li = document.createElement('li');
                li.textContent = (err.path ? err.path + ': ' : '') + err.message;
                errorList.appendChild(li);
              }
            } else if (response.error) {
              const li = document.createElement('li');
              li.textContent = response.error;
              errorList.appendChild(li);
            }
            loadedConfig = null;
            lastLoadedConfigSummary = null;
            lastLoadedConfigSummaryValid = false;
            document.getElementById('config-load-progress').textContent = t('web.status.error');
          }
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = t('web.error.validationFailed') + ' ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
          lastLoadedConfigSummary = null;
          lastLoadedConfigSummaryValid = false;
          document.getElementById('config-load-progress').textContent = t('web.status.error');
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-load-config').addEventListener('click', async () => {
      if (!loadedConfig) return;

      // Support both new format (v1.0.0) and old format (v0.1.x)
      const isNewFormat = loadedConfig.version === '1.0.0' || loadedConfig.environment?.prefix;

      // Extract values (with fallback for old format)
      const env = isNewFormat
        ? loadedConfig.environment?.prefix
        : loadedConfig.env || 'prod';

      const loadButton = document.getElementById('btn-load-config');
      const originalLoadButtonText = loadButton.textContent;
      loadButton.disabled = true;
      loadButton.textContent = t('web.loadConfig.checkingEnvironment');
      try {
        const shouldContinue = await confirmLoadedConfigEnvironmentConflict(env);
        if (!shouldContinue) {
          return;
        }
      } catch (error) {
        console.warn('Environment conflict check failed:', error);
      } finally {
        loadButton.disabled = false;
        loadButton.textContent = originalLoadButtonText;
      }

      const apiDomain = isNewFormat
        ? loadedConfig.urls?.api?.custom
        : loadedConfig.apiDomain;

      const loginUiDomain = isNewFormat
        ? loadedConfig.urls?.loginUi?.custom
        : loadedConfig.loginUiDomain;

      const adminUiDomain = isNewFormat
        ? loadedConfig.urls?.adminUi?.custom
        : loadedConfig.adminUiDomain;

      const tenant = loadedConfig.tenant || {
        name: 'default',
        displayName: 'Initial Tenant',
        multiTenant: false,
      };

      const components = {
        api: true,
        ...(loadedConfig.components || {}),
        loginUi: loadedConfig.components?.loginUi ?? true,
        adminUi: loadedConfig.components?.adminUi ?? true,
        saml: true,
        async: true,
        vc: true,
        bridge: true,
        policy: true,
      };
      const profiles = loadedConfig.profiles || buildProfilesConfig();
      const features = {
        queue: { enabled: loadedConfig.features?.queue?.enabled === true },
        r2: { enabled: loadedConfig.features?.r2?.enabled !== false },
        email: loadedConfig.features?.email || { provider: 'none' },
      };

      // Build internal config
      config = {
        env,
        apiDomain: stripProtocol(apiDomain) || null,
        loginUiDomain: stripProtocol(loginUiDomain) || null,
        adminUiDomain: stripProtocol(adminUiDomain) || null,
        tenant,
        components,
        profiles,
        features,
        zoneId: loadedConfig.urls?.api?.zoneId || null,
        customDomainBinding: loadedConfig.urls?.api?.customDomainBinding === true,
      };

      // Set form values
      document.getElementById('env').value = config.env;
      document.getElementById('base-domain').value = stripProtocol(config.tenant?.baseDomain || config.apiDomain);
      document.getElementById('login-domain').value = stripProtocol(config.loginUiDomain);
      document.getElementById('admin-domain').value = stripProtocol(config.adminUiDomain);
      document.getElementById('tenant-name').value = config.tenant?.name || 'default';
      document.getElementById('tenant-display').value = config.tenant?.displayName || 'Initial Tenant';
      document.getElementById('enable-multi-tenant').checked = config.tenant?.multiTenant === true;
      document.getElementById('naked-domain').checked = config.tenant?.nakedDomain || false;
      if (document.getElementById('user-id-format')) {
        document.getElementById('user-id-format').value = config.tenant?.userIdFormat || 'nanoid';
      }
      if (document.getElementById('primary-tenant')) {
        document.getElementById('primary-tenant').value = config.tenant?.primaryTenant || '';
      }
      updateBaseDomainUI();
      setAutomaticProvisioningEnabled(config.controlPlane?.automaticProvisioning === true);
      document.getElementById('comp-login-ui').checked = config.components.loginUi !== false;
      document.getElementById('comp-admin-ui').checked = config.components.adminUi !== false;
      document.getElementById('feature-queue-enabled').checked =
        config.features?.queue?.enabled === true;
      updateComponentOptionUi();

      // Restore domain check UI if custom domain is set
      const loadedBaseDomain = document.getElementById('base-domain').value.trim();
      if (loadedBaseDomain && /^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/i.test(loadedBaseDomain)) {
        document.getElementById('domain-check-row').style.display = 'block';
        // Auto-trigger zone check for loaded domain
        setTimeout(() => document.getElementById('check-domain-btn').click(), 300);
      }

      // Trigger env input to update preview/default labels
      document.getElementById('env').dispatchEvent(new Event('input'));

      // Show configuration screen for review/editing
      // User can modify settings before proceeding to provision
      // Loaded configurations always expose all component options for editing.
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(3);
      showSection('config');
      updatePreview();
    });

    // Configuration handlers
    // Update preview section when any input changes
    function getCurrentApiDomainUiState() {
      return computeApiDomainUiState({
        baseDomain: document.getElementById('base-domain').value.trim(),
        multiTenantChecked: document.getElementById('enable-multi-tenant').checked,
        nakedDomainChecked: document.getElementById('naked-domain').checked,
        tenantName: document.getElementById('tenant-name').value.trim(),
        primaryTenant: document.getElementById('primary-tenant').value.trim(),
      });
    }

    function getCurrentSetupDomainValidationIssues() {
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      return validateSetupDomainInputs({
        apiDomain: document.getElementById('base-domain').value.trim(),
        loginUiDomain: loginUiEnabled ? document.getElementById('login-domain').value.trim() : '',
        adminUiDomain: adminUiEnabled ? document.getElementById('admin-domain').value.trim() : '',
        tenantName: document.getElementById('tenant-name').value.trim(),
      });
    }

    function renderDomainDepthError(elementId, issue) {
      const el = document.getElementById(elementId);
      if (!el) return;
      if (!issue) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }

      const message = issue.kind === 'baseDomainDepth'
        ? t('domain.baseDomainDepthError', { hostname: issue.hostname })
        : t('domain.uiDomainDepthError', {
            label: issue.field === 'loginUiDomain'
              ? t('web.domain.loginUi')
              : t('web.domain.adminUi'),
            hostname: issue.hostname,
          });
      el.textContent = issue.suggestion
        ? message + ' ' + t('domain.suggestedHost', { hostname: issue.suggestion })
        : message;
      el.style.display = 'block';
    }

    function refreshDomainDepthValidation() {
      const issues = getCurrentSetupDomainValidationIssues();
      const byField = new Map(issues.map((issue) => [issue.field, issue]));

      renderDomainDepthError('base-domain-depth-error', byField.get('apiDomain'));
      renderDomainDepthError('login-domain-depth-error', byField.get('loginUiDomain'));
      renderDomainDepthError('admin-domain-depth-error', byField.get('adminUiDomain'));

      const configureButton = document.getElementById('btn-configure');
      if (configureButton) {
        configureButton.disabled = false;
      }

      const domainContinueButton = document.getElementById('btn-domain-continue');
      if (domainContinueButton) {
        domainContinueButton.disabled = issues.length > 0;
      }

      return issues;
    }

    function renderTenantUrlExamples(state, copy) {
      const body = document.getElementById('tenant-url-examples-body');
      body.textContent = '';

      state.exampleRows.forEach((row) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        const td = document.createElement('td');

        if (row.kind === 'initial-tenant') {
          th.textContent = copy.rowInitialTenant(row.tenantName || 'default');
        } else if (row.kind === 'initial-tenant-explicit') {
          th.textContent = copy.rowInitialTenantExplicit(row.tenantName || 'default');
        } else {
          th.textContent = copy.rowOtherTenant;
        }

        td.textContent = row.url;
        tr.appendChild(th);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    }

    function generateRandomTenantIdInBrowser() {
      const alphabet = 'abcdefghjkmnpqrstuvwxyz';
      const bytes = new Uint8Array(12);
      globalThis.crypto.getRandomValues(bytes);
      let body = '';
      for (let i = 0; i < bytes.length; i += 1) {
        body += alphabet[bytes[i] % alphabet.length];
      }
      return body;
    }

    function isValidTenantId(value) {
      return /^[a-z][a-z0-9-]{0,62}$/.test(String(value || '').trim());
    }

    function showTenantIdValidationError(inputId, label) {
      alert(t('web.domain.tenantIdInvalid', { label }));
      document.getElementById(inputId)?.focus();
    }

    function refreshApiDomainUi() {
      const state = getCurrentApiDomainUiState();
      const copy = getApiDomainUiCopy();
      const baseDomain = document.getElementById('base-domain').value.trim();
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const primaryTenant = document.getElementById('primary-tenant').value.trim() || tenantName;
      const singleTenantMode = !state.multiTenantEnabled;

      document.getElementById('tenant-id-label').textContent =
        singleTenantMode
          ? copy.singleTenantLabel || copy.initialTenantLabel
          : copy.initialTenantLabel;
      document.getElementById('tenant-name-random').textContent =
        copy.randomTenantButtonLabel || 'Generate Random';
      document.getElementById('primary-tenant-label').textContent = copy.primaryTenantLabel;
      document.getElementById('tenant-url-examples-title').textContent = copy.examplesTitle;
      document.getElementById('tenant-url-examples-header-label').textContent =
        copy.tableHeaderLabel;
      document.getElementById('tenant-url-examples-header-url').textContent = copy.tableHeaderUrl;

      if (state.multiTenantHintMode === 'needs-custom-domain') {
        document.getElementById('multi-tenant-hint').textContent = copy.multiTenantHintNeedsDomain;
      } else if (state.multiTenantHintMode === 'single-tenant') {
        document.getElementById('multi-tenant-hint').textContent = copy.multiTenantHintSingleTenant;
      } else {
        document.getElementById('multi-tenant-hint').textContent =
          copy.multiTenantHintEnabled(baseDomain);
      }

      if (state.showTenantFields && state.multiTenantEnabled) {
        document.getElementById('tenant-id-hint').textContent = copy.initialTenantHintSubdomain(
          tenantName,
          baseDomain,
          'https://' + tenantName + '.' + baseDomain
        );
      } else {
        document.getElementById('tenant-id-hint').textContent =
          singleTenantMode
            ? copy.singleTenantHintGeneric || copy.initialTenantHintGeneric
            : copy.initialTenantHintGeneric;
      }

      document.getElementById('primary-tenant-hint').textContent = copy.primaryTenantHint(
        baseDomain || 'example.com',
        primaryTenant,
        'https://' + (baseDomain || 'example.com')
      );

      if (state.nakedDomainHintMode === 'omit-tenant') {
        document.getElementById('naked-domain-hint').textContent = copy.nakedDomainHintOmit(
          primaryTenant,
          baseDomain,
          'https://' + (baseDomain || 'example.com')
        );
      } else if (state.nakedDomainHintMode === 'include-tenant') {
        document.getElementById('naked-domain-hint').textContent = copy.nakedDomainHintInclude(
          tenantName,
          baseDomain,
          'https://' + tenantName + '.' + baseDomain
        );
      } else {
        document.getElementById('naked-domain-hint').textContent = '';
      }

      renderTenantUrlExamples(state, copy);
    }

    window.refreshApiDomainUi = refreshApiDomainUi;
    window.renderDeployManualWildcardWarning = renderDeployManualWildcardWarning;
    window.setSetupPreviewConfig = (nextConfig) => {
      config = { ...(config || {}), ...(nextConfig || {}) };
      updateSetupPrimaryMeta(currentStep);
    };
    window.setSetupPreviewComplete = (nextConfig, result) => {
      config = { ...(config || {}), ...(nextConfig || {}) };
      showComplete(result || {});
    };

    function getOriginFromPreviewUrl(value) {
      try {
        return new URL(value).origin;
      } catch {
        return '';
      }
    }

    function hostWithinBaseDomain(host, baseDomain) {
      if (!host || !baseDomain) return false;
      const normalizedHost = host.toLowerCase();
      const normalizedBase = baseDomain.toLowerCase();
      return normalizedHost === normalizedBase || normalizedHost.endsWith('.' + normalizedBase);
    }

    function normalizeDomainHostname(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw.match(/^https?:\\/\\//i) ? raw : 'https://' + raw).hostname.toLowerCase();
      } catch {
        return raw
          .replace(/^https?:\\/\\//i, '')
          .replace(/\\/.*$/, '')
          .replace(/[.]+$/, '')
          .toLowerCase();
      }
    }

    function isImmediateSubdomainOfBaseDomain(host, baseDomain) {
      if (!host || !baseDomain || !host.endsWith('.' + baseDomain)) return false;
      const prefix = host.slice(0, -baseDomain.length - 1);
      return prefix.length > 0 && !prefix.includes('.');
    }

    function isRoutedByMultiTenantRouterHost(host, baseDomain) {
      return host === baseDomain || isImmediateSubdomainOfBaseDomain(host, baseDomain);
    }

    function uiDomainRequiresOwnRoute(domain) {
      const uiHost = normalizeDomainHostname(domain);
      if (!uiHost) return false;

      const apiHost = normalizeDomainHostname(document.getElementById('base-domain').value);
      if (apiHost && uiHost === apiHost) return false;

      let domainUiState = getCurrentApiDomainUiState();
      if (domainUiState.multiTenantEnabled && apiHost) {
        return !isRoutedByMultiTenantRouterHost(uiHost, apiHost);
      }

      return true;
    }

    function describeAdminPreviewMode(mode) {
      if (mode === 'same-origin') {
        return 'same-origin - relative Admin API calls on the same origin';
      }
      if (mode === 'same-site-cross-origin') {
        return 'same-site-cross-origin - direct Admin API calls with credentialed CORS';
      }
      return 'cross-site-proxy - Admin UI Worker BFF via Service Binding';
    }

    function resolveAdminPreviewMode(apiUrl, adminUrl, baseDomain) {
      const apiOrigin = getOriginFromPreviewUrl(apiUrl);
      const adminOrigin = getOriginFromPreviewUrl(adminUrl);
      if (apiOrigin && adminOrigin && apiOrigin === adminOrigin) {
        return 'same-origin';
      }

      try {
        const apiHost = new URL(apiUrl).hostname;
        const adminHost = new URL(adminUrl).hostname;
        if (
          hostWithinBaseDomain(apiHost, baseDomain) &&
          hostWithinBaseDomain(adminHost, baseDomain)
        ) {
          return 'same-site-cross-origin';
        }
      } catch {
        // Fall through to proxy mode for incomplete preview input.
      }

      return 'cross-site-proxy';
    }

    function updatePreview() {
      const env = document.getElementById('env').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '{env}';
      const baseDomain = document.getElementById('base-domain').value.trim();
      let domainUiState = getCurrentApiDomainUiState();
      const multiTenantEnabled = domainUiState.multiTenantEnabled;
      const nakedDomain = multiTenantEnabled && document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      updateComponentOptionUi();
      syncUserIdFormatCards();
      refreshDomainDepthValidation();

      // Components - build list based on selections
      const components = [
        'API',
        ...(loginUiEnabled ? ['Login UI'] : []),
        ...(adminUiEnabled ? ['Admin UI'] : []),
      ];
      const previewComponents = document.getElementById('preview-components');
      previewComponents.textContent = '';
      components.forEach((component) => {
        const badge = document.createElement('span');
        badge.className = 'preview-component-badge';
        badge.textContent = component;
        previewComponents.appendChild(badge);
      });

      const setPreviewValue = (element, value, note) => {
        element.textContent = '';
        const main = document.createElement('span');
        main.textContent = value;
        element.appendChild(main);
        if (note) {
          const noteEl = document.createElement('span');
          noteEl.className = 'infra-value-note';
          noteEl.textContent = note;
          element.appendChild(noteEl);
        }
      };

      // Generate domains with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      const loginUiWorkerDomain = workersSubdomain
        ? env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-login-ui.workers.dev';
      const adminUiWorkerDomain = workersSubdomain
        ? env + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-admin-ui.workers.dev';
      const routerDefaultNote = document.getElementById('router-default-note');
      if (routerDefaultNote) {
        routerDefaultNote.textContent = workersDomain;
      }
      const bindingRouterName = document.getElementById('binding-router-name');
      if (bindingRouterName) {
        bindingRouterName.textContent = env + '-ar-router';
      }
      const coreDbNamePreview = document.getElementById('core-db-name-preview');
      if (coreDbNamePreview) {
        coreDbNamePreview.textContent = env + '-authrim-core-db';
      }
      const piiDbNamePreview = document.getElementById('pii-db-name-preview');
      if (piiDbNamePreview) {
        piiDbNamePreview.textContent = env + '-authrim-pii-db';
      }

      // Issuer URL
      // Note: Tenant subdomain is only supported with custom domains, NOT workers.dev
      // Workers.dev doesn't support wildcard subdomains, so tenant prefix cannot be used

      if (multiTenantEnabled) {
        if (nakedDomain) {
          document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
        } else {
          document.getElementById('preview-issuer').textContent =
            'https://' + tenantName + '.' + baseDomain;
        }
      } else if (baseDomain) {
        document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        document.getElementById('preview-issuer').textContent = 'https://' + workersDomain;
      }

      document.getElementById('tenant-url-examples').style.display =
        domainUiState.showExamples ? 'block' : 'none';
      refreshApiDomainUi();

      const previewLogin = document.getElementById('preview-login');
      if (loginDomain) {
        previewLogin.textContent = 'https://' + loginDomain;
        previewLogin.style.color = '';
      } else {
        previewLogin.textContent = 'https://' + loginUiWorkerDomain;
        previewLogin.style.color = '';
      }
      document.getElementById('login-default').textContent = loginUiWorkerDomain;

      const previewAdmin = document.getElementById('preview-admin');
      if (adminDomain) {
        previewAdmin.textContent = 'https://' + adminDomain;
        previewAdmin.style.color = '';
      } else {
        previewAdmin.textContent = 'https://' + adminUiWorkerDomain;
        previewAdmin.style.color = '';
      }
      document.getElementById('admin-default').textContent = adminUiWorkerDomain;

      const tenantDiscoverTableRow = document.getElementById('preview-tenant-discover-table-row');
      const tenantDiscoverTable = document.getElementById('preview-tenant-discover-table');
      if (tenantDiscoverTableRow && tenantDiscoverTable) {
        tenantDiscoverTableRow.style.display = loginUiEnabled ? '' : 'none';
        tenantDiscoverTable.textContent = 'https://' + (loginDomain || baseDomain || loginUiWorkerDomain) + '/discover';
      }

      const apiPreviewUrl = document.getElementById('preview-issuer').textContent.trim();
      const adminOriginUrl = previewAdmin.textContent.trim();
      const adminPreviewUrl = adminOriginUrl;
      const adminApiModeRow = document.getElementById('preview-admin-api-mode-row');
      const adminApiModeEl = document.getElementById('preview-admin-api-mode');
      if (adminUiEnabled && adminPreviewUrl.startsWith('https://')) {
        adminApiModeRow.style.display = '';
        adminApiModeEl.textContent = describeAdminPreviewMode(
          resolveAdminPreviewMode(apiPreviewUrl, adminPreviewUrl, baseDomain)
        );
        previewAdmin.textContent = adminOriginUrl + '/admin';
      } else {
        adminApiModeRow.style.display = 'none';
      }

      // === Multi-tenant expansion preview ===
      const previewMtSection = document.getElementById('preview-multi-tenant-section');
      const previewIssuerRow = document.getElementById('preview-issuer-row');
      const previewLoginRow  = document.getElementById('preview-login-row');
      const previewAdminRow  = document.getElementById('preview-admin-row');

      if (multiTenantEnabled && baseDomain) {
        previewIssuerRow.style.display = '';
        previewLoginRow.style.display = loginUiEnabled ? '' : 'none';
        previewAdminRow.style.display = adminUiEnabled ? '' : 'none';
        adminApiModeRow.style.display = adminUiEnabled ? '' : 'none';
        previewMtSection.style.display = 'none';

        const firstBase = nakedDomain
          ? 'https://' + baseDomain
          : 'https://' + tenantName + '.' + baseDomain;
        const loginUiBase = loginDomain || loginUiWorkerDomain;
        const adminUiBase = adminDomain || adminUiWorkerDomain;

        document.getElementById('preview-issuer').textContent = firstBase;
        if (loginUiEnabled) previewLogin.textContent = 'https://' + loginUiBase;
        if (tenantDiscoverTable) tenantDiscoverTable.textContent = 'https://' + loginUiBase + '/discover';
        if (adminUiEnabled) previewAdmin.textContent = 'https://' + adminUiBase + '/admin';
        if (adminApiModeEl) {
          adminApiModeEl.textContent = 'cross-site-proxy';
        }

        // Detect invalid settings and show a warning
        // sameAsApi with nakedDomain=false makes API calls to the naked domain return 404
        const loginSameAsApi = loginDomain !== '' && loginDomain === baseDomain;
        const adminSameAsApi2 = adminDomain !== '' && adminDomain === baseDomain;
        const hasConflict =
          ((loginUiEnabled && loginSameAsApi) || (adminUiEnabled && adminSameAsApi2)) &&
          !nakedDomain;

        const warningDiv = document.getElementById('preview-config-warning');
        if (hasConflict) {
          const conflictUI =
            loginUiEnabled && loginSameAsApi ? t('web.comp.loginUi') : t('web.comp.adminUi');
          warningDiv.style.display = '';
          document.getElementById('preview-warning-message').textContent =
            t('web.preview.conflictWarningMsg', { conflictUI, baseDomain });
          document.getElementById('preview-warning-action').textContent =
            t('web.preview.conflictActionMsg', { conflictUI, tenantName, baseDomain });
        } else {
          warningDiv.style.display = 'none';
        }

      } else {
        // Single-tenant mode: show existing rows
        previewIssuerRow.style.display = '';
        previewLoginRow.style.display  = loginUiEnabled ? '' : 'none';
        previewAdminRow.style.display  = adminUiEnabled ? '' : 'none';
        previewMtSection.style.display = 'none';
      }
    }

    function updateComponentOptionUi() {
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      const loginDomainRow = document.getElementById('login-domain-row');
      const adminDomainRow = document.getElementById('admin-domain-row');
      const loginDomainInput = document.getElementById('login-domain');
      const adminDomainInput = document.getElementById('admin-domain');

      if (loginDomainRow) loginDomainRow.style.display = loginUiEnabled ? '' : 'none';
      if (adminDomainRow) adminDomainRow.style.display = adminUiEnabled ? '' : 'none';
      if (loginDomainInput) loginDomainInput.disabled = !loginUiEnabled;
      if (adminDomainInput) adminDomainInput.disabled = !adminUiEnabled;

      document.querySelector('label[for="comp-login-ui"]')?.classList.toggle('on', loginUiEnabled);
      document.querySelector('label[for="comp-admin-ui"]')?.classList.toggle('on', adminUiEnabled);
    }

    function syncUserIdFormatCards() {
      const select = document.getElementById('user-id-format');
      const selected = select?.value || 'nanoid';
      document.querySelectorAll('[data-user-id-format]').forEach((card) => {
        const isSelected = card.getAttribute('data-user-id-format') === selected;
        card.classList.toggle('on', isSelected);
        card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        card.setAttribute('role', 'radio');
        const status = card.querySelector('.st');
        if (status) {
          status.textContent = '';
        }
      });
      const description = document.getElementById('user-id-format-description');
      const example = document.getElementById('user-id-format-example-value');
      const descriptionKey = selected === 'uuid' ? 'userId.uuidDesc' : 'userId.nanoidDesc';
      if (description) {
        description.setAttribute('data-i18n', descriptionKey);
        description.textContent = t(descriptionKey);
      }
      if (example) {
        example.textContent = selected === 'uuid'
          ? '550e8400-e29b-41d4-a716-446655440000'
          : 'V1StGXR8_Z5jdHi6B-myT';
      }
    }

    // Attach event listeners to all inputs
    ['env', 'base-domain', 'enable-multi-tenant', 'naked-domain', 'tenant-name', 'login-domain', 'admin-domain', 'comp-login-ui', 'comp-admin-ui'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updatePreview);
        el.addEventListener('change', updatePreview);
      }
    });

    document.querySelectorAll('[data-user-id-format]').forEach((card) => {
      card.addEventListener('click', () => {
        const select = document.getElementById('user-id-format');
        if (!select) return;
        select.value = card.getAttribute('data-user-id-format') || 'nanoid';
        syncUserIdFormatCards();
        updatePreview();
      });
    });
    document.getElementById('user-id-format')?.addEventListener('change', syncUserIdFormatCards);
    syncUserIdFormatCards();

    document.getElementById('tenant-name-random').addEventListener('click', () => {
      const tenantNameInput = document.getElementById('tenant-name');
      if (tenantNameInput.disabled) {
        return;
      }

      tenantNameInput.value = generateRandomTenantIdInBrowser();
      updatePreview();
    });

    // Validate environment name on blur
    const envInput = document.getElementById('env');
    const envError = document.getElementById('env-error');
    function validateEnvName(value) {
      return /^[a-z][a-z0-9-]*$/.test(value);
    }
    envInput.addEventListener('blur', () => {
      const value = envInput.value.trim();
      if (value && !validateEnvName(value)) {
        envInput.style.borderColor = 'var(--error)';
        if (envError) envError.style.display = 'block';
      } else {
        envInput.style.borderColor = '';
        if (envError) envError.style.display = 'none';
      }
    });
    envInput.addEventListener('input', () => {
      if (envInput.style.borderColor) {
        const value = envInput.value.trim();
        if (!value || validateEnvName(value)) {
          envInput.style.borderColor = '';
          if (envError) envError.style.display = 'none';
        }
      }
    });

    // Update UI based on base domain presence
    function updateBaseDomainUI() {
      const baseDomain = document.getElementById('base-domain').value.trim();
      let domainUiState = getCurrentApiDomainUiState();
      const multiTenantCheckbox = document.getElementById('enable-multi-tenant');
      const multiTenantLabel = document.getElementById('multi-tenant-label');
      const nakedDomainCheckbox = document.getElementById('naked-domain');
      const nakedDomainLabel = document.getElementById('naked-domain-label');
      const nakedDomainHint = document.getElementById('naked-domain-hint');
      const workersDevNote = document.getElementById('workers-dev-note');
      const tenantWorkersNote = document.getElementById('tenant-workers-note');
      const tenantFields = document.getElementById('tenant-fields');
      const tenantNameInput = document.getElementById('tenant-name');
      const tenantNameRandomButton = document.getElementById('tenant-name-random');
      const primaryTenantRow = document.getElementById('primary-tenant-row');
      const primaryTenantInput = document.getElementById('primary-tenant');
      const customDomainBindingRow = document.getElementById('custom-domain-binding-row');

      if (baseDomain) {
        if (multiTenantCheckbox.dataset.userTouched !== 'true') {
          multiTenantCheckbox.checked = true;
          domainUiState = getCurrentApiDomainUiState();
        }
        multiTenantCheckbox.disabled = false;
        multiTenantLabel.style.opacity = '1';
        customDomainBindingRow.style.display = 'grid';
        customDomainBindingRow.style.opacity = '1';
        document.getElementById('custom-domain-binding').disabled = false;
        workersDevNote.style.display = 'none';
      } else {
        // Workers.dev - tenant subdomains not supported
        customDomainBindingRow.style.display = 'grid';
        customDomainBindingRow.style.opacity = '0.5';
        document.getElementById('custom-domain-binding').disabled = true;
        multiTenantCheckbox.checked = false;
        multiTenantCheckbox.disabled = true;
        multiTenantLabel.style.opacity = '0.5';
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.opacity = '0.5';
        primaryTenantInput.value = '';
      }

      if (domainUiState.showNakedDomainControls) {
        nakedDomainCheckbox.disabled = false;
        nakedDomainLabel.style.display = 'grid';
        nakedDomainLabel.style.opacity = '1';
        nakedDomainHint.style.display = 'block';
      } else {
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.display = 'grid';
        nakedDomainLabel.style.opacity = '0.5';
        nakedDomainHint.style.display = 'none';
      }

      workersDevNote.style.display = 'block';
      tenantWorkersNote.style.display = domainUiState.showWorkersDevNote ? 'block' : 'none';
      tenantFields.style.display = domainUiState.showTenantFields ? 'block' : 'none';
      primaryTenantRow.style.display = domainUiState.showPrimaryTenantRow ? 'block' : 'none';

      if (domainUiState.showTenantFields) {
        tenantNameInput.disabled = false;
        tenantNameInput.readOnly = false;
        tenantNameRandomButton.disabled = false;
      } else {
        tenantNameInput.disabled = true;
        tenantNameInput.readOnly = true;
        tenantNameRandomButton.disabled = true;
      }

      document.getElementById('base-domain').placeholder = domainUiState.baseDomainPlaceholder;
      document.getElementById('tenant-url-examples').style.display =
        domainUiState.showExamples ? 'block' : 'none';
      refreshApiDomainUi();
    }

    // Base domain change - update UI for tenant subdomain options
    document.getElementById('base-domain').addEventListener('input', () => {
      updateBaseDomainUI();
      updatePreview();
      // Show/hide domain check row
      const domainCheckRow = document.getElementById('domain-check-row');
      const baseDomain = document.getElementById('base-domain').value.trim();
      if (baseDomain && isValidCustomDomain(baseDomain)) {
        domainCheckRow.style.display = 'block';
        document.getElementById('custom-domain-binding-row').style.display = 'grid';
      } else {
        domainCheckRow.style.display = 'none';
        document.getElementById('domain-check-status').replaceChildren();
        document.getElementById('custom-domain-binding-row').style.display = 'none';
      }
    });

    document.getElementById('enable-multi-tenant').addEventListener('change', (e) => {
      updateBaseDomainUI();
      updatePreview();
    });

    // Check Domain button handler
    let domainZoneId = null;
    document.getElementById('enable-multi-tenant').addEventListener('change', (event) => {
      event.currentTarget.dataset.userTouched = 'true';
    });
    document.getElementById('check-domain-btn').addEventListener('click', async () => {
      const domain = document.getElementById('base-domain').value.trim();
      if (!domain) return;

      const statusEl = document.getElementById('domain-check-status');
      const bindingRow = document.getElementById('custom-domain-binding-row');
      statusEl.replaceChildren(createAlert('info', t('domain.checkingZone', { domain })));
      domainZoneId = null;

      try {
        const result = await api('/cloudflare/check-zone', {
          method: 'POST',
          body: { domain },
        });
        const zoneName = result.zone?.name || result.zoneName || domain;
        const diagnosticAlert = createZoneDiagnosticAlert(result, {
          domain,
          zone: zoneName,
          onRetry: () => document.getElementById('check-domain-btn').click(),
        });

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }

        bindingRow.style.display = result.diagnostic?.allowBinding ? 'flex' : 'none';
        domainZoneId = result.found && result.zone ? result.zone.id : null;
      } catch (e) {
        const diagnosticAlert = createZoneDiagnosticAlert(
          {
            found: false,
            zoneName: domain,
            diagnostic: {
              code: 'api_error',
              severity: 'error',
              allowBinding: false,
              actions: ['retry_check', 'reload_page'],
            },
          },
          {
            domain,
            zone: domain,
            onRetry: () => document.getElementById('check-domain-btn').click(),
          }
        );

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }
        bindingRow.style.display = 'none';
        domainZoneId = null;
      }
    });

    async function checkUiCustomDomainZone(field, options) {
      const inputId = field === 'login' ? 'login-domain' : 'admin-domain';
      const statusId = field === 'login' ? 'login-domain-zone-status' : 'admin-domain-zone-status';
      const label = field === 'login' ? 'Login UI' : 'Admin UI';
      const domain = document.getElementById(inputId).value.trim();
      const statusEl = document.getElementById(statusId);
      const blockOnFailure = options?.blockOnFailure === true;

      statusEl.replaceChildren();
      if (!domain || !isValidCustomDomain(domain) || !uiDomainRequiresOwnRoute(domain)) {
        return true;
      }

      statusEl.replaceChildren(
        createAlert(
          'info',
          label + ': ' + t('domain.checkingZone', { domain })
        )
      );

      try {
        const result = await api('/cloudflare/check-zone', {
          method: 'POST',
          body: { domain },
        });
        const zoneName = result.zone?.name || result.zoneName || domain;
        const diagnosticAlert = createZoneDiagnosticAlert(result, {
          domain,
          zone: zoneName,
          onRetry: () => checkUiCustomDomainZone(field, options),
        });

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }

        const ok = Boolean(result.found && result.zone);
        if (!ok && blockOnFailure) {
          statusEl.appendChild(
            createAlert(
              'error',
              label +
                ' custom domain requires a direct Worker custom-domain route. Confirm that the Cloudflare zone is available before continuing.'
            )
          );
        }
        return ok || !blockOnFailure;
      } catch (e) {
        const diagnosticAlert = createZoneDiagnosticAlert(
          {
            found: false,
            zoneName: domain,
            diagnostic: {
              code: 'api_error',
              severity: 'error',
              allowBinding: false,
              actions: ['retry_check', 'reload_page'],
            },
          },
          {
            domain,
            zone: domain,
            onRetry: () => checkUiCustomDomainZone(field, options),
          }
        );

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }
        if (blockOnFailure) {
          statusEl.appendChild(
            createAlert(
              'error',
              label +
                ' custom domain route cannot be verified right now. Retry the zone check before continuing.'
            )
          );
        }
        return !blockOnFailure;
      }
    }

    // Auto-check domain on blur (debounced)
    let domainCheckTimer;
    document.getElementById('base-domain').addEventListener('blur', () => {
      clearTimeout(domainCheckTimer);
      domainCheckTimer = setTimeout(() => {
        const domain = document.getElementById('base-domain').value.trim();
        if (domain && isValidCustomDomain(domain)) {
          document.getElementById('check-domain-btn').click();
        }
      }, 500);
    });

    let loginDomainCheckTimer;
    let adminDomainCheckTimer;
    document.getElementById('login-domain').addEventListener('blur', () => {
      clearTimeout(loginDomainCheckTimer);
      loginDomainCheckTimer = setTimeout(() => {
        checkUiCustomDomainZone('login', { blockOnFailure: false });
      }, 500);
    });
    document.getElementById('admin-domain').addEventListener('blur', () => {
      clearTimeout(adminDomainCheckTimer);
      adminDomainCheckTimer = setTimeout(() => {
        checkUiCustomDomainZone('admin', { blockOnFailure: false });
      }, 500);
    });

    ['login-domain', 'admin-domain', 'base-domain', 'enable-multi-tenant', 'naked-domain'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        document.getElementById('login-domain-zone-status').replaceChildren();
        document.getElementById('admin-domain-zone-status').replaceChildren();
      });
      el.addEventListener('change', () => {
        document.getElementById('login-domain-zone-status').replaceChildren();
        document.getElementById('admin-domain-zone-status').replaceChildren();
      });
    });

    // Initial UI state
    updateBaseDomainUI();

    // Naked domain toggle - show/hide tenant name field and update placeholder
    document.getElementById('naked-domain').addEventListener('change', () => {
      updateBaseDomainUI();
      updatePreview();
    });

    document.getElementById('btn-back-mode').addEventListener('click', () => {
      setStep(2);
      showSection('topMenu');
    });

    function getEnvironmentExistsAlertActionCopy() {
      const locale = String(_currentLocale || 'en').toLowerCase();
      if (locale.startsWith('ja')) {
        return '別の名前を選択するか、「環境を管理する」から先に削除してください。';
      }
      if (locale.startsWith('zh-cn')) {
        return '请选择其他名称，或先通过“管理环境”删除该环境。';
      }
      if (locale.startsWith('zh-tw')) {
        return '請選擇其他名稱，或先透過「管理環境」刪除該環境。';
      }
      if (locale.startsWith('es')) {
        return 'Elige otro nombre o elimínalo primero desde "Administrar entornos".';
      }
      if (locale.startsWith('pt')) {
        return 'Escolha outro nome ou exclua este ambiente primeiro em "Gerenciar ambientes".';
      }
      if (locale.startsWith('fr')) {
        return 'Choisissez un autre nom ou supprimez d’abord cet environnement dans « Gérer les environnements ».';
      }
      if (locale.startsWith('de')) {
        return 'Wähle einen anderen Namen oder lösche die Umgebung zuerst über „Umgebungen verwalten“.';
      }
      if (locale.startsWith('ko')) {
        return '다른 이름을 선택하거나 먼저 “환경 관리”에서 이 환경을 삭제하세요.';
      }
      if (locale.startsWith('id')) {
        return 'Pilih nama lain atau hapus lingkungan ini terlebih dahulu dari "Kelola Lingkungan".';
      }
      if (locale.startsWith('ru')) {
        return 'Выберите другое имя или сначала удалите эту среду в разделе «Управление средами».';
      }
      return 'Please choose a different name or delete this environment from "Manage Environments" first.';
    }

    function formatEnvironmentExistsAlert(envName, existingEnv) {
      const workers = existingEnv?.workers?.length || 0;
      const d1 = existingEnv?.d1?.length || 0;
      const kv = existingEnv?.kv?.length || 0;
      return [
        t('env.alreadyExists', { env: envName }),
        '',
        t('env.workers', { count: workers }) +
          ', ' +
          t('env.d1Databases', { count: d1 }) +
          ', ' +
          t('env.kvNamespaces', { count: kv }),
        '',
        getEnvironmentExistsAlertActionCopy(),
      ].join('\\n');
    }

    document.getElementById('btn-configure').addEventListener('click', async () => {
      const domainDepthIssues = refreshDomainDepthValidation();
      if (domainDepthIssues.length > 0) {
        const firstIssue = domainDepthIssues[0];
        const focusMap = {
          apiDomain: 'base-domain',
          loginUiDomain: 'login-domain',
          adminUiDomain: 'admin-domain',
        };
        document.getElementById(focusMap[firstIssue.field])?.focus();
        return;
      }

      // Get and validate environment name
      const envRaw = document.getElementById('env').value.trim();
      if (!envRaw || !validateEnvName(envRaw)) {
        document.getElementById('env').style.borderColor = 'var(--error)';
        const errEl = document.getElementById('env-error');
        if (errEl) errEl.style.display = 'block';
        document.getElementById('env').focus();
        return;
      }
      const env = envRaw;

      // Check if environment already exists
      const configureBtn = document.getElementById('btn-configure');
      const originalText = configureBtn.textContent;
      configureBtn.textContent = t('web.status.checking');
      configureBtn.disabled = true;

      try {
        const envResult = await api('/environments');
        if (envResult.success && envResult.environments) {
          const existingEnv = envResult.environments.find(
            e => getEnvironmentNameFromDetection(e).toLowerCase() === env.toLowerCase()
          );
          if (existingEnv) {
            alert(formatEnvironmentExistsAlert(env, existingEnv));
            return;
          }
        }
      } catch (e) {
        // Continue if check fails - will catch errors later
        console.warn('Environment check failed:', e);
      } finally {
        configureBtn.textContent = originalText;
        configureBtn.disabled = false;
      }

      // The step 4 header already shows the chosen environment. Store the validated name before
      // changing steps so the generic placeholder is never flashed while the full config is built.
      config = { ...(config || {}), env };
      setStep(4);
      showSection('domain');
      updateBaseDomainUI();
      updatePreview();
    });

    document.getElementById('btn-back-domain').addEventListener('click', () => {
      setStep(3);
      showSection('config');
    });

    document.getElementById('btn-domain-continue').addEventListener('click', async () => {
      const domainDepthIssues = refreshDomainDepthValidation();
      if (domainDepthIssues.length > 0) {
        const firstIssue = domainDepthIssues[0];
        const focusMap = {
          apiDomain: 'base-domain',
          loginUiDomain: 'login-domain',
          adminUiDomain: 'admin-domain',
        };
        document.getElementById(focusMap[firstIssue.field])?.focus();
        return;
      }

      const envRaw = document.getElementById('env').value.trim();
      if (!envRaw || !validateEnvName(envRaw)) {
        setStep(3);
        showSection('config');
        document.getElementById('env').style.borderColor = 'var(--error)';
        const errEl = document.getElementById('env-error');
        if (errEl) errEl.style.display = 'block';
        document.getElementById('env').focus();
        return;
      }
      const env = envRaw;
      const baseDomain = document.getElementById('base-domain').value.trim();
      const hasCustomApiDomain = !!baseDomain;
      const multiTenantEnabled =
        hasCustomApiDomain && document.getElementById('enable-multi-tenant').checked;
      const nakedDomain = multiTenantEnabled && document.getElementById('naked-domain').checked;
      const tenantName = multiTenantEnabled
        ? (document.getElementById('tenant-name').value.trim() || 'default')
        : 'default';
      const tenantDisplayName = document.getElementById('tenant-display').value.trim() || 'Initial Tenant';
      const userIdFormat = document.getElementById('user-id-format').value || 'nanoid';
      const primaryTenant = multiTenantEnabled && nakedDomain
        ? tenantName
        : undefined;
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;

      if (!isValidTenantId(tenantName)) {
        showTenantIdValidationError('tenant-name', 'Initial Tenant ID');
        return;
      }
      const loginZoneOk =
        !loginUiEnabled || (await checkUiCustomDomainZone('login', { blockOnFailure: true }));
      const adminZoneOk =
        !adminUiEnabled || (await checkUiCustomDomainZone('admin', { blockOnFailure: true }));
      if (!loginZoneOk || !adminZoneOk) {
        document.getElementById(!loginZoneOk ? 'login-domain' : 'admin-domain').focus();
        return;
      }

      config = {
        env,
        apiDomain: baseDomain || null,
        loginUiDomain: loginDomain || null,
        adminUiDomain: adminDomain || null,
        tenant: {
          name: tenantName,
          displayName: tenantDisplayName,
          placementPolicy: 'tenant_exclusive',
          multiTenant: multiTenantEnabled,
          baseDomain: multiTenantEnabled ? baseDomain : undefined,
          nakedDomain: nakedDomain,
          userIdFormat: userIdFormat,
          primaryTenant: primaryTenant,
        },
        components: {
          api: true,
          loginUi: loginUiEnabled,
          adminUi: adminUiEnabled,
          saml: true,
          async: true,
          vc: true,
          bridge: true, // Standard component
          policy: true, // Standard component
        },
        features: {
          queue: { enabled: false },
          r2: { enabled: true },
          email: { provider: 'none' },
        },
        profiles: buildProfilesConfig(),
        controlPlane: { automaticProvisioning: true },
        zoneId: domainZoneId || null,
        customDomainBinding: baseDomain
          ? (document.getElementById('custom-domain-binding')?.checked ?? false)
          : false,
      };

      // Create default config with component settings
      const customDomainBinding = document.getElementById('custom-domain-binding')?.checked ?? false;
      await api('/config/default', {
        method: 'POST',
        body: {
          env,
          apiDomain: config.apiDomain,
          loginUiDomain: loginDomain,
          adminUiDomain: adminDomain,
          tenant: config.tenant,
          components: config.components,
          zoneId: domainZoneId || null,
          customDomainBinding: config.apiDomain ? customDomainBinding : false,
          profiles: config.profiles,
        },
      });

      // Update resource preview with the selected env
      updateResourcePreview(env);
      updateProvisionButtons();
      renderDeployManualWildcardWarning();

      // Go to database configuration step
      setStep(5);
      showSection('database');
    });

    document.getElementById('btn-back-config').addEventListener('click', () => {
      // Go back to email configuration (previous step in the flow)
      setStep(6);
      showSection('email');
    });

    // Database configuration handlers
    document.getElementById('btn-back-database').addEventListener('click', () => {
      setStep(4);
      showSection('domain');
    });

    document.getElementById('btn-continue-database').addEventListener('click', () => {
      // Get selected values
      const coreLocation = document.querySelector('input[name="db-core-location"]:checked').value;
      const piiLocation = document.querySelector('input[name="db-pii-location"]:checked').value;

      // Parse location vs jurisdiction
      function parseDbLocation(value) {
        if (value === 'eu') {
          return { location: 'auto', jurisdiction: 'eu' };
        }
        return { location: value, jurisdiction: 'none' };
      }

      // Add database config to config object
      config.database = {
        core: parseDbLocation(coreLocation),
        pii: parseDbLocation(piiLocation),
      };
      config.profiles = {
        ...(config.profiles || buildProfilesConfig()),
        defaults: {
          ...((config.profiles && config.profiles.defaults) || {}),
          audit: config.profiles?.defaults?.audit || 'builtin:audit:standard',
          residency: config.profiles?.defaults?.residency || 'builtin:residency:default',
        },
        registry: config.profiles?.registry || { backend: 'kv' },
        references: config.profiles?.references || { hyperdrive: {} },
        seed: config.profiles?.seed || { audit: [], residency: [] },
      };
      config.controlPlane = { automaticProvisioning: automaticProvisioningEnabled() };

      // Proceed to email configuration
      setStep(6);
      showSection('email');
    });

    // Email configuration handlers
    function syncFeatureQueueUi() {
      const input = document.getElementById('feature-queue-enabled');
      const state = document.querySelector('#feature-queue-row .sw-state');
      if (!input || !state) return;
      state.textContent = input.checked ? state.dataset.on : state.dataset.off;
    }

    function syncEmailChoiceUi() {
      const cloudflareForm = document.getElementById('cloudflare-config-form');
      const resendForm = document.getElementById('resend-config-form');
      const checked = document.querySelector('input[name="email-setup-choice"]:checked');
      const choice = checked?.value || 'later';

      document.querySelectorAll('.email-choice-card').forEach((card) => {
        const input = card.querySelector('input[name="email-setup-choice"]');
        card.classList.toggle('on', input?.checked === true);
      });

      if (choice === 'cloudflare') {
        cloudflareForm.classList.remove('hidden');
        resendForm.classList.add('hidden');
      } else if (choice === 'resend') {
        cloudflareForm.classList.add('hidden');
        resendForm.classList.remove('hidden');
      } else {
        cloudflareForm.classList.add('hidden');
        resendForm.classList.add('hidden');
      }
    }

    document.getElementById('feature-queue-enabled').addEventListener('change', syncFeatureQueueUi);

    // Toggle provider form visibility
    document.querySelectorAll('input[name="email-setup-choice"]').forEach(radio => {
      radio.addEventListener('change', syncEmailChoiceUi);
    });

    syncFeatureQueueUi();
    syncEmailChoiceUi();

    document.getElementById('btn-back-email').addEventListener('click', () => {
      setStep(5);
      showSection('database');
    });

    document.getElementById('btn-continue-email').addEventListener('click', async () => {
      const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
      const btn = document.getElementById('btn-continue-email');
      const queueEnabled = document.getElementById('feature-queue-enabled').checked === true;
      config.features = {
        ...(config.features || {}),
        queue: { enabled: queueEnabled },
        r2: config.features?.r2 || { enabled: true },
        email: config.features?.email || { provider: 'none' },
      };

      if (choice === 'cloudflare' || choice === 'resend') {
        // Validate and store email configuration
        const isCloudflare = choice === 'cloudflare';
        const apiKey = document.getElementById('resend-api-key').value.trim();
        const fromAddress = isCloudflare
          ? document.getElementById('cloudflare-from-address').value.trim()
          : document.getElementById('email-from-address').value.trim();
        const fromName = isCloudflare
          ? document.getElementById('cloudflare-from-name').value.trim()
          : document.getElementById('email-from-name').value.trim();

	        // Validate API key format
	        if (!isCloudflare && !apiKey) {
	          alert(t('web.email.resendApiKeyMissing'));
	          return;
	        }
	        if (!isCloudflare && !apiKey.startsWith('re_')) {
	          if (!confirm(t('web.email.resendApiKeyConfirmInvalid'))) {
	            return;
	          }
	        }

	        // Validate email address
	        if (!fromAddress) {
	          alert(t('web.email.fromEmailMissing'));
	          return;
	        }
	        if (!fromAddress.includes('@')) {
	          alert(t('web.email.fromEmailInvalid'));
	          return;
	        }

        // Save email configuration to server
        btn.disabled = true;
        btn.textContent = t('web.status.saving');

        try {
          const result = await api('/email/configure', {
            method: 'POST',
            body: {
              env: config.env,
              provider: isCloudflare ? 'cloudflare' : 'resend',
              apiKey: isCloudflare ? undefined : apiKey,
              fromAddress: fromAddress,
              fromName: fromName || undefined,
            },
	          });

	          if (!result.success) {
	            throw new Error(result.error || t('web.email.saveConfigFailed'));
	          }

          // Store email configuration (without apiKey for config file)
          config.email = {
            provider: isCloudflare ? 'cloudflare' : 'resend',
            fromAddress: fromAddress,
            fromName: fromName || undefined,
            configured: true,
          };
          config.features.email = {
            ...(config.features.email || {}),
            ...config.email,
          };
	        } catch (error) {
	          alert(t('web.email.saveConfigFailed') + ': ' + error.message);
	          btn.disabled = false;
	          btn.textContent = t('web.btn.continue');
	          return;
        }

        btn.disabled = false;
        btn.textContent = t('web.btn.continue');
      } else {
        // Configure later - no email provider
        config.email = {
          provider: 'none',
        };
        config.features.email = {
          ...(config.features.email || {}),
          provider: 'none',
        };
      }

      // Show save config modal before proceeding
      const modal = document.getElementById('save-config-modal');
      modal.classList.remove('hidden');
    });

    // Modal handlers
    document.getElementById('modal-skip-save').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    document.getElementById('modal-save-config').addEventListener('click', async () => {
      const modal = document.getElementById('save-config-modal');
      const btn = document.getElementById('modal-save-config');
      btn.disabled = true;
      btn.textContent = t('web.status.saving');

      try {
        await saveConfigToFile();
        modal.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = t('web.btn.saveConfiguration');
        proceedToProvision();
      } catch (error) {
        alert(t('web.config.saveFailed', { error: error.message }));
        btn.disabled = false;
        btn.textContent = t('web.btn.saveConfiguration');
      }
    });

    // Close modal on backdrop click
    document.querySelector('.modal-backdrop').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    function proceedToProvision() {
      updateResourcePreview(config.env);
      renderDeployManualWildcardWarning();
      setStep(7);
      showSection('provision');
    }

    // Provision
    document.getElementById('btn-provision').addEventListener('click', async () => {
      const btn = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const btnSaveConfig = document.getElementById('btn-save-config-provision');
      const status = document.getElementById('provision-status');
      const log = document.getElementById('provision-log');
      const output = document.getElementById('provision-output');
      const resourcePreview = document.getElementById('resource-preview');
      const keysSavedInfo = document.getElementById('keys-saved-info');
      const keysPath = document.getElementById('keys-path');
      const progressUI = document.getElementById('provision-progress-ui');

      // Confirmation dialog for re-provisioning
      if (provisioningCompleted) {
        const confirmed = confirm(
          t('web.provision.reprovisionConfirm')
        );
        if (!confirmed) {
          return;
        }
      }

      btn.disabled = true;
      btn.classList.add('hidden');
      btnSaveConfig.classList.remove('hidden');
      btnGotoDeploy.classList.remove('hidden');
      btnGotoDeploy.disabled = true;
      const totalProvisionTasks = 8;
      status.textContent = t('web.provision.runningTasks', {
        current: 0,
        total: totalProvisionTasks,
      });
      status.className = '';
      progressUI.classList.remove('hidden');
      dismissSetupProgressPreludes(['provision-preflight-row']);
      setLogVisibility('provision-log-toggle', 'provision-log', true);
      resourcePreview.classList.remove('hidden');
      keysSavedInfo.classList.add('hidden');
      output.textContent = '';

      const provisionProgress = createProvisionProgressTracker(totalProvisionTasks);
      updateProgressUI('provision', 0, totalProvisionTasks, t('web.status.initializing'));

      // Start polling for progress
      let lastProgressLength = 0;
      provisionPollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            // Append new progress messages
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += formatProgressMessageForDisplay(msg) + '\\n';
              provisionProgress.handle(msg);
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        } catch (e) {
          // Ignore polling errors
        }
      }, 500);

      try {
        // Generate keys
        output.textContent += t('keys.generating') + '\\n';
        scrollToBottom(log);
        const keyResult = await api('/keys/generate', {
          method: 'POST',
          body: { keyId: config.env + '-key-' + Date.now(), env: config.env },
        });
        if (!keyResult.success) {
          throw new Error(apiErrorMessages(keyResult).join('; '));
        }
        output.textContent += '  ✓ RSA key pair generated\\n';
        output.textContent += '  ✓ Encryption keys generated\\n';
        output.textContent += '  ✓ Admin secrets generated\\n';
        if (keyResult.reusedExistingKeys === true) {
          output.textContent += '  ✓ Existing environment keys reused\\n';
        }
        output.textContent += '\\n';
        provisionProgress.handle('Admin secrets generated');
        scrollToBottom(log);

        const generatedKeysPath =
          keyResult && keyResult.keysPath
            ? String(keyResult.keysPath)
            : '.authrim-keys/' + config.env;
        keysPath.textContent = generatedKeysPath.endsWith('/')
          ? generatedKeysPath
          : generatedKeysPath + '/';
        keysSavedInfo.classList.remove('hidden');

        // Provision resources
        output.textContent += 'Provisioning Cloudflare resources...\\n';
        scrollToBottom(log);

        const result = await api('/provision', {
          method: 'POST',
          body: {
            env: config.env,
            databaseConfig: config.database,
            createQueues: config.features?.queue?.enabled === true,
            createR2: true,
            automaticProvisioning: config.controlPlane?.automaticProvisioning === true,
          },
        });

        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        if (result.success) {
          // Final progress update
          provisionProgress.complete();
          output.textContent += '\\n' + t('web.status.complete') + '\\n';
          if (result.savedPaths) {
            output.textContent += 'Config: ' + result.savedPaths.config + '\\n';
            output.textContent += 'Lock:   ' + result.savedPaths.lock + '\\n';
            if (result.savedPaths.log) {
              output.textContent += 'Log:    ' + result.savedPaths.log + '\\n';
            }
          }
          scrollToBottom(log);
          status.textContent = t('web.status.complete');
          status.className = '';

          // Mark provisioning as completed
          provisioningCompleted = true;

          btn.textContent = t('web.btn.reprovision');
          btn.classList.remove('hidden', 'btn-next');
          btn.classList.add('btn-ghost');
          btn.disabled = false;
          btnGotoDeploy.disabled = false;
          btnGotoDeploy.classList.remove('hidden');
        } else {
          if (result.logPath) {
            output.textContent += '\\nLog: ' + result.logPath + '\\n';
          }
          throw new Error(result.error);
        }
      } catch (error) {
        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        output.textContent += '\\nError: ' + error.message + '\\n';
        markProgressBarError('provision');
        scrollToBottom(log);
        status.textContent = t('web.status.error');
        status.className = '';
        btn.classList.remove('hidden');
        btn.disabled = false;
        btnGotoDeploy.disabled = !provisioningCompleted;
        resourcePreview.classList.remove('hidden');
      }
    });

    // Continue to Deploy button
    document.getElementById('btn-goto-deploy').addEventListener('click', () => {
      setStep(8);
      showSection('deploy');
    });

    document.getElementById('btn-back-provision').addEventListener('click', () => {
      setStep(7);
      // Update buttons based on provisioning status
      updateProvisionButtons();
      // Show resource preview if not completed
      if (!provisioningCompleted) {
        document.getElementById('resource-preview').classList.remove('hidden');
      }
      showSection('provision');
    });

    document.getElementById('keys-copy-btn').addEventListener('click', async () => {
      const keysPath = document.getElementById('keys-path').textContent || '';
      await copyTextWithFeedback(document.getElementById('keys-copy-btn'), keysPath);
    });

    let controlBootstrapOwnership = null;
    document
      .getElementById('btn-create-control-bootstrap-token')
      .addEventListener('click', async () => {
        const status = document.getElementById('control-bootstrap-token-status');
        const dashboardWindow = window.open('about:blank', '_blank');
        if (dashboardWindow) dashboardWindow.opener = null;
        const result = await api('/cloudflare/control-token-template', {
          method: 'POST',
          body: { env: config.env },
        });
        if (!result.success || !result.url || !result.expiresOnDate) {
          dashboardWindow?.close();
          status.textContent = result.error || t('web.control.tokenLinkFailed');
          return;
        }
        resumeControlBootstrapReady = false;
        controlBootstrapOwnership = result.ownership;
        if (dashboardWindow) dashboardWindow.location.replace(result.url);
        status.textContent = dashboardWindow
          ? t('web.deploy.bootstrapTokenCreateStatus', { endDate: result.expiresOnDate })
          : t('web.deploy.bootstrapPopupBlocked');
      });

    document
      .getElementById('btn-env-create-control-bootstrap-token')
      .addEventListener('click', async () => {
        if (!selectedEnvForDetail) return;
        const status = document.getElementById('env-control-automatic-message');
        const dashboardWindow = window.open('about:blank', '_blank');
        if (dashboardWindow) dashboardWindow.opener = null;
        const result = await api('/cloudflare/control-token-template', {
          method: 'POST',
          body: { env: selectedEnvForDetail.env },
        });
        if (!result.success || !result.url || !result.expiresOnDate) {
          dashboardWindow?.close();
          status.textContent = result.error || t('web.control.tokenLinkFailed');
          return;
        }
        envControlBootstrapOwnership = result.ownership;
        if (dashboardWindow) dashboardWindow.location.replace(result.url);
        status.textContent = dashboardWindow
          ? t('web.envDetail.enterOneTimeTokenThenEnable', { endDate: result.expiresOnDate })
          : t('web.envDetail.bootstrapPopupBlocked');
      });

    document
      .getElementById('btn-env-enable-control-automatic')
      .addEventListener('click', async () => {
        if (!selectedEnvForDetail) return;
        const envName = selectedEnvForDetail.env;
        const input = document.getElementById('env-control-bootstrap-token');
        const button = document.getElementById('btn-env-enable-control-automatic');
        const status = document.getElementById('env-control-automatic-message');
        let bootstrapToken = input.value.trim();
        let bootstrapSubmitted = false;
        const recoveringCutover = envControlBootstrapPhase !== 'none';
        if (!bootstrapToken && !recoveringCutover) {
          status.textContent = t('web.envDetail.enterOneTimeTokenFirst');
          input.focus();
          return;
        }
        button.disabled = true;
        status.textContent = t('web.envDetail.preparingControlAuthority');
        try {
          if (!recoveringCutover) {
            const prepared = await api('/control/automatic-provisioning/prepare', {
              method: 'POST',
              body: {
                env: envName,
                ...(envControlBootstrapOwnership
                  ? { ownership: envControlBootstrapOwnership }
                  : {}),
              },
            });
            if (!prepared.success) throw new Error(prepared.error || t('web.control.preparationFailed'));
            status.textContent = t('web.envDetail.deployingControlWorker');
            const deployed = await api('/deploy/component/ar-control', {
              method: 'POST',
              body: {
                env: envName,
                dryRun: false,
                skipBuild: false,
                initialControlBootstrap: true,
              },
            });
            if (!deployed.success) throw new Error(deployed.error || t('web.control.deploymentFailed'));
          }
          status.textContent = t('web.envDetail.registeringScopedCredentials');
          bootstrapSubmitted = true;
          input.value = '';
          const completed = await api('/control/automatic-provisioning/complete', {
            method: 'POST',
            body: {
              env: envName,
              ...(bootstrapToken ? { bootstrapToken } : {}),
              ...(envControlBootstrapOwnership
                ? { ownership: envControlBootstrapOwnership }
                : {}),
            },
          });
          if (!completed.success) {
            const completionError = new Error(
              completed.error || t('web.control.credentialBootstrapFailed')
            );
            completionError.cleanupRequired = completed.cleanupRequired === true;
            completionError.bootstrapRetainedForRetry =
              completed.bootstrapRetainedForRetry === true;
            completionError.cutoverPending = completed.cutoverPending === true;
            completionError.recoveryTokenRequired = completed.recoveryTokenRequired === true;
            throw completionError;
          }
          envControlBootstrapOwnership = null;
          await loadEnvControlAutomaticProvisioning(envName);
        } catch (error) {
          if (!bootstrapSubmitted && bootstrapToken) {
            input.value = bootstrapToken;
            status.textContent =
              (error.message || t('web.control.automaticProvisioningPaused')) +
              ' ' +
              t('web.envDetail.bootstrapNotSubmittedForRetry');
            input.focus();
            return;
          }
          if (error.recoveryTokenRequired === true) {
            envControlBootstrapOwnership = null;
            document
              .getElementById('btn-env-create-control-bootstrap-token')
              .classList.remove('hidden');
            status.textContent = t('web.control.revocationRecoveryRequired', {
              error: error.message || t('web.control.revocationInterrupted'),
            });
            input.focus();
            return;
          }
          if (recoveringCutover || error.cutoverPending === true) {
            status.textContent = t('web.control.cutoverResumeRequired', {
              error: error.message || t('web.control.cutoverPaused'),
            });
            return;
          }
          if (error.bootstrapRetainedForRetry === true) {
            status.textContent =
              (error.message || t('web.control.automaticProvisioningPaused')) +
              ' ' +
              t('web.envDetail.bootstrapRetainedForRetry');
            input.focus();
            return;
          }
          let cleanupConfirmed = error.cleanupRequired === false;
          if (!cleanupConfirmed) {
            try {
              const cleanup = await api('/control/automatic-provisioning/cleanup-bootstrap', {
                method: 'POST',
                body: {
                  env: envName,
                  bootstrapToken,
                  ...(envControlBootstrapOwnership
                    ? { ownership: envControlBootstrapOwnership }
                    : {}),
                },
              });
              cleanupConfirmed = cleanup.success === true && cleanup.revoked === true;
            } catch {
              cleanupConfirmed = false;
            }
          }
          const manualCleanup = error.cleanupRequired === true || !cleanupConfirmed;
          let pendingCanceled = false;
          if (!manualCleanup) {
            try {
              const canceled = await api('/control/automatic-provisioning/cancel-pending', {
                method: 'POST',
                body: { env: envName },
              });
              pendingCanceled = canceled.success === true && canceled.enabled === false;
            } catch {
              pendingCanceled = false;
            }
          }
          status.textContent = manualCleanup
            ? (error.message || t('web.control.automaticProvisioningFailed')) +
              ' ' + t('web.envDetail.revokeTokensBeforeRetry')
            : !pendingCanceled
              ? (error.message || t('web.control.automaticProvisioningFailed')) +
                ' ' + t('web.envDetail.bootstrapRevokedPendingReset')
              : (error.message || t('web.control.automaticProvisioningFailed')) +
                ' ' + t('web.envDetail.bootstrapRevokedDisabled');
        } finally {
          bootstrapToken = '';
          button.disabled = false;
        }
      });

    // Deploy
    document.getElementById('btn-deploy').addEventListener('click', async () => {
      const btn = document.getElementById('btn-deploy');
      const btnBack = document.getElementById('btn-back-provision');
      const btnCancel = document.getElementById('btn-cancel-deploy');
      const btnGotoComplete = document.getElementById('btn-goto-complete');
      const status = document.getElementById('deploy-status');
      const log = document.getElementById('deploy-log');
      const output = document.getElementById('deploy-output');
      const progressUI = document.getElementById('deploy-progress-ui');
      const readyText = document.getElementById('deploy-ready-text');
      const bootstrapTokenInput = document.getElementById('control-bootstrap-token');
      const bootstrapToken = bootstrapTokenInput.value.trim();

      if (
        automaticProvisioningEnabled() &&
        !resumeControlBootstrapReady &&
        (!bootstrapToken || !controlBootstrapOwnership)
      ) {
        document.getElementById('control-bootstrap-token-status').textContent =
          t('web.deploy.bootstrapTokenRequired');
        // A wildcard-DNS preflight can return before the one-time Control token is consumed.
        // Keep the credential step reachable on retry instead of leaving the operator on a
        // re-check button that silently returns because its hidden prerequisite is missing.
        restoreSetupProgressPreludes([
          'control-token-bootstrap-row',
          'deploy-manual-wildcard-warning',
        ]);
        syncAutomaticProvisioningUi();
        bootstrapTokenInput.focus();
        return;
      }

      btn.disabled = true;
      btn.classList.add('hidden');
      btnBack.classList.add('hidden');
      btnGotoComplete.disabled = true;
      deployedWorkerNames.clear();
      updateDeployedWorkerCount([]);
      status.className = '';
      readyText.classList.add('hidden');
      progressUI.classList.remove('hidden');
      dismissSetupProgressPreludes([
        'control-token-bootstrap-row',
        'deploy-manual-wildcard-warning',
      ]);
      setLogVisibility('deploy-log-toggle', 'deploy-log', false);
      output.textContent = t('web.status.startingDeploy') + '\\n\\n';

      let pollInterval = null;
      let lastProgressLength = 0;
      lastRenderedDeployStep = 1;
      updateProgressUI('deploy', 0, 100, t('web.status.initializing'));
      renderDeploymentSnapshot({
        operation: 'deploy',
        phase: 'preparation',
        step: 1,
        totalSteps: 10,
        status: 'running',
        message: t('web.status.startingDeploy'),
      });

      try {
        // Generate wrangler configs first
        output.textContent += 'Generating wrangler.toml files...\\n';
        scrollToBottom(log);
        await api('/wrangler/generate', {
          method: 'POST',
          body: { env: config.env },
        });
        output.textContent += '✓ Config files generated\\n\\n';
        scrollToBottom(log);

        // Start deployment
        output.textContent += 'Deploying workers...\\n';
        scrollToBottom(log);

        // Poll for status updates
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            const progress = statusResult.progress || [];
            if (progress.length < lastProgressLength) {
              lastProgressLength = 0;
            }
            if (progress.length > lastProgressLength) {
              const newMessages = progress.slice(lastProgressLength);
              newMessages.forEach(msg => {
                output.textContent += formatProgressMessageForDisplay(msg) + '\\n';
              });
              lastProgressLength = progress.length;
              scrollToBottom(log);
            }
            updateDeployedWorkerCount(progress);
            if (statusResult.deploymentProgress) {
              renderDeploymentSnapshot(statusResult.deploymentProgress);
            }
          } catch (e) {
            // Ignore transient polling errors while deployment is running.
          }
        }, 1000);

        const result = await api('/deploy', {
          method: 'POST',
          body: {
            env: config.env,
            dryRun: false,
            ...(resumeWorkerOwnershipRecovery ? { recoverWorkerOwnership: true } : {}),
            ...(automaticProvisioningEnabled() && !resumeControlBootstrapReady
              ? {
                  bootstrapToken,
                  tokenOwnership: controlBootstrapOwnership,
                }
              : {}),
          },
        });

        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }

        if (result.success) {
          bootstrapTokenInput.value = '';
          // Final progress update
          renderDeploymentSnapshot({
            operation: 'deploy',
            phase: 'ui',
            step: 10,
            totalSteps: 10,
            status: 'complete',
            message: t('web.deploy.phase.complete'),
          });
          output.textContent += '\\n✓ Deployment complete!\\n';
          if (result.logPath) {
            output.textContent += 'Log: ' + result.logPath + '\\n';
          }
          scrollToBottom(log);

          // Complete admin setup to get setup URL
          output.textContent += '\\nSetting up initial admin...\\n';
          scrollToBottom(log);
          const workersDomain = workersSubdomain
            ? config.env + '-ar-router.' + workersSubdomain + '.workers.dev'
            : config.env + '-ar-router.workers.dev';
          // Build API URL
          // Note: Tenant subdomain only works with custom domains, NOT workers.dev
          let apiUrl;
          if (config.apiDomain) {
            const apiDomain = stripProtocol(config.apiDomain);
            if (config.tenant?.multiTenant && config.tenant.name && !config.tenant.nakedDomain) {
              apiUrl = 'https://' + config.tenant.name + '.' + apiDomain;
            } else {
              apiUrl = 'https://' + apiDomain;
            }
          } else {
            // Workers.dev - no tenant prefix (wildcard subdomains not supported)
            apiUrl = 'https://' + workersDomain;
          }
          // Login UI URL for setup page (setup page is in Login UI, not API)
          const loginUiWorkerDomain = workersSubdomain
            ? config.env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
            : config.env + '-ar-login-ui.workers.dev';
          const loginUiUrl = config.loginUiDomain
            ? ensureHttpsUrl(config.loginUiDomain)
            : 'https://' + loginUiWorkerDomain;

          output.textContent += '  API URL: ' + apiUrl + '\\n';
          output.textContent += '  Login UI URL: ' + loginUiUrl + '\\n';
          output.textContent += '  Keys Dir: .authrim-keys/' + config.env + '/\\n';
          scrollToBottom(log);

          let adminSetupResult;
          try {
            adminSetupResult = await api('/admin/setup', {
              method: 'POST',
              body: {
                env: config.env,
                baseUrl: apiUrl,  // Setup page is served by ar-auth worker (API)
                // keysDir is auto-detected by API using paths.ts
              },
            });
            output.textContent += '  API Response: ' + JSON.stringify(adminSetupResult) + '\\n';
            scrollToBottom(log);
          } catch (adminError) {
            output.textContent += '  ✗ Admin setup API error: ' + adminError.message + '\\n';
            scrollToBottom(log);
            adminSetupResult = { success: false, error: adminError.message };
          }

          if (adminSetupResult.success && adminSetupResult.setupUrl) {
            output.textContent += '✓ Admin setup ready!\\n';
            output.textContent += '  Setup URL: ' + adminSetupResult.setupUrl + '\\n';
          } else if (adminSetupResult.alreadyCompleted) {
            output.textContent += 'Info: Admin setup already completed\\n';
          } else if (adminSetupResult.error) {
            output.textContent += 'Warning: Admin setup warning: ' + adminSetupResult.error + '\\n';
          } else {
            output.textContent += 'Warning: Admin setup: No setup URL returned\\n';
          }
          scrollToBottom(log);

          status.textContent = t('web.status.complete');
          status.className = '';

          // Show completion with setup URL, expiration time, and debug info
          showComplete({
            ...result,
            setupUrl: adminSetupResult.setupUrl,
            expiresAt: adminSetupResult.expiresAt,
            adminSetupDebug: adminSetupResult,
          });
        } else if (result.manualAction?.kind === 'wildcard-dns' && result.manualAction.baseDomain) {
          config.manualAction = result.manualAction;
          renderDeployManualWildcardWarning();
          // DNS validation happens before Control token consumption. Preserve the one-time token
          // in this page and keep both prerequisites visible so a DNS retry is a single explicit
          // action rather than an invisible-token failure.
          restoreSetupProgressPreludes([
            'control-token-bootstrap-row',
            'deploy-manual-wildcard-warning',
          ]);
          syncAutomaticProvisioningUi();
          output.textContent += '\\n' + buildWildcardDnsManualMessage(result.manualAction.baseDomain) + '\\n';
          if (result.logPath) {
            output.textContent += '\\nLog: ' + result.logPath + '\\n';
          }
          scrollToBottom(log);
          status.textContent = t('web.deploy.manualWildcardTitle');
          status.className = '';
          btn.disabled = false;
          btn.classList.add('hidden');
          btnBack.classList.remove('hidden');
          btnCancel.classList.add('hidden');
          btnGotoComplete.classList.add('hidden');
          renderDeploymentSnapshot({
            operation: 'deploy',
            phase: 'routing',
            step: 8,
            totalSteps: 10,
            status: 'warning',
            message: t('web.deploy.manualWildcardTitle'),
            terminal: true,
          });
          return;
        } else {
          if (result.logPath) {
            output.textContent += '\\nLog: ' + result.logPath + '\\n';
          }
          const deploymentError = new Error(result.error || t('web.status.error'));
          deploymentError.cleanupRequired = result.cleanupRequired === true;
          deploymentError.bootstrapRetainedForRetry =
            result.bootstrapRetainedForRetry === true;
          deploymentError.recoveryTokenRequired = result.recoveryTokenRequired === true;
          throw deploymentError;
        }
      } catch (error) {
        bootstrapTokenInput.value = '';
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        output.textContent += '\\n✗ Error: ' + error.message + '\\n';
        if (error.bootstrapRetainedForRetry === true) {
          output.textContent +=
            t('web.envDetail.bootstrapRetainedForRetry') + '\\n';
        }
        if (error.recoveryTokenRequired === true) {
          resumeControlBootstrapReady = false;
          controlBootstrapOwnership = null;
          document.getElementById('control-bootstrap-token-status').textContent =
            'Create and enter a new one-time token to verify the interrupted revocation, then retry deployment.';
        }
        status.textContent = t('web.status.error');
        status.className = '';
        let renderedServerSnapshot = false;
        try {
          const finalStatus = await api('/deploy/status');
          const finalProgress = finalStatus.progress || [];
          if (finalProgress.length < lastProgressLength) lastProgressLength = 0;
          if (finalProgress.length > lastProgressLength) {
            finalProgress.slice(lastProgressLength).forEach((message) => {
              output.textContent += formatProgressMessageForDisplay(message) + '\\n';
            });
            lastProgressLength = finalProgress.length;
          }
          if (finalStatus.deploymentProgress) {
            renderDeploymentSnapshot(finalStatus.deploymentProgress);
            renderedServerSnapshot = true;
          }
        } catch {
          // Fall back to a preparation-phase error when final server state is unavailable.
        }
        if (!renderedServerSnapshot) {
          renderDeploymentSnapshot({
            operation: 'deploy',
            phase: 'preparation',
            step: 1,
            totalSteps: 10,
            status: 'error',
            message: error.message,
          });
        }
        btn.disabled = false;
        let recoveryStatus = null;
        try {
          recoveryStatus = await api('/deploy/recovery/' + encodeURIComponent(config.env));
        } catch {
          // An unverified checkpoint must never enable a blind retry.
        }
        if (recoveryStatus?.success === true && recoveryStatus.canResume === true) {
          btn.textContent = t('web.envDetail.initialDeployRecoveryAction');
          output.textContent += '\\n' + describeInitialDeploymentRecovery(recoveryStatus) + '\\n';
        } else {
          output.textContent +=
            '\\n' +
            (recoveryStatus
              ? describeInitialDeploymentRecovery(recoveryStatus)
              : t('web.envDetail.initialDeployRecoveryBlocked')) +
            '\\n';
          btn.classList.add('hidden');
        }
        scrollToBottom(log);
        if (recoveryStatus?.success === true && recoveryStatus.canResume === true) {
          btn.classList.remove('hidden');
        }
        btnBack.classList.remove('hidden');
        btnCancel.classList.add('hidden');
        btnGotoComplete.classList.add('hidden');
      }
    });

    document.getElementById('deploy-manual-wildcard-recheck').addEventListener('click', () => {
      const deployButton = document.getElementById('btn-deploy');
      if (deployButton.disabled) return;
      deployButton.click();
    });

    function buildCompleteUrls(env, config) {
      const issuerUrl = resolveEnvDetailIssuerUrl(env, config);
      const loginBaseUrl = resolveEnvDetailSharedLoginBase(env, config);
      const adminBaseUrl = resolveEnvDetailAdminBase(env, config);
      const multiTenantConfigured = isMultiTenantConfigured(config);
      const loginUiDeployed = hasUiWorker(env, env.env + '-ar-login-ui');
      const adminUiDeployed = hasUiWorker(env, env.env + '-ar-admin-ui');
      const loginUrl = loginUiDeployed ? loginBaseUrl : null;
      const tenantDiscoverUrl = multiTenantConfigured && loginUiDeployed ? loginBaseUrl + '/discover' : null;
      const adminUrl = adminUiDeployed ? adminBaseUrl + '/admin' : null;
      const notDeployed = t('web.envDetail.notDeployed');
      return [
        {
          label: t('web.domain.issuerInitialTenant'),
          value: issuerUrl,
          href: issuerUrl,
        },
        {
          label: 'Discovery',
          value: issuerUrl + '/.well-known/openid-configuration',
          href: issuerUrl + '/.well-known/openid-configuration',
        },
        {
          label: t('web.complete.authorizationEndpoint'),
          value: issuerUrl + '/authorize',
          href: issuerUrl + '/authorize',
        },
        {
          label: t('web.complete.tokenEndpoint'),
          value: issuerUrl + '/token',
          href: issuerUrl + '/token',
        },
        {
          label: 'JWKS',
          value: issuerUrl + '/.well-known/jwks.json',
          href: issuerUrl + '/.well-known/jwks.json',
        },
        {
          label: 'Login UI',
          value: loginUrl || notDeployed,
          href: loginUrl,
        },
        {
          label: t('web.preview.tenantDiscover'),
          value: tenantDiscoverUrl || notDeployed,
          href: tenantDiscoverUrl,
        },
        {
          label: 'Admin UI',
          value: adminUrl || notDeployed,
          href: adminUrl,
        },
      ];
    }

    // Show completion
    function showComplete(result) {
      lastCompleteResult = result || {};
      const urlsEl = document.getElementById('urls');
      const env = config.env || config.environment?.prefix || 'prod';
      const completeEnv = {
        env,
        workers: [
          ...(config.components?.loginUi === false ? [] : [{ name: env + '-ar-login-ui' }]),
          ...(config.components?.adminUi === false ? [] : [{ name: env + '-ar-admin-ui' }]),
        ],
      };
      const completeUrls = buildCompleteUrls(completeEnv, config);

      // Clear and rebuild URLs section safely
      urlsEl.textContent = '';

      for (const item of completeUrls) {
        urlsEl.appendChild(createUrlItem(item.label, item.value, item.href));
      }
      // Create Admin Setup section (separate, prominent box)
      resetDynamicCompleteSections();

      const adminSetupSection = document.createElement('div');
      adminSetupSection.id = 'complete-admin-setup-section';
      adminSetupSection.className = 'cred';

      if (result && result.setupUrl) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'c-head';
        headerDiv.textContent =
          t('web.complete.adminAccountTitle') +
          t('web.complete.expiresOneHour');

        const descP = document.createElement('p');
        descP.className = 'c-note';
        descP.textContent = t('web.complete.adminAccountDesc');
        descP.setAttribute('data-i18n', 'web.complete.adminAccountDesc');

        const inputRow = document.createElement('div');
        inputRow.className = 'c-row';
        const urlKey = document.createElement('span');
        urlKey.className = 'c-k';
        urlKey.textContent = t('web.complete.adminSetupLabel');
        const urlValue = document.createElement('span');
        urlValue.className = 'c-v';
        urlValue.textContent = result.setupUrl;
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn btn-ghost sm';
        copyBtn.textContent = t('web.complete.copy');
        copyBtn.setAttribute('data-i18n', 'web.complete.copy');
        const setupUrlForCopy = result.setupUrl;
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(setupUrlForCopy);
          copyBtn.removeAttribute('data-i18n'); // prevent updateAllTranslations from overwriting "Copied"
          copyBtn.textContent = t('web.complete.copied');
          setTimeout(() => {
            copyBtn.textContent = t('web.complete.copy');
            copyBtn.setAttribute('data-i18n', 'web.complete.copy');
          }, 2000);
        });
        inputRow.appendChild(urlKey);
        inputRow.appendChild(urlValue);

        const openDiv = document.createElement('div');
        openDiv.style.cssText = 'margin-top: 14px; display: flex; gap: 12px;';
        const openLink = document.createElement('a');
        openLink.href = result.setupUrl;
        openLink.target = '_blank';
        openLink.className = 'btn btn-ghost sm';
        openLink.textContent = t('web.complete.openSetup');
        openLink.setAttribute('data-i18n', 'web.complete.openSetup');
        openDiv.appendChild(openLink);
        openDiv.appendChild(copyBtn);

        adminSetupSection.appendChild(headerDiv);
        adminSetupSection.appendChild(inputRow);
        adminSetupSection.appendChild(descP);
        adminSetupSection.appendChild(openDiv);
      } else {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'c-head';
        headerDiv.textContent = t('web.complete.adminAccountTitle');
        headerDiv.setAttribute('data-i18n', 'web.complete.adminAccountTitle');

        const descP = document.createElement('p');
        descP.className = 'c-note';
        descP.textContent = t('web.complete.adminSetupUnavailable');
        descP.setAttribute('data-i18n', 'web.complete.adminSetupUnavailable');

        adminSetupSection.appendChild(headerDiv);
        adminSetupSection.appendChild(descP);

        if (result && result.adminSetupDebug) {
          const debug = result.adminSetupDebug;
          const debugP = document.createElement('p');
          debugP.className = 'c-note';
          if (debug.alreadyCompleted) {
            debugP.textContent = t('web.complete.adminSetupUnavailable');
            debugP.setAttribute('data-i18n', 'web.complete.adminSetupUnavailable');
          } else if (debug.error) {
            debugP.style.color = 'var(--error)';
            debugP.textContent = t('web.status.errorWithMessage', { error: debug.error });
          }
          if (debugP.textContent) adminSetupSection.appendChild(debugP);
        }
      }
      const adminSetupAnchor = document.getElementById('complete-admin-setup-anchor');
      if (adminSetupAnchor) {
        adminSetupAnchor.replaceChildren(adminSetupSection);
      } else {
        urlsEl.parentNode.insertBefore(adminSetupSection, urlsEl.nextSibling);
      }

      setStep(9);
      showSection('complete');
    }

    // Resource naming functions
    function getResourceNames(env) {
      const kvPrefix = env.toUpperCase();
      return {
        d1: ${JSON.stringify(D1_DATABASES.map((database) => database.dbType))}.map(
          dbType => env + '-authrim-' + dbType
        ),
        kv: [
          kvPrefix + '-SETTINGS',
          kvPrefix + '-CLIENTS_CACHE',
          kvPrefix + '-AUTHRIM_CONFIG',
          kvPrefix + '-USER_CACHE',
          kvPrefix + '-TENANT_RUNTIME_REGISTRY',
          kvPrefix + '-REBAC_CACHE',
          kvPrefix + '-STATE_STORE',
          kvPrefix + '-CONSENT_CACHE',
          kvPrefix + '-INITIAL_ACCESS_TOKENS'
        ],
        queues: [
          env + '-audit-queue',
          env + '-logging-delivery-critical-queue',
          env + '-logging-delivery-queue',
          env + '-logging-delivery-bulk-queue'
        ],
        keys: []
      };
    }

    // Get human-readable label for database region
    function getRegionLabel(location, jurisdiction) {
      if (jurisdiction === 'eu') {
        return 'eu';
      }
      return location || 'auto';
    }

    function updateResourcePreview(env) {
      const resources = getResourceNames(env);
      const d1List = document.getElementById('preview-d1');
      const kvList = document.getElementById('preview-kv');
      const queueList = document.getElementById('preview-queues');
      const queueCategory = document.getElementById('preview-queues-category');
      const queueDisabledNote = document.getElementById('preview-queues-disabled-note');
      const keysList = document.getElementById('preview-keys');
      const d1Count = document.getElementById('preview-d1-count');
      const kvCount = document.getElementById('preview-kv-count');
      const queueCount = document.getElementById('preview-queues-count');

      d1List.replaceChildren();
      kvList.replaceChildren();
      queueList.replaceChildren();
      keysList.replaceChildren();

      // Get region info from config
      const coreRegion = config.database?.core || { location: 'apac', jurisdiction: 'none' };
      const piiRegion = config.database?.pii || { location: 'apac', jurisdiction: 'none' };

      // Fixed D1 databases use the same canonical inventory as provisioning.
      const d1LocationProfiles = ${JSON.stringify(
        Object.fromEntries(
          D1_DATABASES.map((database) => [database.dbType, database.locationProfile])
        )
      )};
      resources.d1.forEach(dbName => {
        const dbType = dbName.slice((env + '-authrim-').length);
        const region = d1LocationProfiles[dbType] === 'pii' ? piiRegion : coreRegion;
        appendDatabasePreviewItem(
          d1List,
          dbName,
          getRegionLabel(region.location, region.jurisdiction)
        );
      });
      if (d1Count) d1Count.textContent = String(resources.d1.length + 3);
      appendPreviewRow(d1List, 'Control Plane bootstrap tenant shards', '3 D1');

      for (let i = 0; i < resources.kv.length; i += 2) {
        appendPreviewPair(kvList, resources.kv[i], resources.kv[i + 1] || '');
      }
      if (kvCount) kvCount.textContent = String(resources.kv.length);

      const queueEnabled = config.features?.queue?.enabled === true;
      queueCategory.classList.toggle('hidden', !queueEnabled);
      if (queueDisabledNote) queueDisabledNote.classList.toggle('hidden', queueEnabled);
      if (queueEnabled) {
        resources.queues.forEach(name => appendPreviewRow(queueList, name, 'queue'));
      }
      if (queueCount) queueCount.textContent = String(queueEnabled ? resources.queues.length : 0);

      [
        ['private.pem', t('web.provision.jwtSigning')],
        ['setup_machine_private.pem', t('web.provision.setupMachineAuth')],
        ['admin_ui_bff_private.pem', 'Admin UI BFF'],
        [t('web.provision.aesSecrets'), t('web.provision.encryption')],
      ].forEach(([displayName, label]) => appendPreviewRow(keysList, displayName, label));
    }

    function appendDatabasePreviewItem(list, dbName, regionLabel) {
      appendPreviewRow(list, dbName, regionLabel);
    }

    function appendPreviewRow(tableBody, value, badge) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'v';
      td.appendChild(document.createTextNode(value));
      if (badge) {
        td.appendChild(document.createTextNode(' '));
        const chip = document.createElement('span');
        chip.className = 'copy';
        chip.textContent = badge;
        td.appendChild(chip);
      }
      tr.appendChild(td);
      tableBody.appendChild(tr);
    }

    function appendPreviewPair(tableBody, left, right) {
      const tr = document.createElement('tr');
      const leftCell = document.createElement('td');
      leftCell.className = 'v';
      leftCell.textContent = left;
      tr.appendChild(leftCell);

      const rightCell = document.createElement('td');
      rightCell.className = 'v';
      rightCell.textContent = right;
      tr.appendChild(rightCell);
      tableBody.appendChild(tr);
    }

    // Update provision button state based on completion status
    function updateProvisionButtons() {
      const btnProvision = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const btnSaveConfig = document.getElementById('btn-save-config-provision');

      if (provisioningCompleted) {
        btnProvision.textContent = t('web.btn.reprovision');
        btnProvision.classList.remove('btn-next');
        btnProvision.classList.add('btn-ghost');
        btnProvision.disabled = false;
        btnGotoDeploy.classList.remove('hidden');
        btnSaveConfig.classList.remove('hidden');
      } else {
        btnProvision.textContent = t('web.btn.createResources');
        btnProvision.classList.remove('btn-ghost');
        btnProvision.classList.add('btn-next');
        btnProvision.disabled = false;
        btnGotoDeploy.classList.add('hidden');
        btnSaveConfig.classList.add('hidden');
      }
    }

    // Save configuration to file (AuthrimConfigSchema format)
    function saveConfigToFile() {
      if (!config || !config.env) {
        alert(t('web.config.noConfigurationToSave'));
        return;
      }

      const now = new Date().toISOString();
      const env = config.env;

      // Calculate auto-generated URLs (use workersSubdomain if available for full-form URL)
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      const loginUiWorkerDomain = workersSubdomain
        ? env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-login-ui.workers.dev';
      const adminUiWorkerDomain = workersSubdomain
        ? env + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-admin-ui.workers.dev';
      const apiCustomUrl = config.apiDomain || null;
      const loginUiCustomUrl = config.loginUiDomain || null;
      const adminUiCustomUrl = config.adminUiDomain || null;

      // Build config in AuthrimConfigSchema format
      const configToSave = {
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
        environment: {
          prefix: env,
        },
        urls: {
          api: {
            custom: apiCustomUrl,
            // api.auto must always be the workers.dev URL (used for proxy backend and CORS).
            // The custom domain (issuer URL) belongs in api.custom, not api.auto.
            auto: 'https://' + workersDomain,
            zoneId: config.zoneId || null,
            customDomainBinding: config.customDomainBinding === true,
          },
          loginUi: {
            custom: loginUiCustomUrl,
            auto: 'https://' + loginUiWorkerDomain,
            sameAsApi: Boolean(apiCustomUrl && loginUiCustomUrl === apiCustomUrl),
          },
          adminUi: {
            custom: adminUiCustomUrl,
            auto: 'https://' + adminUiWorkerDomain,
            sameAsApi: Boolean(apiCustomUrl && adminUiCustomUrl === apiCustomUrl),
          },
        },
        tenant: {
          name: config.tenant?.name || 'default',
          displayName: config.tenant?.displayName || 'Initial Tenant',
          multiTenant: config.tenant?.multiTenant || false,
          baseDomain: config.tenant?.baseDomain || undefined,
          nakedDomain: config.tenant?.nakedDomain ?? false,
          userIdFormat: config.tenant?.userIdFormat || 'nanoid',
          primaryTenant: config.tenant?.primaryTenant || undefined,
        },
        components: {
          api: true,
          ...(config.components || {}),
          loginUi: config.components?.loginUi ?? true,
          adminUi: config.components?.adminUi ?? true,
          saml: true,
          async: true,
          vc: true,
          bridge: true,
          policy: true,
        },
        keys: {
          secretsPath: (workingDirectory || '.') + '/.authrim-keys/' + config.env + '/',
          storageType: 'external',
        },
        database: config.database || {
          core: { location: 'auto', jurisdiction: 'none' },
          pii: { location: 'auto', jurisdiction: 'none' },
        },
        profiles: config.profiles || buildProfilesConfig(),
        features: {
          queue: {
            enabled: config.features?.queue?.enabled === true,
          },
          r2: {
            enabled: config.features?.r2?.enabled !== false,
          },
          email: {
            ...(config.features?.email || {}),
            provider: config.email?.provider || 'none',
            fromAddress: config.email?.fromAddress || undefined,
            fromName: config.email?.fromName || undefined,
            configured: config.email?.provider && config.email?.provider !== 'none' ? true : false,
          },
        },
      };

      // Remove undefined values for cleaner output
      if (!configToSave.tenant.baseDomain) {
        delete configToSave.tenant.baseDomain;
      }
      if (!configToSave.tenant.primaryTenant) {
        delete configToSave.tenant.primaryTenant;
      }
      if (!configToSave.features.email.fromAddress) {
        delete configToSave.features.email.fromAddress;
      }
      if (!configToSave.features.email.fromName) {
        delete configToSave.features.email.fromName;
      }

      const blob = new Blob([JSON.stringify(configToSave, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'authrim-' + env + '-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Save config button handlers
    document.getElementById('btn-save-config-provision').addEventListener('click', saveConfigToFile);
    document.getElementById('btn-save-config-complete').addEventListener('click', saveConfigToFile);

    // Back to main button (from complete screen)
    document.getElementById('btn-back-to-main').addEventListener('click', async () => {
      await resetSetupFlowState();
      showSection('topMenu');
    });
    document.getElementById('btn-open-env-detail')?.addEventListener('click', () => {
      const envName = config.env || config.environment?.prefix || 'prod';
      const resources = getResourceNames(envName);
      const workers = [
        envName + '-ar-router',
        envName + '-ar-auth',
        envName + '-ar-token',
        envName + '-ar-userinfo',
        envName + '-ar-management',
        envName + '-ar-login-ui',
        envName + '-ar-admin-ui',
      ].map((name) => ({ name }));
      showEnvDetail({
        env: envName,
        status: 'ok',
        workers,
        d1: resources.d1.map((name) => ({ name })),
        kv: resources.kv.map((name) => ({ name })),
        queues: resources.queues.map((name) => ({ name })),
        r2: [],
        pages: [],
      });
    });

    // =============================================================================
    // Environment Management
    // =============================================================================

    // Menu handler for environment management
    document.getElementById('menu-manage-env').addEventListener('click', () => {
      loadEnvironments();
      showSection('envList');
    });

    function renderEnvironmentListSummary(count, scanState = environmentScanState) {
      const summary = document.getElementById('env-list-progress-summary');
      if (!summary) return;

      summary.replaceChildren();
      if (scanState === 'scanning') {
        summary.textContent = t('web.env.scanningEnvironments');
        summary.setAttribute('aria-busy', 'true');
        return;
      }
      summary.removeAttribute('aria-busy');
      if (scanState === 'error') {
        summary.textContent = t('web.status.error');
        return;
      }

      const detectedLabel = document.createElement('span');
      detectedLabel.textContent = t('web.env.detected');
      const countElement = document.createElement('b');
      countElement.id = 'env-list-count';
      countElement.textContent = String(Math.max(0, Number(count) || 0));
      const environmentLabel = document.createElement('span');
      environmentLabel.textContent = t('web.env.environments');
      summary.append(detectedLabel, document.createTextNode(' '), countElement);
      summary.append(document.createTextNode(' '), environmentLabel);
    }

    // Load environments
    async function loadEnvironments() {
      const scanGeneration = ++environmentScanGeneration;
      const status = document.getElementById('env-list-status');
      const loading = document.getElementById('env-list-loading');
      const content = document.getElementById('env-list-content');
      const output = document.getElementById('env-scan-output');
      const noEnvsMessage = document.getElementById('no-envs-message');
      const refreshButton = document.getElementById('btn-refresh-env-list');

      status.textContent = t('web.status.scanning');
      status.className = 'env-scan-status status-running';
      loading.classList.remove('hidden');
      content.classList.add('hidden');
      output.textContent = '';
      environmentScanState = 'scanning';
      renderEnvironmentListSummary(null, environmentScanState);
      if (refreshButton) refreshButton.disabled = true;

      try {
        const result = await api('/environments');
        if (scanGeneration !== environmentScanGeneration) return;

        if (result.success) {
          if (Array.isArray(result.progress)) {
            output.textContent = result.progress.map(formatProgressMessageForDisplay).join('\\n');
          }
          detectedEnvironments = result.environments || [];
          environmentScanState = 'complete';
          renderEnvironmentListSummary(detectedEnvironments.length, environmentScanState);

          status.textContent = t('web.status.found', { count: detectedEnvironments.length });
          status.className = 'env-scan-status status-success';
          loading.classList.add('hidden');
          content.classList.remove('hidden');

          renderEnvironmentCards();
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        if (scanGeneration !== environmentScanGeneration) return;
        environmentScanState = 'error';
        renderEnvironmentListSummary(null, environmentScanState);
        status.textContent = t('web.status.error');
        status.className = 'env-scan-status status-error';
        output.textContent += '\\nError: ' + error.message;
      } finally {
        if (scanGeneration === environmentScanGeneration && refreshButton) {
          refreshButton.disabled = false;
        }
      }
    }

    function getEnvironmentIssuerPreview(env) {
      const router = (env.workers || []).find((worker) => worker?.name?.includes('-ar-router'));
      if (router?.name && workersSubdomain) {
        return router.name + '.' + workersSubdomain + '.workers.dev';
      }
      if (router?.name) return router.name + '.workers.dev';
      return env.env + '-ar-router.workers.dev';
    }

    function getEnvironmentModePreview(env, config = null) {
      const multiTenant = config?.tenant?.multiTenant ?? env?.multiTenant;
      return multiTenant === true ? t('web.env.modeMulti') : t('web.env.modeSingle');
    }

    function appendEnvCardKv(body, key, value, className, rowClassName) {
      const row = document.createElement('div');
      row.className = rowClassName ? 'e-kv ' + rowClassName : 'e-kv';
      const keyEl = document.createElement('span');
      keyEl.className = 'k';
      keyEl.textContent = key;
      const valueEl = document.createElement('span');
      valueEl.className = className ? 'v ' + className : 'v';
      valueEl.textContent = value;
      row.appendChild(keyEl);
      row.appendChild(valueEl);
      body.appendChild(row);
      return row;
    }

    function appendEnvCardIssuer(body, issuer) {
      const row = document.createElement('div');
      row.className = 'e-kv e-kv-issuer';
      const keyEl = document.createElement('span');
      keyEl.className = 'k';
      keyEl.textContent = 'Issuer';
      const valueEl = document.createElement('span');
      valueEl.className = 'v';
      valueEl.textContent = issuer;
      row.appendChild(keyEl);
      row.appendChild(valueEl);
      body.appendChild(row);
    }

    async function updateEnvCardIssuerFromConfig(env, generation) {
      const card = document.getElementById('env-card-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_'));
      const issuerValue = card?.querySelector('.e-kv-issuer .v');
      const modeValue = card?.querySelector('.e-kv-mode .v');
      if (!issuerValue && !modeValue) return;

      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(env.env));
        if (generation !== envCardRenderGeneration) return;
        if (!configResponse.exists || !configResponse.config) return;

        const issuer = stripProtocol(resolveEnvDetailIssuerUrl(env, configResponse.config));
        if (issuer && issuerValue) {
          issuerValue.textContent = issuer;
        }
        if (modeValue) {
          modeValue.textContent = getEnvironmentModePreview(env, configResponse.config);
        }
      } catch (error) {
        console.warn('Failed to load config issuer for ' + env.env + ':', error);
      }
    }

    // Render environment cards
    function renderEnvironmentCards() {
      const container = document.getElementById('env-cards');
      const noEnvsMessage = document.getElementById('no-envs-message');
      const generation = ++envCardRenderGeneration;

      // Clear existing cards using safe method
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      if (detectedEnvironments.length === 0) {
        noEnvsMessage.classList.remove('hidden');
        return;
      }

      noEnvsMessage.classList.add('hidden');

      for (const env of detectedEnvironments) {
        const card = document.createElement('div');
        card.className = 'envcard';
        card.id = 'env-card-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_');

        const head = document.createElement('div');
        head.className = 'e-head';

        const name = document.createElement('span');
        name.className = 'e-name';
        name.textContent = env.env;
        head.appendChild(name);

        if (env.release?.canUpdate) {
          const releaseBadge = document.createElement('span');
          releaseBadge.className = 'env-release-badge';
          releaseBadge.textContent = t('web.env.updateBadge', {
            version: env.release.targetVersion,
          });
          head.appendChild(releaseBadge);
        }

        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'e-body';
        appendEnvCardIssuer(body, getEnvironmentIssuerPreview(env));
        appendEnvCardKv(
          body,
          t('web.env.cardMode'),
          getEnvironmentModePreview(env),
          undefined,
          'e-kv-mode'
        );
        appendEnvCardKv(body, 'Workers', String(env.workers.length));
        appendEnvCardKv(body, 'D1 / KV', env.d1.length + ' / ' + env.kv.length);
        appendEnvCardKv(
          body,
          t('web.env.cardAdmin'),
          t('web.status.checking'),
          'warn',
          'e-kv-admin'
        );
        card.appendChild(body);

        const foot = document.createElement('div');
        foot.className = 'e-foot';
        foot.textContent = t('web.env.openDetails');
        card.appendChild(foot);

        // Make entire card clickable
        card.addEventListener('click', () => showEnvDetail(env));
        container.appendChild(card);

        // Check admin status and add badge if needed
        updateEnvCardIssuerFromConfig(env, generation);
        checkAndAddAdminBadge(env, generation);
      }
    }

    // Check admin status and add badge to environment card
    async function checkAndAddAdminBadge(env, generation) {
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      const card = document.getElementById('env-card-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_'));
      const adminRow = card?.querySelector('.e-body .e-kv-admin');
      const adminValue = adminRow?.querySelector('.v');

      if (!configKv || !configKv.id) {
        adminRow?.remove();
        return;
      }

      try {
        const response = await api('/admin/status/' + encodeURIComponent(configKv.id));
        if (generation !== envCardRenderGeneration) return;
        if (!response.success || !adminValue) {
          adminRow?.remove();
          return;
        }

        if (response.adminSetupCompleted) {
          adminValue.textContent = t('web.env.adminConfigured');
          adminValue.classList.remove('warn');
          adminValue.classList.add('ok');
        } else {
            adminValue.textContent = t('web.env.adminNotConfigured');
            adminValue.classList.remove('ok');
            adminValue.classList.add('warn');
        }
      } catch (error) {
        console.error('Failed to check admin status for ' + env.env + ':', error);
        adminRow?.remove();
      }
    }

    // Show environment details
    function showEnvDetail(env) {
      selectedEnvForDetail = env;
      selectedEnvDetailConfig = null;
      selectedEnvRecoveryStatus = null;
      renderEnvDetailDeploymentStatus(null);
      resetReleaseUpdateCard();

      const totalResources =
        (env.workers?.length || 0) +
        (env.d1?.length || 0) +
        (env.kv?.length || 0) +
        (env.queues?.length || 0) +
        (env.r2?.length || 0) +
        ((env.pages || []).length || 0);
      document.getElementById('detail-env-name').textContent = env.env;
      document.getElementById('detail-stat-workers').textContent = String(env.workers?.length || 0);
      document.getElementById('detail-stat-d1').textContent = String(env.d1?.length || 0);
      document.getElementById('detail-stat-kv').textContent = String(env.kv?.length || 0);
      document.getElementById('detail-workers-tab-count').textContent = String(env.workers?.length || 0);
      document.getElementById('detail-resource-tab-count').textContent = String(totalResources);
      const progressEl = document.querySelector('#section-env-detail .setup-env-actions .progress');
      if (progressEl) {
        progressEl.innerHTML = t('web.env.resourceSummary', {
          env: escapeHtml(env.env),
          total: totalResources,
        });
      }
      renderEnvDetailUrls(env);
      loadEnvControlAutomaticProvisioning(env.env);
      loadInitialDeploymentRecovery(env.env);
      loadEnvEmailStatus(env.env);
      loadServiceSiteStatus(env.env);
      loadReleaseUpdateStatus(env.env);
      document.getElementById('env-email-progress').classList.add('hidden');
      document.getElementById('env-email-log').textContent = '';
      document.getElementById('env-service-site-progress').classList.add('hidden');
      document.getElementById('env-service-site-log').textContent = '';
      document.getElementById('btn-save-service-site').disabled = false;
      document.getElementById('btn-enable-cloudflare-email').disabled = false;
      document.getElementById('btn-enable-resend-email').disabled = false;
      document.getElementById('env-email-resend-api-key').value = '';
      const enableCloudflareBtnSpan = document
        .getElementById('btn-enable-cloudflare-email')
        ?.querySelector('span');
      if (enableCloudflareBtnSpan) {
        enableCloudflareBtnSpan.textContent =
          t('web.envDetail.emailEnableCloudflare') || 'Enable Cloudflare Email Service';
      }
      const enableResendBtnSpan = document
        .getElementById('btn-enable-resend-email')
        ?.querySelector('span');
      if (enableResendBtnSpan) {
        enableResendBtnSpan.textContent = t('web.email.configureResend') || 'Resend';
      }

      // Render resource lists with loading state
      renderResourceList('detail-workers-list', 'detail-workers-count', env.workers, 'name', 'worker');
      renderResourceList('detail-d1-list', 'detail-d1-count', env.d1, 'name', 'd1');
      renderResourceList('detail-kv-list', 'detail-kv-count', env.kv, 'name', 'kv');
      renderResourceList('detail-queues-list', 'detail-queues-count', env.queues, 'name', 'queue');
      renderResourceList('detail-r2-list', 'detail-r2-count', env.r2, 'name', 'r2');
      renderResourceList('detail-pages-list', 'detail-pages-count', env.pages || [], 'name', 'pages');

      // Hide empty sections
      document.getElementById('detail-queues-section').style.display = env.queues.length === 0 ? 'none' : 'block';
      document.getElementById('detail-r2-section').style.display = env.r2.length === 0 ? 'none' : 'block';
      document.getElementById('detail-pages-section').style.display = (env.pages || []).length === 0 ? 'none' : 'block';

      // Check and show/hide admin setup section
      const adminSetupSection = document.getElementById('admin-setup-section');
      const resultDiv = document.getElementById('admin-setup-result');
      const btn = document.getElementById('btn-start-admin-setup');

      // Reset state
      adminSetupSection.classList.add('hidden');
      resultDiv.classList.add('hidden');
      btn.disabled = false;
      btn.classList.remove('hidden');
      adminSetupSection.querySelector('p')?.classList.remove('hidden');
      btn.textContent =
        t('web.envDetail.startPasskey');

      // Find AUTHRIM_CONFIG KV namespace
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      if (configKv && configKv.id) {
        // Check admin setup status asynchronously
        checkAndShowAdminSetup(configKv.id, env.env);
      }

      document.getElementById('env-r2-provision-progress').classList.add('hidden');
      document.getElementById('env-r2-provision-log').textContent = '';
      document.getElementById('btn-provision-r2-buckets').disabled = false;
      loadR2ProvisionStatus(env.env);
      resetMigrationStatusUI();
      loadMigrationStatus(env.env);

      // Reset and load worker version comparison
      resetWorkerUpdateUI();
      loadWorkerVersionComparison(env.env);

      showSection('envDetail');

      // Load details asynchronously
      loadResourceDetails(env);
    }

    function resetReleaseUpdateCard() {
      const card = document.getElementById('env-release-update');
      if (!card) return;
      card.classList.add('hidden');
      card.dataset.state = '';
      document.getElementById('release-update-progress')?.classList.add('hidden');
      const log = document.getElementById('release-update-log');
      if (log) log.textContent = '';
      const button = document.getElementById('btn-start-release-update');
      const databaseOnlyButton = document.getElementById('btn-start-database-only-update');
      if (button) {
        button.disabled = false;
        button.classList.remove('hidden');
        button.setAttribute('aria-busy', 'false');
        button.querySelector('.inline-action-spinner')?.classList.add('hidden');
      }
      if (databaseOnlyButton) {
        databaseOnlyButton.disabled = false;
        databaseOnlyButton.classList.remove('hidden');
      }
      const updates = document.getElementById('detail-stat-updates');
      if (updates) updates.textContent = '0';
    }

    function renderReleaseUpdateStatus(release) {
      const card = document.getElementById('env-release-update');
      const title = document.getElementById('release-update-title');
      const message = document.getElementById('release-update-message');
      const button = document.getElementById('btn-start-release-update');
      const databaseOnlyButton = document.getElementById('btn-start-database-only-update');
      const label = button?.querySelector('[data-release-update-label]');
      if (!card || !release) return;

      const visibleStatuses = [
        'update_available',
        'resume_available',
        'reconciliation_required',
        'setup_tool_older',
        'blocked',
      ];
      card.classList.toggle('hidden', !visibleStatuses.includes(release.status));
      document.getElementById('release-current-version').textContent =
        release.currentVersion ? 'v' + release.currentVersion : 'legacy';
      document.getElementById('release-target-version').textContent = 'v' + release.targetVersion;
      const updates = document.getElementById('detail-stat-updates');
      if (updates) updates.textContent = release.canUpdate ? '1' : '0';

      card.dataset.state = release.canUpdate ? 'available' : 'blocked';
      button?.classList.toggle('hidden', !release.canUpdate);
      databaseOnlyButton?.classList.toggle(
        'hidden',
        !release.canUpdate || release.databaseOnlyAvailable !== true
      );
      if (release.status === 'resume_available') {
        title.textContent = t('web.envDetail.releaseUpdateResume');
        message.textContent = t('web.envDetail.releaseUpdateDesc');
        if (label) label.textContent = t('web.envDetail.releaseUpdateResumeAction');
      } else if (release.status === 'setup_tool_older') {
        title.textContent = t('web.envDetail.releaseUpdateBlocked');
        message.textContent = t('web.envDetail.releaseUpdateOlderTool');
      } else if (release.status === 'blocked') {
        title.textContent = t('web.envDetail.releaseUpdateBlocked');
        message.textContent = t('web.envDetail.releaseUpdateBlocked');
      } else {
        title.textContent = t('web.envDetail.releaseUpdateAvailable');
        message.textContent = t('web.envDetail.releaseUpdateDesc');
        if (label) label.textContent = t('web.envDetail.releaseUpdateAction');
      }
    }

    async function loadReleaseUpdateStatus(envName) {
      try {
        const response = await api('/update/release/' + encodeURIComponent(envName));
        if (selectedEnvForDetail?.env !== envName || response.success !== true) return;
        renderReleaseUpdateStatus(response.release);
      } catch (error) {
        console.warn('Failed to load release update status:', error);
      }
    }

    function releaseUpdateStageFromProgress(progress) {
      const recent = (Array.isArray(progress) ? progress.slice(-20) : [])
        .join('\\n')
        .toLowerCase();
      if (/verif|health|readiness|healthy/u.test(recent)) {
        return t('web.envDetail.releaseUpdateVerifying');
      }
      if (/deploy|worker|wrangler/u.test(recent)) {
        return t('web.envDetail.releaseUpdateServices');
      }
      if (/migrat|schema|database|d1/u.test(recent)) {
        return t('web.envDetail.releaseUpdateDatabase');
      }
      return t('web.envDetail.releaseUpdatePreparing');
    }

    async function startReleaseUpdate(databaseOnly = false) {
      if (!selectedEnvForDetail) return;
      if (databaseOnly && !window.confirm(t('web.envDetail.releaseUpdateDatabaseOnlyConfirm'))) {
        return;
      }
      const envName = selectedEnvForDetail.env;
      const card = document.getElementById('env-release-update');
      const button = document.getElementById('btn-start-release-update');
      const databaseOnlyButton = document.getElementById('btn-start-database-only-update');
      const spinner = button?.querySelector('.inline-action-spinner');
      const progressPanel = document.getElementById('release-update-progress');
      const progressBar = document.getElementById('release-update-progress-bar');
      const stage = document.getElementById('release-update-stage');
      const log = document.getElementById('release-update-log');
      button.disabled = true;
      if (databaseOnlyButton) databaseOnlyButton.disabled = true;
      button.setAttribute('aria-busy', 'true');
      spinner?.classList.remove('hidden');
      progressPanel?.classList.remove('hidden');
      updateProgressBarVisual(progressBar, 28, 'running', true);
      card.dataset.state = 'updating';
      if (stage) stage.textContent = t('web.envDetail.releaseUpdatePreparing');
      if (log) log.textContent = '';

      let lastProgressLength = 0;
      const appendProgress = (messages) => {
        if (!Array.isArray(messages)) return;
        if (messages.length < lastProgressLength) lastProgressLength = 0;
        if (messages.length > lastProgressLength && log) {
          const next = messages
            .slice(lastProgressLength)
            .map((message) => formatProgressMessageForDisplay(message))
            .join('\\n');
          log.textContent += (log.textContent ? '\\n' : '') + next;
          log.scrollTop = log.scrollHeight;
          lastProgressLength = messages.length;
        }
        if (stage) stage.textContent = releaseUpdateStageFromProgress(messages);
      };
      const poll = async () => {
        try {
          const result = await api('/deploy/status');
          appendProgress(result.progress || []);
        } catch {
          // The update request provides the final result.
        }
      };
      const pollTimer = window.setInterval(poll, 1000);
      window.setTimeout(poll, 250);

      try {
        const response = await api('/update/release', {
          method: 'POST',
          body: JSON.stringify({ env: envName, databaseOnly }),
        });
        appendProgress(response.progress || []);
        if (response.success !== true) {
          throw new Error(response.error || t('web.envDetail.releaseUpdateFailed'));
        }
        if (response.inProgress === true) {
          card.dataset.state = 'updating';
          document.getElementById('release-update-title').textContent =
            t('web.envDetail.releaseUpdateResume');
          document.getElementById('release-update-message').textContent =
            t('web.envDetail.releaseUpdateContinuing');
          if (stage) stage.textContent = t('web.envDetail.releaseUpdateDatabase');
          button.disabled = false;
          const continuingLabel = button.querySelector('[data-release-update-label]');
          if (continuingLabel) continuingLabel.textContent = t('web.envDetail.releaseUpdateResumeAction');
          return;
        }
        card.dataset.state = 'complete';
        updateProgressBarVisual(progressBar, 100, 'complete');
        document.getElementById('release-update-title').textContent =
          t('web.envDetail.releaseUpdateComplete');
        document.getElementById('release-update-message').textContent =
          t('web.envDetail.releaseUpdateDesc');
        if (stage) stage.textContent = t('web.envDetail.releaseUpdateComplete');
        button.classList.add('hidden');
        databaseOnlyButton?.classList.add('hidden');
        document.getElementById('detail-stat-updates').textContent = '0';
        selectedEnvForDetail.release = response.release;
        const detected = detectedEnvironments.find((environment) => environment.env === envName);
        if (detected) detected.release = response.release;
        await loadWorkerVersionComparison(envName);
      } catch (error) {
        card.dataset.state = 'blocked';
        updateProgressBarVisual(progressBar, 28, 'error');
        document.getElementById('release-update-title').textContent =
          t('web.envDetail.releaseUpdateFailed');
        document.getElementById('release-update-message').textContent =
          error instanceof Error ? error.message : String(error);
        if (stage) stage.textContent = t('web.envDetail.releaseUpdateFailed');
        button.disabled = false;
        if (databaseOnlyButton) databaseOnlyButton.disabled = false;
        const label = button.querySelector('[data-release-update-label]');
        if (label) label.textContent = t('web.envDetail.releaseUpdateResumeAction');
      } finally {
        window.clearInterval(pollTimer);
        await poll();
        button.setAttribute('aria-busy', 'false');
        spinner?.classList.add('hidden');
      }
    }

    function describeInitialDeploymentRecovery(result) {
      if (result?.status === 'recreate_required') {
        if (result.reasonCode === 'initial_manifest_changed') {
          return t('web.envDetail.initialDeployRecoveryManifestChanged');
        }
        return t('web.envDetail.initialDeployRecoveryRecreate');
      }
      if (result?.status === 'blocked') {
        return t('web.envDetail.initialDeployRecoveryBlocked');
      }
      if (result?.status !== 'resumable') {
        return t('web.envDetail.initialDeployRecoveryDesc');
      }
      const completed = [];
      if (result.completedSteps?.resourcesProvisioned) {
        completed.push(t('web.envDetail.initialDeployRecoveryResources'));
      }
      if (result.completedSteps?.schemaApplied) {
        completed.push(t('web.envDetail.initialDeployRecoverySchema'));
      }
      if (result.completedSteps?.workersDeployed) {
        completed.push(t('web.envDetail.initialDeployRecoveryWorkers'));
      }
      const stageKey =
        result.resumeFrom === 'database_migrations'
          ? 'web.envDetail.initialDeployRecoveryStageMigrations'
          : result.resumeFrom === 'control_plane_bootstrap'
            ? 'web.envDetail.initialDeployRecoveryStageControlPlane'
          : result.resumeFrom === 'worker_deployment'
            ? 'web.envDetail.initialDeployRecoveryStageWorkers'
            : 'web.envDetail.initialDeployRecoveryStageVerification';
      return (
        t('web.envDetail.initialDeployRecoveryVerified', {
          completed: completed.join(' / '),
          stage: t(stageKey),
        }) +
        (result.requiresBootstrapToken
          ? t('web.envDetail.initialDeployRecoveryTokenRequired')
          : '')
      );
    }

    async function loadInitialDeploymentRecovery(envName) {
      const recovery = document.getElementById('env-initial-deploy-recovery');
      if (!recovery) return;
      recovery.classList.add('hidden');
      renderEnvDetailDeploymentStatus(null);
      try {
        const result = await api('/deploy/recovery/' + encodeURIComponent(envName));
        if (selectedEnvForDetail?.env !== envName) return;
        selectedEnvRecoveryStatus = result;
        renderEnvDetailDeploymentStatus(result);
        const visible =
          result.success === true &&
          ['resumable', 'blocked', 'recreate_required'].includes(result.status);
        recovery.classList.toggle('hidden', !visible);
        const message = document.getElementById('env-initial-deploy-recovery-message');
        if (message && visible) message.textContent = describeInitialDeploymentRecovery(result);
        const button = document.getElementById('btn-resume-initial-deploy');
        if (button) button.classList.toggle('hidden', result.canResume !== true);
      } catch (error) {
        if (selectedEnvForDetail?.env !== envName) return;
        selectedEnvRecoveryStatus = { success: false };
        renderEnvDetailDeploymentStatus(selectedEnvRecoveryStatus);
        recovery.classList.remove('hidden');
        const message = document.getElementById('env-initial-deploy-recovery-message');
        if (message) message.textContent = t('web.envDetail.initialDeployRecoveryBlocked');
        document.getElementById('btn-resume-initial-deploy')?.classList.add('hidden');
        console.warn('Failed to load initial deployment recovery status:', error);
      }
    }

    function renderEnvDetailDeploymentStatus(result) {
      const status = document.getElementById('detail-url-deployment-status');
      if (!status) return;

      if (result === null) {
        status.textContent = t('web.envDetail.deploymentChecking');
        status.dataset.state = 'checking';
        return;
      }

      const deploymentVerified =
        result?.success === true &&
        result.status === 'complete' &&
        result.completedSteps?.verificationComplete === true;
      if (deploymentVerified) {
        status.textContent = t('web.envDetail.verified');
        status.dataset.state = 'verified';
        return;
      }

      if (result?.success === true) {
        status.textContent = t('web.envDetail.deploymentIncomplete');
        status.dataset.state = 'incomplete';
        return;
      }

      status.textContent = t('web.envDetail.deploymentStatusUnknown');
      status.dataset.state = 'unknown';
    }

    function buildSetupConfigFromSavedConfig(savedConfig) {
      const isNewFormat = savedConfig.version === '1.0.0' || savedConfig.environment?.prefix;
      const env = isNewFormat ? savedConfig.environment?.prefix : savedConfig.env || 'prod';
      const apiDomain = isNewFormat ? savedConfig.urls?.api?.custom : savedConfig.apiDomain;
      const loginUiDomain = isNewFormat
        ? savedConfig.urls?.loginUi?.custom
        : savedConfig.loginUiDomain;
      const adminUiDomain = isNewFormat
        ? savedConfig.urls?.adminUi?.custom
        : savedConfig.adminUiDomain;
      return {
        env,
        apiDomain: stripProtocol(apiDomain) || null,
        loginUiDomain: stripProtocol(loginUiDomain) || null,
        adminUiDomain: stripProtocol(adminUiDomain) || null,
        tenant: savedConfig.tenant || {
          name: 'default',
          displayName: 'Initial Tenant',
          multiTenant: false,
        },
        components: {
          api: true,
          ...(savedConfig.components || {}),
          loginUi: savedConfig.components?.loginUi ?? true,
          adminUi: savedConfig.components?.adminUi ?? true,
          saml: true,
          async: true,
          vc: true,
          bridge: true,
          policy: true,
        },
        features: {
          queue: { enabled: savedConfig.features?.queue?.enabled === true },
          r2: { enabled: savedConfig.features?.r2?.enabled !== false },
          email: savedConfig.features?.email || { provider: 'none' },
        },
        profiles: savedConfig.profiles || buildProfilesConfig(),
        controlPlane: {
          automaticProvisioning: savedConfig.controlPlane?.automaticProvisioning === true,
        },
        database: savedConfig.database,
        zoneId: isNewFormat ? savedConfig.urls?.api?.zoneId || null : savedConfig.zoneId || null,
        customDomainBinding:
          isNewFormat
            ? savedConfig.urls?.api?.customDomainBinding === true
            : savedConfig.customDomainBinding === true,
      };
    }

    async function resumeInitialDeploymentFromEnvironment() {
      const envName = selectedEnvForDetail?.env || config?.env;
      if (!envName) return;
      const button = document.getElementById('btn-resume-initial-deploy');
      const spinner = button.querySelector('.inline-action-spinner');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      spinner?.classList.remove('hidden');
      try {
        const recoveryStatus = await api(
          '/deploy/recovery/' + encodeURIComponent(envName)
        );
        if (recoveryStatus.success !== true || recoveryStatus.canResume !== true) {
          throw new Error(describeInitialDeploymentRecovery(recoveryStatus));
        }
        const response = await api('/config?env=' + encodeURIComponent(envName));
        if (!response.exists || !response.config) {
          throw new Error(t('web.loadConfig.provisionedValid'));
        }
        config = buildSetupConfigFromSavedConfig(response.config);
        controlBootstrapOwnership = null;
        resumeControlBootstrapReady = false;
        resumeWorkerOwnershipRecovery =
          recoveryStatus.requiresWorkerOwnershipRecovery === true;
        if (config.controlPlane?.automaticProvisioning === true) {
          resumeControlBootstrapReady = recoveryStatus.requiresBootstrapToken !== true;
        }
        const bootstrapInput = document.getElementById('control-bootstrap-token');
        if (bootstrapInput) bootstrapInput.value = '';
        setAutomaticProvisioningEnabled(config.controlPlane?.automaticProvisioning === true);
        renderDeployManualWildcardWarning();
        setStep(8);
        showSection('deploy');
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        spinner?.classList.add('hidden');
        button.setAttribute('aria-busy', 'false');
        button.disabled = false;
      }
    }

    function renderEnvControlAutomaticProvisioning(result) {
      const section = document.getElementById('env-control-automatic-provisioning');
      const status = document.getElementById('env-control-automatic-status');
      const inputs = document.getElementById('env-control-automatic-inputs');
      const message = document.getElementById('env-control-automatic-message');
      const controlPlane = result?.success && result.controlPlane === true;
      section.classList.toggle('hidden', !controlPlane);
      if (!controlPlane) return;
      const capabilityState = result.authority?.capabilityState ||
        (result.enabled ? 'pending' : 'disabled');
      envControlBootstrapPhase = result.authority?.bootstrapPhase || 'none';
      status.textContent = envControlBootstrapPhase !== 'none'
        ? envControlBootstrapPhase.replaceAll('_', ' ')
        : capabilityState === 'ready'
        ? t('web.envDetail.automaticProvisioningOn')
        : capabilityState === 'disabled'
          ? t('web.envDetail.automaticProvisioningOff')
          : capabilityState;
      inputs.classList.toggle('hidden', capabilityState === 'ready');
      document
        .getElementById('btn-env-create-control-bootstrap-token')
        .classList.toggle('hidden', envControlBootstrapPhase !== 'none');
      const missingResourceClasses = Array.isArray(result.missingResourceClasses)
        ? result.missingResourceClasses.join(', ')
        : '';
      message.textContent = capabilityState === 'ready'
        ? t('web.envDetail.automaticProvisioningCredentialsRegistered')
        : capabilityState === 'blocked'
          ? t('web.envDetail.automaticProvisioningBlocked') +
            (missingResourceClasses
              ? ' ' + t('web.envDetail.automaticProvisioningMissing', { missing: missingResourceClasses })
              : '') +
            ' ' + t('web.envDetail.automaticProvisioningRepairHint')
          : '';
    }

    async function loadEnvControlAutomaticProvisioning(envName) {
      const status = document.getElementById('env-control-automatic-status');
      envControlBootstrapPhase = 'unknown';
      document.getElementById('env-control-automatic-inputs').classList.add('hidden');
      document.getElementById('btn-env-create-control-bootstrap-token').classList.add('hidden');
      status.textContent = t('web.envDetail.automaticProvisioningChecking');
      try {
        renderEnvControlAutomaticProvisioning(
          await api('/control/automatic-provisioning/status?env=' + encodeURIComponent(envName))
        );
      } catch (error) {
        status.textContent = t('web.envDetail.automaticProvisioningUnavailable');
      }
    }

    function stripTrailingSlash(url) {
      const value = String(url || '');
      return value.endsWith('/') ? value.slice(0, -1) : value;
    }

    function stripProtocol(urlOrDomain) {
      return String(urlOrDomain || '').trim().replace(/^https?:[/][/]/, '').replace(/[/]+$/, '');
    }

    function ensureHttpsUrl(urlOrDomain) {
      const normalized = stripProtocol(urlOrDomain);
      return normalized ? 'https://' + normalized : '';
    }

    function firstConfiguredValue(...values) {
      for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
      }
      return '';
    }

    function firstConfiguredUrl(...values) {
      const value = firstConfiguredValue(...values);
      return value ? stripTrailingSlash(ensureHttpsUrl(value)) : '';
    }

    function isMultiTenantConfigured(config) {
      return !!(
        config &&
        config.tenant &&
        config.tenant.multiTenant === true &&
        config.tenant.baseDomain &&
        String(config.tenant.baseDomain).trim()
      );
    }

    function createEnvDetailUrlRow(label, value, description, href) {
      const row = document.createElement('tr');

      const labelEl = document.createElement('td');
      labelEl.className = 'k';
      labelEl.textContent = label;
      row.appendChild(labelEl);

      const valueEl = document.createElement('td');
      valueEl.className = 'v endpoint-value';

      const urlEl = href ? document.createElement('a') : document.createElement('span');
      if (href) {
        urlEl.href = href;
        urlEl.target = '_blank';
        urlEl.rel = 'noopener noreferrer';
      }
      urlEl.textContent = value;
      valueEl.appendChild(urlEl);

      if (href) {
        const copy = document.createElement('button');
        copy.className = 'copy';
        copy.type = 'button';
        copy.textContent = t('web.envDetail.copyBtn');
        copy.addEventListener('click', () => navigator.clipboard?.writeText(value));
        valueEl.appendChild(copy);
      }

      if (description) {
        valueEl.title = description;
      }
      row.appendChild(valueEl);
      return row;
    }

    function hasUiWorker(env, workerName) {
      return (env.workers || []).some((worker) => worker && worker.name === workerName);
    }

    function resolveEnvDetailIssuerUrl(env, config) {
      const envName = env.env;
      const workersDomain = workersSubdomain
        ? envName + '-ar-router.' + workersSubdomain + '.workers.dev'
        : envName + '-ar-router.workers.dev';
      const fallbackIssuer = 'https://' + workersDomain;

      if (isMultiTenantConfigured(config)) {
        const tenantName = (config.tenant.name || 'default').trim();
        const baseDomain = String(config.tenant.baseDomain).trim();
        return config.tenant.nakedDomain === true
          ? 'https://' + baseDomain
          : 'https://' + tenantName + '.' + baseDomain;
      }

      const apiUrl = firstConfiguredUrl(
        config?.urls?.api?.custom,
        config?.apiDomain,
        config?.urls?.api?.auto
      );
      return apiUrl ? stripTrailingSlash(apiUrl) : fallbackIssuer;
    }

    function resolveEnvDetailSharedLoginBase(env, config) {
      const envName = env.env;
      const fallbackLoginWorkerUrl = workersSubdomain
        ? 'https://' + envName + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : 'https://' + envName + '-ar-login-ui.workers.dev';
      return firstConfiguredUrl(
        config?.urls?.loginUi?.custom,
        config?.loginUiDomain,
        config?.urls?.loginUi?.auto,
        fallbackLoginWorkerUrl
      );
    }

    function isWorkersDevUrl(url) {
      try {
        const hostname = new URL(url).hostname;
        return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
      } catch {
        return false;
      }
    }

    function resolveEnvDetailAdminBase(env, config) {
      const envName = env.env;
      const fallbackAdminWorkerUrl = workersSubdomain
        ? 'https://' + envName + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : 'https://' + envName + '-ar-admin-ui.workers.dev';
      return firstConfiguredUrl(
        config?.urls?.adminUi?.custom,
        config?.adminUiDomain,
        config?.urls?.adminUi?.auto,
        fallbackAdminWorkerUrl
      );
    }

    function buildEnvDetailUrls(env, config) {
      const envName = env.env;
      const loginProjectName = envName + '-ar-login-ui';
      const adminProjectName = envName + '-ar-admin-ui';
      const loginUiDeployed = hasUiWorker(env, loginProjectName);
      const adminUiDeployed = hasUiWorker(env, adminProjectName);
      const multiTenantConfigured = isMultiTenantConfigured(config);
      const issuerUrl = resolveEnvDetailIssuerUrl(env, config);
      const apiHealthUrl = issuerUrl + '/api/health';
      const discoveryUrl = issuerUrl + '/.well-known/openid-configuration';
      const loginSharedBaseUrl = resolveEnvDetailSharedLoginBase(env, config);
      const adminBaseUrl = resolveEnvDetailAdminBase(env, config);
      const loginEntryUrl = loginUiDeployed
        ? (
            multiTenantConfigured || config?.urls?.loginUi?.sameAsApi === true
              ? issuerUrl
              : loginSharedBaseUrl
          ) + '/login'
        : null;
      const tenantDiscoverBaseUrl =
        multiTenantConfigured && config?.tenant?.baseDomain
          ? (
              config?.urls?.loginUi?.sameAsApi !== true &&
              loginSharedBaseUrl &&
              !isWorkersDevUrl(loginSharedBaseUrl)
                ? loginSharedBaseUrl
                : 'https://' + String(config.tenant.baseDomain).trim()
            )
          : loginSharedBaseUrl;
      const tenantDiscoverUrl = multiTenantConfigured && loginUiDeployed
        ? tenantDiscoverBaseUrl + '/discover'
        : null;
      const adminEntryUrl = adminUiDeployed
        ? (
            config?.urls?.adminUi?.sameAsApi === true
              ? issuerUrl
              : adminBaseUrl
          ) + '/admin/info'
        : null;
      const notDeployed = t('web.envDetail.notDeployed');

      const urls = [
        {
          label: 'Issuer',
          value: issuerUrl,
          href: null,
          description: 'Canonical OIDC issuer value',
        },
        {
          label: 'API Health',
          value: apiHealthUrl,
          href: apiHealthUrl,
          description: 'API router health check',
        },
        {
          label: 'OIDC Discovery',
          value: discoveryUrl,
          href: discoveryUrl,
          description: 'OpenID Provider metadata endpoint',
        },
        {
          label: 'Login UI',
          value: loginEntryUrl || notDeployed,
          href: loginEntryUrl,
          description: multiTenantConfigured
            ? 'Tenant login entry point'
            : 'Login screen entry point',
        },
        {
          label: 'Admin UI',
          value: adminEntryUrl || notDeployed,
          href: adminEntryUrl,
          description: 'Admin console entry point',
        },
      ];

      if (tenantDiscoverUrl) {
        urls.splice(2, 0, {
          label: 'Tenant Discovery',
          value: tenantDiscoverUrl,
          href: tenantDiscoverUrl,
          description: 'Shared login entry point for tenant selection',
        });
      }

      return urls;
    }

    function updateEnvDetailHeroAside(env, config) {
      if (!env) return;
      const aside = document.getElementById('setup-hero-aside');
      if (!aside) return;

      const issuer = stripProtocol(resolveEnvDetailIssuerUrl(env, config || null));
      const mode = getEnvironmentModePreview(env, config);
      aside.innerHTML = t('web.env.heroDetailAside', {
        mode: escapeHtml(mode),
        issuer: escapeHtml(issuer),
      });
    }

    async function renderEnvDetailUrls(env) {
      const listEl = document.getElementById('detail-url-list');
      listEl.textContent = '';

      let config = null;
      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(env.env));
        if (configResponse.exists && configResponse.config) {
          config = configResponse.config;
        }
      } catch (error) {
        console.warn('Failed to load config for env detail URLs:', error);
      }

      const urls = buildEnvDetailUrls(env, config);
      updateEnvDetailHeroAside(env, config);
      for (const item of urls) {
        listEl.appendChild(createEnvDetailUrlRow(item.label, item.value, item.description, item.href));
      }
    }

    function renderEnvEmailStatus(configResponse) {
      const providerEl = document.getElementById('env-email-provider');
      const statusEl = document.getElementById('env-email-status');
      const fromEl = document.getElementById('env-email-from');
      const fromAddressInput = document.getElementById('env-email-from-address');
      const fromNameInput = document.getElementById('env-email-from-name');
      const emailConfig = configResponse?.config?.features?.email || null;
      const provider = emailConfig?.provider || 'none';
      const configured = emailConfig?.configured === true;
      const fromAddress = emailConfig?.fromAddress || '';
      const fromName = emailConfig?.fromName || '';

      selectedEnvDetailConfig = configResponse?.config || null;

      providerEl.textContent =
        provider === 'none'
          ? (t('web.envDetail.emailProviderNone') || 'Not configured')
          : provider;
      statusEl.textContent = configured
        ? (t('web.envDetail.emailConfigured') || 'Configured')
        : (t('web.envDetail.emailNotConfigured') || 'Not configured');
      fromEl.textContent = fromAddress || '—';

      fromAddressInput.value = fromAddress;
      fromNameInput.value = fromName;
    }

    async function loadEnvEmailStatus(envName) {
      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(envName));
        if (configResponse.exists && configResponse.config) {
          renderEnvEmailStatus(configResponse);
          return;
        }
      } catch (error) {
        console.warn('Failed to load env email config:', error);
      }

      renderEnvEmailStatus(null);
    }

    function renderServiceSiteStatus(configResponse) {
      const summaryEl = document.getElementById('env-service-site-summary');
      const enabledInput = document.getElementById('env-service-site-enabled');
      const enabledLine = document.getElementById('env-service-site-enabled-line');
      const workerInput = document.getElementById('env-service-site-worker-name');
      const bindingInput = document.getElementById('env-service-site-binding');
      const serviceSite = configResponse?.config?.serviceSite || {};
      const enabled = serviceSite.enabled === true;
      const binding = serviceSite.binding || 'SERVICE_SITE';
      const workerName = serviceSite.workerName || '';

      selectedEnvDetailConfig = configResponse?.config || selectedEnvDetailConfig;
      enabledInput.checked = enabled;
      enabledLine.classList.toggle('on', enabled);
      workerInput.value = workerName;
      bindingInput.value = binding;
      summaryEl.textContent = enabled
        ? t('web.envDetail.serviceSiteEnabledSummary', { binding, worker: workerName || '-' })
        : t('web.envDetail.serviceSiteDisabledSummary');
    }

    async function loadServiceSiteStatus(envName) {
      const summaryEl = document.getElementById('env-service-site-summary');
      summaryEl.textContent = t('web.envDetail.serviceSiteLoading');
      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(envName));
        if (configResponse.exists && configResponse.config) {
          renderServiceSiteStatus(configResponse);
          return;
        }
      } catch (error) {
        console.warn('Failed to load Service Site config:', error);
      }

      renderServiceSiteStatus(null);
    }

    async function configureServiceSiteForEnv() {
      if (!selectedEnvForDetail) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const envName = selectedEnvForDetail.env;
      const enabled = document.getElementById('env-service-site-enabled').checked;
      const workerName = String(
        document.getElementById('env-service-site-worker-name').value || ''
      ).trim();
      const binding = String(
        document.getElementById('env-service-site-binding').value || 'SERVICE_SITE'
      ).trim();

      if (enabled && !workerName) {
        alert(t('web.envDetail.serviceSiteWorkerRequired'));
        return;
      }
      if (enabled && !/^[a-z][a-z0-9-]*$/.test(workerName)) {
        alert(t('web.envDetail.serviceSiteWorkerInvalid'));
        return;
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(binding)) {
        alert(t('web.envDetail.serviceSiteBindingInvalid'));
        return;
      }
      if (!confirm(t('web.envDetail.serviceSiteConfirm'))) return;

      const btn = document.getElementById('btn-save-service-site');
      const progressDiv = document.getElementById('env-service-site-progress');
      const logDiv = document.getElementById('env-service-site-log');
      const btnLabel = btn.querySelector('span');
      const originalLabel = btnLabel?.textContent || '';

      btn.disabled = true;
      if (btnLabel) btnLabel.textContent = t('web.status.deploying') || 'Deploying...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (message) => {
        const line = document.createElement('div');
        line.textContent = message;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      let lastProgressLength = 0;
      let pollInterval = null;
      try {
        addLog(t('web.envDetail.serviceSiteSaving'));
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
              const newMessages = statusResult.progress.slice(lastProgressLength);
              newMessages.forEach(msg => addLog(formatProgressMessageForDisplay(msg)));
              lastProgressLength = statusResult.progress.length;
            }
          } catch (error) {
            // The save/deploy request handles final errors.
          }
        }, 1000);

        const response = await api('/service-site/configure', {
          method: 'POST',
          body: {
            env: envName,
            enabled,
            binding,
            workerName,
            deployRouter: true,
          },
        });

        if (response.progress && response.progress.length > lastProgressLength) {
          response.progress
            .slice(lastProgressLength)
            .forEach(msg => addLog(formatProgressMessageForDisplay(msg)));
          lastProgressLength = response.progress.length;
        }

        if (!response.success) {
          throw new Error(response.error || t('web.status.error'));
        }

        addLog(t('web.envDetail.serviceSiteDeployComplete'));
        await loadServiceSiteStatus(envName);
        await loadWorkerVersionComparison(envName);
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        if (pollInterval !== null) {
          clearInterval(pollInterval);
        }
        btn.disabled = false;
        if (btnLabel) btnLabel.textContent = originalLabel || t('web.envDetail.serviceSiteSaveDeploy');
      }
    }

    function renderR2ProvisionStatus(response) {
      const summaryEl = document.getElementById('env-r2-provision-summary');
      const provisionBtn = document.getElementById('btn-provision-r2-buckets');

      if (!response || !response.success) {
        summaryEl.textContent = response?.error || t('web.envDetail.r2StatusLoadFailed');
        provisionBtn.disabled = false;
        return;
      }

      if (response.identityMismatchCount > 0) {
        summaryEl.textContent = t('web.envDetail.r2IdentityMismatchSummary', {
          count: response.identityMismatchCount,
        });
        provisionBtn.disabled = true;
        return;
      }

      if (response.ownershipRecoveryRequired > 0) {
        summaryEl.textContent =
          response.ownershipRecoveryMode === 'explicit_adoption'
            ? t('web.envDetail.r2OwnershipRecoverySummary', {
                count: response.ownershipRecoveryRequired,
                command: response.requiredCommand || '',
              })
            : t('web.envDetail.r2OwnershipRecreateSummary', {
                count: response.ownershipRecoveryRequired,
              });
        provisionBtn.disabled = true;
        return;
      }

      if (response.enabled) {
        summaryEl.textContent = t('web.envDetail.r2ConfiguredSummary', {
          configured: response.configured,
          required: response.required,
        });
        provisionBtn.disabled = true;
        return;
      }

      summaryEl.textContent = t('web.envDetail.r2NeedsProvisioningSummary', {
        configured: response.configured,
        required: response.required,
      });
      provisionBtn.disabled = false;
    }

    async function loadR2ProvisionStatus(envName) {
      const summaryEl = document.getElementById('env-r2-provision-summary');
      summaryEl.textContent = t('web.envDetail.loadingR2Status');
      try {
        const response = await api('/r2/' + encodeURIComponent(envName) + '/status');
        renderR2ProvisionStatus(response);
      } catch (error) {
        renderR2ProvisionStatus({ success: false, error: error.message });
      }
    }

    async function provisionR2BucketsForEnv() {
      if (!selectedEnvForDetail) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const envName = selectedEnvForDetail.env;
      const confirmed = confirm(
        t('web.envDetail.provisionR2Confirm')
      );
      if (!confirmed) return;

      const btn = document.getElementById('btn-provision-r2-buckets');
      const progressDiv = document.getElementById('env-r2-provision-progress');
      const logDiv = document.getElementById('env-r2-provision-log');
      btn.disabled = true;
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (message) => {
        const line = document.createElement('div');
        line.textContent = message;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      let pollInterval = null;
      try {
        addLog(t('web.envDetail.r2Provisioning'));
        const provisionResult = await api('/r2/' + encodeURIComponent(envName) + '/provision', {
          method: 'POST',
        });
        if (!provisionResult.success) {
          throw new Error(provisionResult.error || t('web.status.error'));
        }
        addLog(t('web.envDetail.r2ConfiguredBuckets', { count: provisionResult.buckets.length }));
        addLog(t('web.status.startingDeploy'));

        let lastProgressLength = 0;
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
              const newMessages = statusResult.progress.slice(lastProgressLength);
              newMessages.forEach(msg => addLog(formatProgressMessageForDisplay(msg)));
              lastProgressLength = statusResult.progress.length;
            }
          } catch (error) {
            // Ignore transient polling errors while deploy is running.
          }
        }, 1000);

        const deployResult = await api('/update/workers', {
          method: 'POST',
          body: {
            env: envName,
            onlyChanged: false,
            topologyDeploymentToken: provisionResult.topologyDeploymentToken,
          },
        });

        if (!deployResult.success) {
          throw new Error(deployResult.error || t('web.status.error'));
        }

        addLog(t('web.envDetail.r2ProvisioningComplete'));
        await loadR2ProvisionStatus(envName);
        await loadWorkerVersionComparison(envName);
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
        btn.disabled = false;
      } finally {
        if (pollInterval !== null) {
          clearInterval(pollInterval);
        }
      }
    }

    function resetMigrationStatusUI() {
      const list = document.getElementById('migration-status-list');
      if (list) {
        list.innerHTML =
          '<div class="bigtable migration-loading-card">' +
          '<div class="cap"><span>' +
          escapeHtml(t('web.envDetail.migrations')) +
          '</span><em>' +
          escapeHtml(t('web.status.loading')) +
          '</em></div>' +
          '<div class="env-loading-indicator migration-loading-indicator">' +
          '<span class="env-loading-spinner" aria-hidden="true"></span>' +
          '<span>' +
          escapeHtml(t('web.envDetail.migrationLoading')) +
          '</span>' +
          '</div>' +
          '</div>';
      }
      document.getElementById('env-migration-summary').textContent =
        t('web.envDetail.migrationLoading');
      document.getElementById('detail-migrations-tab-count').textContent = '0';
      document.getElementById('migration-stat-applied').textContent = '0';
      document.getElementById('migration-stat-pending').textContent = '0';
      document.getElementById('migration-stat-changed').textContent = '0';
      document.getElementById('migration-stat-orphaned').textContent = '0';
      document.getElementById('btn-apply-all-migrations').disabled = true;
      document.getElementById('migration-progress').classList.add('hidden');
      document.getElementById('migration-log').textContent = '';
    }

    function setMigrationApplyBusy(isBusy) {
      migrationApplyInProgress = isBusy;
      document.getElementById('btn-refresh-migrations')?.toggleAttribute('disabled', isBusy);
      document.getElementById('btn-back-env-detail')?.toggleAttribute('disabled', isBusy);
      document.getElementById('btn-delete-from-detail')?.toggleAttribute('disabled', isBusy);
      if (isBusy) {
        document.getElementById('btn-apply-all-migrations')?.setAttribute('disabled', '');
      }
      document.querySelectorAll('.migration-apply-one').forEach((button) => {
        button.disabled = isBusy;
      });
    }

    function migrationStatusLabel(status) {
      const labels = {
        applied: t('web.envDetail.migrationStatusApplied'),
        pending: t('web.envDetail.migrationStatusPending'),
        changed: t('web.envDetail.migrationStatusChanged'),
        orphaned: t('web.envDetail.migrationStatusOrphaned'),
      };
      return labels[status] || status;
    }

    function migrationRoleLabel(role) {
      const labels = {
        core: 'Core D1',
        pii: 'PII D1',
        admin: 'Admin D1',
      };
      return labels[role] || role;
    }

    function formatMigrationAppliedAt(value) {
      const numeric = Number(value || 0);
      if (!Number.isFinite(numeric) || numeric <= 0) return '—';
      const millis = numeric < 100000000000 ? numeric * 1000 : numeric;
      return new Date(millis).toLocaleString();
    }

    function shortChecksum(value) {
      return value ? String(value).slice(0, 12) : '—';
    }

    function appendMigrationRow(tbody, database, migration) {
      const row = document.createElement('tr');
      row.className = 'migration-row migration-' + migration.status;

      const statusCell = document.createElement('td');
      statusCell.appendChild(document.createTextNode(migrationStatusLabel(migration.status)));
      row.appendChild(statusCell);

      const fileCell = document.createElement('td');
      fileCell.className = 'migration-file';
      fileCell.textContent = migration.filename;
      row.appendChild(fileCell);

      const appliedCell = document.createElement('td');
      appliedCell.textContent = formatMigrationAppliedAt(migration.appliedAt);
      row.appendChild(appliedCell);

      const checksumCell = document.createElement('td');
      checksumCell.className = 'migration-checksum';
      checksumCell.title = migration.checksum || migration.appliedChecksum || '';
      checksumCell.textContent =
        migration.status === 'changed'
          ? shortChecksum(migration.appliedChecksum) + ' → ' + shortChecksum(migration.checksum)
          : shortChecksum(migration.checksum || migration.appliedChecksum);
      row.appendChild(checksumCell);

      const actionCell = document.createElement('td');
      actionCell.className = 'migration-action-cell';
      if (migration.status === 'pending') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost sm migration-apply-one';
        button.dataset.role = database.role;
        button.dataset.filename = migration.filename;
        button.disabled = migrationApplyInProgress;
        button.textContent = t('web.envDetail.migrationApplyPending');
        actionCell.appendChild(button);
      } else {
        actionCell.textContent = '—';
      }
      row.appendChild(actionCell);

      tbody.appendChild(row);
    }

    function renderMigrationStatus(response) {
      const list = document.getElementById('migration-status-list');
      const applyAllButton = document.getElementById('btn-apply-all-migrations');
      list.textContent = '';

      if (!response || !response.success) {
        document.getElementById('env-migration-summary').textContent =
          response?.error || t('web.envDetail.migrationLoadFailed');
        applyAllButton.disabled = true;
        return;
      }

      const databases = response.databases || [];
      const totals = databases.reduce((acc, database) => {
        const counts = database.counts || {};
        acc.applied += counts.applied || 0;
        acc.pending += counts.pending || 0;
        acc.changed += counts.changed || 0;
        acc.orphaned += counts.orphaned || 0;
        return acc;
      }, { applied: 0, pending: 0, changed: 0, orphaned: 0 });

      document.getElementById('migration-stat-applied').textContent = String(totals.applied);
      document.getElementById('migration-stat-pending').textContent = String(totals.pending);
      document.getElementById('migration-stat-changed').textContent = String(totals.changed);
      document.getElementById('migration-stat-orphaned').textContent = String(totals.orphaned);
      document.getElementById('detail-migrations-tab-count').textContent = String(
        totals.pending + totals.changed
      );

      if (totals.changed > 0) {
        document.getElementById('env-migration-summary').textContent =
          t('web.envDetail.migrationChangedBlocked');
        applyAllButton.disabled = true;
      } else if (totals.pending > 0) {
        document.getElementById('env-migration-summary').textContent =
          t('web.envDetail.migrationPendingSummary', { count: totals.pending });
        applyAllButton.disabled = migrationApplyInProgress;
      } else {
        document.getElementById('env-migration-summary').textContent =
          t('web.envDetail.migrationNoPending');
        applyAllButton.disabled = true;
      }

      for (const database of databases) {
        const table = document.createElement('div');
        table.className = 'bigtable migration-table';
        const cap = document.createElement('div');
        cap.className = 'cap';
        const title = document.createElement('span');
        title.textContent = migrationRoleLabel(database.role);
        const summary = document.createElement('em');
        const counts = database.counts || {};
        summary.textContent =
          (database.dbName || '') +
          ' · ' +
          t('web.envDetail.migrationMiniSummary', {
            applied: counts.applied || 0,
            pending: counts.pending || 0,
            changed: counts.changed || 0,
          });
        cap.appendChild(title);
        cap.appendChild(summary);
        table.appendChild(cap);

        const tableEl = document.createElement('table');
        const thead = document.createElement('thead');
        thead.innerHTML =
          '<tr><th>' + escapeHtml(t('web.envDetail.migrationStatus')) +
          '</th><th>' + escapeHtml(t('web.envDetail.migrationFile')) +
          '</th><th>' + escapeHtml(t('web.envDetail.migrationAppliedAt')) +
          '</th><th>' + escapeHtml(t('web.envDetail.migrationChecksum')) +
          '</th><th style="text-align:right;">' + escapeHtml(t('web.envDetail.action')) +
          '</th></tr>';
        tableEl.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const migration of database.migrations || []) {
          appendMigrationRow(tbody, database, migration);
        }
        if (!database.migrations || database.migrations.length === 0) {
          const emptyRow = document.createElement('tr');
          const emptyCell = document.createElement('td');
          emptyCell.colSpan = 5;
          emptyCell.textContent = database.error || t('web.envDetail.migrationNoFiles');
          emptyRow.appendChild(emptyCell);
          tbody.appendChild(emptyRow);
        }
        tableEl.appendChild(tbody);
        table.appendChild(tableEl);
        list.appendChild(table);
      }
    }

    async function loadMigrationStatus(envName) {
      const generation = ++migrationStatusLoadGeneration;
      resetMigrationStatusUI();
      document.getElementById('env-migration-summary').textContent =
        t('web.envDetail.migrationLoading');
      try {
        const response = await api('/migrations/status/' + encodeURIComponent(envName));
        if (generation !== migrationStatusLoadGeneration) return;
        renderMigrationStatus(response);
      } catch (error) {
        if (generation !== migrationStatusLoadGeneration) return;
        renderMigrationStatus({ success: false, error: error.message });
      }
    }

    async function applyMigrationsForEnv(options = {}) {
      if (migrationApplyInProgress) return;
      if (!selectedEnvForDetail) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }
      const envName = selectedEnvForDetail.env;

      const applyAll = !options.role;
      if (applyAll && !confirm(t('web.envDetail.migrationApplyConfirm'))) {
        return;
      }

      const progressDiv = document.getElementById('migration-progress');
      const logDiv = document.getElementById('migration-log');
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';
      setMigrationApplyBusy(true);
      progressDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog(t('web.envDetail.migrationApplying'));
        const response = await api('/migrations/apply', {
          method: 'POST',
          body: {
            env: envName,
            role: options.role,
            filenames: options.filename ? [options.filename] : undefined,
          },
        });
        if (Array.isArray(response.progress)) {
          response.progress.forEach((msg) => addLog(formatProgressMessageForDisplay(msg)));
        }
        if (!response.success) {
          throw new Error(response.error || response.core?.error || response.pii?.error || response.admin?.error || t('web.status.error'));
        }
        addLog(t('web.envDetail.migrationComplete'));
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        migrationApplyInProgress = false;
        await loadMigrationStatus(envName);
        setMigrationApplyBusy(false);
      }
    }

    async function enableCloudflareEmailForEnv() {
      if (!selectedEnvForDetail) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const btn = document.getElementById('btn-enable-cloudflare-email');
      const btnSpan = btn.querySelector('span');
      const progressDiv = document.getElementById('env-email-progress');
      const logDiv = document.getElementById('env-email-log');
      const fromAddress = document.getElementById('env-email-from-address').value.trim();
      const fromName = document.getElementById('env-email-from-name').value.trim();
      const currentProvider = selectedEnvDetailConfig?.features?.email?.provider;

      if (!fromAddress) {
        alert(t('web.envDetail.emailFromMissing'));
        return;
      }

      const emailInput = document.getElementById('env-email-from-address');
      if (emailInput && !emailInput.checkValidity()) {
        alert(t('web.envDetail.emailFromInvalid'));
        return;
      }

      if (
        currentProvider &&
        currentProvider !== 'none' &&
        currentProvider !== 'cloudflare' &&
        !confirm(
          t('web.envDetail.emailSwitchProviderConfirm') ||
            'This environment already has another email provider configured. Switch it to Cloudflare Email Service?'
        )
      ) {
        return;
      }

      btn.disabled = true;
      if (btnSpan) {
        btnSpan.textContent = t('web.envDetail.emailDeploying');
      }
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog(t('web.envDetail.emailStarting'));
        const response = await api('/env/email/cloudflare/enable', {
          method: 'POST',
          body: {
            env: selectedEnvForDetail.env,
            fromAddress,
            fromName,
          },
        });

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress) {
            addLog(formatProgressMessageForDisplay(msg));
          }
        }

        if (!response.success) {
          addLog('');
          addLog(t('web.status.errorWithMessage', {
            error: response.error || t('web.envDetail.emailUpdateFailed') || t('web.status.error'),
          }));
          return;
        }

        addLog('');
        addLog(t('web.envDetail.emailUpdatedSuccess'));
        await loadEnvEmailStatus(selectedEnvForDetail.env);
        resetWorkerUpdateUI();
        await loadWorkerVersionComparison(selectedEnvForDetail.env);
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        btn.disabled = false;
        if (btnSpan) {
          btnSpan.textContent =
            t('web.envDetail.emailEnableCloudflare') || 'Enable Cloudflare Email Service';
        }
      }
    }

    async function enableResendEmailForEnv() {
      if (!selectedEnvForDetail) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const btn = document.getElementById('btn-enable-resend-email');
      const btnSpan = btn.querySelector('span');
      const progressDiv = document.getElementById('env-email-progress');
      const logDiv = document.getElementById('env-email-log');
      const fromAddress = document.getElementById('env-email-from-address').value.trim();
      const fromName = document.getElementById('env-email-from-name').value.trim();
      const apiKey = document.getElementById('env-email-resend-api-key').value.trim();
      const currentProvider = selectedEnvDetailConfig?.features?.email?.provider;

      if (!fromAddress) {
        alert(t('web.envDetail.emailFromMissing'));
        return;
      }

      const emailInput = document.getElementById('env-email-from-address');
      if (emailInput && !emailInput.checkValidity()) {
        alert(t('web.envDetail.emailFromInvalid'));
        return;
      }

      if (!apiKey) {
        alert(t('web.email.resendApiKeyMissing') || 'Resend API key is required.');
        return;
      }

      if (!apiKey.startsWith('re_')) {
        const proceed = confirm(
          t('web.email.resendApiKeyConfirmInvalid') ||
            'The API key does not start with "re_". Continue anyway?'
        );
        if (!proceed) return;
      }

      if (
        currentProvider &&
        currentProvider !== 'none' &&
        currentProvider !== 'resend' &&
        !confirm(
          t('web.envDetail.emailSwitchProviderToResendConfirm') ||
            'This environment already has another email provider configured. Switch it to Resend?'
        )
      ) {
        return;
      }

      btn.disabled = true;
      if (btnSpan) btnSpan.textContent = t('web.envDetail.emailDeploying') || 'Updating...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog(t('web.envDetail.emailResendStarting') || 'Saving Resend email configuration...');
        const response = await api('/email/configure', {
          method: 'POST',
          body: {
            env: selectedEnvForDetail.env,
            provider: 'resend',
            apiKey,
            fromAddress,
            fromName,
          },
        });

        if (!response.success) {
          addLog('');
          addLog(t('web.status.errorWithMessage', {
            error: response.error || t('web.envDetail.emailUpdateFailed') || t('web.status.error'),
          }));
          return;
        }

        addLog('');
        addLog(t('web.envDetail.emailResendUpdatedSuccess') || 'Resend email configuration updated.');
        document.getElementById('env-email-resend-api-key').value = '';
        await loadEnvEmailStatus(selectedEnvForDetail.env);
        resetWorkerUpdateUI();
        await loadWorkerVersionComparison(selectedEnvForDetail.env);
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        btn.disabled = false;
        if (btnSpan) btnSpan.textContent = t('web.email.configureResend') || 'Resend';
      }
    }

    // ===========================================
    // Worker Update Functions
    // ===========================================

    let workerVersionComparison = [];
    let currentEnvForUpdate = null;

    // Reset worker update UI
    function resetWorkerUpdateUI() {
      workerVersionComparison = [];
      const tbody = document.getElementById('worker-version-tbody');
      tbody.textContent = '';
      const loadingRow = document.createElement('tr');
      const loadingCell = document.createElement('td');
      loadingCell.colSpan = 5;
      loadingCell.style.cssText = 'text-align: center; padding: 1rem; color: var(--text-muted);';
      loadingCell.textContent = t('web.status.loading');
      loadingRow.appendChild(loadingCell);
      tbody.appendChild(loadingRow);
      document.getElementById('update-summary').textContent = '';
      document.getElementById('btn-update-workers').disabled = true;
      document.getElementById('worker-update-progress').classList.add('hidden');
      document.getElementById('worker-update-log').textContent = '';
      // Also reset UI update progress
      document.getElementById('ui-update-progress')?.classList.add('hidden');
      document.getElementById('ui-update-log') && (document.getElementById('ui-update-log').textContent = '');
    }

    function updateWorkerUpdateButtonState() {
      const updateButton = document.getElementById('btn-update-workers');
      const onlyChangedCheckbox = document.getElementById('update-only-changed');

      if (!updateButton || !onlyChangedCheckbox) {
        return;
      }

      if (workerVersionComparison.length === 0) {
        updateButton.disabled = true;
        return;
      }

      const onlyChanged = onlyChangedCheckbox.checked;
      const hasUpdates = workerVersionComparison.some((item) => item.needsUpdate);
      updateButton.disabled = onlyChanged ? !hasUpdates : false;
    }

    // Load and compare worker versions
    async function loadWorkerVersionComparison(envName) {
      currentEnvForUpdate = envName;
      const tbody = document.getElementById('worker-version-tbody');

      try {
        const response = await api('/update/compare/' + encodeURIComponent(envName));

        if (response.success) {
          workerVersionComparison = response.comparison;
          renderVersionTable(response.comparison);

          // Update summary
          const summary = response.summary;
          const summaryText = summary.needsUpdate > 0
            ? (t('web.envDetail.updatesAvailable', { count: summary.needsUpdate }) || summary.needsUpdate + ' update(s) available')
            : (t('web.envDetail.allUpToDate') || 'All up to date');
          document.getElementById('update-summary').textContent = summaryText;
          updateWorkerUpdateButtonState();
        } else {
          tbody.textContent = '';
          const errorRow = document.createElement('tr');
          const errorCell = document.createElement('td');
          errorCell.colSpan = 5;
          errorCell.style.cssText = 'color: var(--error); padding: 1rem;';
          errorCell.textContent = response.error || t('web.status.failedToLoad');
          errorRow.appendChild(errorCell);
          tbody.appendChild(errorRow);
        }
      } catch (error) {
        console.error('Failed to load version comparison:', error);
        tbody.textContent = '';
        const errorRow = document.createElement('tr');
        const errorCell = document.createElement('td');
        errorCell.colSpan = 5;
        errorCell.style.cssText = 'color: var(--error); padding: 1rem;';
        errorCell.textContent = error.message;
        errorRow.appendChild(errorCell);
        tbody.appendChild(errorRow);
      }
    }

    // Render version comparison table
    function renderVersionTable(comparison) {
      const tbody = document.getElementById('worker-version-tbody');
      tbody.textContent = '';

      if (comparison.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyCell = document.createElement('td');
        emptyCell.colSpan = 5;
        emptyCell.style.cssText = 'text-align: center; padding: 1rem; color: var(--text-muted);';
        emptyCell.textContent = t('web.status.none');
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
      }

      for (const item of comparison) {
        const tr = document.createElement('tr');

        // Worker name
        const tdName = document.createElement('td');
        tdName.className = 'v';
        tdName.textContent = item.component;
        tr.appendChild(tdName);

        // Deployed version
        const tdDeployed = document.createElement('td');
        tdDeployed.textContent = item.deployedVersion || '-';
        if (!item.deployedVersion) tdDeployed.style.color = 'var(--text-muted)';
        tr.appendChild(tdDeployed);

        // Local version
        const tdLocal = document.createElement('td');
        tdLocal.textContent = item.localVersion || '-';
        tr.appendChild(tdLocal);

        // Status
        const tdStatus = document.createElement('td');

        const badge = document.createElement('span');

        if (item.needsUpdate) {
          badge.className = 'pill-stale';
          if (!item.deployedVersion) {
            badge.textContent = t('web.envDetail.notDeployed');
          } else {
            badge.textContent = t('web.envDetail.needsUpdate') || 'Update';
          }
        } else {
          badge.className = 'pill-ok';
          badge.textContent = t('web.envDetail.upToDate') || 'Current';
        }

        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        // Action column with individual update button
        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';
        const updateBtn = document.createElement('button');
        updateBtn.className = 'btn btn-ghost sm';
        updateBtn.textContent = t('web.envDetail.updateNow') || 'Update';
        updateBtn.title = t('web.envDetail.updateThis');
        updateBtn.onclick = () => updateSingleComponent(item.component);
        tdAction.appendChild(updateBtn);
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
      }
    }

    // Start worker update
    async function startWorkerUpdate() {
      if (!currentEnvForUpdate) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }
      const btn = document.getElementById('btn-update-workers');
      const progressDiv = document.getElementById('worker-update-progress');
      const logDiv = document.getElementById('worker-update-log');
      const onlyChanged = document.getElementById('update-only-changed').checked;
      const includeUiWorkers = document.getElementById('update-include-ui-workers').checked;

      btn.disabled = true;
      const btnSpan = btn.querySelector('span');
      if (btnSpan) btnSpan.textContent = t('web.status.deploying') || 'Updating...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      let lastProgressLength = 0;
      let hasSeenUpdateStart = false;
      const updateStartMarker = 'Starting worker update for environment: ' + currentEnvForUpdate;
      const appendProgressMessages = (progress) => {
        if (!Array.isArray(progress)) return;

        if (!hasSeenUpdateStart) {
          const startIndex = progress.findIndex((msg) => String(msg || '').includes(updateStartMarker));
          if (startIndex === -1) return;
          hasSeenUpdateStart = true;
          lastProgressLength = startIndex + 1;
        }

        if (progress.length < lastProgressLength) {
          lastProgressLength = 0;
        }

        if (progress.length > lastProgressLength) {
          const newMessages = progress.slice(lastProgressLength);
          for (const msg of newMessages) {
            addLog(formatProgressMessageForDisplay(msg));
          }
          lastProgressLength = progress.length;
        }
      };

      let pollTimer = null;
      const pollWorkerUpdateProgress = async () => {
        try {
          const statusResult = await api('/deploy/status');
          appendProgressMessages(statusResult.progress || []);
        } catch {
          // Keep the deploy request in charge of final error handling.
        }
      };

      try {
        addLog(t('web.envDetail.workerUpdateStarting', { env: currentEnvForUpdate }));

        const updateRequest = api('/update/workers', {
          method: 'POST',
          body: JSON.stringify({
            env: currentEnvForUpdate,
            onlyChanged: onlyChanged,
            includeUiWorkers: includeUiWorkers
          })
        });

        pollTimer = window.setInterval(pollWorkerUpdateProgress, 1000);
        window.setTimeout(pollWorkerUpdateProgress, 300);

        const response = await updateRequest;

        if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        appendProgressMessages(response.progress || []);

        if (response.success) {
          addLog('');
          addLog(t('web.envDetail.updateCompletedSuccess'));
          const summary = response.summary;
          addLog(t('web.envDetail.workerUpdateSummary', {
            success: summary.successCount,
            total: summary.totalComponents,
          }));

          // Refresh version table
          await loadWorkerVersionComparison(currentEnvForUpdate);
        } else if (response.manualAction?.kind === 'wildcard-dns' && response.manualAction.baseDomain) {
          addLog('');
          buildWildcardDnsManualMessage(response.manualAction.baseDomain)
            .split('\\n')
            .forEach((line) => addLog(line));
        } else {
          addLog('');
          addLog(t('web.envDetail.updateFailedWithMessage', {
            error: response.error || t('web.status.unknownError'),
          }));
        }
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        if (pollTimer) {
          window.clearInterval(pollTimer);
        }
        await pollWorkerUpdateProgress();
        updateWorkerUpdateButtonState();
        const btnSpan2 = btn.querySelector('span');
        if (btnSpan2) btnSpan2.textContent = t('web.envDetail.updateAllWorkers') || 'Update All Workers';
      }
    }

    function getFullDeployUiComponents() {
      const configuredComponents = selectedEnvDetailConfig?.components;
      if (configuredComponents && typeof configuredComponents === 'object') {
        return ['ar-admin-ui', 'ar-login-ui'].filter((componentName) => {
          const configKey = componentName === 'ar-admin-ui' ? 'adminUi' : 'loginUi';
          return configuredComponents[configKey] !== false;
        });
      }

      if (!selectedEnvForDetail) return [];
      return ['ar-admin-ui', 'ar-login-ui'].filter((componentName) =>
        hasUiWorker(selectedEnvForDetail, currentEnvForUpdate + '-' + componentName)
      );
    }

    async function runFullDeployStep(endpoint, body, startMarker, addLog) {
      let lastProgressLength = 0;
      let hasSeenStart = false;
      const appendProgressMessages = (progress) => {
        if (!Array.isArray(progress)) return;

        if (!hasSeenStart) {
          const startIndex = progress.findIndex((msg) => String(msg || '').includes(startMarker));
          if (startIndex === -1) return;
          hasSeenStart = true;
          lastProgressLength = startIndex + 1;
        }

        if (progress.length < lastProgressLength) lastProgressLength = 0;
        if (progress.length > lastProgressLength) {
          progress.slice(lastProgressLength).forEach((msg) => addLog(formatProgressMessageForDisplay(msg)));
          lastProgressLength = progress.length;
        }
      };

      const pollProgress = async () => {
        try {
          const statusResult = await api('/deploy/status');
          appendProgressMessages(statusResult.progress || []);
        } catch {
          // The deployment request remains the source of truth for the final result.
        }
      };

      const pollTimer = window.setInterval(pollProgress, 1000);
      window.setTimeout(pollProgress, 300);
      try {
        const response = await api(endpoint, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        appendProgressMessages(response.progress || []);
        return response;
      } finally {
        window.clearInterval(pollTimer);
        await pollProgress();
      }
    }

    async function startFullEnvironmentDeploy() {
      if (!currentEnvForUpdate) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const btn = document.getElementById('btn-deploy-full-environment');
      const progressDiv = document.getElementById('full-environment-deploy-progress');
      const logDiv = document.getElementById('full-environment-deploy-log');
      if (!btn || !progressDiv || !logDiv) return;

      const workerUpdateButton = document.getElementById('btn-update-workers');
      const adminUpdateButton = document.getElementById('btn-update-admin-ui');
      const loginUpdateButton = document.getElementById('btn-update-login-ui');
      const buttons = [btn, workerUpdateButton, adminUpdateButton, loginUpdateButton].filter(Boolean);
      const uiComponents = getFullDeployUiComponents();
      const totalComponents = 1 + uiComponents.length;
      let completedComponents = 0;

      buttons.forEach((button) => { button.disabled = true; });
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog(t('web.envDetail.fullDeployStarting', { env: currentEnvForUpdate }));
        addLog(t('web.envDetail.fullDeployApiPhase'));
        const workerResponse = await runFullDeployStep(
          '/update/workers',
          { env: currentEnvForUpdate, onlyChanged: false, includeUiWorkers: true },
          'Starting worker update for environment: ' + currentEnvForUpdate,
          addLog
        );
        if (!workerResponse.success) {
          throw new Error(workerResponse.error || t('web.status.unknownError'));
        }
        completedComponents += 1;

        for (const componentName of uiComponents) {
          addLog(t('web.envDetail.fullDeployUiComponent', { component: componentName }));
          const uiResponse = await runFullDeployStep(
            '/deploy/component/' + encodeURIComponent(componentName),
            { env: currentEnvForUpdate, skipBuild: false, dryRun: false },
            'Deploying component: ' + componentName,
            addLog
          );
          if (!uiResponse.success) {
            throw new Error(uiResponse.error || t('web.status.unknownError'));
          }
          completedComponents += 1;
        }

        addLog(t('web.envDetail.fullDeploySummary', {
          success: completedComponents,
          total: totalComponents,
        }));
        addLog(t('web.envDetail.fullDeployComplete'));
        await loadWorkerVersionComparison(currentEnvForUpdate);
      } catch (error) {
        addLog(t('web.envDetail.fullDeployFailed', { error: error.message }));
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
        updateWorkerUpdateButtonState();
      }
    }

    // Update a single worker component
    async function updateSingleComponent(componentName) {
      if (!currentEnvForUpdate) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const progressDiv = document.getElementById('worker-update-progress');
      const logDiv = document.getElementById('worker-update-log');

      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      addLog(t('web.envDetail.componentUpdating', {
        component: componentName,
        env: currentEnvForUpdate,
      }));

      try {
        const response = await api('/deploy/component/' + encodeURIComponent(componentName), {
          method: 'POST',
          body: JSON.stringify({
            env: currentEnvForUpdate,
            skipBuild: false,
            dryRun: false
          })
        });

        if (response.success) {
          addLog('');
          addLog(t('web.envDetail.componentUpdatedSuccess', { component: componentName }));
          if (response.workerName) addLog(t('web.envDetail.logWorker', { value: response.workerName }));
          if (response.version) addLog(t('web.envDetail.logVersion', { value: response.version }));
          if (response.deployedAt) addLog(t('web.envDetail.logDeployedAt', { value: response.deployedAt }));

          if (response.version) {
            workerVersionComparison = workerVersionComparison.map((item) =>
              item.component === componentName
                ? {
                    ...item,
                    deployedVersion: response.version,
                    lastDeployedAt: response.deployedAt || item.lastDeployedAt,
                    needsUpdate: item.localVersion ? response.version !== item.localVersion : false,
                  }
                : item
            );
            renderVersionTable(workerVersionComparison);
            updateWorkerUpdateButtonState();
          }

          // Refresh version table from the lock file after the deploy endpoint saves it.
          await loadWorkerVersionComparison(currentEnvForUpdate);
        } else if (response.manualAction?.kind === 'wildcard-dns' && response.manualAction.baseDomain) {
          addLog('');
          buildWildcardDnsManualMessage(response.manualAction.baseDomain)
            .split('\\n')
            .forEach((line) => addLog(line));
        } else {
          addLog('');
          addLog(t('web.envDetail.updateFailedWithMessage', {
            error: response.error || t('web.status.unknownError'),
          }));
        }
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      }
    }

    // Update UI component (Workers)
    async function updateUIComponent(componentName) {
      if (!currentEnvForUpdate) {
        alert(t('web.envDetail.noEnvironmentSelected'));
        return;
      }

      const btn = componentName === 'ar-admin-ui'
        ? document.getElementById('btn-update-admin-ui')
        : document.getElementById('btn-update-login-ui');
      const progressDiv = document.getElementById('ui-update-progress');
      const logDiv = document.getElementById('ui-update-log');

      // Disable button and show progress
      btn.disabled = true;
      const originalText = btn.querySelector('span').textContent;
      btn.querySelector('span').textContent = t('web.status.deploying') || 'Updating...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      addLog(t('web.envDetail.componentUpdating', {
        component: componentName,
        env: currentEnvForUpdate,
      }));
      addLog(t('web.envDetail.uiUpdateMayTakeMinutes'));

      try {
        const response = await api('/deploy/component/' + encodeURIComponent(componentName), {
          method: 'POST',
          body: JSON.stringify({
            env: currentEnvForUpdate,
            skipBuild: false,
            dryRun: false
          })
        });

        if (response.success) {
          addLog('');
          addLog(t('web.envDetail.componentUpdatedSuccess', { component: componentName }));
          if (response.projectName) addLog(t('web.envDetail.logProject', { value: response.projectName }));
          if (response.deployedAt) addLog(t('web.envDetail.logDeployedAt', { value: response.deployedAt }));
        } else {
          addLog('');
          addLog(t('web.envDetail.updateFailedWithMessage', {
            error: response.error || t('web.status.unknownError'),
          }));
        }
      } catch (error) {
        addLog(t('web.status.errorWithMessage', { error: error.message }));
      } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = originalText;
      }
    }

    // Event listeners for Worker Update
    document.getElementById('btn-deploy-full-environment')?.addEventListener('click', startFullEnvironmentDeploy);
    document.getElementById('btn-update-workers')?.addEventListener('click', startWorkerUpdate);
    document.getElementById('update-only-changed')?.addEventListener('change', () => {
      updateWorkerUpdateButtonState();
    });
    document.getElementById('btn-refresh-versions')?.addEventListener('click', () => {
      if (currentEnvForUpdate) {
        resetWorkerUpdateUI();
        loadWorkerVersionComparison(currentEnvForUpdate);
      }
    });

    // Event listeners for UI Update
    document.getElementById('btn-update-admin-ui')?.addEventListener('click', () => updateUIComponent('ar-admin-ui'));
    document.getElementById('btn-update-login-ui')?.addEventListener('click', () => updateUIComponent('ar-login-ui'));
    document.getElementById('env-service-site-enabled')?.addEventListener('change', (event) => {
      document
        .getElementById('env-service-site-enabled-line')
        ?.classList.toggle('on', event.currentTarget.checked);
    });
    document.getElementById('btn-refresh-service-site')?.addEventListener('click', () => {
      if (selectedEnvForDetail) {
        loadServiceSiteStatus(selectedEnvForDetail.env);
      }
    });
    document.getElementById('btn-save-service-site')?.addEventListener('click', configureServiceSiteForEnv);
    document.getElementById('btn-enable-cloudflare-email')?.addEventListener('click', enableCloudflareEmailForEnv);
    document.getElementById('btn-enable-resend-email')?.addEventListener('click', enableResendEmailForEnv);
    document.getElementById('btn-refresh-r2-buckets')?.addEventListener('click', () => {
      if (selectedEnvForDetail) {
        loadR2ProvisionStatus(selectedEnvForDetail.env);
      }
    });
    document.getElementById('btn-provision-r2-buckets')?.addEventListener('click', provisionR2BucketsForEnv);

    // ===========================================
    // Admin Setup Functions
    // ===========================================

    // Check admin setup status and show section if needed
    async function checkAndShowAdminSetup(kvNamespaceId, envName) {
      try {
        const response = await api(
          '/admin/status/' + encodeURIComponent(kvNamespaceId) +
          '?env=' + encodeURIComponent(envName)
        );
        if (!response.success) return;

        const section = document.getElementById('admin-setup-section');
        const heading = section.querySelector('.a-head');
        const description = section.querySelector('p');
        const button = document.getElementById('btn-start-admin-setup');

        if (response.statusKnown === false) {
          // Do not turn a transient Cloudflare/namespace status failure into a false
          // "not configured" instruction that invites another setup-token operation.
          section.classList.add('hidden');
          return;
        }

        if (response.adminSetupCompleted) {
          section.className = 'alert ok';
          section.classList.remove('hidden');
          if (heading) {
            heading.setAttribute('data-i18n', 'web.env.adminConfigured');
            heading.textContent = t('web.env.adminConfigured');
          }
          if (description) {
            description.removeAttribute('data-i18n');
            description.textContent = '';
            description.classList.add('hidden');
          }
          document.getElementById('admin-setup-result')?.classList.add('hidden');
          if (button) {
            button.disabled = true;
            button.classList.add('hidden');
          }
          return;
        }

        section.className = 'alert ok';
        section.classList.remove('hidden');
        if (heading) {
          heading.setAttribute('data-i18n', 'web.envDetail.adminNotConfigured');
          heading.textContent = t('web.envDetail.adminNotConfigured');
        }
        if (description) {
          description.classList.remove('hidden');
          description.setAttribute('data-i18n', 'web.envDetail.adminNotConfiguredDesc');
          description.textContent = t('web.envDetail.adminNotConfiguredDesc');
        }
        if (button) {
          button.disabled = false;
          button.classList.remove('hidden');
          button.setAttribute('data-i18n', 'web.envDetail.startPasskey');
          button.textContent = t('web.envDetail.startPasskey');
        }
      } catch (error) {
        console.error('Failed to check admin status:', error);
      }
    }

    // Helper to render resource list
    function renderResourceList(listId, countId, resources, nameKey, resourceType) {
      const list = document.getElementById(listId);
      const count = document.getElementById(countId);

      list.innerHTML = '';
      count.textContent = String(resources.length);

      if (resources.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyCell = document.createElement('td');
        emptyCell.className = 'v resource-empty';
        emptyCell.textContent = t('web.status.none');
        emptyRow.appendChild(emptyCell);
        list.appendChild(emptyRow);
        return;
      }

      for (const resource of resources) {
        const item = document.createElement('tr');
        item.className = 'resource-item';
        item.id = 'resource-' + resourceType + '-' + (resource.name || resource.title || '').replace(/[^a-zA-Z0-9-]/g, '_');

        const nameDiv = document.createElement('td');
        nameDiv.className = 'resource-item-name';
        nameDiv.textContent =
          resource[nameKey] || resource.title || resource.id || t('web.status.unknown');
        item.appendChild(nameDiv);

        // Add loading placeholder for D1 and Workers
        if (resourceType === 'd1' || resourceType === 'worker') {
          const detailsDiv = document.createElement('td');
          detailsDiv.className = 'resource-item-details resource-item-loading';
          detailsDiv.textContent = t('web.status.loading');
          item.appendChild(detailsDiv);
        } else {
          const spacer = document.createElement('td');
          spacer.className = 'resource-item-details';
          spacer.textContent = '';
          item.appendChild(spacer);
        }

        list.appendChild(item);
      }
    }

    // Load resource details asynchronously
    async function loadResourceDetails(env) {
      // Load D1 and Worker details in parallel
      const d1Promises = env.d1.map(db => loadD1Details(db.name));
      const workerPromises = env.workers.map(w => loadWorkerDetails(w.name));

      // Wait for all to complete (don't block on errors)
      await Promise.allSettled([...d1Promises, ...workerPromises]);
    }

    // Load D1 database details
    async function loadD1Details(name) {
      try {
        const result = await fetch('/api/d1/' + encodeURIComponent(name) + '/info').then(r => r.json());

        const itemId = 'resource-d1-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.info) {
          const info = result.info;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (info.databaseSize) {
            const span = document.createElement('span');
            span.textContent = info.databaseSize;
            detailsDiv.appendChild(span);
          }
          if (info.region) {
            const span = document.createElement('span');
            span.textContent = info.region;
            detailsDiv.appendChild(span);
          }
          if (info.createdAt) {
            const span = document.createElement('span');
            span.textContent = formatDate(info.createdAt);
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-error';
          detailsDiv.textContent = t('web.status.failedToLoad');
        }
      } catch (e) {
        console.error('Failed to load D1 details:', e);
      }
    }

    // Load Worker deployment details
    async function loadWorkerDetails(name) {
      try {
        const result = await fetch('/api/worker/' + encodeURIComponent(name) + '/deployments').then(r => r.json());

        const itemId = 'resource-worker-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.deployments) {
          const info = result.deployments;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (!info.exists) {
            detailsDiv.className = 'resource-item-details resource-item-not-deployed';
            detailsDiv.textContent = t('web.envDetail.notDeployed');
            return;
          }

          if (info.lastDeployedAt) {
            const span = document.createElement('span');
            span.textContent = formatDate(info.lastDeployedAt);
            detailsDiv.appendChild(span);
          }
          if (info.author) {
            const span = document.createElement('span');
            span.textContent = info.author;
            detailsDiv.appendChild(span);
          }
          if (info.versionId) {
            const span = document.createElement('span');
            span.textContent = info.versionId.substring(0, 8) + '...';
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-not-deployed';
          detailsDiv.textContent = t('web.envDetail.notDeployed');
        }
      } catch (e) {
        console.error('Failed to load Worker details:', e);
      }
    }

    // Format ISO date to readable format with timezone
    function formatDate(isoString) {
      try {
        const date = new Date(isoString);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Get timezone abbreviation
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzAbbr = date.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
        return dateStr + ' (' + tzAbbr + ')';
      } catch {
        return isoString;
      }
    }

    // Show delete confirmation
    function showDeleteConfirmation(env, resetState = true) {
      selectedEnvForDelete = env;
      if (resetState) {
        resetDeleteSection();
      }
      const resourceCount = (count, key) => t(key, { count });
      const setDeleteOption = (optionId, inputId, countId, count, key) => {
        const option = document.getElementById(optionId);
        const input = document.getElementById(inputId);
        const countEl = document.getElementById(countId);
        if (countEl) countEl.textContent = resourceCount(count, key);
        if (input && resetState) input.checked = count > 0;
        if (option) option.classList.toggle('hidden', count === 0);
      };

      document.getElementById('delete-env-name').textContent = env.env;
      document.getElementById('delete-workers-count').textContent = resourceCount(env.workers.length, 'web.delete.countWorkers');
      document.getElementById('delete-d1-count').textContent = resourceCount(env.d1.length, 'web.delete.countDatabases');
      document.getElementById('delete-kv-count').textContent = resourceCount(env.kv.length, 'web.delete.countNamespaces');
      setDeleteOption('delete-queues-option', 'delete-queues', 'delete-queues-count', env.queues.length, 'web.delete.countQueues');
      setDeleteOption('delete-r2-option', 'delete-r2', 'delete-r2-count', env.r2.length, 'web.delete.countBuckets');
      setDeleteOption('delete-pages-option', 'delete-pages', 'delete-pages-count', (env.pages || []).length, 'web.delete.countProjects');
      const totalCount =
        (env.workers?.length || 0) +
        (env.d1?.length || 0) +
        (env.kv?.length || 0) +
        (env.queues?.length || 0) +
        (env.r2?.length || 0) +
        ((env.pages || []).length || 0);
      const deleteTotalCount = document.getElementById('delete-total-count');
      if (deleteTotalCount) deleteTotalCount.textContent = String(totalCount);
      const confirmCopy = document.getElementById('delete-confirm-copy');
      if (confirmCopy) {
        confirmCopy.innerHTML = t('web.delete.confirmExact', { env: escapeHtml(env.env) });
      }
      const confirmInput = document.getElementById('delete-confirm-input');
      if (confirmInput && resetState) {
        confirmInput.value = '';
        confirmInput.placeholder = env.env;
      }

      if (resetState) {
        // Current resource inventories remain strict even at zero. Legacy Pages is selected only
        // when observed; the API separately records that this flow intends to finish the environment.
        document.getElementById('delete-workers').checked = true;
        document.getElementById('delete-d1').checked = true;
        document.getElementById('delete-kv').checked = true;
        document.getElementById('delete-queues').checked = true;
        document.getElementById('delete-r2').checked = true;
        document.getElementById('delete-pages').checked = (env.pages || []).length > 0;
        document.getElementById('btn-confirm-delete').disabled = true;
      }

      showSection('envDelete');
    }

    // Back buttons for environment management
    document.getElementById('btn-back-env-list').addEventListener('click', () => {
      showSection('topMenu');
    });

    window.addEventListener('beforeunload', (event) => {
      if (!migrationApplyInProgress && inFlightMutationRequests === 0) return;
      event.preventDefault();
      event.returnValue = '';
    });

    document.getElementById('btn-refresh-env-list').addEventListener('click', () => {
      loadEnvironments();
    });

    function resetControlCapacityPreview() {
      controlCapacityPreview = null;
      document.getElementById('control-capacity-result')?.classList.add('hidden');
      const targets = document.getElementById('control-capacity-targets');
      if (targets) targets.replaceChildren();
      const requestButton = document.getElementById('btn-control-capacity-request');
      if (requestButton) requestButton.disabled = true;
      const status = document.getElementById('control-capacity-status');
      if (status) status.textContent = '';
    }

    function getControlCapacityRequest() {
      if (!selectedEnvForDetail) throw new Error(t('web.envDetail.capacitySelectEnvironment'));
      const scope = document.getElementById('control-capacity-scope')?.value;
      const profile = document.getElementById('control-capacity-profile')?.value;
      const tenantId =
        scope === 'tenant_exclusive'
          ? document.getElementById('control-capacity-tenant')?.value || null
          : null;
      if (scope === 'tenant_exclusive' && !tenantId) {
        throw new Error(t('web.envDetail.capacityNoTenant'));
      }
      return { environmentId: selectedEnvForDetail.env, profile, scope, tenantId };
    }

    async function loadControlCapacityTenants() {
      if (!selectedEnvForDetail) return;
      const select = document.getElementById('control-capacity-tenant');
      if (!select) return;
      select.replaceChildren();
      try {
        const result = await api(
          '/control/capacity/tenants?environmentId=' +
            encodeURIComponent(selectedEnvForDetail.env)
        );
        for (const tenantId of Array.isArray(result.tenants) ? result.tenants : []) {
          const option = document.createElement('option');
          option.value = tenantId;
          option.textContent = tenantId;
          select.appendChild(option);
        }
      } catch (error) {
        const status = document.getElementById('control-capacity-status');
        if (status) {
          status.textContent =
            error.message || t('web.envDetail.capacityTargetsUnavailable');
        }
      }
    }

    function appendControlCapacityCell(row, primary, secondary) {
      const cell = document.createElement('td');
      const title = document.createElement('strong');
      title.textContent = primary;
      cell.appendChild(title);
      if (secondary) {
        const detail = document.createElement('small');
        detail.textContent = secondary;
        cell.appendChild(document.createElement('br'));
        cell.appendChild(detail);
      }
      row.appendChild(cell);
    }

    function renderControlCapacityPlan(preview, operations = []) {
      controlCapacityPreview = preview;
      const result = document.getElementById('control-capacity-result');
      const summary = document.getElementById('control-capacity-summary');
      const targets = document.getElementById('control-capacity-targets');
      const requestButton = document.getElementById('btn-control-capacity-request');
      if (!result || !summary || !targets || !requestButton) return;
      result.classList.remove('hidden');
      summary.textContent = t('web.envDetail.capacitySummary', {
        units: preview.capacityUnitsAdded,
        d1: preview.d1DatabasesAdded,
        total: preview.projectedEnvironmentD1Count,
      });
      targets.replaceChildren();
      for (const target of preview.targets || []) {
        const row = document.createElement('tr');
        appendControlCapacityCell(
          row,
          target.dataRole + ' / ' + target.residencyPartition,
          target.databaseName
        );
        appendControlCapacityCell(row, target.bindingRef, (target.workerScripts || []).join(', '));
        const operation = operations.find((item) => item.operationId === target.operationId);
        appendControlCapacityCell(
          row,
          operation?.lastErrorCode || operation?.status || t('web.envDetail.capacityPreviewState'),
          target.operationId
        );
        targets.appendChild(row);
      }
      requestButton.disabled =
        !preview.available || !Array.isArray(preview.targets) || preview.targets.length === 0;
    }

    async function runControlCapacityAction(action) {
      const status = document.getElementById('control-capacity-status');
      const previewButton = document.getElementById('btn-control-capacity-preview');
      const requestButton = document.getElementById('btn-control-capacity-request');
      if (previewButton) previewButton.disabled = true;
      if (requestButton) requestButton.disabled = true;
      if (status) {
        status.textContent =
          action === 'preview'
            ? t('web.envDetail.capacityLoading')
            : t('web.envDetail.capacityCreating');
      }
      try {
        const response = await api('/control/capacity/' + action, {
          method: 'POST',
          body: getControlCapacityRequest(),
        });
        if (!response.success) {
          throw new Error(response.error || t('web.envDetail.capacityRequestFailed'));
        }
        const preview = action === 'preview' ? response.preview : response.result?.preview;
        const operations = action === 'request' ? response.result?.operations || [] : [];
        renderControlCapacityPlan(preview, operations);
        if (status) {
          status.textContent =
            action === 'request'
              ? t('web.envDetail.capacityCreated')
              : preview.targets.length === 0
                ? t('web.envDetail.capacitySatisfied')
                : t('web.envDetail.capacityReady');
        }
        if (action === 'request') {
          pendingControlOperations = await loadPendingControlOperations();
        }
      } catch (error) {
        if (status) {
          status.textContent = error.message || t('web.envDetail.capacityRequestFailed');
        }
      } finally {
        if (previewButton) previewButton.disabled = false;
        if (requestButton) {
          requestButton.disabled =
            !controlCapacityPreview?.available || controlCapacityPreview.targets.length === 0;
        }
      }
    }

    document.getElementById('control-capacity-scope')?.addEventListener('change', (event) => {
      const exclusive = event.target.value === 'tenant_exclusive';
      document
        .getElementById('control-capacity-tenant-field')
        ?.classList.toggle('hidden', !exclusive);
      resetControlCapacityPreview();
      if (exclusive) loadControlCapacityTenants();
    });
    document
      .getElementById('control-capacity-profile')
      ?.addEventListener('change', resetControlCapacityPreview);
    document
      .getElementById('control-capacity-tenant')
      ?.addEventListener('change', resetControlCapacityPreview);
    document
      .getElementById('btn-control-capacity-preview')
      ?.addEventListener('click', () => runControlCapacityAction('preview'));
    document
      .getElementById('btn-control-capacity-request')
      ?.addEventListener('click', () => runControlCapacityAction('request'));

    document.getElementById('btn-back-env-detail').addEventListener('click', () => {
      showSection('envList');
    });

    document.querySelectorAll('[data-env-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.getAttribute('data-env-tab');
        if (!name) return;

        document.querySelectorAll('[data-env-tab]').forEach((item) => {
          item.classList.toggle('on', item === tab);
        });
        document.querySelectorAll('[data-env-pane]').forEach((pane) => {
          pane.classList.toggle('on', pane.getAttribute('data-env-pane') === name);
        });

        const activePane = [...document.querySelectorAll('[data-env-pane]')].find(
          (pane) => pane.getAttribute('data-env-pane') === name
        );
        if (activePane) {
          activePane.classList.remove('env-tab-enter');
          void activePane.offsetWidth;
          activePane.classList.add('env-tab-enter');
        }

        if (name === 'migrations' && selectedEnvForDetail) {
          loadMigrationStatus(selectedEnvForDetail.env);
        }
        if (name === 'capacity' && selectedEnvForDetail) {
          resetControlCapacityPreview();
          if (document.getElementById('control-capacity-scope')?.value === 'tenant_exclusive') {
            loadControlCapacityTenants();
          }
        }
      });
    });

    document.getElementById('btn-refresh-migrations')?.addEventListener('click', () => {
      if (selectedEnvForDetail) {
        loadMigrationStatus(selectedEnvForDetail.env);
      }
    });

    document.getElementById('btn-apply-all-migrations')?.addEventListener('click', () => {
      applyMigrationsForEnv();
    });

    document.getElementById('migration-status-list')?.addEventListener('click', (event) => {
      const button = event.target?.closest?.('.migration-apply-one');
      if (!button) return;
      applyMigrationsForEnv({
        role: button.dataset.role,
        filename: button.dataset.filename,
      });
    });

    document.getElementById('btn-delete-from-detail').addEventListener('click', () => {
      if (selectedEnvForDetail) {
        showDeleteConfirmation(selectedEnvForDetail);
      }
    });

    document.getElementById('btn-resume-initial-deploy')?.addEventListener('click', () => {
      resumeInitialDeploymentFromEnvironment();
    });

    document.getElementById('btn-start-release-update')?.addEventListener('click', () => {
      startReleaseUpdate();
    });
    document.getElementById('btn-start-database-only-update')?.addEventListener('click', () => {
      startReleaseUpdate(true);
    });

    // Admin setup button
    document.getElementById('btn-start-admin-setup').addEventListener('click', async () => {
      if (!selectedEnvForDetail) return;

      const btn = document.getElementById('btn-start-admin-setup');
      const resultDiv = document.getElementById('admin-setup-result');
      const urlInput = document.getElementById('admin-setup-url');
      const openLink = document.getElementById('btn-open-setup-url');

      btn.disabled = true;
      btn.textContent = t('web.envDetail.generating');

      try {
        // Find AUTHRIM_CONFIG KV namespace
        const configKv = selectedEnvForDetail.kv.find(kv =>
          kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
          kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
        );

        if (!configKv) {
          alert(t('web.envDetail.configKvNotFound'));
          btn.disabled = false;
          btn.textContent = t('web.envDetail.startPasskey');
          return;
        }

        // Determine base URL: prefer custom domain from config, fallback to workers.dev
        let baseUrl = '';

        // Try to load config to get custom API domain
        try {
          const configResponse = await api('/config?env=' + encodeURIComponent(selectedEnvForDetail.env));
          if (configResponse.exists && configResponse.config) {
            baseUrl = configResponse.config.urls?.api?.custom || configResponse.config.urls?.api?.auto || '';
          }
        } catch (e) {
          // Config not available, will fallback to workers.dev
        }

        // Fallback to workers.dev URL if no config URL found
        if (!baseUrl) {
          const router = selectedEnvForDetail.workers.find(w =>
            w.name.toLowerCase().includes('router')
          );
          if (router && router.name) {
            if (workersSubdomain) {
              baseUrl = 'https://' + router.name + '.' + workersSubdomain + '.workers.dev';
            } else {
              baseUrl = 'https://' + router.name + '.workers.dev';
            }
          } else {
            baseUrl = prompt(t('web.envDetail.routerBaseUrlPrompt'));
            if (!baseUrl) {
              btn.disabled = false;
              btn.textContent = t('web.envDetail.startPasskey');
              return;
            }
          }
        }

        const response = await api('/admin/generate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kvNamespaceId: configKv.id,
            baseUrl: baseUrl,
            env: selectedEnvForDetail.env,
          }),
        });

        if (response.success && response.setupUrl) {
          urlInput.value = response.setupUrl;
          openLink.href = response.setupUrl;
          resultDiv.classList.remove('hidden');
          btn.textContent = t('web.envDetail.tokenGenerated');
        } else {
          if (String(response.error || '').includes('already been completed')) {
            document.getElementById('admin-setup-section')?.classList.add('hidden');
            resultDiv.classList.add('hidden');
            return;
          }
          alert(t('web.envDetail.tokenGenerateFailed', {
            error: response.error || t('web.status.unknownError'),
          }));
          btn.disabled = false;
          btn.textContent = t('web.envDetail.startPasskey');
        }
      } catch (error) {
        alert(t('web.status.errorWithMessage', { error: error.message }));
        btn.disabled = false;
        btn.textContent = t('web.envDetail.startPasskey');
      }
    });

    // Copy setup URL button
    document.getElementById('btn-copy-setup-url').addEventListener('click', () => {
      const urlInput = document.getElementById('admin-setup-url');
      urlInput.select();
      document.execCommand('copy');
      const btn = document.getElementById('btn-copy-setup-url');
      const originalText = btn.textContent;
      btn.textContent = t('web.complete.copied');
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    });

    document.getElementById('btn-back-env-delete').addEventListener('click', () => {
      // Go back to detail view if we came from there
      if (selectedEnvForDetail) {
        showSection('envDetail');
      } else {
        showSection('envList');
      }
    });

    document.getElementById('delete-confirm-input')?.addEventListener('input', (event) => {
      const expected = selectedEnvForDelete?.env || '';
      const btn = document.getElementById('btn-confirm-delete');
      if (btn) {
        btn.disabled = event.target.value !== expected;
      }
    });

    // Delete environment
    document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
      if (!selectedEnvForDelete) return;

      const btn = document.getElementById('btn-confirm-delete');
      const confirmInput = document.getElementById('delete-confirm-input');
      if (confirmInput && confirmInput.value !== selectedEnvForDelete.env) {
        btn.disabled = true;
        return;
      }
      const log = document.getElementById('delete-log');
      const output = document.getElementById('delete-output');
      const result = document.getElementById('delete-result');
      const progressUI = document.getElementById('delete-progress-ui');

      btn.disabled = true;
      btn.classList.add('hidden');
      document.getElementById('delete-options-section').classList.add('hidden');
      progressUI.classList.remove('hidden');
      log.classList.add('hidden'); // Log is hidden by default, toggled via button
      result.classList.add('hidden');
      output.textContent = '';

      const deleteOptions = {
        deleteWorkers: document.getElementById('delete-workers').checked,
        deleteD1: document.getElementById('delete-d1').checked,
        deleteKV: document.getElementById('delete-kv').checked,
        deleteQueues: document.getElementById('delete-queues').checked,
        deleteR2: document.getElementById('delete-r2').checked,
        deletePages: document.getElementById('delete-pages').checked,
        finalizeEnvironment: true,
      };

      // Count actual resources to delete based on environment info
      let deleteCompleted = 0;
      let totalToDelete = 0;
      if (deleteOptions.deleteWorkers) totalToDelete += selectedEnvForDelete.workers?.length || 0;
      if (deleteOptions.deleteD1) totalToDelete += selectedEnvForDelete.d1?.length || 0;
      if (deleteOptions.deleteKV) totalToDelete += selectedEnvForDelete.kv?.length || 0;
      if (deleteOptions.deleteQueues) totalToDelete += selectedEnvForDelete.queues?.length || 0;
      if (deleteOptions.deleteR2) totalToDelete += selectedEnvForDelete.r2?.length || 0;
      if (deleteOptions.deletePages) totalToDelete += selectedEnvForDelete.pages?.length || 0;
      updateProgressUI('delete', 0, totalToDelete, t('web.delete.starting'));

      // Poll for progress
      let lastProgressLength = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          const structuredProgress = statusResult.operationProgress?.operation === 'delete'
            ? statusResult.operationProgress
            : null;
          if (structuredProgress) {
            deleteCompleted = Math.max(0, Number(structuredProgress.current) || 0);
            if (Number(structuredProgress.total) > 0) {
              totalToDelete = Number(structuredProgress.total);
            }
            updateProgressUI('delete', deleteCompleted, totalToDelete);
          }
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += formatProgressMessageForDisplay(msg) + '\\n';
              // Update progress UI based on message content
              const taskInfo = getDeleteProgressTask(msg) || parseProgressMessage(msg);
              if (taskInfo) {
                updateProgressUI('delete', deleteCompleted, totalToDelete, taskInfo);
              }
              // Count completed items (lines with checkmark)
              if (!structuredProgress && (msg.includes('✓') || msg.includes('✅'))) {
                deleteCompleted++;
                updateProgressUI('delete', deleteCompleted, totalToDelete, taskInfo || t('web.delete.deletedItems', { count: deleteCompleted }));
              }
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        } catch (e) {}
      }, 500);

      try {
        const deleteResult = await api('/environments/' + selectedEnvForDelete.env + '/delete', {
          method: 'POST',
          body: deleteOptions,
        });

        clearInterval(pollInterval);

        // Show final progress
        if (deleteResult.progress) {
          output.textContent = deleteResult.progress.map(formatProgressMessageForDisplay).join('\\n');
        }

        const finalStructuredProgress = deleteResult.operationProgress?.operation === 'delete'
          ? deleteResult.operationProgress
          : null;
        if (finalStructuredProgress && Number(finalStructuredProgress.total) > 0) {
          deleteCompleted = Math.max(0, Number(finalStructuredProgress.current) || 0);
          totalToDelete = Number(finalStructuredProgress.total);
          updateProgressUI('delete', deleteCompleted, totalToDelete);
        }

        result.classList.remove('hidden');

        if (deleteResult.success && deleteResult.completion === 'manual_action_required') {
          const environmentDeleted = deleteResult.environmentDeleted === true;
          updateProgressUI(
            'delete',
            totalToDelete,
            totalToDelete,
            t(environmentDeleted ? 'web.delete.complete' : 'web.delete.manualActionRequired')
          );
          result.textContent = '';
          const manualR2Targets = Array.isArray(deleteResult.manualR2) ? deleteResult.manualR2 : [];
          const manualDnsIssues = Array.isArray(deleteResult.manualDns) ? deleteResult.manualDns : [];
          const manualControlTokenTargets = Array.isArray(deleteResult.manualControlTokens) ? deleteResult.manualControlTokens : [];
          if (manualR2Targets.length > 0) {
            result.appendChild(createAlert('warning', t('web.delete.manualR2Summary')));
            appendManualR2CleanupNotice(result, manualR2Targets);
          }
          if (manualDnsIssues.length > 0) {
            result.appendChild(createAlert('warning', t('web.delete.dnsNote')));
            appendManualDnsCleanupNotice(result, manualDnsIssues);
          }
          appendManualControlTokenCleanupNotice(result, manualControlTokenTargets);
          if (environmentDeleted) {
            markDeleteNavigationComplete();
            // Keep the follow-up guidance visible while refreshing the hidden environment list so
            // navigating back cannot resurrect an entry whose local recovery state was removed.
            setTimeout(async () => {
              await resetServerState();
              selectedEnvForDelete = null;
              selectedEnvForDetail = null;
              await loadEnvironments();
            }, 0);
          }
        } else if (deleteResult.success) {
          // Final progress update
          updateProgressUI('delete', totalToDelete, totalToDelete, t('web.delete.complete'));
          result.textContent = '';
          const environmentDeleted = deleteResult.environmentDeleted === true;
          if (environmentDeleted) markDeleteNavigationComplete();
          result.appendChild(createAlert(
            environmentDeleted ? 'success' : 'warning',
            t(environmentDeleted ? 'web.delete.success' : 'web.delete.partialSuccess')
          ));

          // Refresh environment list after a short delay
          setTimeout(async () => {
            await resetServerState();
            resetDeleteSection();
            selectedEnvForDelete = null;
            selectedEnvForDetail = null;
            loadEnvironments();
            showSection('envList');
          }, 2000);
        } else {
          markProgressBarError('delete');
          result.textContent = '';
          result.appendChild(createAlert('error', t('web.delete.errorList', { errors: apiErrorMessages(deleteResult).join(', ') })));
          appendManualR2CleanupNotice(result, deleteResult.manualR2);
          appendManualDnsCleanupNotice(result, deleteResult.manualDns);
          appendManualControlTokenCleanupNotice(result, deleteResult.manualControlTokens);
          btn.classList.remove('hidden');
          btn.disabled = false;
        }
      } catch (error) {
        clearInterval(pollInterval);
        markProgressBarError('delete');
        result.classList.remove('hidden');
        result.textContent = '';
        const message = error instanceof Error && error.message
          ? error.message
          : t('web.status.unknownError');
        result.appendChild(createAlert('error', t('web.status.errorWithMessage', { error: message })));
        btn.classList.remove('hidden');
        btn.disabled = false;
      }
    });

    async function initializeManageOnly() {
      showSection('envList');
      const runtimeContextPromise = loadRuntimeContext()
        .then(() => {
          setEnvManagementHero('envList');
        })
        .catch((error) => {
          console.warn('Failed to load Cloudflare account context:', error);
        });
      await Promise.allSettled([runtimeContextPromise, loadEnvironments()]);
    }

    // Initialize
    if (MANAGE_ONLY) {
      // The CLI already enforced prerequisites, but the browser still needs the same read-only
      // context so account and workers.dev metadata do not remain as placeholders.
      initializeManageOnly();
    } else {
      checkPrerequisites();
    }
  </script>
</body>
</html>`;
}

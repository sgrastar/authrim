export interface SetupCapabilityCopy {
  title: string;
  hint: string;
  ok: string;
  review: string;
  ng: string;
  workersDeploy: string;
  workersDeployOk: string;
  workersDeployReview: string;
  workersDeployNg: string;
  customDomain: string;
  customDomainOk: string;
  customDomainReviewZoneRead: string;
  customDomainNgNoZone: string;
  multiTenant: string;
  multiTenantOk: string;
  multiTenantReview: string;
  nakedDomain: string;
  nakedDomainOk: string;
  nakedDomainReview: string;
  pages: string;
  pagesOk: string;
  pagesReview: string;
}

export const SETUP_CAPABILITY_COPY: Record<string, SetupCapabilityCopy> = {
  ja: {
    title: '利用可否の目安',
    hint: '現在の Cloudflare ログイン状態と API 到達性から推定しています。途中失敗を減らすための事前チェックです。',
    ok: 'OK',
    review: '要確認',
    ng: 'NG',
    workersDeploy: 'Workers デプロイ',
    workersDeployOk:
      'wrangler のログイン状態を確認できたため、Workers 配備に必要な前提を満たしています。',
    workersDeployReview: '前提を一部確認できません。ログイン状態と token を見直してください。',
    workersDeployNg: 'wrangler のインストールまたは Cloudflare ログインが未完了です。',
    customDomain: 'カスタムドメイン',
    customDomainOk:
      'Zone 一覧にアクセスできるため、カスタムドメイン設定に必要な前提を満たしています。',
    customDomainReviewZoneRead:
      'Zone 一覧を確認できません。カスタムドメイン設定は追加確認が必要です。',
    customDomainNgNoZone:
      '利用可能な Cloudflare Zone が見つかりません。カスタムドメインは使えません。',
    multiTenant: 'マルチテナント',
    multiTenantOk:
      'DNS レコード参照を確認できたため、テナント用ワイルドカード DNS 設定に必要な前提を満たしています。',
    multiTenantReview: 'DNS 権限を確認できません。サブドメイン設定は追加確認が必要です。',
    nakedDomain: 'ネイキッドドメイン',
    nakedDomainOk:
      'マルチテナント用 DNS 前提を満たしているため、ネイキッドドメイン構成に必要な前提も満たしています。',
    nakedDomainReview:
      'マルチテナント用 DNS 前提を確認できません。ネイキッドドメイン構成は追加確認が必要です。',
    pages: 'Cloudflare Pages',
    pagesOk:
      'Pages API に到達できるため、Login/Admin UI の Pages 配備に必要な前提を満たしています。',
    pagesReview: 'Pages API を確認できません。Pages 配備は追加確認が必要です。',
  },
  en: {
    title: 'Estimated Feature Availability',
    hint: 'This is an estimate based on the current Cloudflare login and API reachability. It helps catch likely failures before setup continues.',
    ok: 'OK',
    review: 'Review',
    ng: 'NG',
    workersDeploy: 'Workers deploy',
    workersDeployOk:
      'Wrangler authentication looks usable, meeting the prerequisites required for Workers deployment.',
    workersDeployReview:
      'Some prerequisites for Workers deployment could not be verified. Review login and token access before continuing.',
    workersDeployNg: 'Wrangler is not installed or Cloudflare login is incomplete.',
    customDomain: 'Custom domain',
    customDomainOk:
      'Zone access is available, meeting the prerequisites required for custom-domain setup.',
    customDomainReviewZoneRead:
      'Zone access could not be verified, so custom-domain setup may still work but needs review.',
    customDomainNgNoZone:
      'No accessible Cloudflare zone was found, so custom domains are not available.',
    multiTenant: 'Multi-tenant',
    multiTenantOk:
      'DNS record access is available, meeting the prerequisites required for wildcard DNS setup.',
    multiTenantReview:
      'DNS access could not be verified, so tenant subdomain setup may still work but needs review.',
    nakedDomain: 'Naked domain',
    nakedDomainOk:
      'The DNS prerequisites for multi-tenant routing appear available, meeting the requirements for naked-domain routing.',
    nakedDomainReview:
      'The DNS prerequisites for multi-tenant routing could not be verified, so naked-domain routing needs review.',
    pages: 'Cloudflare Pages',
    pagesOk:
      'The Pages API is reachable, meeting the prerequisites required for Login/Admin UI deployment on Pages.',
    pagesReview:
      'The Pages API could not be verified, so Pages deployment may still work but needs review.',
  },
  'zh-CN': {
    title: '可用性预估',
    hint: '这是根据当前 Cloudflare 登录状态和 API 可达性得出的推测，用于提前发现可能的失败。',
    ok: '可用',
    review: '需确认',
    ng: '不可用',
    workersDeploy: 'Workers 部署',
    workersDeployOk: '已确认 Wrangler 登录状态，满足 Workers 部署所需的前提。',
    workersDeployReview: 'Workers 部署的部分前提未能确认。请检查登录状态和 token 权限。',
    workersDeployNg: 'Wrangler 未安装，或尚未登录 Cloudflare。',
    customDomain: '自定义域名',
    customDomainOk: '可以访问 Zone 列表，满足自定义域名设置所需的前提。',
    customDomainReviewZoneRead:
      '无法确认 Zone 列表访问，因此自定义域名设置可能可行，但需要进一步确认。',
    customDomainNgNoZone: '未找到可访问的 Cloudflare Zone，因此无法使用自定义域名。',
    multiTenant: '多租户',
    multiTenantOk: '已确认 DNS 记录读取能力，满足租户通配 DNS 设置所需的前提。',
    multiTenantReview: '无法确认 DNS 权限，因此多租户子域名设置可能可行，但仍有失败风险。',
    nakedDomain: '裸域名',
    nakedDomainOk: '多租户路由所需的 DNS 前提已满足，裸域名配置所需条件已具备。',
    nakedDomainReview: '无法确认多租户路由所需的 DNS 前提，因此裸域名配置需要进一步确认。',
    pages: 'Cloudflare Pages',
    pagesOk: '可以访问 Pages API，满足 Login/Admin UI 的 Pages 部署所需的前提。',
    pagesReview: '无法确认 Pages API，因此 Pages 部署可能可行，但需要进一步确认。',
  },
  'zh-TW': {
    title: '可用性預估',
    hint: '這是根據目前的 Cloudflare 登入狀態與 API 可達性所做的推測，用來提早發現可能的失敗。',
    ok: '可用',
    review: '需確認',
    ng: '不可用',
    workersDeploy: 'Workers 部署',
    workersDeployOk: '已確認 Wrangler 登入狀態，滿足 Workers 部署所需的前提。',
    workersDeployReview: 'Workers 部署的部分前提尚未確認。請檢查登入狀態與 token 權限。',
    workersDeployNg: 'Wrangler 尚未安裝，或尚未登入 Cloudflare。',
    customDomain: '自訂網域',
    customDomainOk: '可以存取 Zone 清單，滿足自訂網域設定所需的前提。',
    customDomainReviewZoneRead:
      '無法確認 Zone 清單存取，因此自訂網域設定可能可行，但需要進一步確認。',
    customDomainNgNoZone: '找不到可存取的 Cloudflare Zone，因此無法使用自訂網域。',
    multiTenant: '多租戶',
    multiTenantOk: '已確認 DNS 記錄讀取能力，滿足租戶萬用字元 DNS 設定所需的前提。',
    multiTenantReview: '無法確認 DNS 權限，因此多租戶子網域設定可能可行，但仍有失敗風險。',
    nakedDomain: '裸網域',
    nakedDomainOk: '多租戶路由所需的 DNS 前提已滿足，裸網域設定所需條件已具備。',
    nakedDomainReview: '無法確認多租戶路由所需的 DNS 前提，因此裸網域設定需要進一步確認。',
    pages: 'Cloudflare Pages',
    pagesOk: '可以存取 Pages API，滿足 Login/Admin UI 的 Pages 部署所需的前提。',
    pagesReview: '無法確認 Pages API，因此 Pages 部署可能可行，但需要進一步確認。',
  },
  es: {
    title: 'Disponibilidad estimada',
    hint: 'Esta es una estimación basada en el estado actual de inicio de sesión de Cloudflare y el acceso a la API. Ayuda a detectar fallos probables antes de continuar.',
    ok: 'OK',
    review: 'Revisar',
    ng: 'No',
    workersDeploy: 'Despliegue de Workers',
    workersDeployOk:
      'La autenticación de Wrangler parece válida, cumpliendo los requisitos necesarios para el despliegue de Workers.',
    workersDeployReview:
      'No se pudieron verificar algunos requisitos del despliegue de Workers. Revise el inicio de sesión y el acceso del token antes de continuar.',
    workersDeployNg:
      'Wrangler no está instalado o el inicio de sesión en Cloudflare está incompleto.',
    customDomain: 'Dominio personalizado',
    customDomainOk:
      'Hay acceso a la zona, cumpliendo los requisitos necesarios para la configuración del dominio personalizado.',
    customDomainReviewZoneRead:
      'No se pudo verificar el acceso a la zona, por lo que la configuración del dominio personalizado podría funcionar, pero requiere revisión.',
    customDomainNgNoZone:
      'No se encontró ninguna zona de Cloudflare accesible, por lo que los dominios personalizados no están disponibles.',
    multiTenant: 'Multi-tenant',
    multiTenantOk:
      'Hay acceso a los registros DNS, cumpliendo los requisitos necesarios para la configuración del DNS wildcard de tenants.',
    multiTenantReview:
      'No se pudo verificar el acceso DNS, por lo que la configuración de subdominios por tenant podría funcionar, pero requiere revisión.',
    nakedDomain: 'Dominio raíz',
    nakedDomainOk:
      'Los requisitos DNS para el enrutamiento multi-tenant parecen disponibles, cumpliendo los requisitos para el dominio raíz.',
    nakedDomainReview:
      'No se pudieron verificar los requisitos DNS para el enrutamiento multi-tenant, por lo que el dominio raíz requiere revisión.',
    pages: 'Cloudflare Pages',
    pagesOk:
      'La API de Pages es accesible, cumpliendo los requisitos necesarios para el despliegue de Login/Admin UI en Pages.',
    pagesReview:
      'No se pudo verificar la API de Pages, por lo que el despliegue en Pages podría funcionar, pero requiere revisión.',
  },
  pt: {
    title: 'Disponibilidade estimada',
    hint: 'Esta é uma estimativa baseada no estado atual de login no Cloudflare e no alcance da API. Ela ajuda a detectar falhas prováveis antes de continuar.',
    ok: 'OK',
    review: 'Revisar',
    ng: 'Não',
    workersDeploy: 'Deploy do Workers',
    workersDeployOk:
      'A autenticação do Wrangler parece válida, atendendo aos requisitos necessários para o deploy do Workers.',
    workersDeployReview:
      'Alguns pré-requisitos do deploy do Workers não puderam ser verificados. Revise o login e o acesso do token antes de continuar.',
    workersDeployNg: 'O Wrangler não está instalado ou o login no Cloudflare está incompleto.',
    customDomain: 'Domínio personalizado',
    customDomainOk:
      'O acesso à zona está disponível, atendendo aos requisitos necessários para a configuração de domínio personalizado.',
    customDomainReviewZoneRead:
      'Não foi possível verificar o acesso à zona, então a configuração de domínio personalizado pode funcionar, mas exige revisão.',
    customDomainNgNoZone:
      'Nenhuma zona do Cloudflare acessível foi encontrada, então domínios personalizados não estão disponíveis.',
    multiTenant: 'Multi-tenant',
    multiTenantOk:
      'O acesso aos registros DNS está disponível, atendendo aos requisitos necessários para a configuração de DNS curinga para tenants.',
    multiTenantReview:
      'Não foi possível verificar o acesso DNS, então a configuração de subdomínios por tenant pode funcionar, mas exige revisão.',
    nakedDomain: 'Domínio raiz',
    nakedDomainOk:
      'Os pré-requisitos de DNS para roteamento multi-tenant parecem disponíveis, atendendo aos requisitos para o domínio raiz.',
    nakedDomainReview:
      'Os pré-requisitos de DNS para roteamento multi-tenant não puderam ser verificados, então o domínio raiz exige revisão.',
    pages: 'Cloudflare Pages',
    pagesOk:
      'A API do Pages está acessível, atendendo aos requisitos necessários para o deploy do Login/Admin UI no Pages.',
    pagesReview:
      'Não foi possível verificar a API do Pages, então o deploy no Pages pode funcionar, mas exige revisão.',
  },
  fr: {
    title: 'Disponibilité estimée',
    hint: "Il s'agit d'une estimation basée sur l'état de connexion Cloudflare et l'accessibilité de l'API. Elle aide à détecter les échecs probables avant de continuer.",
    ok: 'OK',
    review: 'Vérifier',
    ng: 'Non',
    workersDeploy: 'Déploiement Workers',
    workersDeployOk:
      "L'authentification Wrangler semble utilisable, remplissant les prérequis nécessaires au déploiement Workers.",
    workersDeployReview:
      "Certains prérequis du déploiement Workers n'ont pas pu être vérifiés. Vérifiez la connexion et l'accès du jeton avant de continuer.",
    workersDeployNg: "Wrangler n'est pas installé ou la connexion Cloudflare est incomplète.",
    customDomain: 'Domaine personnalisé',
    customDomainOk:
      "L'accès à la zone est disponible, remplissant les prérequis nécessaires à la configuration du domaine personnalisé.",
    customDomainReviewZoneRead:
      "L'accès à la zone n'a pas pu être vérifié, la configuration du domaine personnalisé peut donc fonctionner mais doit être vérifiée.",
    customDomainNgNoZone:
      "Aucune zone Cloudflare accessible n'a été trouvée, les domaines personnalisés ne sont donc pas disponibles.",
    multiTenant: 'Multi-tenant',
    multiTenantOk:
      "L'accès aux enregistrements DNS est disponible, remplissant les prérequis nécessaires à la configuration DNS générique des tenants.",
    multiTenantReview:
      "L'accès DNS n'a pas pu être vérifié, la configuration des sous-domaines tenant peut donc fonctionner mais doit être vérifiée.",
    nakedDomain: 'Domaine nu',
    nakedDomainOk:
      'Les prérequis DNS pour le routage multi-tenant semblent disponibles, remplissant les prérequis pour le domaine nu.',
    nakedDomainReview:
      "Les prérequis DNS pour le routage multi-tenant n'ont pas pu être vérifiés, le domaine nu doit donc être vérifié.",
    pages: 'Cloudflare Pages',
    pagesOk:
      "L'API Pages est accessible, remplissant les prérequis nécessaires au déploiement des UI Login/Admin sur Pages.",
    pagesReview:
      "L'API Pages n'a pas pu être vérifiée, le déploiement sur Pages peut donc fonctionner mais doit être vérifié.",
  },
  de: {
    title: 'Geschätzte Verfügbarkeit',
    hint: 'Dies ist eine Schätzung auf Basis des aktuellen Cloudflare-Logins und der API-Erreichbarkeit. So lassen sich wahrscheinliche Fehler vorab erkennen.',
    ok: 'OK',
    review: 'Prüfen',
    ng: 'Nein',
    workersDeploy: 'Workers-Bereitstellung',
    workersDeployOk:
      'Die Wrangler-Authentifizierung scheint verwendbar zu sein und erfüllt die Voraussetzungen für die Workers-Bereitstellung.',
    workersDeployReview:
      'Einige Voraussetzungen für die Workers-Bereitstellung konnten nicht verifiziert werden. Bitte Login und Tokenzugriff prüfen.',
    workersDeployNg: 'Wrangler ist nicht installiert oder der Cloudflare-Login ist unvollständig.',
    customDomain: 'Benutzerdefinierte Domain',
    customDomainOk:
      'Zugriff auf die Zone ist vorhanden und erfüllt die Voraussetzungen für die Einrichtung der benutzerdefinierten Domain.',
    customDomainReviewZoneRead:
      'Der Zugriff auf die Zone konnte nicht verifiziert werden. Die Einrichtung kann funktionieren, muss aber geprüft werden.',
    customDomainNgNoZone:
      'Es wurde keine zugängliche Cloudflare-Zone gefunden, daher sind benutzerdefinierte Domains nicht verfügbar.',
    multiTenant: 'Multi-Tenant',
    multiTenantOk:
      'DNS-Record-Zugriff ist vorhanden und erfüllt die Voraussetzungen für die Wildcard-DNS-Einrichtung für Tenants.',
    multiTenantReview:
      'Der DNS-Zugriff konnte nicht verifiziert werden. Die Tenant-Subdomain-Einrichtung kann funktionieren, muss aber geprüft werden.',
    nakedDomain: 'Naked Domain',
    nakedDomainOk:
      'Die DNS-Voraussetzungen für Multi-Tenant-Routing scheinen verfügbar zu sein und erfüllen die Anforderungen für die Naked-Domain-Konfiguration.',
    nakedDomainReview:
      'Die DNS-Voraussetzungen für Multi-Tenant-Routing konnten nicht verifiziert werden. Die Naked-Domain-Konfiguration muss geprüft werden.',
    pages: 'Cloudflare Pages',
    pagesOk:
      'Die Pages-API ist erreichbar und erfüllt die Voraussetzungen für die Bereitstellung von Login/Admin UI auf Pages.',
    pagesReview:
      'Die Pages-API konnte nicht verifiziert werden. Die Pages-Bereitstellung kann funktionieren, muss aber geprüft werden.',
  },
  ko: {
    title: '기능 사용 가능성 추정',
    hint: '현재 Cloudflare 로그인 상태와 API 도달 가능성을 바탕으로 추정한 결과입니다. 진행 중 실패 가능성을 미리 줄이기 위한 확인입니다.',
    ok: '가능',
    review: '확인 필요',
    ng: '불가',
    workersDeploy: 'Workers 배포',
    workersDeployOk: 'Wrangler 로그인 상태가 확인되어 Workers 배포에 필요한 전제를 충족합니다.',
    workersDeployReview:
      'Workers 배포 전제 중 일부를 확인하지 못했습니다. 로그인 상태와 token 권한을 확인하세요.',
    workersDeployNg: 'Wrangler가 설치되지 않았거나 Cloudflare 로그인 상태가 완료되지 않았습니다.',
    customDomain: '커스텀 도메인',
    customDomainOk: 'Zone 목록에 접근할 수 있어 커스텀 도메인 설정에 필요한 전제를 충족합니다.',
    customDomainReviewZoneRead:
      'Zone 목록 접근을 확인하지 못해 커스텀 도메인 설정이 가능할 수도 있지만 추가 확인이 필요합니다.',
    customDomainNgNoZone:
      '접근 가능한 Cloudflare Zone을 찾지 못해 커스텀 도메인을 사용할 수 없습니다.',
    multiTenant: '멀티테넌트',
    multiTenantOk:
      'DNS 레코드 조회를 확인해 테넌트용 와일드카드 DNS 설정에 필요한 전제를 충족합니다.',
    multiTenantReview:
      'DNS 권한을 확인하지 못해 멀티테넌트 서브도메인 설정이 가능할 수도 있지만 실패 가능성이 있습니다.',
    nakedDomain: '네이키드 도메인',
    nakedDomainOk:
      '멀티테넌트 라우팅에 필요한 DNS 전제가 충족되어 네이키드 도메인 구성에 필요한 조건을 만족합니다.',
    nakedDomainReview:
      '멀티테넌트 라우팅용 DNS 전제를 확인하지 못해 네이키드 도메인 구성은 추가 확인이 필요합니다.',
    pages: 'Cloudflare Pages',
    pagesOk: 'Pages API에 도달할 수 있어 Login/Admin UI의 Pages 배포에 필요한 전제를 충족합니다.',
    pagesReview:
      'Pages API를 확인하지 못해 Pages 배포가 가능할 수도 있지만 추가 확인이 필요합니다.',
  },
  ru: {
    title: 'Оценка доступности',
    hint: 'Это оценка на основе текущего входа в Cloudflare и доступности API. Она помогает заранее заметить вероятные сбои.',
    ok: 'OK',
    review: 'Проверить',
    ng: 'Нет',
    workersDeploy: 'Деплой Workers',
    workersDeployOk:
      'Аутентификация Wrangler выглядит пригодной и удовлетворяет требованиям для деплоя Workers.',
    workersDeployReview:
      'Некоторые предпосылки для деплоя Workers не удалось проверить. Проверьте вход и доступ токена перед продолжением.',
    workersDeployNg: 'Wrangler не установлен или вход в Cloudflare не завершен.',
    customDomain: 'Пользовательский домен',
    customDomainOk:
      'Доступ к зоне есть и удовлетворяет требованиям для настройки пользовательского домена.',
    customDomainReviewZoneRead:
      'Не удалось проверить доступ к зоне, поэтому настройка пользовательского домена может сработать, но требует проверки.',
    customDomainNgNoZone:
      'Не найдена доступная зона Cloudflare, поэтому пользовательские домены недоступны.',
    multiTenant: 'Мультитенантность',
    multiTenantOk:
      'Доступ к DNS-записям есть и удовлетворяет требованиям для настройки wildcard DNS для тенантов.',
    multiTenantReview:
      'Не удалось проверить доступ к DNS, поэтому настройка поддоменов тенантов может сработать, но требует проверки.',
    nakedDomain: 'Naked domain',
    nakedDomainOk:
      'DNS-предпосылки для мультитенантной маршрутизации выглядят доступными и удовлетворяют требованиям для naked domain.',
    nakedDomainReview:
      'Не удалось проверить DNS-предпосылки для мультитенантной маршрутизации, поэтому конфигурация naked domain требует проверки.',
    pages: 'Cloudflare Pages',
    pagesOk: 'API Pages доступен и удовлетворяет требованиям для деплоя Login/Admin UI в Pages.',
    pagesReview:
      'Не удалось проверить API Pages, поэтому деплой в Pages может сработать, но требует проверки.',
  },
  id: {
    title: 'Perkiraan Ketersediaan',
    hint: 'Ini adalah perkiraan berdasarkan status login Cloudflare saat ini dan keterjangkauan API. Ini membantu mendeteksi kemungkinan kegagalan sebelum proses dilanjutkan.',
    ok: 'OK',
    review: 'Periksa',
    ng: 'Tidak',
    workersDeploy: 'Deploy Workers',
    workersDeployOk:
      'Autentikasi Wrangler tampak dapat digunakan, memenuhi prasyarat yang diperlukan untuk deploy Workers.',
    workersDeployReview:
      'Beberapa prasyarat deploy Workers tidak dapat diverifikasi. Periksa login dan akses token sebelum melanjutkan.',
    workersDeployNg: 'Wrangler belum terpasang atau login Cloudflare belum lengkap.',
    customDomain: 'Domain kustom',
    customDomainOk:
      'Akses ke zone tersedia, memenuhi prasyarat yang diperlukan untuk pengaturan domain kustom.',
    customDomainReviewZoneRead:
      'Akses ke zone tidak dapat diverifikasi, jadi pengaturan domain kustom mungkin bisa berhasil tetapi perlu diperiksa.',
    customDomainNgNoZone:
      'Tidak ditemukan zone Cloudflare yang dapat diakses, jadi domain kustom tidak tersedia.',
    multiTenant: 'Multi-tenant',
    multiTenantOk:
      'Akses ke catatan DNS tersedia, memenuhi prasyarat yang diperlukan untuk pengaturan DNS wildcard tenant.',
    multiTenantReview:
      'Akses DNS tidak dapat diverifikasi, jadi pengaturan subdomain tenant mungkin bisa berhasil tetapi perlu diperiksa.',
    nakedDomain: 'Domain telanjang',
    nakedDomainOk:
      'Prasyarat DNS untuk routing multi-tenant tampak tersedia, memenuhi persyaratan untuk konfigurasi domain telanjang.',
    nakedDomainReview:
      'Prasyarat DNS untuk routing multi-tenant tidak dapat diverifikasi, jadi konfigurasi domain telanjang perlu diperiksa.',
    pages: 'Cloudflare Pages',
    pagesOk:
      'API Pages dapat dijangkau, memenuhi prasyarat yang diperlukan untuk deploy Login/Admin UI ke Pages.',
    pagesReview:
      'API Pages tidak dapat diverifikasi, jadi deploy ke Pages mungkin bisa berhasil tetapi perlu diperiksa.',
  },
};

export function getSetupCapabilityCopy(locale: string): SetupCapabilityCopy {
  const normalized = String(locale || 'en');
  return (
    SETUP_CAPABILITY_COPY[normalized] ||
    SETUP_CAPABILITY_COPY[normalized.split('-')[0]] ||
    SETUP_CAPABILITY_COPY.en
  );
}

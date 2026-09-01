export interface WildcardDnsManualAction {
  kind: 'wildcard-dns';
  baseDomain: string;
  zoneName: string;
  recordName: string;
  dashboardRecordName: string;
  target: string;
  title: string;
  summary: string;
  timing: string;
  steps: string[];
  retryHint: string;
  continueHint: string;
}

export const CLOUDFLARE_DNS_RECORDS_DOCS_URL =
  'https://developers.cloudflare.com/automatic-platform-optimization/get-started/confirm-dns-records/';

export function getCloudflareDnsRecordsDashboardUrl(
  accountId?: string | null,
  domainOrZoneName?: string | null
): string | null {
  if (!accountId || !domainOrZoneName) {
    return null;
  }

  const normalized = String(domainOrZoneName).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

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
  const zoneName =
    twoPartTlds.has(lastTwo) && parts.length >= 3
      ? parts.slice(-3).join('.')
      : parts.length >= 2
        ? parts.slice(-2).join('.')
        : normalized;

  return `https://dash.cloudflare.com/${accountId}/${zoneName}/dns/records`;
}

interface WildcardDnsManualCopy {
  title: string;
  summary: (baseDomain: string) => string;
  timing: string;
  steps: (
    zoneName: string,
    recordName: string,
    target: string,
    dashboardRecordName: string
  ) => string[];
  retryHint: string;
  continueHint: string;
  dashboardLinkLabel: string;
  docsLinkLabel: string;
  confirmSuffix: string;
}

export const WILDCARD_DNS_MANUAL_COPY: Record<string, WildcardDnsManualCopy> = {
  ja: {
    title: 'ワイルドカード DNS の手動設定が必要です',
    summary: () => '',
    timing:
      '推奨タイミング: デプロイ前に設定してください。すでにデプロイが止まっている場合は、今この設定を追加してから再実行してください。',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Cloudflare Dashboard で ${zoneName} の DNS management を開き、Add record を押します。`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `この設定で ${recordName} が ${target} を向きます。保存後、Cloudflare 側で反映を確認します。`,
      `証明書の注意: ${recordName} をカバーする Cloudflare Edge 証明書も必要です。Advanced 証明書または Total TLS で有効化されるまで TLS 警告が出ることがあります。`,
    ],
    retryHint: '設定後に Deploy を実行してください。',
    continueHint:
      'すでに手動設定済みなら続行できます。まだなら一度止めて設定してから再開してください。',
    dashboardLinkLabel: 'Cloudflare DNS を開く',
    docsLinkLabel: 'DNS ドキュメントを開く',
    confirmSuffix: 'OK でそのまま続行、Cancel でいったん止めて DNS 設定を行います。',
  },
  en: {
    title: 'Manual wildcard DNS setup is required',
    summary: () => '',
    timing:
      'Recommended timing: create this record before deploy. If deployment already stopped, create it now and rerun deployment.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Open DNS management for ${zoneName} in Cloudflare Dashboard and click Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `This record makes ${recordName} resolve to ${target}. Save the record and wait for Cloudflare to accept it.`,
      `Certificate note: a Cloudflare Edge certificate must also cover ${recordName}. TLS warnings can appear until an Advanced certificate or Total TLS covers it.`,
    ],
    retryHint: 'After that, run deploy.',
    continueHint:
      'If you already created the record manually, you can continue. Otherwise stop here, create it, and retry.',
    dashboardLinkLabel: 'Open Cloudflare DNS',
    docsLinkLabel: 'Open DNS docs',
    confirmSuffix: 'Press OK to continue anyway, or Cancel to stop and configure DNS first.',
  },
  'zh-CN': {
    title: '需要手动配置通配 DNS',
    summary: () => '',
    timing: '建议时机：请在部署前完成此设置。如果部署已经停止，请现在添加该记录后重新执行部署。',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `在 Cloudflare Dashboard 中打开 ${zoneName} 的 DNS management，然后点击 Add record。`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied（橙色云）',
      'TTL: Auto',
      `该记录会让 ${recordName} 指向 ${target}。保存后，确认 Cloudflare 已接受并生效。`,
      `证书提示：Cloudflare Edge 证书也必须覆盖 ${recordName}。在 Advanced 证书或 Total TLS 覆盖之前，可能会出现 TLS 警告。`,
    ],
    retryHint: '完成后请执行部署。',
    continueHint: '如果你已经手动创建了该记录，可以继续。否则请先停止并完成 DNS 设置。',
    dashboardLinkLabel: '打开 Cloudflare DNS',
    docsLinkLabel: '打开 DNS 文档',
    confirmSuffix: '按“确定”继续，或按“取消”先去完成 DNS 设置。',
  },
  'zh-TW': {
    title: '需要手動設定萬用字元 DNS',
    summary: () => '',
    timing: '建議時機：請在部署前完成此設定。如果部署已經中斷，請現在新增該記錄後再重新部署。',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `在 Cloudflare Dashboard 中開啟 ${zoneName} 的 DNS management，然後按 Add record。`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied（橘色雲）',
      'TTL: Auto',
      `這筆記錄會讓 ${recordName} 指向 ${target}。儲存後，確認 Cloudflare 已接受並套用。`,
      `憑證提醒：Cloudflare Edge 憑證也必須涵蓋 ${recordName}。在 Advanced 憑證或 Total TLS 涵蓋之前，可能會出現 TLS 警告。`,
    ],
    retryHint: '完成後請執行部署。',
    continueHint: '如果你已手動建立該記錄，可以繼續。否則請先停止並完成 DNS 設定。',
    dashboardLinkLabel: '開啟 Cloudflare DNS',
    docsLinkLabel: '開啟 DNS 文件',
    confirmSuffix: '按「確定」繼續，或按「取消」先完成 DNS 設定。',
  },
  es: {
    title: 'Se requiere configurar manualmente el DNS wildcard',
    summary: () => '',
    timing:
      'Momento recomendado: haga esta configuración antes del despliegue. Si el despliegue ya se detuvo, añádala ahora y vuelva a ejecutar el despliegue.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Abra DNS management de ${zoneName} en Cloudflare Dashboard y pulse Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (nube naranja)',
      'TTL: Auto',
      `Este registro hace que ${recordName} apunte a ${target}. Guarde el registro y confirme que Cloudflare lo haya aceptado.`,
      `Nota sobre certificados: el certificado Edge de Cloudflare también debe cubrir ${recordName}. Pueden aparecer advertencias TLS hasta que un certificado Advanced o Total TLS lo cubra.`,
    ],
    retryHint: 'Después de eso, ejecute el despliegue.',
    continueHint:
      'Si ya creó manualmente el registro, puede continuar. Si no, deténgase aquí, créelo y vuelva a intentarlo.',
    dashboardLinkLabel: 'Abrir Cloudflare DNS',
    docsLinkLabel: 'Abrir documentación DNS',
    confirmSuffix:
      'Pulse OK para continuar igualmente, o Cancel para detenerse y configurar primero el DNS.',
  },
  pt: {
    title: 'A configuração manual do DNS curinga é necessária',
    summary: () => '',
    timing:
      'Momento recomendado: faça essa configuração antes do deploy. Se o deploy já parou, adicione o registro agora e execute novamente.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Abra o DNS management de ${zoneName} no Cloudflare Dashboard e clique em Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (nuvem laranja)',
      'TTL: Auto',
      `Esse registro fará ${recordName} apontar para ${target}. Salve o registro e confirme que o Cloudflare o aceitou.`,
      `Nota de certificado: o certificado Edge da Cloudflare também precisa cobrir ${recordName}. Avisos de TLS podem aparecer até que um certificado Advanced ou Total TLS cubra esse host.`,
    ],
    retryHint: 'Depois disso, execute o deploy.',
    continueHint:
      'Se você já criou o registro manualmente, pode continuar. Caso contrário, pare aqui, crie-o e tente de novo.',
    dashboardLinkLabel: 'Abrir Cloudflare DNS',
    docsLinkLabel: 'Abrir documentação DNS',
    confirmSuffix:
      'Pressione OK para continuar mesmo assim, ou Cancel para parar e configurar o DNS primeiro.',
  },
  fr: {
    title: 'Une configuration manuelle du DNS wildcard est nécessaire',
    summary: () => '',
    timing:
      'Moment recommandé : effectuez cette configuration avant le déploiement. Si le déploiement s’est déjà arrêté, ajoutez cet enregistrement maintenant puis relancez-le.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Ouvrez DNS management pour ${zoneName} dans le tableau de bord Cloudflare puis cliquez sur Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (nuage orange)',
      'TTL: Auto',
      `Cet enregistrement fera pointer ${recordName} vers ${target}. Enregistrez puis vérifiez que Cloudflare a bien accepté la modification.`,
      `Note sur le certificat : le certificat Edge Cloudflare doit aussi couvrir ${recordName}. Des alertes TLS peuvent apparaître tant qu'un certificat Advanced ou Total TLS ne le couvre pas.`,
    ],
    retryHint: 'Ensuite, lancez le déploiement.',
    continueHint:
      'Si vous avez déjà créé cet enregistrement manuellement, vous pouvez continuer. Sinon, arrêtez-vous ici, créez-le puis réessayez.',
    dashboardLinkLabel: 'Ouvrir Cloudflare DNS',
    docsLinkLabel: 'Ouvrir la documentation DNS',
    confirmSuffix:
      'Appuyez sur OK pour continuer quand même, ou sur Cancel pour arrêter et configurer le DNS d’abord.',
  },
  de: {
    title: 'Manuelle Wildcard-DNS-Konfiguration erforderlich',
    summary: () => '',
    timing:
      'Empfohlener Zeitpunkt: richten Sie dies vor dem Deploy ein. Wenn der Deploy bereits gestoppt wurde, fügen Sie den Eintrag jetzt hinzu und starten Sie erneut.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Öffnen Sie DNS management für ${zoneName} im Cloudflare-Dashboard und klicken Sie auf Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `Dieser Eintrag sorgt dafür, dass ${recordName} auf ${target} zeigt. Speichern Sie ihn und prüfen Sie, dass Cloudflare ihn übernommen hat.`,
      `Zertifikatshinweis: Das Cloudflare Edge-Zertifikat muss auch ${recordName} abdecken. Bis ein Advanced-Zertifikat oder Total TLS dies abdeckt, können TLS-Warnungen erscheinen.`,
    ],
    retryHint: 'Starten Sie danach den Deploy.',
    continueHint:
      'Wenn Sie den Eintrag bereits manuell erstellt haben, können Sie fortfahren. Andernfalls hier stoppen, einrichten und erneut versuchen.',
    dashboardLinkLabel: 'Cloudflare DNS öffnen',
    docsLinkLabel: 'DNS-Dokumentation öffnen',
    confirmSuffix:
      'Mit OK trotzdem fortfahren oder mit Cancel abbrechen und zuerst DNS konfigurieren.',
  },
  ko: {
    title: '와일드카드 DNS를 수동으로 설정해야 합니다',
    summary: () => '',
    timing:
      '권장 시점: 배포 전에 이 설정을 완료하세요. 이미 배포가 중단되었다면 지금 레코드를 추가한 뒤 다시 실행하세요.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Cloudflare Dashboard에서 ${zoneName} 의 DNS management를 열고 Add record를 누릅니다.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `이 레코드를 저장하면 ${recordName} 이 ${target} 를 가리키게 됩니다. 저장 후 반영 여부를 확인합니다.`,
      `인증서 참고: Cloudflare Edge 인증서도 ${recordName} 을 포함해야 합니다. Advanced 인증서 또는 Total TLS가 적용되기 전에는 TLS 경고가 표시될 수 있습니다.`,
    ],
    retryHint: '설정 후 deploy 를 실행하세요.',
    continueHint:
      '이미 수동으로 레코드를 만들었다면 계속할 수 있습니다. 아니라면 여기서 멈추고 DNS 설정을 먼저 완료하세요.',
    dashboardLinkLabel: 'Cloudflare DNS 열기',
    docsLinkLabel: 'DNS 문서 열기',
    confirmSuffix: '계속하려면 확인, 먼저 DNS를 설정하려면 취소를 누르세요.',
  },
  ru: {
    title: 'Требуется ручная настройка wildcard DNS',
    summary: () => '',
    timing:
      'Рекомендуемый момент: выполните эту настройку до деплоя. Если деплой уже остановился, добавьте запись сейчас и запустите его снова.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Откройте DNS management для ${zoneName} в Cloudflare Dashboard и нажмите Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `Эта запись направит ${recordName} на ${target}. Сохраните запись и убедитесь, что Cloudflare её принял.`,
      `Примечание о сертификате: Cloudflare Edge-сертификат также должен покрывать ${recordName}. Пока это не покрыто Advanced-сертификатом или Total TLS, могут появляться TLS-предупреждения.`,
    ],
    retryHint: 'После этого запустите деплой.',
    continueHint:
      'Если запись уже создана вручную, можно продолжать. Иначе остановитесь здесь, создайте её и повторите попытку.',
    dashboardLinkLabel: 'Открыть Cloudflare DNS',
    docsLinkLabel: 'Открыть документацию DNS',
    confirmSuffix:
      'Нажмите OK, чтобы продолжить, или Cancel, чтобы остановиться и сначала настроить DNS.',
  },
  id: {
    title: 'Pengaturan DNS wildcard manual diperlukan',
    summary: () => '',
    timing:
      'Waktu yang disarankan: buat pengaturan ini sebelum deploy. Jika deploy sudah berhenti, tambahkan record sekarang lalu jalankan lagi.',
    steps: (zoneName, recordName, target, dashboardRecordName) => [
      `Buka DNS management untuk ${zoneName} di Cloudflare Dashboard lalu klik Add record.`,
      'Type: CNAME',
      `Name (required): ${dashboardRecordName}`,
      `Target (required): ${target}`,
      'Proxy status: Proxied (orange cloud)',
      'TTL: Auto',
      `Record ini akan membuat ${recordName} mengarah ke ${target}. Simpan record dan pastikan Cloudflare sudah menerimanya.`,
      `Catatan sertifikat: sertifikat Cloudflare Edge juga harus mencakup ${recordName}. Peringatan TLS dapat muncul sampai sertifikat Advanced atau Total TLS mencakup host ini.`,
    ],
    retryHint: 'Setelah itu, jalankan deploy.',
    continueHint:
      'Jika Anda sudah membuat record tersebut secara manual, Anda bisa melanjutkan. Jika belum, berhenti di sini, buat dulu, lalu coba lagi.',
    dashboardLinkLabel: 'Buka Cloudflare DNS',
    docsLinkLabel: 'Buka dokumentasi DNS',
    confirmSuffix:
      'Tekan OK untuk tetap lanjut, atau Cancel untuk berhenti dan mengatur DNS terlebih dahulu.',
  },
};

function getCopy(locale: string): WildcardDnsManualCopy {
  const normalized = String(locale || 'en');
  return (
    WILDCARD_DNS_MANUAL_COPY[normalized] ||
    WILDCARD_DNS_MANUAL_COPY[normalized.split('-')[0]] ||
    WILDCARD_DNS_MANUAL_COPY.en
  );
}

export function getWildcardDnsManualAction(
  baseDomain: string,
  locale = 'en'
): WildcardDnsManualAction {
  const trimmedBaseDomain = baseDomain.trim();
  const zoneName = getCloudflareDnsZoneName(trimmedBaseDomain);
  const recordName = `*.${trimmedBaseDomain}`;
  const dashboardRecordName = getCloudflareDashboardRecordName(trimmedBaseDomain, zoneName);
  const copy = getCopy(locale);

  return {
    kind: 'wildcard-dns',
    baseDomain: trimmedBaseDomain,
    zoneName,
    recordName,
    dashboardRecordName,
    target: trimmedBaseDomain,
    title: copy.title,
    summary: copy.summary(trimmedBaseDomain),
    timing: copy.timing,
    steps: copy.steps(zoneName, recordName, trimmedBaseDomain, dashboardRecordName),
    retryHint: copy.retryHint,
    continueHint: copy.continueHint,
  };
}

export function formatWildcardDnsManualAction(action: WildcardDnsManualAction): string {
  const lines = [action.title];

  if (action.summary) {
    lines.push(action.summary);
  }

  lines.push(
    action.timing,
    '',
    ...action.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    action.retryHint,
    action.continueHint
  );

  return lines.join('\n');
}

export function isWildcardDnsPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /wildcard dns|exact proxied cname target for \*\./i.test(message);
}

function getCloudflareDnsZoneName(domainOrZoneName: string): string {
  const normalized = String(domainOrZoneName || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return '';
  }

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
  return twoPartTlds.has(lastTwo) && parts.length >= 3
    ? parts.slice(-3).join('.')
    : parts.length >= 2
      ? parts.slice(-2).join('.')
      : normalized;
}

function getCloudflareDashboardRecordName(baseDomain: string, zoneName: string): string {
  if (baseDomain === zoneName) {
    return '*';
  }

  const suffix = `.${zoneName}`;
  if (baseDomain.endsWith(suffix)) {
    return `*.${baseDomain.slice(0, -suffix.length)}`;
  }

  return `*.${baseDomain}`;
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const seconds = (value) => (finite(value) ? (value / 1000).toFixed(2) : '未記録');
const mib = (value) => (finite(value) ? (value / 1024 ** 2).toFixed(2) : '未記録');
const count = (value) => (finite(value) ? value.toLocaleString('en-US') : '未記録');
const milliseconds = (value) => (finite(value) ? value.toFixed(1) : '未記録');
const cell = (value) =>
  String(value ?? '未記録')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');
const label = (measurement) => `${cell(measurement.targetMiB)}MiB / ${cell(measurement.repeat)}`;
const failures = (series) =>
  series && finite(series.requests) && finite(series.failures)
    ? `${series.failures}/${series.requests}`
    : '未記録';
const safeError = (value) => cell(String(value ?? 'なし').replace(/https?:\/\/\S+/g, '[URL]'));
const foreignKeyMode = (sample) =>
  sample ? `${cell(sample.apiMode)} / ${cell(sample.bindingMode)}` : '未記録';
const recoveryTiming = (measurement) =>
  measurement.recoveryTimingMode === 'continuous wall clock'
    ? '連続実測'
    : measurement.recoveryTimingMode ===
        'sum completed provisioning/import/verification stages after resume'
      ? '再開後の完了段階を合算'
      : cell(measurement.recoveryTimingMode);
const locations = (values) =>
  Array.isArray(values) && values.length ? values.map(cell).join(', ') : '未記録';
const deletionState = (value) =>
  value === true ? '削除済み' : value === false ? '未削除' : '未記録';
const recoveryWall = (measurement) =>
  finite(measurement.recoveryWallTotalMs)
    ? measurement.recoveryWallTotalMs
    : measurement.recoveryTimingMode === 'continuous wall clock'
      ? measurement.recoveryTotalMs
      : undefined;
const activeParts = (measurement) =>
  measurement.restoreTailPreparation
    ? [
        ...(measurement.restorePreparation?.parts ?? []).slice(
          0,
          measurement.restoreTailBasePartCount
        ),
        ...measurement.restoreTailPreparation.parts,
      ]
    : (measurement.restorePreparation?.parts ?? []);
const partSize = (measurement, part) =>
  activeParts(measurement).find((prepared) => prepared.key === part.key)?.sizeBytes ??
  part.restoreUpload?.sizeBytes;
const partKind = (kind) =>
  ({
    data: 'データ',
    'data-tail': '残りデータ',
    'populated-index': 'データあり表のindex',
    'empty-indexes': '空表のindex群',
    triggers: 'trigger群',
    'ddl-tail': '残りDDL',
    'foreign-key-finalizer': 'FK再有効化',
  })[kind] ?? cell(kind);
const table = (headers, rows) =>
  `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`;

function formattedDate(value) {
  if (value === null || value === undefined || value === '') return '未記録';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '未記録'
    : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

/** Render recorded evidence only. This function never accesses cloud resources or raw SQL. */
export function renderReport(results) {
  if (!results || !Array.isArray(results.measurements)) {
    throw new TypeError('Expected a results object with measurements[]');
  }
  const measurements = results.measurements;
  const verified = measurements.filter((measurement) => measurement.verified === true);
  const incomplete = measurements.filter((measurement) => measurement.verified !== true);
  const profile = results.profile ?? results.currentfixtureprofile ?? {};
  const groups = new Map();
  for (const measurement of verified) {
    const key = measurement.targetMiB;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(measurement);
  }
  const averages = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([target, group]) => {
      const mean = (field) => {
        const values = group
          .map((measurement) =>
            typeof field === 'function' ? field(measurement) : measurement[field]
          )
          .filter(finite);
        return values.length === group.length
          ? seconds(values.reduce((sum, value) => sum + value, 0) / values.length)
          : '未記録';
      };
      const timingModes = new Map();
      for (const measurement of group) {
        const mode = recoveryTiming(measurement);
        timingModes.set(mode, (timingModes.get(mode) ?? 0) + 1);
      }
      return [
        cell(target),
        String(group.length),
        mean('exportApiMs'),
        mean('rawBackupTotalMs'),
        mean('restorePreparationMs'),
        mean('backupTotalMs'),
        mean('importTotalMs'),
        mean('recoveryTotalMs'),
        mean(recoveryWall),
        [...timingModes.entries()].map(([mode, count]) => `${mode}: ${count}件`).join(' / '),
      ];
    });
  const overview = verified.map((measurement) => [
    label(measurement),
    mib(measurement.sizeBytes),
    count(measurement.accountCount),
    mib(measurement.backup?.sizeBytes),
    seconds(measurement.exportApiMs),
    seconds(measurement.rawBackupTotalMs),
    seconds(measurement.backupTotalMs),
    seconds(measurement.importTotalMs),
    seconds(measurement.recoveryTotalMs),
    seconds(recoveryWall(measurement)),
    recoveryTiming(measurement),
    measurement.sourceDeletedForRecovery === true
      ? '削除後に復元'
      : measurement.sourceDeletedForRecovery === false
        ? '保持して復元'
        : '未記録',
  ]);
  const breakdown = verified.map((measurement) => [
    label(measurement),
    seconds(measurement.backup?.totalMs),
    seconds(measurement.databaseCreateMs),
    seconds(measurement.workerDeployMs),
    seconds(measurement.restoreUpload?.totalMs ?? measurement.restoreUpload?.uploadMs),
    seconds(measurement.ingestObservedMs),
    seconds(measurement.verificationMs),
    cell(measurement.fingerprintQueryStrategy),
    seconds(measurement.foreignKeyEnableMs),
    seconds(measurement.foreignKeyReadiness?.durationMs),
    cell(measurement.foreignKeyCheck),
    measurement.quickCheckMode?.startsWith('per-table')
      ? `${cell(measurement.quickCheck)}（テーブル別）`
      : cell(measurement.quickCheck),
  ]);
  const preparationRows = verified.map((measurement) => {
    const parts = measurement.restorePreparation?.parts;
    const sizes = parts?.map((part) => part.sizeBytes);
    return [
      label(measurement),
      seconds(measurement.rawBackupTotalMs),
      seconds(measurement.restorePreparationMs ?? measurement.restorePreparation?.totalMs),
      Array.isArray(parts) ? String(parts.length) : '未記録',
      sizes?.length && sizes.every(finite)
        ? mib(sizes.reduce((sum, size) => sum + size, 0))
        : '未記録',
      sizes?.length && sizes.every(finite) ? mib(Math.max(...sizes)) : '未記録',
    ];
  });
  const tailRuns = measurements.filter((measurement) => measurement.restoreTailPreparation);
  const tailRows = tailRuns.map((measurement) => [
    label(measurement),
    count(measurement.restorePreparation?.parts.length),
    count(measurement.restoreTailBasePartCount),
    count(measurement.restoreTailPreparation.parts.length),
    count(activeParts(measurement).length),
    seconds(measurement.restoreTailPreparationMs),
    seconds(measurement.recoveryRemediationMs),
    measurement.restoreTailPreparationConfirmed === true ? '確認済み' : '未確認',
    measurement.verified === true ? '復元・検証完了' : '未完了',
  ]);
  const partRows = verified.flatMap((measurement) =>
    (measurement.importParts ?? []).map((part, index) => [
      label(measurement),
      String(index + 1),
      partKind(part.kind),
      mib(partSize(measurement, part)),
      count(partSize(measurement, part)),
      seconds(part.importInitMs),
      seconds(part.restoreUpload?.totalMs ?? part.restoreUpload?.uploadMs),
      seconds(part.ingestObservedMs),
      seconds(part.importTotalMs),
      part.uploadReused === true ? '再利用' : '転送',
    ])
  );
  const controlRows = [];
  const sourceRows = [];
  const allTrialsRows = [];
  const coverageRows = [];
  const phases = [
    ['baseline', '事前'],
    ['export', 'SQL生成'],
    ['backupCopy', 'R2保存'],
    ['backupPrepare', '復元準備'],
    ['recoveryPrepare', '復旧中の追加準備'],
    ['recovery', '復旧'],
  ];
  for (const measurement of verified) {
    for (const [key, title] of phases) {
      const group = measurement.probes?.[key];
      if (key === 'recoveryPrepare' && !group) continue;
      controlRows.push([
        label(measurement),
        title,
        failures(group?.['control/read']),
        failures(group?.['control/write']),
        finite(group?.['control/read']?.maxMs) ? group['control/read'].maxMs.toFixed(1) : '未記録',
        finite(group?.['control/write']?.maxMs)
          ? group['control/write'].maxMs.toFixed(1)
          : '未記録',
      ]);
    }
    const source = measurement.probes?.export;
    sourceRows.push([
      label(measurement),
      failures(source?.['source/read']),
      failures(source?.['source/write']),
    ]);
  }
  for (const measurement of measurements) {
    if (measurement.allTrialsProbes) {
      const read = measurement.allTrialsProbes['control/read'];
      const write = measurement.allTrialsProbes['control/write'];
      allTrialsRows.push([
        label(measurement),
        failures(read),
        count(read?.timeouts),
        milliseconds(read?.p95Ms),
        milliseconds(read?.maxMs),
        failures(write),
        count(write?.timeouts),
        milliseconds(write?.p95Ms),
        milliseconds(write?.maxMs),
      ]);
    }
    const coverage = measurement.probeCoverage;
    if (coverage) {
      coverageRows.push([
        label(measurement),
        count(coverage.probeFilesRead),
        count(coverage.uniqueSamples),
        coverage.backupPrepare?.inferred === true
          ? coverage.backupPrepare.available === true
            ? '終了時刻と準備時間から推定'
            : '推定区間に記録なし'
          : coverage.backupPrepare?.available === true
            ? '保存済み区間'
            : '未記録',
        coverage.recovery?.continuousEndToEndCoverage === false
          ? measurement.importTimingMode === 'sum successful part stages after resume'
            ? '最終の部分import再開と検証'
            : '最終の再開検証のみ'
          : coverage.recovery?.continuousEndToEndCoverage === true
            ? '最後の復旧区間'
            : '未記録',
      ]);
    }
  }
  const crashRuns = verified.filter((measurement) => measurement.sourceDeletedForRecovery === true);
  const incompleteQuickChecks = verified.filter((measurement) => measurement.quickCheck !== 'ok');
  const incompleteForeignKeyChecks = verified.filter(
    (measurement) => measurement.foreignKeyCheck !== 'ok'
  );
  const rawFailures = measurements.filter((measurement) => measurement.rawImportFailure);
  const importFailureRows = measurements.flatMap((measurement) =>
    (measurement.importFailures ?? []).map((failure) => [
      label(measurement),
      count(failure.partIndex),
      count(failure.polls),
      count(failure.polling?.timeouts),
      seconds(failure.importTotalMs),
      seconds(failure.ingestObservedMs),
      formattedDate(failure.failedAt),
      safeError(failure.error),
    ])
  );
  const hasFiveGiBPollCancellation = measurements.some(
    (measurement) =>
      measurement.targetMiB === 5120 &&
      (measurement.importFailures ?? []).some((failure) =>
        String(failure.error).includes('no poll() received in 15000ms')
      )
  );
  const resumedPartRows = measurements
    .filter((measurement) => measurement.importResumeCheckpoint || measurement.importTimingMode)
    .map((measurement) => [
      label(measurement),
      cell(measurement.importTimingMode),
      count(measurement.importResumeCheckpoint?.completedPartCount),
      seconds(measurement.importTotalMs),
      seconds(measurement.recoveryTotalMs),
      seconds(recoveryWall(measurement)),
      formattedDate(measurement.recoveryOriginalStartedAtMs),
    ]);
  const integrityRows = measurements
    .filter(
      (measurement) =>
        measurement.verified || measurement.quickCheckMode || measurement.fullQuickCheckError
    )
    .map((measurement) => [
      label(measurement),
      measurement.verified === true ? '完了' : '未完了',
      cell(measurement.quickCheck),
      cell(measurement.quickCheckMode),
      count(measurement.quickCheckTablesChecked),
      count(measurement.foreignKeyTablesChecked),
      safeError(measurement.fullQuickCheckError),
    ]);
  const foreignKeyRows = [];
  const previousRecoveryRows = [];
  for (const measurement of measurements) {
    const attempts = [
      ...(measurement.previousRecoveryAttempts ?? []).map((attempt, index) => ({
        ...attempt,
        attemptLabel: `再開前 ${index + 1}`,
      })),
      { ...measurement, attemptLabel: '今回' },
    ];
    for (const attempt of attempts) {
      if (!attempt.foreignKeyReadiness && !finite(attempt.foreignKeyEnableMs)) continue;
      const samples = attempt.foreignKeyReadiness?.samples ?? [];
      const ready =
        samples.length >= 3 &&
        samples.slice(-3).every((sample) => sample.apiMode === 1 && sample.bindingMode === 1);
      foreignKeyRows.push([
        label(measurement),
        attempt.attemptLabel,
        seconds(attempt.foreignKeyEnableMs),
        seconds(attempt.foreignKeyReadiness?.durationMs),
        String(samples.length),
        `${samples.filter((sample) => sample.apiMode === 0).length} / ${samples.filter((sample) => sample.bindingMode === 0).length}`,
        foreignKeyMode(samples.at(-1)),
        ready ? '確認済み' : '未確認',
        safeError(attempt.error),
      ]);
    }
    for (const [index, attempt] of (measurement.previousRecoveryAttempts ?? []).entries()) {
      previousRecoveryRows.push([
        label(measurement),
        String(index + 1),
        seconds(attempt.importTotalMs),
        seconds(attempt.foreignKeyReadiness?.durationMs),
        safeError(attempt.error),
      ]);
    }
  }
  const paragraphs = [
    '# Authrim core D1のR2バックアップ・SQL分割復元ベンチマーク',
    `実施開始は${formattedDate(results.createdAt)} JST。run IDは\`${cell(results.runId)}\`。復元後の検証まで完了した試行は${verified.length}件、未完了は${incomplete.length}件。`,
    'Authrimの現行core shardに合成データを入れ、D1から専用の非公開R2へSQLを保存した。復元先には毎回空のD1を作成した。ダンプ本体はMacを経由せずCloudflare内で転送し、API制御・進捗・少量の照合用サンプルはMacで扱った。fingerprint用SELECTで照合対象テーブルの先頭・末尾の行サンプルを取得し、Mac上でSHAを計算した。',
    '公式exportのraw SQLはR2へそのまま保持した。復元用には、SQL文を途中で切らず約1GiBずつ分割し、各ファイルの先頭へPRAGMA foreign_keys=OFF、末尾へONを追加した。以下の成功結果は、加工・分割したファイルを順に公式import APIへ渡した条件である。raw SQLを無加工で一括importした成功時間としては扱わない。',
    'ファイル末尾のONだけでは、取り込み後のFK制約が有効にならなかった。データファイルの後に、PRAGMA foreign_keys=ONで始まる小さな専用SQLファイルを最後の独立したimportとして取り込む。その後REST APIと新D1 bindingの双方でforeign_keys=1を3回連続で確認してから、全テーブルのFK検査へ進む。',
    crashRuns.length
      ? `${crashRuns.map(label).join('、')}では、バックアップとmanifestの確認後に、この検証で作成したsource D1を削除した。保存済みのfingerprintと比較し、R2から新しいD1へ復元した。`
      : measurements.some((measurement) => measurement.sourceDeletedForRecovery === true)
        ? 'source D1を削除した試行があるが、復元後の検証はまだ完了していない。削除後の復元成功としては扱わない。'
        : 'source D1の削除後に復元を確認した試行は、現時点の結果にはない。',
    '## 測定結果',
    '容量はMiBで、1MiBは2^20バイト。時間は秒。D1実サイズはmeta.size_afterで取得し、SQL量はR2に保存したファイルのバイト数から算出した。',
    tailRuns.length
      ? '5GiBの初期backup・準備は27分1秒だったが、その7ファイルだけでは復元を完了できず、失敗後に95.54秒の追加準備を要した。最終的には70ファイルで復元した。下表の初期backup時間に追加準備は含めず、復旧処理と総経過に含めている。'
      : '初期backup・準備は、raw保存と最初の復元用ファイル群の準備までの時間を示す。',
    verified.length
      ? table(
          [
            '対象 / 回',
            'D1実サイズ MiB',
            'アカウント数',
            'raw SQL量 MiB',
            'SQL生成 秒',
            'raw R2保存まで 秒',
            '初期backup・準備 秒',
            'import合計 秒',
            '復旧処理 秒',
            '復旧総経過 秒',
            '復旧の計時方式',
            'sourceの扱い',
          ],
          overview
        )
      : '復元後の検証まで完了した試行がないため、成功結果の数値は掲載していない。',
  ];
  if (averages.length) {
    paragraphs.push(
      '同じ容量の平均値を次に示す。1回だけの容量では、その実測値を掲載した。復旧時間は連続実測と再開後の段階合算を区別し、平均に含む方式の内訳も示す。方式が混在する平均を連続したRTOの実測値とは扱わない。少数回の測定からp99や一般的な性能保証は算出していない。',
      table(
        [
          '目標 MiB',
          '完了回数',
          'SQL生成平均 秒',
          'raw保存まで平均 秒',
          '復元準備平均 秒',
          '初期backup・準備平均 秒',
          'import平均 秒',
          '復旧処理平均 秒',
          '復旧総経過平均 秒',
          '復旧計時方式の内訳',
        ],
        averages
      ),
      '## 処理の内訳',
      table(
        [
          '対象 / 回',
          'raw保存まで 秒',
          '初期復元準備 秒',
          '初期ファイル数',
          '初期SQL合計 MiB',
          '初期最大ファイル MiB',
        ],
        preparationRows
      ),
      table(
        [
          '対象 / 回',
          'R2コピー・確認 秒',
          '新D1作成 秒',
          'binding配備 秒',
          'R2→一時PUT 秒',
          '取り込み 秒',
          '復元検証 秒',
          '照合SQL方式',
          'FK専用import 秒（内数）',
          'FK待機 秒',
          'FK検査',
          'quick_check',
        ],
        breakdown
      )
    );
  }
  if (tailRows.length) {
    paragraphs.push(
      '## 5GiBで必要になった追加の復元準備',
      '初期backup・準備の値は、raw保存と最初の復元ファイル群を作った時点までの時間である。5GiBでは、その初期7ファイルの最後のデータファイルをそのまま取り込む方式では復元を完了できなかった。初期準備の27分だけで、実証済みの復元手順まで準備できていたとは扱わない。',
      '復旧中にR2内の失敗ファイルだけを再処理し、残りデータ、データあり表のindexを1つずつ、空表のindex群とtrigger群をそれぞれ最大16個ずつに分割した。最初の5ファイルは保持し、追加した65ファイルと合わせて70ファイルを使った。DDLの意味と順序を保ち、最後にFK再有効化専用ファイルを取り込んだ。',
      table(
        [
          '対象 / 回',
          '初期ファイル数',
          '保持した初期ファイル数',
          '追加ファイル数',
          '実使用ファイル数',
          '失敗後の追加準備 秒',
          '復旧対処 秒',
          '追加manifest確認',
          '結果',
        ],
        tailRows
      ),
      '追加準備はrestoreTailPreparationMs、追加manifestはrestoreTailPreparationへ記録した。recoveryRemediationMsは追加準備と最後のWorker再配備を含み、復旧処理時間にも含める。初期backupの時間へ遡って加算しない。総経過には失敗・診断待ちも含む。したがって今回の5GiBは、初期バックアップに復旧中の追加加工を加えて復元できた結果であり、初期7ファイルだけの復元成功ではない。'
    );
  }
  if (partRows.length) {
    paragraphs.push(
      '実際に使用したファイルを順番に示す。5GiBは最初の5ファイルと再構成した65ファイルの合計70ファイルであり、初期の7ファイルとは異なる。成功した転送と取り込みの合計をimport合計へ記録した。FK専用importはimport合計の内数で、別途加算しない。',
      table(
        [
          '対象 / 回',
          '順番',
          '種類',
          'SQL量 MiB',
          'SQL量 byte',
          '初期化 秒',
          '一時PUT 秒',
          '取り込み 秒',
          'import合計 秒',
          'upload',
        ],
        partRows
      )
    );
  }
  if (rawFailures.length) {
    paragraphs.push(
      '## 無加工のraw SQLを取り込んだ結果',
      '次のraw importは失敗した。加工・分割後の成功結果とは別に記録し、成功時間の平均へ加算していない。D1_RESET_DOだけでは原因を特定できない。FK用PRAGMAの追加と分割で復元できた場合も、このエラーの根因を確定したことにはならない。',
      table(
        ['対象 / 回', 'raw importのエラー', '初期化 秒', '一時PUT 秒'],
        rawFailures.map((measurement) => [
          label(measurement),
          cell(
            String(measurement.rawImportFailure.error ?? '詳細未記録').replace(
              /https?:\/\/\S+/g,
              '[URL]'
            )
          ),
          seconds(measurement.rawImportFailure.importInitMs),
          seconds(
            measurement.rawImportFailure.restoreUpload?.totalMs ??
              measurement.rawImportFailure.restoreUpload?.uploadMs
          ),
        ])
      )
    );
  }
  if (foreignKeyRows.length) {
    paragraphs.push(
      '## FK制約の再有効化と確認',
      '末尾にONを付けたデータファイルのimport完了後も、REST APIとbindingの両方でforeign_keys=0が60秒継続し、確認を打ち切った試行があった。REST queryのONでも直後に有効化できないことを観測した。後から1になった試行の原因は特定していない。別の新規専用DBでは、OFFだけを設定する小さなimportの後に0、ONだけを設定する小さなimportの直後に1を確認し、保存済みのテスト行も保持された。以後は最後にFK再有効化専用ファイルをimportし、双方の1を3回連続で確認する。専用importの時間はimport合計の内数で、確認待ちは復元検証へ含む。いずれも復旧全体に含む。',
      '0の観測数と最終値はREST API / bindingの順。FK待機には確認APIの通信時間も含む。全観測値と経過時間はJSONのforeignKeyReadiness.samplesへ残した。',
      table(
        [
          '対象 / 回',
          '試行',
          'FK再有効化 秒',
          'FK待機 秒',
          '観測回数',
          '0の観測数 API / binding',
          '最終値 API / binding',
          '双方1を3連続',
          'エラー',
        ],
        foreignKeyRows
      )
    );
  }
  if (previousRecoveryRows.length) {
    paragraphs.push(
      '## 再開前の復元試行',
      '再開前の処理記録を示す。失敗した復旧や検証の時間を、成功結果へ追加加算しない。取り込み済みのD1で検証だけを再開した場合は、その完了済みimport時間を成功結果へ1回だけ含める。成功結果は、すべての失敗や中断も含む総経過時間とは異なる。',
      table(
        ['対象 / 回', '再開前の試行', 'import合計 秒', 'FK待機 秒', 'エラー'],
        previousRecoveryRows
      )
    );
  }
  if (importFailureRows.length || resumedPartRows.length) {
    paragraphs.push(
      '## 分割importの失敗と再開',
      hasFiveGiBPollCancellation
        ? '5GiBの初回復元ではデータファイル1〜5が完了した後、6番目がCancelled due to no poll() received in 15000msで失敗した。pollは64回実行し、1回の応答に約35秒かかった観測もあった。再試行もpollリクエストのタイムアウト12回連続で停止した。これは2回目のnative importキャンセル応答を確認したという意味ではない。どちらも復元先の件数とschemaが5番目までのSQL境界と一致することを確認した。その後、失敗ファイルをデータとDDLに追加分割し、同じ専用D1で復元を完了した。D1のエラー文を、クライアントがpollを実行していなかった証拠とは解釈しない。'
        : '記録された失敗履歴、再開時に確認した完了ファイル数と計時方式を示す。'
    );
    if (importFailureRows.length) {
      paragraphs.push(
        table(
          [
            '対象 / 回',
            '失敗ファイル番号',
            'poll回数',
            'timeout回数',
            '処理経過 秒',
            '取り込み観測 秒',
            '失敗日時 JST',
            'エラー',
          ],
          importFailureRows
        )
      );
    }
    if (resumedPartRows.length) {
      paragraphs.push(
        table(
          [
            '対象 / 回',
            'import計時方式',
            '確認済み完了ファイル数',
            'import成功段階 秒',
            '復旧処理 秒',
            '復旧総経過 秒',
            '最初の復旧開始 JST',
          ],
          resumedPartRows
        )
      );
    }
    paragraphs.push(
      'sum successful part stages after resumeは、再開前の成功ファイルと再開後に成功したファイルの時間を1回ずつ合算する。復旧処理は追加準備と最後のWorker再配備を含むrecoveryRemediationMsも加算するが、失敗した取り込み、中断、診断待ちは除く。復旧総経過は最初の復旧開始から最終確認までで、それらも含む。利用者が復旧を待つ時間として読む場合は総経過を使う。未完了または未記録の時間は推測しない。',
      '失敗履歴はimportFailures、完了ファイルの件数・schema確認はimportResumeCheckpoint、元の復旧開始と総経過はrecoveryOriginalStartedAtMsとrecoveryWallTotalMsへ記録した。JSON原本とCSVには、各partの成功時間と失敗履歴も残す。'
    );
    paragraphs.push(
      '今回の再開は、読み取りで確認したSQL境界と検証済みcheckpointを使った専用の復旧手順である。既定の分割方式だけで5GiBの復元を完了できた結果や、任意の障害から無人で復旧するツールの実証としては扱わない。'
    );
  }
  if (integrityRows.length) {
    paragraphs.push(
      '## 整合性検査の方式と限界',
      '100MiB条件でDB全体のPRAGMA quick_checkがSQLITE_NOMEMとなったため、アプリケーションの全テーブルとsqlite_schemaを個別に検査する方式へ変更した。現行の197テーブルでは計198対象を12文ずつのbatchで確認する。表のokは記録した個別検査の成功を示し、DB全体のquick_checkが成功したという意味ではない。全体検査の失敗はfullQuickCheckErrorへ保持した。',
      table(
        [
          '対象 / 回',
          '状態',
          'quick_check',
          '検査方式',
          '確認対象数',
          'FK検査テーブル数',
          '全体quick_checkのエラー',
        ],
        integrityRows
      ),
      'テーブル別の検査では、異なるテーブル間のページ重複や未使用領域を検出できない。sqlite_schemaを対象にした検査でfreelistも確認するが、全DBを通したページ割当検査の代わりにはならない。quick_check自体もUNIQUE制約やindexとtableの内容一致を検査しない。FKは別途全テーブルのforeign_key_checkで確認する。[SQLite integrity_check](https://www.sqlite.org/pragma.html#pragma_integrity_check)、[SQLite quick_check](https://www.sqlite.org/pragma.html#pragma_quick_check)'
    );
  }
  paragraphs.push(
    'SQL生成はexport開始から完了応答までの観測時間で、API通信とpollを含む。raw保存まではSQL生成、Workerでのコピー、objectとmanifestの確認を含む。初期backup・準備はraw保存と最初の復元用ファイル群の準備の合計で、再開待ちや復旧中の追加加工を除く。export中はsource D1がほかのリクエストを処理できない。SQL生成の観測時間を、厳密な連続停止時間とは扱わない。[D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)',
    'import合計は実使用ファイルのimport初期化、own R2からD1の一時アップロード先への転送、SQL取り込みを合計した時間。FK再有効化の時間はこの内数である。復旧処理は新D1作成、binding配備、全ファイルのimport、復旧中の追加準備と再配備、FK状態の確認待ち、データ検証、新bindingへの読み書き確認までを含む。sourceを削除する試行では削除と不在確認も含む。最初のファイル準備はbackup側、失敗後の追加準備はrecovery側へ計上した。[D1 import API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/)',
    '復旧の計時方式が連続実測の場合は、一連の処理の開始から検証完了までの経過時間を示す。再開後の完了段階を合算した場合は、保存済みのD1作成・binding配備・成功したimportと、最後に成功した検証時間を合算した。source削除と、追加準備・最後の再配備があればそれらも加える。再開待ちや失敗した処理の時間を除くため、利用者が待つ実際の総経過とは異なる。元の方式はrecoveryTimingModeへ記録した。',
    '5GiBの事前fingerprintでは、検証SQLがtenant_idのindexを選び、範囲ごとにtenant全体を繰り返し走査してCPU上限を超え、D1がリセットされた。HTTP 429・code 7429を確認し、原因を検証クエリの実装として切り分けた。100MiBと1GiBはlegacy-v1、5GiBはPK範囲のindex指定とoutbox全範囲集計を使うpk-range-v2-outbox-globalで照合した。DB・schema・indexや検証内容、hash、サンプル境界は変更していない。SQL生成とraw SQL保存は容量別に比較できるが、5GiBのimportにはDDL追加分割、復旧全体には検証SQLの実装差も含まれる。取り込み時間やRTOを単純な容量比例として比較しない。',
    '## 別DBの読み書き',
    '別のcontrol D1でPK検索と更新を続けた。最終処理区間の集計と、失敗・再試行・準備を含む全記録の集計を分けて示す。区間をまたぐリクエストが複数区間へ含まれることがあるため、区間の件数は合算しない。'
  );
  if (results.probeAudit) {
    const audit = results.probeAudit;
    paragraphs.push(
      '### 全記録のcontrol成否（失敗・再試行・準備を含む）',
      `記録されたprobeファイル${count(audit.probeFilesRead)}件を読み、重複を除いた全対象の${count(audit.uniqueSamples)}観測から集計した。発行・記録されたリクエストだけが対象で、監視の空白を補間していない。集計範囲の記録は\`${cell(audit.scope)}\`。`,
      table(
        ['control操作', '失敗/件数', 'timeout件数', 'p50 ms', 'p95 ms', '最大 ms'],
        [
          ['read', audit.controlRead],
          ['write', audit.controlWrite],
        ].map(([operation, series]) => [
          operation,
          failures(series),
          count(series?.timeouts),
          milliseconds(series?.p50Ms),
          milliseconds(series?.p95Ms),
          milliseconds(series?.maxMs),
        ])
      ),
      'p50とp95は成功リクエストから算出し、最大値は失敗リクエストも含む。timeoutは失敗件数の内数として別に示す。',
      `probeで観測したWorker coloは${locations(audit.workerColos)}、D1 coloは${locations(audit.d1Colos)}、D1 regionは${locations(audit.d1Regions)}。応答に記録された配置の集合であり、全DBや転送処理の実行場所を確定する値ではない。`
    );
  } else {
    paragraphs.push(
      '全記録をまとめたprobeAuditは未記録。次の処理区間の表だけで、失敗試行や再試行を含む全記録の成否を判断しない。'
    );
  }
  if (allTrialsRows.length) {
    paragraphs.push(
      '容量・回ごとの全記録には、その条件で記録された失敗試行と再試行も含む。',
      table(
        [
          '対象 / 回',
          'read 失敗/件数',
          'read timeout',
          'read p95 ms',
          'read最大 ms',
          'write 失敗/件数',
          'write timeout',
          'write p95 ms',
          'write最大 ms',
        ],
        allTrialsRows
      )
    );
  }
  if (coverageRows.length) {
    paragraphs.push(
      'probeの記録範囲を次に示す。復元準備の推定区間はbackupFinishedAtMsからrestorePreparationMsを引いて求め、その区間と重なる実際のリクエストを集計した。推定したのは区間の境界であり、リクエストや結果を生成したものではない。初回の復旧区間が最終の再開検証だけの場合、元のD1作成・importや以前の失敗処理は全記録の集計にのみ含む。',
      table(
        ['対象 / 回', '記録ファイル数', '重複除外後の全観測数', '復元準備区間', '復旧区間の範囲'],
        coverageRows
      ),
      'probeCoverageには補完方法とscopeを、allTrialsProbesには条件ごとの全記録を保存した。区間別のrecovery統計は最後の復旧区間のまま保持し、以前の試行へ広げていない。'
    );
  }
  if (controlRows.length) {
    paragraphs.push(
      '最後に記録された処理区間ごとの成否は次のとおり。',
      table(
        [
          '対象 / 回',
          '区間',
          'control read 失敗/件数',
          'control write 失敗/件数',
          'read最大 ms',
          'write最大 ms',
        ],
        controlRows
      )
    );
    paragraphs.push(
      'source側のSQL生成区間では、次の失敗を観測した。',
      table(['対象 / 回', 'source read 失敗/件数', 'source write 失敗/件数'], sourceRows)
    );
  }
  const deletedSourceRows = measurements
    .filter(
      (measurement) =>
        measurement.sourceDeletedForRecovery && measurement.probes?.recoveryPrepare?.['source/read']
    )
    .map((measurement) => [
      label(measurement),
      failures(measurement.probes.recoveryPrepare['source/read']),
      failures(measurement.probes.recoveryPrepare['control/read']),
      failures(measurement.probes.recoveryPrepare['control/write']),
    ]);
  if (deletedSourceRows.length) {
    paragraphs.push(
      '復旧中の追加準備では、削除済みsourceへのread監視が残っていた。次のsource read失敗は、その削除済みDBを監視した結果であり、新しい復元先D1や別control D1の障害を示すものではない。',
      table(
        [
          '対象 / 回',
          '削除済みsource read 失敗/件数',
          'control read 失敗/件数',
          'control write 失敗/件数',
        ],
        deletedSourceRows
      )
    );
  }
  paragraphs.push(
    '短い停止や、監視リクエストを発行できなかった時間は、この集計だけでは判定できない。失敗が0件でも、ほかのDBが常に無影響であるという保証にはならない。p50とp95は成功分、最大値は失敗も含む値として読み、失敗件数も確認する。',
    '## スキーマと検証範囲',
    `対象は${cell(profile.name ?? '現行core-d1')}。製品版数は${cell(profile.productVersion)}、テーブル数は${count(profile.tableCount)}、インデックス数は${count(profile.indexCount)}、trigger数は${count(profile.triggerCount)}。適用したmigrationファイルは${Array.isArray(profile.migrationFiles) ? profile.migrationFiles.length : '未記録'}件。checksumと構成の詳細は元のJSONに記録した。`,
    'ユーザー、identity、passkey、role割当、consent、session、token familyを合成データで作成した。passkeyは保存量を再現するための値で、認証には使えない。ランダム16進文字列をmetadataへ格納しており、実運用のデータ量・圧縮率・トラフィック構成を再現したものではない。PII、Admin、Control、Lookupなど別DBのデータは、このcore shardのダンプに含めていない。',
    'raw SQL全体と各復元用ファイルには、それぞれのMD5、SHA-256、サイズを記録した。復元時にも各ファイルのhashとサイズを照合し、一時PUT先のETagをそのファイルのMD5と比較した。PRAGMAを付加したファイルのhashには、付加したバイトも含む。multipartで保存したown R2 objectのETagは、全体MD5とは別の値になる。[R2のETag](https://developers.cloudflare.com/r2/objects/upload-objects/#etags)',
    'データファイルの取り込み中はFK制約を無効にする。最後の専用importで制約を有効化し、REST APIとbindingで確認してから、全テーブルのFK検査、schema、件数、範囲ごとの集計、行サンプル、参照関係を確認する。foreign_keys=1は以後の制約の有効性を、foreign_key_checkは既存データの参照整合性を確かめる別の検証である。これは全行・全カラムの暗号学的な一致検証とは範囲が異なる。FK検査と、テーブル別quick_checkの状態を表へ記録した。',
    incompleteForeignKeyChecks.length
      ? `FK検査のokが記録されていない試行は${incompleteForeignKeyChecks.map(label).join('、')}。FK整合性を確認できた結果としては扱わない。`
      : verified.length
        ? '完了した全試行でFK検査のokを確認した。'
        : 'FK検査の成功結果はまだない。',
    incompleteQuickChecks.length
      ? `quick_checkがokと記録されていない試行は${incompleteQuickChecks.map(label).join('、')}。記録した範囲の個別検査を完了した結果としては扱わない。`
      : verified.length
        ? '完了した全試行で記録した範囲のquick_checkのokを確認した。検査方式と対象数は上表に示し、DB全体のquick_checkの成功とは扱わない。'
        : 'quick_checkの成功結果はまだない。',
    '今回確認したのは、単一core D1のR2バックアップ、新D1への復元、別control D1のI/O継続である。Authrimのログインやtoken処理、Lookup切替、全writerの停止、自動failover、Cloudflare全体の障害からの復旧は検証範囲に含まない。DB削除後に復元できても、これらの運用手順が完成したことまでは示さない。'
  );
  paragraphs.push(
    'RPO（失われ得る更新の範囲）は、この測定では評価していない。照合対象のsourceデータは投入後の更新を止め、確認済みバックアップから復元する条件とした。監視用の更新は別control D1へ送っている。最後のバックアップ後も書き込みを続けた場合の更新損失や、その差分の回収は試験していないため、RPOが0であるとは結論しない。',
    'fingerprintは複数クエリの結果であり、全クエリを1つのsnapshotで実行する方式ではない。更新を止めた合成データを前提に照合した。SQLファイル全体のhashは転送内容の一致を確認するもので、復元DBの全行・全カラムを暗号学的に照合した証明ではない。'
  );
  if (incomplete.length) {
    paragraphs.push(
      '## 未完了の試行',
      '次の試行を成功結果と平均値から除外した。未完了の時間を補間していない。',
      table(
        ['対象 / 回', '状態', '記録済みSQL生成 秒', '記録済み復元用backup完成 秒'],
        incomplete.map((measurement) => [
          label(measurement),
          cell(
            measurement.error
              ? String(measurement.error).replace(/https?:\/\/\S+/g, '[URL]')
              : '検証未完了'
          ),
          seconds(measurement.exportApiMs),
          seconds(measurement.backupTotalMs),
        ])
      )
    );
  }
  const resumed = measurements.filter((measurement) => measurement.previousErrors?.length);
  if (resumed.length) {
    paragraphs.push(
      '## 再開した試行',
      '次の試行は途中で中断し、同じバックアップから再開した。復旧時間は表の計時方式に従う。取り込み済みのD1で検証から再開した場合、元の完了済み処理と最後に成功した検証を合算し、中断していた時間や失敗した検証は含めない。途中から監視を再開した場合、以前のSQL生成区間のprobeが未記録になることがある。',
      table(
        ['対象 / 回', '再開前のエラー'],
        resumed.map((measurement) => [
          label(measurement),
          cell(
            measurement.previousErrors
              .map((error) => String(error).replace(/https?:\/\/\S+/g, '[URL]'))
              .join(' / ')
          ),
        ])
      )
    );
  }
  const verificationRetries = measurements.filter(
    (measurement) => measurement.previousVerificationErrors?.length
  );
  if (verificationRetries.length) {
    paragraphs.push(
      '取り込み済みD1の検証だけを再開した際の失敗理由を次に示す。この記録はimportの繰り返しを意味しない。',
      table(
        ['対象 / 回', '検証再開時のエラー'],
        verificationRetries.map((measurement) => [
          label(measurement),
          measurement.previousVerificationErrors.map(safeError).join(' / '),
        ])
      )
    );
  }
  if (results.cleanupSummary) {
    const cleanup = results.cleanupSummary;
    paragraphs.push(
      `専用リソースの後片付け: 作成したD1 ${count(cleanup.dbsCreated)}個のうち${count(cleanup.dbsDeleted)}個を削除、Workerは${deletionState(cleanup.workerDeleted)}、R2 bucketは${deletionState(cleanup.bucketDeleted)}。削除処理を確認した対象keyは${count(cleanup.objectKeysDeleted)}件で、未作成の予約keyを含み、実object数とは異なる。完了日時は${formattedDate(cleanup.completedAt)} JST。`
    );
  } else {
    paragraphs.push('専用リソースの後片付けはcleanupSummaryへ未記録。');
  }
  paragraphs.push(
    '再現手順と時間の定義は[R2-README.md](R2-README.md)、数値と検証記録は[r2-results.json](r2-results.json)を参照。CSVにも原数値、計時方式、失敗履歴、part別時間を残す。専用リソースの削除状態はrunごとのresources.jsonに残している。'
  );
  return `${paragraphs.join('\n\n')}\n`;
}

/** One measurement per row; nested traces remain JSON inside quoted CSV cells. */
export function renderCsv(results) {
  if (!results || !Array.isArray(results.measurements)) {
    throw new TypeError('Expected a results object with measurements[]');
  }
  const textWithoutUrls = (value) =>
    value === undefined ? undefined : String(value).replace(/https?:\/\/\S+/g, '[URL]');
  const fields = [
    ['runId', () => results.runId],
    ...[
      'targetMiB',
      'repeat',
      'verified',
      'sizeBytes',
      'accountCount',
      'exportApiMs',
      'rawBackupTotalMs',
      'restorePreparationMs',
      'restoreTailPreparationMs',
      'restoreTailPreparationConfirmed',
      'restoreTailBasePartCount',
      'recoveryRemediationMs',
      'backupTotalMs',
      'importTotalMs',
      'importTimingMode',
      'recoveryTotalMs',
      'recoveryTimingMode',
      'recoveryOriginalStartedAtMs',
      'verificationMs',
      'fingerprintQueryStrategy',
      'sourceDeletedForRecovery',
      'sourceAbsenceConfirmed',
      'restoredBindingReadWrite',
      'foreignKeyCheck',
      'foreignKeyTablesChecked',
      'quickCheck',
      'quickCheckMode',
      'quickCheckTablesChecked',
    ].map((name) => [name, (measurement) => measurement[name]]),
    ['rawSqlBytes', (measurement) => measurement.backup?.sizeBytes],
    ['initialRestorePartCount', (measurement) => measurement.restorePreparation?.parts.length],
    ['tailRestorePartCount', (measurement) => measurement.restoreTailPreparation?.parts.length],
    ['activeRestorePartCount', (measurement) => activeParts(measurement).length],
    [
      'activeRestoreBytes',
      (measurement) => {
        const parts = activeParts(measurement);
        return parts.length && parts.every((part) => finite(part.sizeBytes))
          ? parts.reduce((total, part) => total + part.sizeBytes, 0)
          : undefined;
      },
    ],
    ['recoveryWallTotalMs', recoveryWall],
    [
      'importResumeCompletedPartCount',
      (measurement) => measurement.importResumeCheckpoint?.completedPartCount,
    ],
    [
      'importPartsJson',
      (measurement) =>
        JSON.stringify(
          (measurement.importParts ?? []).map((part, index) => ({
            partIndex: part.partIndex ?? index + 1,
            key: textWithoutUrls(part.key),
            kind: part.kind,
            sizeBytes: partSize(measurement, part),
            importInitMs: part.importInitMs,
            restoreUploadMs: part.restoreUpload?.totalMs ?? part.restoreUpload?.uploadMs,
            ingestObservedMs: part.ingestObservedMs,
            importTotalMs: part.importTotalMs,
            polls: part.importPolls,
            uploadReused: part.uploadReused,
          }))
        ),
    ],
    [
      'importFailuresJson',
      (measurement) =>
        JSON.stringify(
          (measurement.importFailures ?? []).map((failure) => ({
            partIndex: failure.partIndex,
            key: textWithoutUrls(failure.key),
            error: textWithoutUrls(failure.error),
            polls: failure.polls,
            importTotalMs: failure.importTotalMs,
            ingestObservedMs: failure.ingestObservedMs,
            importInitMs: failure.importInitMs,
            restoreUploadMs: failure.restoreUpload?.totalMs ?? failure.restoreUpload?.uploadMs,
            failedAt: failure.failedAt,
          }))
        ),
    ],
    ['fullQuickCheckError', (measurement) => textWithoutUrls(measurement.fullQuickCheckError)],
    ['error', (measurement) => textWithoutUrls(measurement.error)],
  ];
  const csvCell = (value) => {
    if (value === undefined || value === null || (typeof value === 'number' && !finite(value)))
      return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return (
    [
      fields.map(([name]) => name),
      ...results.measurements.map((measurement) => fields.map(([, get]) => get(measurement))),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = path.resolve(process.argv[2] ?? path.join(directory, 'r2-results.json'));
  const output = path.resolve(process.argv[3] ?? path.join(directory, 'R2-RESULTS.md'));
  const csvOutput = path.resolve(
    process.argv[4] ?? path.join(path.dirname(output), `${path.parse(output).name}.csv`)
  );
  if (new Set([input, output, csvOutput]).size !== 3) {
    throw new Error('Input, Markdown output, and CSV output paths must differ');
  }
  const results = JSON.parse(await readFile(input, 'utf8'));
  await writeFile(output, renderReport(results));
  await writeFile(csvOutput, renderCsv(results));
  process.stdout.write(`${output}\n${csvOutput}\n`);
}

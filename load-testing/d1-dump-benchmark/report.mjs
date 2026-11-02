import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from './metrics.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
const measurements = results.measurements.filter((measurement) => measurement.verified);
const groups = Map.groupBy(measurements, (measurement) => measurement.targetMiB);
function seconds(value) {
  return `${(value / 1000).toFixed(2)}秒`;
}
function range(group, field) {
  const values = group.map((measurement) => measurement[field]);
  return group.length === 1
    ? seconds(values[0])
    : `${seconds(percentile(values, 50))} (${seconds(Math.min(...values))}〜${seconds(Math.max(...values))})`;
}
function size(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(3)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
const overview = [];
for (const [targetMiB, group] of groups) {
  overview.push(
    `| ${size(group[0].sizeBytes)} | ${group[0].rows.toLocaleString('en-US')} | ${size(group[0].dumpBytes)} | ${group.length} | ${range(group, 'exportApiMs')} | ${range(group, 'exportTotalMs')} | ${range(group, 'importTotalMs')} |`
  );
}
const detailed = measurements.map(
  (m) =>
    `| ${m.targetMiB} MiB / ${m.repeat} | ${seconds(m.exportApiMs)} | ${seconds(m.downloadMs)} | ${seconds(m.uploadMs)} | ${seconds(m.ingestObservedMs)} | ${seconds(m.importTotalMs)} | ${seconds(m.verificationMs)} | ${m.quickCheck ?? 'ok（旧版の必須検証を通過）'} |`
);
const incompleteIntegrity = measurements.filter((m) => m.quickCheck === 'incomplete');
const integrityNote = incompleteIntegrity.length
  ? `全体の整合性チェックが期限超過で未完了: ${incompleteIntegrity.map((m) => `${m.targetMiB} MiB / ${m.repeat}`).join('、')}。件数・集計・サンプルは一致したが、DB全体の整合性検証が完了した結果とは扱わない。`
  : '全回でPRAGMA quick_checkの正常終了を確認した。';
const streamMeasurements = measurements.filter((m) => m.downloadMode === 'stream-discard');
const streamNote = streamMeasurements.length
  ? `ローカル空き容量不足のため、${streamMeasurements.map((m) => `${m.targetMiB} MiB / ${m.repeat}`).join('、')}はダンプをディスクに保存せず、ストリームで全バイトの受信・サイズ・ハッシュを確認した。復元時は同じ署名付きexport URLから再取得しながらMac経由でPUTした。この回のアップロード時間は再取得と転送が重なる時間を含み、ローカルファイルを使うWranglerの転送時間と同一条件ではない。D1への取り込み時間は別途計測した。`
  : '';
const aborted = results.measurements.filter((m) => m.error && m.exportApiMs && !m.verified);
const abortedNote = aborted.length
  ? `途中で中断した試行: ${aborted.map((m) => `${m.targetMiB} MiB / ${m.repeat} はSQL生成が${seconds(m.exportApiMs)}で完了後、${m.error === 'Less than 512 MiB disk remains' ? 'ローカルの空き容量が512MiB未満となり、保存を中断' : '後続処理が失敗'}`).join('。')}。この試行を復元済みの表・中央値へ含めていない。`
  : '';
const pendingNote = results.measurements
  .filter((m) => !m.verified && !m.error && m.exportTotalMs)
  .map(
    (m) =>
      `復元検証待ち: ${size(m.sizeBytes)}のSQLダンプは${size(m.dumpBytes)}、SQL生成は${seconds(m.exportApiMs)}、全量取得までは${seconds(m.exportTotalMs)}。復元時間はまだ確定していない。`
  )
  .join('\n\n');
const outageRows = [];
const outages = [];
for (const m of measurements) {
  const samples = (
    await readFile(
      path.join(directory, 'runs', results.runId, `probes-${m.targetMiB}-${m.repeat}.ndjson`),
      'utf8'
    )
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const [target, operation] of [
    ['source', 'read'],
    ['source', 'write'],
    ['control', 'read'],
  ]) {
    const series = samples
      .filter((s) => s.target === target && s.operation === operation)
      .sort((a, b) => a.startedMs - b.startedMs);
    const failed = series.filter((s) => !s.ok);
    const first = failed[0];
    const last = failed.at(-1);
    const recovered = last ? series.find((s) => s.ok && s.startedMs > last.startedMs) : undefined;
    const entry = {
      targetMiB: m.targetMiB,
      repeat: m.repeat,
      target,
      operation,
      failures: failed.length,
      requests: series.length,
      firstFailureAt: first ? new Date(first.startedMs).toISOString() : null,
      lastFailureAt: last ? new Date(last.startedMs).toISOString() : null,
      failureSampleSpanMs: first ? last.startedMs - first.startedMs : 0,
      firstRecoveredAt: recovered ? new Date(recovered.finishedMs).toISOString() : null,
      maxMs: Math.max(...series.map((s) => s.elapsedMs)),
      workerColos: [...new Set(series.map((s) => s.colo).filter(Boolean))],
      databaseColos: [...new Set(series.map((s) => s.meta?.served_by_colo).filter(Boolean))],
    };
    outages.push(entry);
    const exportStats = m.probes.export[`${target}/${operation}`];
    outageRows.push(
      `| ${m.targetMiB} MiB / ${m.repeat} | ${target}/${operation} | ${entry.failures}/${entry.requests} | ${first ? seconds(entry.failureSampleSpanMs) : 'なし'} | ${seconds(entry.maxMs)} | ${exportStats.failures}/${exportStats.requests} |`
    );
  }
}
const observedColos = (target, key) =>
  [
    ...new Set(outages.filter((entry) => entry.target === target).flatMap((entry) => entry[key])),
  ].join(', ');

const report = `# D1 SQL dump / restore ベンチマーク

${results.partial ? '測定継続中。以下は復元検証まで完了した回の途中結果。\n\n' : ''}
実施日: ${new Date(results.createdAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}。Cloudflare上の専用D1を使用し、Macから計測した。ソースDBは容量ごとに拡張し、復元先は毎回空のD1を作成した。

## 容量別の結果

単位はMiB/GiB（2進）。複数回は中央値、括弧内は最小〜最大。SQL生成列はAPI開始から完了を検知するまでの観測時間で、通信・poll待機を含む。ダンプ取得列は生成と全バイト受信の合計。復元列はimport初期化・アップロード・取り込みを含み、DB作成・検証を含まない。

${streamNote}

| D1実サイズ | 行数 | SQLダンプ | 回数 | SQL生成の完了検知まで | ダンプ取得まで | 空DBへの復元 |
|---|---:|---|---:|---|---|---|
${overview.join('\n')}

${abortedNote}

${pendingNote}

## 処理段階ごとの内訳

| 対象 / 回 | SQL生成の完了検知まで | ダウンロード・hash | アップロード（stream時は再取得込み） | 取り込み完了の観測時間 | 復元合計 | 復元後の検証 | quick_check |
|---|---|---|---|---|---|---|---|
${detailed.join('\n')}

${integrityNote}

## export中の読み書き

1秒ごとに、対象DBの主系への読み取り・書き込みと、別の小さなD1への読み取りを発行した。成功時の遅延は成功リクエストだけで集計し、失敗件数を別掲する。観測幅は最初と最後の失敗リクエストの発行時刻差で、厳密な連続停止時間ではない。1秒間隔のため、それより短い事象は見逃す可能性がある。

| 対象 / 回 | 監視先 / 操作 | 全監視区間の失敗/件数 | 最初〜最後の失敗の観測幅 | 最大応答時間 | SQL生成と重なる失敗/件数 |
|---|---|---:|---|---|---:|
${outageRows.join('\n')}

監視のbaselineはexport前10秒、ダウンロード後は5秒継続した。生成開始前から継続中だったリクエストも生成区間の集計に含めている。HTTP失敗とtimeoutを記録し、最大同時実行数に達して発行できなかった回数はresults.jsonのprobeSchedulingへ残した。import先の同時監視は今回の対象に含めていない。

## 条件と解釈の限界

- Authrimの実スキーマ・実データではなく、整数主キー・テナントとemailの一意制約・テナント/status/更新日時の複合インデックスを持つ合成アカウントテーブル。各行に1,024バイトのランダム16進TEXTを格納した。16進TEXTのエントロピーは1バイトあたり4bitで、任意の実データの圧縮率を再現するものではない。
- D1配置hintはapac。観測した主系D1のcoloは対象DBが${observedColos('source', 'databaseColos')}、比較用が${observedColos('control', 'databaseColos')}、監視Workerは${observedColos('source', 'workerColos')}。実行環境のネットワーク速度はダウンロード・アップロードに影響する。
- Wrangler 4.148.0と同じ公式export/import APIプロトコルを使い、各段階を分けた。CLIの起動・認証・DB名解決の時間は含まない。継続pollの間に250ms待機し、その待機とAPI往復も観測時間に含むため、Wrangler CLIと厳密に同じ条件での測定ではない。
- DB保存容量とSQLダンプ容量を別々に記録した。インデックスはSQLで再構築されるため、保存容量とダンプ容量は一致しない。
- ダンプをダウンロードしながらSHA-256とMD5を計算し、アップロード先のETagとMD5の一致を確認した。復元後は件数・ID/更新日時/ペイロード長の集計と先頭末尾計6行の全カラムを照合し、PRAGMA quick_checkを実行した。全行の内容を暗号学的に照合したものではない。
- R2の世代バックアップ保存、R2からの再取得、Lookupの切り替え、Authrimのログイン再開は今回測っていない。ここで示す復元時間だけで障害復旧全体の時間は決まらない。
- 大容量の各1回の結果には、日・時間帯・配置・キャッシュ状態のばらつきを評価できるだけの反復がない。

専用リソースの削除状態はローカルのruns/内journalへ記録した。再現方法は[README](README.md)、数値の詳細は[results.json](results.json)。

公式仕様: [export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)、[import API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/)、[import/exportの制約](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。
`;
await writeFile(path.join(directory, 'RESULTS.md'), report);
await writeFile(path.join(directory, 'outages.json'), `${JSON.stringify(outages, null, 2)}\n`);
process.stdout.write(`${path.join(directory, 'RESULTS.md')}\n`);

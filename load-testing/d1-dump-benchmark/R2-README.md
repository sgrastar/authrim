# Authrim core D1のR2バックアップとSQL分割復元

Authrimの現行core shardと合成データを使い、SQLバックアップを専用の非公開R2へ保存する。毎回空のD1へ復元し、別のcontrol D1の読み書きが続くかを測る。

100MiB条件では、公式exportで取得したraw SQLをそのまま一括importすると`D1_RESET_DO`で失敗した。raw SQLをR2へ保持し、各ファイルへFK用PRAGMAを追加してSQL文の境界で分割した復元用ファイルを作る。以後の成功結果は、この加工・分割を含む方式で測定する。エラーの根因は断定しない。

加工後の100MiBファイルは取り込みとfingerprintの照合に成功した。ただし、末尾に`PRAGMA foreign_keys=ON;`があるにもかかわらず、取り込み完了後のREST APIと新D1 bindingで`foreign_keys=0`が60秒継続した試行があった。REST queryのONでも直後に有効化できないことを観測した。後から1になった試行の原因は特定していない。

別の新規専用DBでは、OFFだけを設定する小さなimportの後に0、ONだけを設定する小さなimportの直後に1を確認した。保存済みのテスト行は両方のimport後も保持された。この診断DBは削除済み。以後の復元手順では、データファイルの後にFK再有効化専用ファイルを独立してimportし、制約の状態を確認する。

この方式で100MiBの取り込み後にREST APIとbindingの双方で1を3回連続確認し、fingerprintの一致と全197テーブルのFK検査に成功した。その後、DB全体の`PRAGMA quick_check`は`SQLITE_NOMEM`で停止した。以後は全テーブルと`sqlite_schema`を個別に検査する。個別検査の成功をDB全体の`quick_check`成功とは扱わない。

5GiBの条件では、rawバックアップ、復元用ファイルとmanifestの確認後に、この検証で新規作成したsource D1を削除する。その後はR2のSQLと保存済みfingerprintを使い、新D1への復元を確認する。既存のAuthrim環境やユーザーデータは使用しない。

最終的に5試行すべてで復元後の検証を完了した。5GiBでは初期7ファイルだけで復元を完了できず、失敗後にR2内で末尾を再分割した。最初の5ファイルと追加65ファイルの計70ファイルで、source削除後の復元に成功した。初期backup・準備の27分1秒に、この復旧中の追加準備95.54秒は含めない。追加準備と最後の再配備を含む復旧処理は32分6秒、失敗と診断待ちを含む総経過は52分38秒だった。

## データとスキーマ

`authrim-fixture.mjs`は`migrations/release-manifest.draft.json`に記載されたcore-d1のSQLをchecksum付きで読み込み、ローカルのSQLiteで適用する。その最終schemaと初期データを、新しいD1向けに出力する。migrationのtable rebuildを本番環境へ実行する処理ではない。

初期環境の構築では、約285KBのschemaを一括importすると`D1_RESET_DO`で失敗したため、REST APIの25回のbatchに分けて適用し、初期化に成功した。エラーの根因は特定していない。この分割は測定用sourceの初期構築に使う。バックアップと復元は引き続き、公式export/import APIを使って測定する。

作成時の構成はAuthrim 0.4.2の19個のcore migrationで、bench_probeを含む197テーブル、672インデックス、84trigger。実際に使用したファイルとchecksum、構成の件数は測定結果のprofileへ残す。後日schemaが変わった場合は、その記録を優先する。

主な合成データは`users_core`、`identity_subjects`、`identity_accounts`、`subject_account_links`、`passkeys`、`role_assignments`、`oauth_client_consents`、`sessions`、`user_token_families`に格納する。3つの関連テーブルには既存triggerがデータを追加する。3つのmetadata_jsonへ、1アカウント当たり各768文字のランダム16進値を入れる。PIIは別DBを指す設定だけを持たせ、PII DBは作成しない。

passkeyやtokenは保存構造を再現する合成値で、実際の認証には使えない。実運用の行数配分や圧縮率を再現したものではない。任意の文字列へ比べ、16進値のエントロピーは1バイト当たり4bitになる。

## 転送と復旧の手順

Mac上の`r2-run.mjs`がD1の公式REST APIを操作する。API tokenとOAuth資格情報はMacだけで扱う。認証済みWorkerへ渡すのは、一時的な署名付きURLとその試行の識別子で、URLは結果へ保存しない。

1. sourceを目的の容量まで拡張し、schemaとデータのfingerprintを保存する。
2. exportを開始して完了までpollする。
3. Workerがraw SQLを取得し、8MiBずつmultipartでown R2へ保存する。全体のMD5、SHA-256、サイズを計算する。
4. raw objectをHEADで確認し、hashとサイズをmanifestへ保存する。
5. Workerの`/prepare-restore`がraw objectを読み、SQL文の境界で約1GiBずつ分割する。データファイルの先頭へ`PRAGMA foreign_keys=OFF;`、末尾へ`PRAGMA foreign_keys=ON;`を追加する。さらに`PRAGMA foreign_keys=ON;`と`SELECT 1;`だけの小さな専用ファイルを最後に追加し、`kind: 'foreign-key-finalizer'`を付ける。サイズ、両hash、順序をmanifestへ記録し、raw objectも保持する。
6. 初期の復元用ファイルとmanifestを確認し、最後の5GiB条件だけ専用source D1を削除する。この段階で5GiBの最終的な復元手順まで実証できていたわけではなく、後述の追加準備が必要になった。
7. 空D1を作り、WorkerのRESTORE bindingを設定する。
8. ファイルごとにimportを初期化し、Workerがown R2から一時PUTへ転送する。サイズと両hash、PUT先のETagを照合する。
9. Macがingestとpollを行い、データファイルを順番に取り込み、最後にFK再有効化専用ファイルを独立したimportとして取り込む。
10. 最大60秒の間にREST APIと新D1 bindingの双方で`foreign_keys=1`を3回連続で確認してから、全テーブルのFK検査、schema、件数、集計、サンプル、参照関係を確認する。`quick_check`は全テーブルと`sqlite_schema`に対して個別に実行し、12文ずつのbatchで確認する。最後に新bindingで読み書きを確認する。

ダンプ本体はMacを経由せずCloudflare内で転送し、API制御・進捗・少量の照合用サンプルはMacで扱う。fingerprint用SELECTで照合対象テーブルの先頭・末尾の行サンプルを取得し、Mac上でSHAを計算する。`dumpBytesThroughMac=0`はダンプ本体が対象で、照合用サンプルの転送を含まない。MacからのAPI通信、照合、Workerの配備・進捗取得にかかる時間は、該当する観測値に含まれる。

別control D1へのPK検索と更新は、事前のbaselineから復旧後の確認まで続ける。sourceのexport中の失敗、R2保存・復元準備中の回復、復旧中のcontrolの成否を分けて記録する。

## 実行

これは測定環境と試行結果を残すためのharnessで、無人運用向けの復旧ツールではない。既定の実行は最初の分割方式を再現し、今回と同様に5GiBの末尾で停止する可能性がある。未完了のimportに対する`--resume`だけでは新しい復元先D1を作り、同じ失敗を繰り返す場合がある。

今回使った`--resume-import --split-restore-tail`は、復元先が完了済みファイルのSQL境界へ戻っていることを読み取りで検証し、有効なcheckpointを記録した後の専用手順である。引数だけで任意の失敗状態から安全に再開できるものではない。今回の`user_token_families=788201`、`users_core`未作成、明示index・trigger未作成という境界はこの試行だけの値で、ほかのデータへ流用しない。

リポジトリの`authrim`ディレクトリで、既存のWranglerとNode.jsを使用する。資格情報は`CLOUDFLARE_API_TOKEN`、またはWranglerの保存済みOAuthを読み込む。OAuthは期限到達時にWranglerで更新する。

```sh
node load-testing/d1-dump-benchmark/r2-run.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID"
```

既定の目標サイズは100MiB、1GiB、5GiB。100MiBを3回、1GiBと5GiBを各1回測る。D1実サイズは目標を少し超えることがある。復元先は毎回新規作成する。

```sh
# 小さい条件だけ測る
node load-testing/d1-dump-benchmark/r2-run.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" --sizes 100 --repeats 1

# journalに記録されたrunを再開する
node load-testing/d1-dump-benchmark/r2-run.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" --resume RUN_ID

# 完了後も検証用リソースを保持する
node load-testing/d1-dump-benchmark/r2-run.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" --keep-resources
```

run IDは実行ログへ表示する。`runs/RUN_ID/resources.json`にリソースと処理段階を記録し、完了した試行は再開時に省略する。import完了時にもcheckpointを残し、専用の復元先が存在する場合は、再開時に同じD1の検証から続ける。失敗した試行も結果へ残し、成功結果の平均には含めない。

完了時は専用D1、Worker、R2のraw SQL、復元用ファイルとmanifest、専用bucketを削除する。`--keep-resources`を付けた場合は保持する。既存リソースを削除対象として渡す手順は用意していない。

```sh
# 保持した専用リソースをjournalに従って削除する
node load-testing/d1-dump-benchmark/r2-run.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" --resume RUN_ID --cleanup
```

## 結果の生成

`r2-results.json`を入力に、クラウドへ接続せずMarkdownを生成する。未完了の値は推測せず、成功結果と分けて表示する。

```sh
# 全試行の完了と専用リソースの削除後に、保存済みprobeを監査する
node load-testing/d1-dump-benchmark/r2-audit.mjs \
  --input-results load-testing/d1-dump-benchmark/r2-results.json \
  --run-dir load-testing/d1-dump-benchmark/runs/RUN_ID \
  --output-results load-testing/d1-dump-benchmark/r2-results.json

# 監査済みJSONからレポートを生成する
node load-testing/d1-dump-benchmark/r2-report.mjs

# 別の保存済み結果から生成する場合
node load-testing/d1-dump-benchmark/r2-report.mjs /absolute/input.json /absolute/report.md
```

既定の出力は`R2-RESULTS.md`と`R2-RESULTS.csv`。Markdownの出力先を指定した場合、CSVは同じ場所へ同じbasenameで保存する。第3のパス引数でCSV出力先も指定できる。元のJSONには個別試行、profile、hash、probeの集計を残す。小規模の3回は平均と個別値を併記し、大容量の各1回はその実測値を示す。小規模データから5GiBの時間を外挿しない。

CSVは1試行1行で、容量はbyte、時間はmsの原数値を出力する。importと復旧の計時方式、最初の復旧開始、復旧総経過、再開時の完了ファイル数、初期・追加・実使用のファイル数、追加準備時間と確認結果を記録する。`importPartsJson`と`importFailuresJson`列には、part別の成功時間と失敗履歴をJSONとして残す。欠けている時間は空欄とし、成功した値を補間しない。連続実測の復旧総経過は復旧処理時間と同じ値になる。詳しいcheckpoint検証、hash、probe、過去試行の原本は`r2-results.json`を参照する。

`RUN_ID`には実行したrun IDを指定する。`r2-audit.mjs`は保存済み結果、journal、NDJSONだけを読み、クラウド操作は行わない。上のコマンドでは元の結果JSONへ監査集計を追加して保存する。全試行の検証と後片付けが完了していない場合や、記録されたprobeファイルを読めない場合は停止する。`--keep-resources`で保持した場合は、先に`--resume RUN_ID --cleanup`を実行する。

監査では失敗試行、再試行、復元準備を含む全probeファイルを読み、同じ観測の重複を除いて`probeAudit`へ集計する。`controlRead`と`controlWrite`に件数、失敗、timeout、成功分のp50・p95、失敗も含む最大時間を保存する。`workerColos`、`d1Colos`、`d1Regions`はprobe応答で観測した配置の集合。`cleanupSummary`には作成・削除したD1数、Workerとbucketの削除状態、削除処理を確認した対象key数、完了日時を残す。対象keyには未作成の予約keyも含み、実object数とは異なる。

各条件の`allTrialsProbes`も、その条件で記録した失敗と再試行を含む。`probeCoverage`には記録ファイル数、重複除外後の観測数と集計範囲を記録する。初回に復元準備の区間が欠けている場合は、`backupFinishedAtMs - restorePreparationMs`で最後の準備区間を推定し、そこに重なる実際の観測を集計する。リクエストや結果の空白を補間する処理ではない。

初回の`probes.recovery`は、最後に再開した検証だけを含む。元のD1作成やimport、以前の失敗処理は`allTrialsProbes`と`probeAudit`へ含め、最後の復旧区間の統計へ混ぜない。ほかの条件でも、最後の復旧区間と全記録の集計を分けて読む。監視していない時間を含めてcontrol D1が無停止だったと保証するものではない。

5GiBの最後の`probes.recovery`は、追加分割したファイルの取り込みと検証を含む。復旧中の追加準備は`probes.recoveryPrepare`へ別に記録する。この追加準備中のsource readは105件すべて失敗したが、削除済みsourceへの監視が残っていた結果で、新しい復元先やcontrol D1の障害を示さない。同区間のcontrolはread・writeとも105件で失敗0だった。

## 時間の定義

| 記録項目                        | 含む処理                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| exportApiMs                     | export開始から完了応答まで。通信とpollを含む                                                                                               |
| backup.totalMs                  | Workerでraw SQLを取得し、own R2へ保存してobjectとmanifestを確認するまで                                                                    |
| rawBackupTotalMs                | SQL生成からraw SQLのR2保存・確認まで                                                                                                       |
| restorePreparation.totalMs      | Workerでraw SQLを読み、FK用PRAGMAを付加して分割ファイルとmanifestを作るまで                                                                |
| restorePreparationMs            | 復元用ファイルの準備をMacから観測した時間                                                                                                  |
| backupTotalMs                   | rawBackupTotalMsと最初のrestorePreparationMsの合計。初期backup・準備の時間で、再開待ちと復旧中の追加加工は除く                             |
| restoreTailPreparation          | 元の失敗ファイルをデータ・index・triggerなどに再分割した追加manifestとファイル群                                                           |
| restoreTailPreparationMs        | 復旧失敗後に行った追加準備。元のbackupTotalMsへは加算せず、復旧時間へ含める                                                                |
| restoreTailBasePartCount        | 再構成前のファイル群から保持した先頭ファイル数。5GiBでは5                                                                                  |
| restoreTailPreparationConfirmed | 追加したファイルとmanifestの確認結果                                                                                                       |
| recoveryRemediationMs           | 追加準備と最後のWorker再配備の合計。成功段階を合算した復旧処理時間の内数                                                                   |
| databaseCreateMs                | 空D1の作成                                                                                                                                 |
| workerDeployMs                  | RESTORE bindingを設定したWorkerの配備                                                                                                      |
| importParts                     | データとFK再有効化専用ファイルのkind、初期化、転送、取り込み時間とupload再利用の記録                                                       |
| restoreUpload.totalMs           | 全ファイルのown R2読込、一時PUT、転送内容の照合の合計                                                                                      |
| ingestObservedMs                | 全ファイルのD1取り込み開始から完了応答までの合計                                                                                           |
| importTotalMs                   | 全ファイルのimport初期化、一時PUTへの転送、SQL取り込みの合計                                                                               |
| importTimingMode                | sum successful part stages after resumeは、完了済みpartと再開後に成功したpartの処理時間を1回ずつ合算した値                                 |
| importFailures                  | 失敗したpart番号、エラー、poll回数、記録済み処理時間、失敗日時、初期化と転送の記録                                                         |
| importResumeCheckpoint          | 再開前に確認した完了part数と、そのSQL境界での件数・schema検証                                                                              |
| foreignKeyEnableMs              | 最後のFK再有効化専用ファイルのimportTotalMs。全体のimportTotalMsの内数で、別途加算しない                                                   |
| foreignKeyReadiness             | REST APIと新bindingの双方で1を3回連続確認するまでのdurationMsと、経過時間・両値のsamples                                                   |
| verificationMs                  | FK状態の確認待ち、復元したschema・データ・FK整合性、テーブル別quick_checkなどの検証                                                        |
| fingerprintQueryStrategy        | 100MiBと1GiBはlegacy-v1。5GiBはpk-range-v2-outbox-global。同じ検証内容を異なるSQL実行方式で照合する                                        |
| recoveryTotalMs                 | 新D1作成、binding配備、全ファイルのimport、FK制約の再有効化と確認待ち、検証、新bindingでの読み書き確認。source削除時は削除と不在確認も含む |
| rawImportFailure                | 無加工のraw SQLを一括importして失敗したときのエラーと、記録済みの段階別時間                                                                |
| previousRecoveryAttempts        | 同じバックアップから再開する前の失敗理由、import時間、FK確認待ちと観測値                                                                   |
| quickCheckMode                  | テーブル別とsqlite_schemaの個別検査であり、DB全体のページ割当検査を含まないことを記録                                                      |
| quickCheckTablesChecked         | 個別quick_checkで確認した対象数。現行schemaでは197テーブルとsqlite_schemaの計198                                                           |
| fullQuickCheckError             | DB全体のquick_checkが失敗した場合のエラー。個別検査成功後も保持                                                                            |
| recoveryTimingMode              | continuous wall clockは連続実測。sum completed provisioning/import/verification stages after resumeは再開後の完了段階の合算                |
| recoveryOriginalStartedAtMs     | 最初に復旧を始めた時刻。再開時にも上書きしないepoch ms                                                                                     |
| recoveryWallTotalMs             | 最初の復旧開始から最終検証完了までの実総経過。失敗したpart、中断、診断、再配備の待ち時間も含む                                             |

初期の復元用ファイルを作る時間はbackup側へ含め、5GiBの失敗後の追加準備はrecovery側へ記録する。実使用ファイル数と転送量、import合計には最後のFK再有効化専用ファイルも含む。その専用importの時間を`foreignKeyEnableMs`へ取り出して表示するが、合計へ二重に加算しない。raw importの失敗は別条件の観測として残し、加工・分割後の成功時間へ加算しない。

SQL生成の観測時間にはAPI往復があるため、DBの厳密な連続停止時間とは一致しない。probeは一定間隔で発行するので、短い停止を見逃す可能性がある。区間をまたぐリクエストを複数区間へ含める場合があり、区間の件数を合算して総件数としない。

連続実測の復旧時間は、一連の処理の開始から検証完了までの経過時間になる。import完了後に検証から再開した場合は、元のD1作成、binding配備、importと、最後に成功した検証の時間を合算する。source削除があればその時間も含める。この合算には中断していた時間や失敗した検証を含めないため、障害発生からの連続した経過時間とは区別する。100MiBの初回はこの方式で検証を再開した。結果に`recoveryTimingMode`を記録し、平均表にも計時方式の内訳を表示する。

再開前のエラー、import時間、FK確認待ちの観測値は`previousRecoveryAttempts`へ残し、成功した最後の復旧時間へ二重に加算しない。60秒の確認待ちで打ち切った試行も失敗として表示する。

取り込み済みのD1で検証だけを再開した際の失敗理由は`previousVerificationErrors`へ記録する。これはimportを繰り返した回数や時間を示す記録ではない。

5GiBの初回復元では、データファイル1〜5の取り込みが完了した後、6番目が`Cancelled due to no poll() received in 15000ms`で失敗した。pollは64回行っており、1回の応答に約35秒かかった観測もある。D1が示したキャンセル理由とクライアントのpoll実行記録をそのまま残し、pollを実行していなかったとは解釈しない。R2のバックアップを保持し、復元先の件数とschemaを5番目までのSQL境界に照合してから、同じ専用D1の6番目を再開する。

その再試行もpoll通信の12回連続タイムアウトで停止した。2回目についてはnative importの終了状態を取得できていない。再度、復元先が5番目までのSQL境界と一致することを確認し、R2内の元の6番目だけを再処理した。残りデータを1ファイル、データあり表の29 indexを各1ファイル、空表のindexを最大16個ずつの28ファイル、triggerを最大16個ずつの6ファイル、FK再有効化を1ファイルとし、計65ファイルを追加した。元の5ファイルと合わせた70ファイルで取り込みと検証を完了した。元の6番目と元のFK専用ファイルは、成功したimport合計には含めない。

この追加準備は95.54秒、最後の再配備も含む復旧対処は100.48秒だった。初期7ファイルを作った時点を、5GiBの復元手順が完成した時点とは扱わない。成功段階のimport合計は28分49秒、復旧処理は32分6秒、実総経過は52分38秒。CSVとJSONでは丸める前のms値を残す。

分割importを再開した場合は、成功した各ファイルの取り込み時間を1回ずつ合算した値と、最初の復旧開始からの実際の総経過時間を分ける。前者はキャンセルされた処理、中断、診断待ちを除く。後者にはそれらも含むため、利用者が復旧を待つ時間として読む場合は総経過時間を使う。完了前の試行を成功した復旧時間として掲載しない。

5GiBの事前fingerprintで繰り返したretryは、検証クエリのCPU超過が原因だった。HTTP 429・code 7429のCPU上限超過とDBリセットを確認した。EXPLAINでは12照合テーブルのうち10表がtenant_idのindexを選び、1万行の範囲を照合するたびにtenant全体の829,500行を走査していた。API全般の不安定さを原因とは扱わない。

100MiBと1GiBの照合SQLは`legacy-v1`、5GiBは9表へのPK index指定とoutboxの全範囲集計を使う`pk-range-v2-outbox-global`とし、`fingerprintQueryStrategy`へ記録する。DB・schema・index自体は変更せず、集計とhashの意味、サンプル境界も維持する。SQL生成とraw保存は容量別に比較できるが、5GiBのimportはDDL追加分割でファイル数も変わった。`verificationMs`と復旧全体には照合SQLの実装差も含むため、取り込み時間やRTOを単純な容量比例として比較しない。

## 制約と確認できる範囲

D1 exportは実行中のDBへのほかのリクエストを停止する。importも取り込み先のDBを停止する。取り込み先には空の専用D1を使う。SQLファイルは1つ当たり5GiBまでで、公式資料も超過時の複数ファイルへの分割を案内している。D1の保存容量とSQL量は一致しないため、raw SQLが5GiBを超えてもown R2へのmultipart保存は許容し、importするファイルを上限内へ分割する。[D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)、[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)

SQL文の境界判定では、引用符、コメント、trigger内の文を維持する。単純なセミコロン分割は使わない。データファイルの取り込み中はFK制約を無効にする。末尾のONだけで取り込み後の有効化を保証せず、最後にFK再有効化専用ファイルを独立してimportし、REST APIとbindingの双方で確認する。REST queryのONを有効化手段として使わない。この確認後、全テーブルへ`foreign_key_check`を実行する。`foreign_keys=1`は以後の制約の有効性を、`foreign_key_check`の空結果は既存データの参照整合性を確かめる別の検証である。

D1の公式資料では通常のqueryでFK制約を強制すると説明し、PRAGMAは現在のtransactionに適用するとしている。import末尾のONが次のqueryへ永続するとは仮定しない。今回のimport直後の0は観測事実として残し、公開資料で保証された挙動とは扱わない。[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)、[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[SQLite foreign keys](https://www.sqlite.org/foreignkeys.html)

複数ファイルをまたぐ復元全体の原子性はない。途中で失敗した空の復元先は利用者へ公開せず、すべての検証が終わってから使用可能と判断する。

DB全体の`quick_check`は100MiB条件でも`SQLITE_NOMEM`となったため、アプリケーションの全テーブルと`sqlite_schema`をそれぞれ検査する。結果の`quickCheck='ok'`はこの範囲の検査成功を示す。テーブル別では、異なるテーブル間のページ重複や未使用領域を検出できない。`sqlite_schema`の検査でfreelistも確認するが、DB全体のページ割当検査の代わりにはならない。`quick_check`自体もUNIQUE制約やindexとtableの内容一致を検査しない。全197テーブルのFK検査とfingerprint照合は別に実行する。[SQLite integrity_check](https://www.sqlite.org/pragma.html#pragma_integrity_check)、[SQLite quick_check](https://www.sqlite.org/pragma.html#pragma_quick_check)

own R2には8MiBのmultipartで保存する。multipartの完成ETagは全体MD5ではないため、D1 import用のMD5はmanifestに別保存する。raw SQLと加工後の各ファイルではサイズとhashが変わる。PRAGMAを付加したバイトも含めてhashを計算し、そのファイルのMD5をimportへ渡す。Workerから一時PUTへ送る際はFixedLengthStreamを使う。Workersは手書きのContent-Lengthを無視するため、body自体を固定長にする。[R2 multipart](https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload-details)、[Content-Length](https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header)

転送Workerは全量をメモリへ保持しない。HTTP接続を維持し、NDJSONで進捗を返す。HTTP 200だけでは成功とせず、最後のsuccess frameを確認する。CPU時間上限はPaidで最大300,000msに設定できる。HTTPの経過時間に固定上限はないが、接続切断やruntime更新で中断される場合がある。途中の結果を確認せずに復元成功とは扱わない。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Node.js crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)

この試験では、単一core D1のR2保存と新D1への復元、別control D1のI/O継続を確認する。Authrimの認証プロトコル、Lookup切替、全writerの停止、自動failover、Cloudflare全体の障害は検証しない。大容量の各1回では、時間帯や配置によるばらつきも評価できない。

RPO（失われ得る更新の範囲）は評価しない。照合対象のsourceデータは投入後の更新を止め、確認済みバックアップから復元する。監視用の更新は別control D1へ送る。最後のバックアップ後もsourceへの書き込みを続けた場合の更新損失や、差分の回収を試験していないため、RPOが0であるとは結論できない。

fingerprintはschema、件数、範囲集計、参照関係と先頭・末尾の行サンプルのhashを照合する。全行・全カラムの暗号学的な一致検証ではない。また複数クエリを1つのsnapshotで実行していないため、更新を止めた合成データを前提とする。SQLファイル全体のhashは転送内容の一致を確認するもので、復元DBの全行一致を証明するものではない。

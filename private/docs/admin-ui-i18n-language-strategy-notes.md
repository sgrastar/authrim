---
project: Authrim
lang: ja
date: 2026-06-03
description: "Admin UI/ログインUIの多言語対応についての会話メモ。日本語化、追加言語候補、OSS採用されやすい国、Keycloakテーマ文化の整理。"
type: notes
tags:
  - authrim
  - internal-docs
  - admin-ui
  - login-ui
  - i18n
  - localization
  - oss
  - language-strategy
---
# Admin UI / Login UI 多言語対応 会話メモ

## 背景

現在のAuthrim Admin UIは英語中心だが、来週のNII/学認イベントに向けて日本語化したい。
Login UIは現状 `en` / `ja` 対応。

日本語化の目的は、単にUIを翻訳することではなく、将来の多言語対応の土台を作ること。
Consent文面の多言語対応もあり、Admin UI、Login UI、同意文、メール文面をどう分けるかが重要。

## 最初の追加言語候補

最初の議論では、日本語の次に追加するなら何がよいかを検討した。

候補:

- `zh-CN`: アジア圏での到達範囲が大きい。中国本土を狙う場合は法務、Cloudflare到達性、サポート期待が重い。
- `ko`: 近いアジア市場、CJK UI検証、セキュリティ/IAM感度のある層に合う。
- `id`: 東南アジア成長枠。価格感度と軽量構成との相性がよい。
- `es`: グローバル到達範囲は大きいが、アジア発の文脈からは少し外れる。

初期判断では `zh-CN` を市場規模で推したが、その後「Authrimはアジア発」という文脈から、`ko`、`id`、`zh-TW` の優先度を上げる方が自然という話になった。

## setupツールの対応言語

setupツール側は既に以下のlocaleを持っている。

- `en`
- `ja`
- `zh-CN`
- `zh-TW`
- `es`
- `pt`
- `fr`
- `de`
- `ko`
- `ru`
- `id`

Admin UIは別実装で、確認時点では `en` / `ja` の辞書が存在するが、Admin画面の多くはまだ直書き英語が残っている前提。

setupで対応済みの言語をそのままAdmin UIに持ってくるのは実装上は自然だが、Admin UIはログインUIより利用者が限定されるため、最初から多数言語を正式対応する必要は薄い。

## Okta / Auth0 / Keycloak / Ory の傾向

競合・類似プロダクトの傾向として、管理画面とユーザー向けログイン画面では多言語対応の広さが違う。

| 製品 | 管理画面 | ログイン/ユーザー向け画面 | 傾向 |
|---|---|---|---|
| Okta | 英語・日本語中心 | 約29言語 | Admin UIはかなり絞っている |
| Auth0 | 管理画面の広い多言語対応は前面に出ていない | Universal Loginはかなり広い | ユーザー向け画面を広くローカライズ |
| Keycloak | テーマ/メッセージで拡張可能 | 標準message bundle + themeで拡張 | OSSらしく利用者がthemeで調整 |
| Ory | headless/API/Components寄り | カスタムUI前提 | 多言語は実装者側で持つ温度感 |

OktaがAdmin Consoleに日本語を入れた理由は、日本法人設立と日本市場への明確な投資が背景にあると見られる。
AuthrimもNII/学認イベントという明確な日本語化理由があるため、`en` / `ja` のAdmin UIは十分説明しやすい。

参考:

- [Okta supported display languages](https://help.okta.com/en-us/Content/Topics/Reference/ref-supported-languages.htm)
- [Auth0 Universal Login Internationalization](https://auth0.com/docs/customize/internationalization-and-localization/universal-login-internationalization)
- [Keycloak themes](https://www.keycloak.org/ui-customization/themes)
- [Keycloak Server Admin Guide localization](https://www.keycloak.org/docs/latest/server_admin/)
- [Ory Elements](https://github.com/ory/elements)

## ドイツ語とQA用途

ドイツ語 `de` は正式対応理由としては少し硬いが、QA用途ではかなり有用。

理由:

- ラベルが長くなりやすい。
- 複合語が長く、ボタン、タブ、テーブルヘッダーの崩れを見つけやすい。
- セキュリティ/IAM、プライバシー、OSS文脈ではドイツ市場との相性もある。

ただし、最初は正式対応ではなく、QA用localeまたは疑似ロケールとして扱うのがよい。

その他のQA向き言語:

| 目的 | 言語 | 見つけやすい問題 |
|---|---|---|
| 長いラベル | `de` | ボタン、タブ、表ヘッダーの崩れ |
| さらに長い単語 | `fi`, `hu` | 折り返し、横幅不足 |
| アクセント/行高 | `vi` | 声調記号、上下クリップ、検索正規化 |
| 大小文字変換 | `tr` | `I`, `İ`, `ı`, `i` 問題 |
| RTL | `ar`, `he` | レイアウト方向、アイコン位置、数値/URL混在 |
| 分かち書きなし | `th` | 改行、入力、検索 |
| CJK幅 | `ja`, `zh-CN`, `ko` | 全角幅、行高、フォントfallback |

実用的なQAセット:

- `de`
- `vi`
- `tr`
- `ar`
- `th`

疑似ロケール:

- `en-XA`: 英語を長くし、アクセントを混ぜる。
- `ar-XB`: RTL風に反転・方向制御を入れる。

## Admin UI日本語化チェックリスト

会話の途中で、専用チェックリストを作成した。

作成ファイル:

- [admin-ui-ja-i18n-checklist.md](/Users/yuta/Documents/Authrim/authrim/private/docs/admin-ui-ja-i18n-checklist.md)

内容:

- 目的
- 現状メモ
- 対象/対象外
- 正式対応言語方針
- 翻訳しないプロトコル用語
- 日本語の文体
- 用語集
- P0/P1/P2の実装タスク
- 翻訳チェックリスト
- レイアウトチェックリスト
- テスト・検証タスク
- 完了条件

イベント前のP0は、SAML/OIDC/Consent/Client/User/Settingsなど、NII/学認イベントで見られやすい導線に寄せた。

## 「なぜ韓国語？」について

途中で「koの導入理由なんて、別にいらない。私のプロジェクトだから」という話になった。

結論:

- 外向きの説明責任が必要な時だけ理由を用意すればよい。
- 内向きには「入れたいから」で十分。
- `ko` は近いアジア市場、CJK 2言語目、セキュリティ/IAM文脈として普通に筋がよい。

外向きに言うなら:

> アジア圏での利用検証とCJK UI品質向上のため。

内向きには:

> Authrimは自分のプロジェクトなので、入れたい言語を入れる。

## OSSで使ってくれそうな国

市場規模だけでなく、以下を重視した。

- OSSを読む/直す/issueを出す文化
- コスト意識
- Auth0/Oktaが高すぎると感じる層
- セルフホストや自前運用を許容する文化
- IAM/SAML/OIDC需要
- Cloudflare Workersの低運用コストが刺さるか

Authrimを使ってくれそうな国ランキング:

| 順位 | 国/地域 | 言語 | Authrim適性 | コメント |
|---:|---|---|---|---|
| 1 | 日本 | `ja` | 非常に高い | 学認/NII、大学、研究機関、中小SaaSに刺さる |
| 2 | インド | `en` / `hi` | 非常に高い | 開発者数、コスト意識、SaaS/内製文化が強い。UIは英語で届きやすい |
| 3 | ブラジル | `pt-BR` | 高い | OSS利用、価格感度、コミュニティ反応のバランスがよい |
| 4 | インドネシア | `id` | 高い | 成長市場、コスト意識、Cloudflare的な軽量構成と相性がよい |
| 5 | 韓国 | `ko` | 高い | セキュリティ/IAM需要、大学・企業IT、CJK UI検証に良い |
| 6 | 台湾 | `zh-TW` | 高い | OSS/open gov/技術コミュニティと相性がよい |
| 7 | ドイツ | `de` | 高い | OSS、プライバシー、IAM、自己運用文化が強い。ただし品質要求も高い |
| 8 | フランス | `fr` | 中〜高 | OSS/公共/デジタル主権文脈が強い |
| 9 | ポーランド | `pl` | 中〜高 | 技術者層が厚く、EU圏でコスト意識もある |
| 10 | メキシコ/LatAm | `es` | 中〜高 | 価格感度と市場規模がある |
| 11 | ベトナム | `vi` | 中〜高 | 開発者市場の伸び、コスト意識が強い |
| 12 | フィリピン | `en` | 中 | 英語で届くが、IAM OSSとしての初期反応は読みにくい |
| 13 | トルコ | `tr` | 中 | ローカル言語価値と価格感度は高い |
| 14 | 南アフリカ | `en` | 中 | OSS/公共/教育文脈はありうる |
| 15 | 中国 | `zh-CN` | 条件付き | 開発者規模は大きいが、Cloudflare/法務/運用/到達性の別問題が重い |

## 自言語でAdmin画面を触りたい国

自言語Admin UIの価値が高そうな順:

| 順位 | 国/地域 | 言語 | 理由 |
|---:|---|---|---|
| 1 | 日本 | `ja` | 英語UIの心理的負荷が高く、管理画面は日本語の価値が大きい |
| 2 | フランス | `fr` | 自国語志向が強く、公共/企業向けでも効きやすい |
| 3 | 中国 | `zh-CN` | ローカル言語前提が強い。ただしAuthrim/Cloudflareの事業相性は別判断 |
| 4 | 韓国 | `ko` | 技術者は英語も読むが、管理画面・設定画面は韓国語の価値がある |
| 5 | ブラジル | `pt-BR` | Portuguese UIの価値が高い |
| 6 | ドイツ | `de` | 英語は強いが、管理・監査・セキュリティ画面はドイツ語が好まれやすい |
| 7 | 台湾 | `zh-TW` | 管理UIは繁体字の安心感がある |
| 8 | スペイン/LatAm | `es` | 到達範囲が広く、自言語UIの価値も高い |
| 9 | イタリア | `it` | EU圏で自国語UIの価値が比較的高い |
| 10 | インドネシア | `id` | 普及を考えるなら効く |
| 11 | トルコ | `tr` | ローカル言語価値が高め |
| 12 | タイ/ベトナム | `th` / `vi` | UI/フォント/改行検証にも価値がある |

## Authrimらしい言語戦略

Authrimはアジア発なので、欧米SaaSの言語優先順位をそのまま真似しなくてよい。

Authrimらしい順番:

| 優先 | 言語 | 狙い |
|---:|---|---|
| 1 | `ja` | 日本発、NII/学認、国内大学・研究機関・SaaS |
| 2 | `ko` | 近いアジア市場、CJK、セキュリティ/IAM感度 |
| 3 | `id` | 東南アジア成長枠、価格感度、Cloudflare構成との相性 |
| 4 | `zh-TW` | 台湾OSS/open gov/技術コミュニティ |
| 5 | `pt-BR` | アジア外だがOSS反応と価格感度が強い |
| 6 | 英語 | インド向け。UI翻訳よりdocsやcheap self-hosting guideが効きそう |
| 7 | `vi` | ベトナム成長枠、QAにもよい |
| 8 | `th` | タイ語UIは差別化になるが、改行/フォントQAが必要 |

整理:

- 正式UI: `en`, `ja`, `ko`, `id`, `zh-TW`
- 外向けOSS反応狙い: `pt-BR` README/docs/setup
- インド狙い: 英語docs強化、cheap self-hosting guide、Keycloak/Auth0代替比較
- QA: `de`, `vi`, 疑似ロケール

## Keycloakのテーマ文化

Keycloakは「みんなが自言語版テーマを汎用配布している」というより、各組織が自組織用themeを作り、その中に必要な言語のmessage bundleを入れている実態に近い。

Keycloakのテーマ対象:

- Login theme
- Account theme
- Admin theme
- Email theme
- Welcome theme

テーマは以下で構成される。

- Freemarker templates
- images
- message bundles
- stylesheets
- scripts
- `theme.properties`

多言語化は `messages_ja.properties` や `messages_de.properties` のようなmessage bundleで行う。

実務で多そうな順:

1. 会社/大学/自治体のブランドテーマを作る
2. ログイン画面の文言を自組織向けに変える
3. 必要なlocaleの `messages_xx.properties` を足す
4. メール文面も同じ言語で調整する
5. Admin Consoleまではあまり触らない

Authrimへの示唆:

- Login UIはtheme/branding/tenant文言を強くする価値が高い。
- Admin UIは本体で `en` / `ja` を持つくらいでよい。
- Consent文面、メール文面、ログイン文面はtenantごとの多言語データとして持てる方がよい。
- 「themeファイルを書かないと文言変更できない」より、Admin UIからlocale別文言を編集できる方がAuthrimの差別化になる。

差別化メッセージ:

> Keycloakではテーマファイルで管理しがちなログイン/同意/メールの多言語文面を、AuthrimではAdmin UIからtenantごとに編集できる。

## 参考リンク

- [GitHub Octoverse 2024](https://github.blog/news-insights/octoverse/octoverse-2024/)
- [GitHub Innovation Graph](https://github.com/github/innovationgraph)
- [Cloudflare Radar](https://radar.cloudflare.com/adoption-and-usage)
- [CSA Research: Do B2B Buyers Value Localized Experiences?](https://csa-research.com/l/blog/article/do-b2b-buyers-value-localization)
- [CSA Research: Consumers Prefer their Own Language](https://csa-research.com/l/media/Consumers-Prefer-their-Own-Language)
- [Okta supported display languages](https://help.okta.com/en-us/Content/Topics/Reference/ref-supported-languages.htm)
- [Auth0 Universal Login Internationalization](https://auth0.com/docs/customize/internationalization-and-localization/universal-login-internationalization)
- [Keycloak themes](https://www.keycloak.org/ui-customization/themes)
- [Keycloak Server Admin Guide](https://www.keycloak.org/docs/latest/server_admin/)
- [Ory Elements](https://github.com/ory/elements)

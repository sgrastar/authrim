# Account Page and Account Screen Customization

## Status

- Internal product and implementation specification.
- The direction in this document reflects the product discussion as of 2026-07-22.
- The initial implementation is available in Admin UI, Management, and Login UI. Published custom
  pages are stored as `authrim.account_pages.v1` documents with resolved screen snapshots; legacy
  single-page settings remain read-compatible during migration.

## Goal

Admin UI から Login UI のアカウントページを編集できるようにする。

Authrim は、すぐに利用できるアカウントページと各アカウントスクリーンを組み込みプリセットとして提供する。管理者はそのプリセットを出発点として、必要なスクリーンだけを配置し、不要なスクリーンを外し、テナント固有の案内文を追加できる。

スクリーン内の機能は、入力フォーム、送信ボタン、ローディング、成功、エラー、空状態、確認、再認証を含む自己完結した Widget として提供する。管理者が処理に必要な部品を一つずつ組み立てなくても、安全で一貫したアカウント機能を構成できることを優先する。

アカウントページの外観は Login UI のテーマと連動させ、同じテーマトークン、アセット、レイアウト規則、ライト・ダークモードを使用する。

## Product Principles

1. **Preset-first**: 初期状態で完成したアカウントページを提供し、設定作業なしでも利用できる。
2. **Safe customization**: 組み込みプリセットを直接破壊せず、テナントの差分としてカスタマイズする。
3. **Widget-level composition**: 業務処理を自己完結した Widget にまとめ、送信ボタンやエラー表示を個別パーツにしない。
4. **Page-level freedom**: 管理者はスクリーンの追加、除外、並べ替え、表示幅、補足文言を編集できる。
5. **Theme consistency**: コンテンツ構成と外観を分離し、アカウントページにも Login UI の有効なテーマを適用する。
6. **Secure defaults**: 再認証、確認、検証、エラー処理などのセキュリティ挙動は Widget が所有し、編集によって欠落させない。
7. **Responsive by default**: デスクトップとモバイルの両方で、プリセットおよびカスタム構成が破綻しない。

## Terminology

| Term              | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| Account page      | Login UI に表示されるアカウント管理ページ全体。複数のスクリーンを順番に配置する。  |
| Account screen    | アカウントページに配置できる編集単位。原則として一つの主要 Account Widget を持つ。 |
| Account Widget    | ユーザー情報、Passkey、同意などの機能単位。フォーム、操作、状態表示を内包する。    |
| Supporting block  | 見出し、説明文、区切り線、リンクなど、Widget の前後に追加できる非機能パーツ。      |
| Built-in preset   | Authrim が提供する変更不可の基準定義。                                             |
| Custom definition | プリセットを基にテナントが変更したスクリーンまたはページ定義。                     |
| Published version | Login UI が実際に利用する、解決済みかつバージョン固定された定義。                  |

## Editing Model

編集機能は二段構成にする。

```text
Screen editor
  └─ Account screen = Account Widget + supporting blocks

Account page editor
  └─ Account page = ordered placement of account screens
```

### Screen editor

スクリーンごとの内容を編集する。

- 組み込みスクリーンプリセットからカスタムスクリーンを作成する。
- Account Widget の前後に見出し、説明文、注意事項、リンク、区切り線を追加する。
- Widget が公開する安全な表示オプションを変更する。
- 表示名、説明、プレースホルダーなど、Widget が許可する文言をロケールごとに上書きする。
- Widget 自体は一つの機能部品として扱い、内部の送信ボタンやエラー領域は分解しない。
- デスクトップとモバイルのプレビューを切り替える。

### Account page editor

完成済みのスクリーンを選び、アカウントページ全体を編集する。

- 組み込みアカウントページプリセットからカスタムページを作成する。
- 左側のスクリーン一覧からページへ追加する。
- ドラッグ＆ドロップで表示順を変更する。
- 不要なスクリーンをページから外す。スクリーン定義自体は削除しない。
- 各スクリーンの表示幅を設定する。
- 条件付き表示を設定する。
- テーマ、画面幅、ロケールを切り替えてプレビューする。
- 下書き保存、公開、以前の公開版へのロールバックを提供する。

## Preset and Customization Semantics

### Built-in presets

- Authrim が標準スクリーンと標準アカウントページを提供する。
- 組み込みプリセットは変更・削除不可とする。
- 新規テナントは標準アカウントページの公開済み定義を自動的に利用できる。
- プリセットにはスクリーンの推奨順序、表示幅、既定文言、条件付き表示を含める。

### Custom definitions

- 管理者が初めて変更するとき、プリセットを基にカスタム定義を作成する。
- カスタム定義は `base preset + explicit overrides` として管理する。
- ページからスクリーンを外す操作は、そのカスタムページの構成差分として保存する。
- 追加文言や文言上書きはロケール別の差分として保存する。
- スクリーン単位およびページ全体で「プリセットに戻す」を提供する。

### Preset updates

Authrim のアップデートで組み込みプリセットが変更されても、公開中のカスタムページを暗黙に変更しない。

- 公開時に解決済みのページ定義をバージョン固定する。
- 新しいプリセット版が利用可能になった場合は Admin UI で通知する。
- 管理者が差分を確認して明示的に取り込む。
- セキュリティ上必須のランタイム挙動はプリセットのコピーではなく Widget 実装側で保証する。

## Account Screen Presets

| Screen preset     | Proposed key              | Account Widget contents                                                                                 |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Account overview  | `account_overview`        | ページ案内、主要設定への導線、必要に応じたユーザー概要。                                                |
| Profile           | `account_profile`         | 現在の氏名・メール、確認済み表示、編集フォーム、保存、検証、成功・エラー。                              |
| Devices           | `account_devices`         | デバイス名、プラットフォーム、最終利用日時、現在のデバイス、空・エラー状態。                            |
| Sessions          | `account_sessions`        | セッション一覧、現在のセッション、開始日時、個別ログアウト、確認・エラー。                              |
| Passkeys          | `account_passkeys`        | Passkey 一覧、登録名入力、WebAuthn 登録、プロバイダー情報、最終利用日時、削除、未対応・空・エラー状態。 |
| Authenticator app | `account_totp`            | TOTP 一覧、登録名、QR コード、手動キー、確認コード、バックアップコード、再生成、削除。                  |
| Consents          | `account_consents`        | 文書への同意、サービスへの情報提供、詳細、件数、取り下げ、空・エラー状態。                              |
| Account activity  | `account_activity`        | ユーザー情報、Passkey、セッションなどの操作日時と内容、空・エラー状態。                                 |
| Social accounts   | `account_social_accounts` | 外部 IdP の連携一覧、連携・解除、処理結果。機能提供まではプリセットで非表示にできる。                   |
| Custom guidance   | `account_custom`          | 管理者が設定する案内文、リンク、補足情報。業務処理は持たない。                                          |

TOTP の登録、バックアップコード表示、再生成は同じ `account_totp` Widget の状態として扱う。同意一覧と同意詳細も同じ `account_consents` Widget に含める。これらを個別スクリーンへ細分化しない。

## Screen Editor Parts Palette

### Account Widgets

| Part                      | Proposed type                   | Behavior owned by the Widget                          |
| ------------------------- | ------------------------------- | ----------------------------------------------------- |
| User profile Widget       | `account_profile_widget`        | 表示、編集、送信、検証、保存中、成功、エラー。        |
| Device list Widget        | `account_device_list_widget`    | 一覧、現在表示、空、読み込み、エラー。                |
| Session management Widget | `account_session_widget`        | 一覧、終了操作、確認、処理中、成功、エラー。          |
| Passkey management Widget | `account_passkey_widget`        | 一覧、登録、削除、再認証、未対応、空、処理結果。      |
| Authenticator app Widget  | `account_totp_widget`           | TOTP 登録・一覧・削除、QR、確認、バックアップコード。 |
| Consent management Widget | `account_consent_widget`        | 一覧、詳細、取り下げ、確認、処理結果。                |
| Account activity Widget   | `account_activity_widget`       | 操作履歴、日時表示、空、読み込み、エラー。            |
| Social account Widget     | `account_social_account_widget` | 連携一覧、連携・解除、確認、処理結果。                |

### Supporting blocks

既存の汎用パーツを再利用し、必要に応じて次を利用可能にする。

- Layout row
- Heading
- Text
- Divider
- Link or guidance action
- Identity Schema field where a supported profile Widget extension requires it

### Parts intentionally not exposed

以下は左側の個別パーツとして公開しない。

- Submit, save, register, delete, withdraw, and logout buttons owned by a Widget
- Validation and API error messages
- Success messages
- Loading indicators
- Empty states
- Confirmation dialogs
- Reauthentication dialogs and method selection
- WebAuthn, TOTP, session, and consent request orchestration

これらは Widget の状態遷移と密接に結び付いている。分離すると、不完全なフォーム、送信不能な画面、エラーの欠落、再認証の回避などが発生し得るため、Widget 内部の固定責務とする。

## Widget Customization Boundary

管理者が変更できるものと、Widget が保証するものを明確に分ける。

| Customizable                                   | Widget-owned                                     |
| ---------------------------------------------- | ------------------------------------------------ |
| スクリーンタイトル、説明、補足文               | API 呼び出しとデータ整合性                       |
| Widget の前後に置く Supporting block           | 入力検証の最低要件                               |
| 許可されたラベル、プレースホルダー、空状態文言 | 送信、削除、取り下げなどの操作手順               |
| スクリーンの順序、表示幅、表示・非表示         | ローディング、成功、エラー状態の発生条件         |
| 機能フラグに基づく条件付き表示                 | 再認証、確認、WebAuthn/TOTP のセキュリティ処理   |
| テーマから提供される表示バリエーション         | アクセシビリティに必要な関連付けとフォーカス制御 |

ボタン文言などを上書き可能にする場合も、意味を変えない専用 localization key として公開する。任意のボタンを削除したり、別の処理へ接続したりする機能は提供しない。

## Account Page Layout

初期実装では複雑な自由配置ではなく、レスポンシブなグリッドとして扱う。

- スクリーンの順序は一次元の並び順として保存する。
- 表示幅は `full`、`half` を基本とする。
- モバイルではすべて一列に折りたたむ。
- Widget 内部の最低幅を下回る場合は自動的に `full` として扱う。
- 高さの固定、ピクセル単位の絶対配置、Widget の重なりは許可しない。
- ページヘッダー、言語切り替え、テーマ切り替え、フッターはページ chrome として扱い、通常のスクリーン配置対象にはしない。
- ログアウトの主導線はページ chrome または Account overview が保証し、管理者がすべての導線を消せないようにする。

## Conditional Display

スクリーンはテナントの有効機能やユーザー状態に基づいて表示を切り替えられる。

初期候補:

- Always visible
- Hidden
- Passkey enabled
- TOTP enabled
- External IdP enabled
- Consent records available
- Multiple sessions or session management enabled

条件が満たされない場合、ページ上に空の枠を残さない。条件式は許可された列挙値から選び、管理者が任意コードを入力する方式にはしない。

## Localization

- プリセットは Authrim が対応する各ロケールの既定文言を持つ。
- カスタム文言はロケール単位で保存する。
- 未設定のロケールは、テナントの既定ロケール、組み込みプリセットの順でフォールバックする。
- Widget が所有するセキュリティエラーや操作結果には安定した message key を使用する。
- 管理者が追加した Text block と上書き文言は、プレビュー時に未翻訳状態を確認できるようにする。

## Theme Integration

### Default behavior

- アカウントページは、Login UI で現在有効なテーマを既定で継承する。
- 背景、surface、文字、境界線、ボタン、状態色、フォント、余白、角丸、影、ロゴ、フッターなどは semantic theme token から取得する。
- Account Widget は raw color やテーマ固有 CSS を保存せず、semantic role を使用する。
- ライト・ダーク切り替えは同じページ構成を維持し、theme token のみを切り替える。
- テーマ変更はスクリーンの順序、表示・非表示、文言を変更しない。

### Theme-to-page association

カスタムテーマは、任意でアカウントページ定義を関連付けられるようにする。

1. 有効なテーマに `account_page_id` が設定されている場合、その公開済みページを使用する。
2. 設定されていない場合、テナントの既定アカウントページを使用する。
3. テナント既定がない場合、Authrim の組み込みアカウントページプリセットを使用する。

この関連付けにより、ブランドテーマごとに異なるアカウントページ構成を用意できる。一方、エンドユーザーが同じテーマ内で light/dark を切り替えるだけではページ構成を切り替えない。

### Theme editor preview

既存の Theme preview surface に `account` を追加する。テーマ編集とアカウントページ編集の両方から、次を確認できるようにする。

- Desktop and mobile viewport
- Light and dark mode
- Selected locale
- Built-in and custom account page
- Representative normal, empty, loading, success, and error states

## Runtime Resolution

Login UI はリクエスト時に編集途中の定義を直接参照しない。

推奨する解決順序:

```text
tenant and active Login UI theme
  -> associated published account page or tenant default
  -> ordered published screen versions
  -> locale overrides with fallback
  -> feature and user-state visibility evaluation
  -> semantic theme tokens
  -> rendered account page
```

- 下書きと公開済み定義を分離する。
- 公開時に参照するスクリーン版を固定する。
- ページまたはスクリーンの公開失敗時は、直前の完全な公開版を維持する。
- 削除済み、無効、未公開のスクリーン参照を公開前に検証する。
- runtime は不正な Widget 設定を fail closed で扱い、該当 Widget の安全な既定値または直前の公開版へフォールバックする。

## Admin UI Navigation

想定する管理画面:

- **Screens**: Login、Registration、Consent などの既存スクリーンに加え、Account screen を一覧・編集する。
- **Account page**: アカウントページプリセットとカスタムページを一覧・編集する。
- **Themes**: テーマの編集、Account preview、任意の Account page association を設定する。

Account page editor の左側は「パーツ一覧」ではなく「利用可能なスクリーン一覧」とする。Screen editor の左側に Account Widget と Supporting block を表示する。

## Validation and Guardrails

公開前に少なくとも次を検証する。

- ページ内の screen placement ID が一意である。
- 参照するスクリーンが存在し、公開可能である。
- Account screen に許可される主要 Account Widget は原則一つである。
- Widget に必須の設定と localization key が存在する。
- 同じ機能スクリーンの重複が許可されているかを screen kind ごとに検証する。
- Supporting block の URL、文字数、許可スキームを検証する。
- すべての表示条件が許可された列挙値である。
- モバイルで不正な幅指定を解消できる。
- テーマと文字色のコントラストに重大な問題がない。
- ページからログアウトまたは安全な戻り導線が完全に消えていない。

## Accessibility Requirements

- Widget 内の label、description、error、input の関連付けは Widget 実装が保証する。
- 成功・エラー・処理中状態を適切な live region で通知する。
- ドラッグ＆ドロップ以外に、キーボードで順序を変更する操作を提供する。
- Dialog の初期フォーカス、フォーカストラップ、復帰先を保証する。
- テーマプレビューで主要 surface のコントラスト警告を表示する。
- モーション軽減設定を尊重する。

## Security and Privacy Requirements

- Screen definition にユーザーデータ、認証情報、秘密値を保存しない。
- Custom text と URL を保存・表示する際は XSS と危険な URL scheme を防止する。
- 再認証の要否は編集可能な画面設定ではなく、サーバーと Widget の操作ポリシーが決定する。
- Passkey、TOTP、session、consent の mutation は既存の CSRF、origin、authorization、tenant boundary を維持する。
- プレビューには実ユーザーデータを使わず、決定的なサンプルデータを使用する。
- 公開、ロールバック、プリセットへのリセット、テーマとの関連付け変更を監査ログに記録する。

## Conceptual Data Model

以下は責務を示す概念モデルであり、確定した API または DB schema ではない。

### Account screen definition

- Stable screen ID and key
- Built-in or custom ownership
- Base preset ID and version
- Account screen kind
- One primary Account Widget configuration
- Ordered supporting blocks
- Locale overrides
- Draft and published versions
- Active state and audit metadata

### Account page definition

- Stable page ID and key
- Built-in or custom ownership
- Base preset ID and version
- Ordered screen placements
- Placement width and display condition
- Default locale behavior
- Draft and published versions
- Active/default state and audit metadata

### Theme association

- Theme ID
- Optional published account page ID
- Fallback to tenant default page

## Out of Scope for the Initial Implementation

- Arbitrary HTML, JavaScript, or CSS injection
- Pixel-based freeform canvas positioning
- Rewiring Widget actions to custom endpoints
- Removing Widget-owned validation, errors, confirmation, or reauthentication
- Arbitrary runtime expressions for display conditions
- Multiple primary Account Widgets inside one Account screen
- Editing the built-in preset in place
- Social account operations before the underlying runtime feature is available

## Proposed Implementation Stages

### Phase 1: Definitions and presets

- Add account screen kinds and bundled Account Widget block types.
- Define built-in account screen presets.
- Define the built-in account page preset.
- Add runtime resolution for the built-in page without changing current behavior.

### Phase 2: Screen editor

- Add Account Widgets to the Screen editor palette.
- Add supporting text and localization editing.
- Add state, locale, theme, desktop, and mobile previews.
- Add draft, publish, rollback, and preset reset behavior.

### Phase 3: Account page editor

- Add the Account page list and editor.
- Add screen placement, removal, ordering, width, and conditions.
- Add validation and responsive previews.
- Add tenant default page selection.

### Phase 4: Theme integration

- Add the Account theme preview surface.
- Apply semantic theme tokens to all Account Widgets.
- Add optional theme-to-account-page association.
- Verify custom themes, light/dark mode, assets, footer, and responsive behavior.

### Phase 5: Hardening

- Add accessibility and keyboard editing coverage.
- Add publish, rollback, invalid reference, and preset update tests.
- Add security regression tests for sanitization, authorization, tenant isolation, and reauthentication.
- Add browser tests for the configured desktop and mobile account page.

## Acceptance Criteria

- A new tenant has a complete, usable account page without customization.
- An administrator can create a custom page from the built-in preset.
- An administrator can remove an optional screen, reorder screens, and add guidance text.
- An administrator can customize permitted Widget labels without rebuilding its controls manually.
- Submit buttons, validation, errors, loading, confirmation, and reauthentication remain functional after customization.
- The same page renders correctly on desktop and mobile.
- The account page follows the active Login UI theme and light/dark mode.
- A custom theme can optionally select a different published account page.
- Draft changes do not affect end users until publication.
- A failed publish does not replace the previous working version.
- Built-in preset updates do not silently alter a published custom page.
- Reset and rollback operations are available and auditable.

## Decisions Captured from Product Discussion

- The product needs an **Account page editor**, not only additional standalone screen kinds.
- The Account page editor composes complete screens and allows administrators to add, remove, and reorder them.
- Account functions are exposed as bundled Widgets for ease of use and correctness.
- Error messages, submit buttons, loading, empty states, confirmation, and reauthentication stay inside the Widget.
- Authrim provides built-in screen and page presets that are usable immediately.
- Administrators can customize presets, remove unnecessary screens, and add tenant-specific copy.
- Account pages and Account Widgets must integrate with the existing Login UI theme system.

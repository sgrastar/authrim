/**
 * Japanese Error Messages (日本語エラーメッセージ)
 *
 * メッセージ形式: {placeholder} で動的値をサポート
 *
 * @packageDocumentation
 */

import type { ErrorMessages } from '../types';

export const errorMessagesJa: ErrorMessages = {
  // ============================================
  // RFC標準エラー
  // ============================================
  invalid_request: 'リクエストに必要なパラメータが不足しているか、形式が正しくありません',
  invalid_client: 'クライアント認証に失敗しました',
  invalid_grant: '認可グラントが無効、期限切れ、または取り消されています',
  unauthorized_client: 'クライアントはこの認可グラントタイプの使用を許可されていません',
  unsupported_grant_type: 'この認可グラントタイプはサポートされていません',
  invalid_scope: 'リクエストされたスコープが無効、不明、または形式が正しくありません',
  access_denied: 'アクセスが拒否されました',
  unsupported_response_type: '認可サーバーはこのレスポンスタイプをサポートしていません',
  server_error: '予期しないエラーが発生しました',
  temporarily_unavailable: 'サービスが一時的に利用できません',
  interaction_required: 'ユーザーの操作が必要です',
  login_required: '認証が必要です',
  account_selection_required: 'アカウントの選択が必要です',
  consent_required: 'ユーザーの同意が必要です',
  invalid_request_uri: 'request_uri が無効です',
  invalid_request_object: 'リクエストオブジェクトが無効です',
  request_not_supported: 'request パラメータはサポートされていません',
  request_uri_not_supported: 'request_uri パラメータはサポートされていません',
  registration_not_supported: '動的クライアント登録はサポートされていません',
  invalid_token: 'アクセストークンが無効です',
  insufficient_scope: 'このリクエストに必要なスコープが不足しています',
  authorization_pending: '認可待ちです',
  slow_down: 'リクエスト頻度を下げてください',
  expired_token: 'トークンが期限切れです',
  invalid_dpop_proof: 'DPoP プルーフが無効です',
  use_dpop_nonce: 'DPoP ノンスが必要です',
  invalid_binding_message: 'バインディングメッセージが無効です',
  issuance_pending: 'クレデンシャルの発行待ちです',
  unsupported_credential_format: 'クレデンシャル形式がサポートされていません',
  invalid_proof: 'プルーフが無効です',
  invalid_redirect_uri: 'リダイレクトURIが無効です',
  invalid_client_metadata: 'クライアントメタデータが無効です',

  // ============================================
  // 認証 (AUTH)
  // ============================================
  'auth.session_expired.title': 'セッション期限切れ',
  'auth.session_expired.detail': '認証セッションが期限切れです。再度ログインしてください。',
  'auth.session_not_found.title': 'セッションが見つかりません',
  'auth.session_not_found.detail': 'セッションが見つかりません。再度ログインしてください。',
  'auth.login_required.title': 'ログインが必要',
  'auth.login_required.detail': 'このリソースにアクセスするには認証が必要です。',
  'auth.mfa_required.title': 'MFA検証が必要',
  'auth.mfa_required.detail': '多要素認証の検証が必要です。',
  'auth.passkey_failed.title': 'パスキー認証失敗',
  'auth.passkey_failed.detail': 'パスキー認証に失敗しました。もう一度お試しください。',
  'auth.invalid_code.title': '無効なコード',
  'auth.invalid_code.detail': '検証コードが無効です。正しいコードを入力してください。',
  'auth.code_expired.title': 'コード期限切れ',
  'auth.code_expired.detail': '検証コードが期限切れです。新しいコードをリクエストしてください。',
  'auth.pkce_required.title': 'PKCEが必要',
  'auth.pkce_required.detail': 'このリクエストにはPKCE (code_challenge) が必要です。',
  'auth.pkce_invalid.title': '無効なPKCE',
  'auth.pkce_invalid.detail': 'PKCE code_verifier が無効です。',
  'auth.nonce_mismatch.title': 'ノンス不一致',
  'auth.nonce_mismatch.detail': 'ノンスが一致しません。',
  'auth.state_mismatch.title': 'ステート不一致',
  'auth.state_mismatch.detail': 'state パラメータが一致しません。',
  'auth.redirect_uri_mismatch.title': 'リダイレクトURI不一致',
  'auth.redirect_uri_mismatch.detail': 'redirect_uri が登録された値と一致しません。',
  'auth.prompt_none_failed.title': 'サイレント認証失敗',
  'auth.prompt_none_failed.detail': 'サイレント認証に失敗しました。ユーザーの操作が必要です。',
  'auth.max_age_exceeded.title': '認証タイムアウト',
  'auth.max_age_exceeded.detail':
    '認証時間が max_age の要件を超過しています。再度ログインしてください。',
  'auth.did_verification_failed.title': 'DID検証失敗',
  'auth.did_verification_failed.detail': 'DID署名の検証に失敗しました。',

  // ============================================
  // トークン (TOKEN)
  // ============================================
  'token.invalid.title': '無効なトークン',
  'token.invalid.detail': 'トークンが無効または形式が正しくありません。',
  'token.expired.title': 'トークン期限切れ',
  'token.expired.detail': 'トークンが期限切れです。',
  'token.revoked.title': 'トークン取り消し済み',
  'token.revoked.detail': 'トークンは取り消されています。',
  'token.reuse_detected.title': 'トークン再利用検出',
  'token.reuse_detected.detail':
    'リフレッシュトークンの再利用が検出されました。セキュリティのため、すべてのトークンが取り消されました。',
  'token.invalid_signature.title': '無効な署名',
  'token.invalid_signature.detail': 'トークンの署名が無効です。',
  'token.invalid_audience.title': '無効なオーディエンス',
  'token.invalid_audience.detail': 'トークンのオーディエンスが一致しません。',
  'token.invalid_issuer.title': '無効な発行者',
  'token.invalid_issuer.detail': 'トークンの発行者が一致しません。',
  'token.dpop_required.title': 'DPoPが必要',
  'token.dpop_required.detail': 'このリクエストにはDPoPプルーフが必要です。',
  'token.dpop_invalid.title': '無効なDPoP',
  'token.dpop_invalid.detail': 'DPoPプルーフが無効です。',
  'token.dpop_nonce_required.title': 'DPoPノンスが必要',
  'token.dpop_nonce_required.detail':
    'DPoPノンスが必要です。提供されたノンスで再試行してください。',

  // ============================================
  // クライアント (CLIENT)
  // ============================================
  'client.auth_failed.title': 'クライアント認証失敗',
  'client.auth_failed.detail': 'クライアント認証に失敗しました。',
  'client.invalid.title': '無効なクライアント',
  'client.invalid.detail': 'クライアントが無効または登録されていません。',
  'client.redirect_uri_invalid.title': '無効なリダイレクトURI',
  'client.redirect_uri_invalid.detail': 'リダイレクトURIがこのクライアントに登録されていません。',
  'client.metadata_invalid.title': '無効なクライアントメタデータ',
  'client.metadata_invalid.detail': 'クライアントメタデータが無効です。',
  'client.not_allowed_grant.title': '許可されていないグラントタイプ',
  'client.not_allowed_grant.detail': 'クライアントはこのグラントタイプの使用を許可されていません。',
  'client.not_allowed_scope.title': '許可されていないスコープ',
  'client.not_allowed_scope.detail': 'クライアントはこのスコープのリクエストを許可されていません。',
  'client.secret_expired.title': 'クライアントシークレット期限切れ',
  'client.secret_expired.detail': 'クライアントシークレットが期限切れです。',
  'client.jwks_invalid.title': '無効なJWKS',
  'client.jwks_invalid.detail': 'クライアントのJWKSが無効または取得できませんでした。',

  // ============================================
  // ユーザー (USER)
  // ============================================
  'user.invalid_credentials.title': '無効な認証情報',
  'user.invalid_credentials.detail': '入力された認証情報が無効です。',
  'user.locked.title': 'アカウントがロックされています',
  'user.locked.detail': 'このアカウントはロックされています。管理者にお問い合わせください。',
  'user.inactive.title': 'アカウントが無効',
  'user.inactive.detail': 'このアカウントは無効です。管理者にお問い合わせください。',
  'user.not_found.title': '無効な認証情報',
  'user.not_found.detail': '入力された認証情報が無効です。',
  'user.email_not_verified.title': 'メール未確認',
  'user.email_not_verified.detail': '続行する前にメールアドレスを確認してください。',
  'user.phone_not_verified.title': '電話番号未確認',
  'user.phone_not_verified.detail': '続行する前に電話番号を確認してください。',

  // ============================================
  // セッション (SESSION)
  // ============================================
  'session.store_error.title': 'セッションエラー',
  'session.store_error.detail': 'セッションストアへのアクセス中にエラーが発生しました。',
  'session.invalid_state.title': '無効なセッション状態',
  'session.invalid_state.detail': 'セッションの状態が無効です。',
  'session.concurrent_limit.title': '同時セッション制限',
  'session.concurrent_limit.detail': '同時セッションの最大数に達しました。',

  // ============================================
  // ポリシー (POLICY)
  // ============================================
  'policy.feature_disabled.title': '機能が無効',
  'policy.feature_disabled.detail': 'この機能は現在無効になっています。',
  'policy.not_configured.title': 'ポリシー未設定',
  'policy.not_configured.detail': 'ポリシーサービスが設定されていません。',
  'policy.invalid_api_key.title': '無効なAPIキー',
  'policy.invalid_api_key.detail': 'APIキーが無効です。',
  'policy.api_key_expired.title': 'APIキー期限切れ',
  'policy.api_key_expired.detail': 'APIキーが期限切れです。',
  'policy.api_key_inactive.title': 'APIキーが無効',
  'policy.api_key_inactive.detail': 'APIキーが無効化されています。',
  'policy.insufficient_permissions.title': '権限不足',
  'policy.insufficient_permissions.detail': 'この操作を行う権限がありません。',
  'policy.rebac_denied.title': 'アクセス拒否',
  'policy.rebac_denied.detail':
    'リレーションシップベースのアクセス制御によりアクセスが拒否されました。',
  'policy.abac_denied.title': 'アクセス拒否',
  'policy.abac_denied.detail': '属性ベースのアクセス制御によりアクセスが拒否されました。',

  // ============================================
  // 管理API (ADMIN)
  // ============================================
  'admin.auth_required.title': '管理者認証が必要',
  'admin.auth_required.detail': '管理者認証が必要です。',
  'admin.insufficient_permissions.title': '管理者権限不足',
  'admin.insufficient_permissions.detail': '十分な管理者権限がありません。',
  'admin.invalid_request.title': '無効なリクエスト',
  'admin.invalid_request.detail': '管理リクエストが無効です。',
  'admin.resource_not_found.title': 'リソースが見つかりません',
  'admin.resource_not_found.detail': 'リクエストされたリソースが見つかりませんでした。',
  'admin.conflict.title': '競合',
  'admin.conflict.detail': 'リクエストが既存のデータと競合しています。',

  // ============================================
  // SAML
  // ============================================
  'saml.invalid_response.title': '無効なSAMLレスポンス',
  'saml.invalid_response.detail': 'SAMLレスポンスが無効です。',
  'saml.slo_failed.title': 'シングルログアウト失敗',
  'saml.slo_failed.detail': 'SAMLシングルログアウトに失敗しました。',
  'saml.signature_invalid.title': '無効なSAML署名',
  'saml.signature_invalid.detail': 'SAML署名の検証に失敗しました。',
  'saml.assertion_expired.title': 'SAMLアサーション期限切れ',
  'saml.assertion_expired.detail': 'SAMLアサーションが期限切れです。',
  'saml.idp_not_configured.title': 'IdP未設定',
  'saml.idp_not_configured.detail': 'SAML IDプロバイダーが設定されていません。',

  // ============================================
  // VC (Verifiable Credentials)
  // ============================================
  'vc.issuance_pending.title': '発行保留中',
  'vc.issuance_pending.detail': 'クレデンシャルの発行が保留中です。後でもう一度お試しください。',
  'vc.unsupported_format.title': 'サポートされていない形式',
  'vc.unsupported_format.detail': 'リクエストされたクレデンシャル形式はサポートされていません。',
  'vc.invalid_proof.title': '無効なプルーフ',
  'vc.invalid_proof.detail': 'クレデンシャルのプルーフが無効です。',
  'vc.credential_revoked.title': 'クレデンシャル取り消し済み',
  'vc.credential_revoked.detail': 'クレデンシャルは取り消されています。',
  'vc.status_check_failed.title': 'ステータスチェック失敗',
  'vc.status_check_failed.detail': 'クレデンシャルのステータス確認に失敗しました。',
  'vc.did_resolution_failed.title': 'DID解決失敗',
  'vc.did_resolution_failed.detail': 'DIDドキュメントの解決に失敗しました。',

  // ============================================
  // 外部IdP (BRIDGE)
  // ============================================
  'bridge.link_required.title': 'アカウント連携が必要',
  'bridge.link_required.detail': '続行するにはアカウント連携が必要です。',
  'bridge.provider_auth_failed.title': 'プロバイダー認証失敗',
  'bridge.provider_auth_failed.detail': '外部プロバイダーでの認証に失敗しました。',
  'bridge.provider_unavailable.title': 'プロバイダー利用不可',
  'bridge.provider_unavailable.detail': '外部IDプロバイダーが一時的に利用できません。',
  'bridge.account_already_linked.title': 'アカウント連携済み',
  'bridge.account_already_linked.detail': 'この外部アカウントは既に連携されています。',
  'bridge.token_refresh_failed.title': 'トークン更新失敗',
  'bridge.token_refresh_failed.detail': '外部プロバイダーのトークン更新に失敗しました。',
  'bridge.jit_provisioning_failed.title': 'プロビジョニング失敗',
  'bridge.jit_provisioning_failed.detail':
    'ジャストインタイムユーザープロビジョニングに失敗しました。',

  // ============================================
  // 設定 (CONFIG)
  // ============================================
  'config.kv_not_configured.title': '設定エラー',
  'config.kv_not_configured.detail': 'キー値ストアが設定されていません。',
  'config.invalid_value.title': '無効な設定',
  'config.invalid_value.detail': '設定値が無効です。',
  'config.load_error.title': '設定読み込みエラー',
  'config.load_error.detail': '設定の読み込みに失敗しました。',
  'config.missing_secret.title': 'シークレット未設定',
  'config.missing_secret.detail': '必要なシークレットが設定されていません。',
  'config.db_not_configured.title': 'データベース未設定',
  'config.db_not_configured.detail': 'データベースが設定されていません。',

  // ============================================
  // レート制限 (RATE)
  // ============================================
  'rate.limit_exceeded.title': 'レート制限超過',
  'rate.limit_exceeded.detail': 'レート制限を超過しました。{retry_after}秒後に再試行してください。',
  'rate.slow_down.title': 'スローダウン',
  'rate.slow_down.detail': 'ポーリング頻度が高すぎます。頻度を下げてください。',
  'rate.too_many_requests.title': 'リクエスト過多',
  'rate.too_many_requests.detail':
    'リクエストが多すぎます。しばらくしてからもう一度お試しください。',

  // ============================================
  // フロー API (FLOW)
  // ============================================
  'flow.missing_challenge_id.title': 'チャレンジID未指定',
  'flow.missing_challenge_id.detail':
    'challenge_idが必要です。新しい認証フローを開始してください。',
  'flow.challenge_not_found.title': 'チャレンジが見つかりません',
  'flow.challenge_not_found.detail':
    '認証チャレンジが見つかりませんでした。新しいフローを開始してください。',
  'flow.challenge_expired.title': 'チャレンジ期限切れ',
  'flow.challenge_expired.detail':
    '認証チャレンジの有効期限が切れました。新しいフローを開始してください。',
  'flow.challenge_consumed.title': 'チャレンジ使用済み',
  'flow.challenge_consumed.detail':
    'この認証チャレンジは既に完了しています。新しいフローを開始してください。',
  'flow.invalid_event.title': '無効なイベント',
  'flow.invalid_event.detail': 'イベントタイプ「{event}」は認識されていません。',
  'flow.invalid_transition.title': '無効な遷移',
  'flow.invalid_transition.detail':
    '現在の状態「{state}」ではイベント「{event}」は許可されていません。',
  'flow.validation_failed.title': '検証失敗',
  'flow.validation_failed.detail': '入力データの検証に失敗しました。入力内容をご確認ください。',
  'flow.webauthn_failed.title': 'パスキー検証失敗',
  'flow.webauthn_failed.detail': 'パスキーの検証に失敗しました。もう一度お試しください。',
  'flow.external_idp_failed.title': '外部ログイン失敗',
  'flow.external_idp_failed.detail':
    '外部プロバイダーでの認証に失敗しました。もう一度お試しください。',
  'flow.capability_not_found.title': 'Capability未検出',
  'flow.capability_not_found.detail': 'Capability「{capability_id}」が見つかりませんでした。',

  // ============================================
  // 内部エラー (INTERNAL)
  // ============================================
  'internal.error.title': '内部エラー',
  'internal.error.detail': '内部エラーが発生しました。',
  'internal.do_error.title': '内部エラー',
  'internal.do_error.detail': '内部エラーが発生しました。',
  'internal.queue_error.title': '内部エラー',
  'internal.queue_error.detail': '内部エラーが発生しました。',
};

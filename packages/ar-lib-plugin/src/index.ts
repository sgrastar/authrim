/**
 * @authrim/ar-lib-plugin
 *
 * Authrim Plugin Architecture
 *
 * Export Strategy:
 * - Plugin developers: Use exports from './core' and './builtin'
 * - Application (Workers): Use 'Infra' namespace for Infrastructure access
 */

// Plugin 開発者向け（Infra を意識しない）
export * from './core';
export * from './builtin';

// アプリ側向け（Infrastructure 明示的にアクセス）
export * as Infra from './infra';

/**
 * @authrim/ar-lib-plugin
 *
 * Authrim Plugin Architecture
 *
 * Export Strategy:
 * - Plugin developers: Use exports from './core' and './builtin'
 * - Application (Workers): Use 'Infra' namespace for Infrastructure access
 */

// For plugin developers (infrastructure-agnostic)
export * from './core';
export * from './builtin';

// For application side (explicit infrastructure access)
export * as Infra from './infra';

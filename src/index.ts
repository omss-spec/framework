/**
 * @omss/framework
 *
 * Official OMSS backend framework for multi-provider streaming media aggregation
 *
 * @packageDocumentation
 */

// Core exports
export { OMSSServer } from './core/server'
export { OMSSConfig, SourceResponse, Source, Subtitle, HealthResponse } from './core/types'
export { OMSSError, OMSSErrors } from './core/errors'
export { CacheService, MemoryCacheService, RedisCacheService } from './core/cache'

// Provider exports
export * from './providers/base-provider'
export { ProviderRegistry, ProviderRegistryConfig } from './providers/provider-registry'

// Service exports
export { SourceService } from './services/source.service'
export { ProxyService } from './services/proxy.service'
export { HealthService } from './services/health.service'

// Utility exports
export { ProxyService as ProxyUtils } from './services/proxy.service'

// Re-export commonly used types
export type * from './core/types'

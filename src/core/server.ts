import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { OMSSConfig } from './types'
import { ProviderRegistry } from '../providers/provider-registry'
import { createCacheService, CacheService } from './cache'
import { SourceService } from '../services/source.service'
import { ProxyService } from '../services/proxy.service'
import { HealthService } from '../services/health.service'
import { ContentController } from '../controllers/content.controller'
import { ProxyController } from '../controllers/proxy.controller'
import { HealthController } from '../controllers/health.controller'
import { errorHandler } from '../middleware/error-handler'
import { requestLogger } from '../middleware/logger'
import { validateContentType } from '../middleware/validation'
import { TMDBService } from '../services/tmdb.service'

export class OMSSServer {
    private app: FastifyInstance
    private config: OMSSConfig
    private registry: ProviderRegistry
    private cache: CacheService

    // Services
    private sourceService: SourceService
    private proxyService: ProxyService
    private healthService: HealthService
    private tmdbService: TMDBService

    // Controllers
    private contentController: ContentController
    private proxyController: ProxyController
    private healthController: HealthController

    constructor(config: OMSSConfig, registry?: ProviderRegistry) {
        this.config = config

        // Create registry with proxy configuration
        const host = config.host || 'localhost'
        const port = config.port || 3000

        // Determine proxy base URL
        let proxyBaseUrl: string

        if (config.publicUrl) {
            // Use explicit public URL
            proxyBaseUrl = config.publicUrl
        } else if (host === '0.0.0.0' || host === '::') {
            // Listen on all interfaces - use localhost for local proxying
            proxyBaseUrl = `http://localhost:${port}`
        } else {
            // Use configured host and port
            proxyBaseUrl = `http://${host}:${port}`
        }

        this.registry =
            registry ||
            new ProviderRegistry({
                proxyBaseUrl,
            })

        console.log(`[Server] Proxy base URL: ${proxyBaseUrl}`)

        // Initialize Fastify
        this.app = Fastify({
            logger: false,
            requestIdHeader: 'x-request-id',
            genReqId: () => require('uuid').v4(),
            trustProxy: true,
        })

        // Initialize cache
        this.cache = createCacheService(config.cache)

        // Initialize TMDB service
        const tmdbApiKey = process.env.TMDB_API_KEY || config.tmdb?.apiKey
        if (!tmdbApiKey) {
            throw new Error('TMDB_API_KEY is required. Set it in .env or config')
        }

        this.tmdbService = new TMDBService(tmdbApiKey, this.cache, config.tmdb?.cacheTTL || 86400)

        // Initialize services
        this.sourceService = new SourceService(this.registry, this.cache, this.tmdbService, config.cache?.ttl)
        this.proxyService = new ProxyService()
        this.healthService = new HealthService(config, this.registry)

        // Initialize controllers
        this.contentController = new ContentController(this.sourceService)
        this.proxyController = new ProxyController(this.proxyService)
        this.healthController = new HealthController(this.healthService)

        // Setup middleware and routes
        this.setupMiddleware()
        this.setupRoutes()
        this.setupErrorHandlers()
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        // CORS
        this.app.register(cors, {
            origin: '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
            credentials: false,
        })

        // Request logging
        this.app.addHook('onRequest', requestLogger)

        // Content-Type validation
        this.app.addHook('preHandler', validateContentType)
    }

    /**
     * Setup routes
     */
    private setupRoutes(): void {
        // Health endpoints
        this.app.get('/', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1/', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1/health', this.healthController.getHealth.bind(this.healthController))

        // Content endpoints
        this.app.get('/v1/movies/:id', this.contentController.getMovie.bind(this.contentController))
        this.app.get('/v1/tv/:id/seasons/:s/episodes/:e', this.contentController.getTVEpisode.bind(this.contentController))

        // Refresh endpoint
        this.app.get('/v1/refresh/:responseId', this.contentController.refreshSource.bind(this.contentController))

        // Proxy endpoint
        this.app.get('/v1/proxy', this.proxyController.proxy.bind(this.proxyController))

        // 404 handler
        this.app.setNotFoundHandler((request, reply) => {
            reply.code(404).send({
                error: {
                    code: 'ENDPOINT_NOT_FOUND',
                    message: 'The requested endpoint does not exist',
                    details: {
                        path: request.url,
                        method: request.method,
                    },
                },
                traceId: request.id,
            })
        })
    }

    /**
     * Setup error handlers
     */
    private setupErrorHandlers(): void {
        this.app.setErrorHandler(errorHandler)
    }

    /**
     * Start the server
     */
    async start(): Promise<void> {
        try {
            const host = this.config.host || 'localhost'
            const port = this.config.port || 3000

            await this.app.listen({ port, host })

            console.log(`
╔════════════════════════════════════════════════════════╗
║                   OMSS Backend Server                  ║
╠════════════════════════════════════════════════════════╣
║  Name:       ${this.config.name.padEnd(42)}║
║  Version:    ${this.config.version.padEnd(42)}║
║  Port:       ${port.toString().padEnd(42)}║
║  Providers:  ${this.registry.count.toString().padEnd(42)}║
║  Cache:      ${(this.config.cache?.type || 'memory').padEnd(42)}║
╠════════════════════════════════════════════════════════╣
║  Endpoints:                                            ║
║    GET  /                        - Health check        ║
║    GET  /v1/movies/:id           - Movie sources       ║
║    GET  /v1/tv/:id/seasons/:s/episodes/:e              ║
║                                  - TV sources          ║
║    GET  /v1/proxy?data=...       - Proxy endpoint      ║
║    GET  /v1/refresh/:responseId  - Refresh cache       ║
╚════════════════════════════════════════════════════════╝

🚀 Server listening at http://${host}:${port}
      `)
        } catch (error) {
            console.error('[Server] Failed to start:', error)
            throw error
        }
    }

    /**
     * Stop the server gracefully
     */
    async stop(): Promise<void> {
        console.log('[Server] Shutting down...')

        try {
            await this.app.close()

            // Cleanup cache
            if ('destroy' in this.cache) {
                ;(this.cache as any).destroy?.()
            } else if ('disconnect' in this.cache) {
                await (this.cache as any).disconnect?.()
            }

            console.log('[Server] Shutdown complete')
        } catch (error) {
            console.error('[Server] Error during shutdown:', error)
            throw error
        }
    }

    /**
     * Get the Fastify instance (for testing or custom configuration)
     */
    getInstance(): FastifyInstance {
        return this.app
    }

    /**
     * Get the provider registry
     */
    getRegistry(): ProviderRegistry {
        return this.registry
    }
}

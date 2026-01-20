import { ProviderRegistry } from '../providers/provider-registry'
import { CacheService } from '../core/cache'
import { SourceResponse, ProviderResult, ResponseIdMapping, ProviderMediaObject } from '../core/types'
import { createTMDBValidator } from '../middleware/validation'
import { OMSSErrors } from '../core/errors'
import { TMDBService } from '../services/tmdb.service'
import { v4 as uuidv4 } from 'uuid'

export class SourceService {
    private tmdbValidator: ReturnType<typeof createTMDBValidator>
    private responseIdMap: Map<string, ResponseIdMapping> = new Map()

    constructor(
        private registry: ProviderRegistry,
        private cache: CacheService,
        private tmdbService: TMDBService,
        private cacheTTL = { sources: 7200, subtitles: 86400 }
    ) {
        setInterval(() => this.cleanupExpiredMappings(), 60 * 60 * 1000)
        this.tmdbValidator = createTMDBValidator(tmdbService)
    }

    /**
     * Get movie sources from all providers
     */
    async getMovieSources(tmdbId: string): Promise<SourceResponse> {
        await this.tmdbValidator.validateMovie(tmdbId)

        const cacheKey = `movie:${tmdbId}`

        // Check cache first
        const cached = await this.cache.get<SourceResponse>(cacheKey)
        if (cached) {
            console.log(`[SourceService] Cache HIT for ${cacheKey}`)
            return cached
        }

        console.log(`[SourceService] Cache MISS for ${cacheKey}`)

        // Build media object for providers
        const media = await this.tmdbService.getMediaObject('movie', tmdbId)

        // Try to get IMDB ID
        media.imdbId = await this.tmdbService.getImdbId(tmdbId, 'movie')

        // Fetch from providers
        const results = await this.fetchFromProviders('movie', media)
        const response = this.buildResponse(results)

        // Throw error if no sources found
        if (response.sources.length === 0) {
            throw OMSSErrors.noSourcesAvailable(tmdbId, this.registry.count)
        }

        // Store responseId mapping
        this.storeResponseIdMapping(response.responseId, {
            cacheKey,
            type: 'movie',
            tmdbId,
            createdAt: Date.now(),
        })

        // Cache the response
        await this.cache.set(cacheKey, response, this.cacheTTL.sources)

        return response
    }

    /**
     * Get TV episode sources from all providers
     */
    async getTVSources(tmdbId: string, season: number, episode: number): Promise<SourceResponse> {
        await this.tmdbValidator.validateTVEpisode(tmdbId, season, episode)

        const cacheKey = `tv:${tmdbId}:s${season}:e${episode}`

        // Check cache
        const cached = await this.cache.get<SourceResponse>(cacheKey)
        if (cached) {
            console.log(`[SourceService] Cache HIT for ${cacheKey}`)
            return cached
        }

        console.log(`[SourceService] Cache MISS for ${cacheKey}`)

        // Build media object for providers
        const media = await this.tmdbService.getMediaObject('tv', tmdbId, season, episode)

        // Try to get IMDB ID
        media.imdbId = await this.tmdbService.getImdbId(tmdbId, 'tv')

        // Fetch from providers
        const results = await this.fetchFromProviders('tv', media)
        const response = this.buildResponse(results)

        // Throw error if no sources found
        if (response.sources.length === 0) {
            throw OMSSErrors.noSourcesAvailable(`${tmdbId}/S${season}E${episode}`, this.registry.count)
        }

        // Store responseId mapping
        this.storeResponseIdMapping(response.responseId, {
            cacheKey,
            type: 'tv',
            tmdbId,
            season,
            episode,
            createdAt: Date.now(),
        })

        // Cache the response
        await this.cache.set(cacheKey, response, this.cacheTTL.sources)

        return response
    }

    /**
     * Refresh cached sources by responseId
     */
    async refreshSource(responseId: string): Promise<void> {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(responseId)) {
            throw OMSSErrors.invalidResponseId(responseId)
        }

        const mapping = this.responseIdMap.get(responseId)

        if (!mapping) {
            console.warn(`[SourceService] No mapping found for responseId: ${responseId}`)
            throw OMSSErrors.responseIdNotFound(responseId)
        }

        console.log(`[SourceService] Refreshing cache for ${mapping.cacheKey} (responseId: ${responseId})`)

        await this.cache.delete(mapping.cacheKey)
        this.responseIdMap.delete(responseId)

        console.log(`[SourceService] Successfully refreshed cache for ${mapping.cacheKey}`)
    }

    /**
     * Store responseId to cacheKey mapping
     */
    private storeResponseIdMapping(responseId: string, mapping: ResponseIdMapping): void {
        this.responseIdMap.set(responseId, mapping)
        console.log(`[SourceService] Stored mapping: ${responseId} -> ${mapping.cacheKey}`)
    }

    /**
     * Cleanup expired responseId mappings
     */
    private cleanupExpiredMappings(): void {
        const now = Date.now()
        const maxAge = this.cacheTTL.sources * 1000
        let cleaned = 0

        for (const [responseId, mapping] of this.responseIdMap.entries()) {
            if (now - mapping.createdAt > maxAge) {
                this.responseIdMap.delete(responseId)
                cleaned++
            }
        }

        if (cleaned > 0) {
            console.log(`[SourceService] Cleaned up ${cleaned} expired responseId mapping(s)`)
        }
    }

    /**
     * Fetch results from all providers concurrently
     */
    private async fetchFromProviders(type: 'movie' | 'tv', media: ProviderMediaObject): Promise<ProviderResult[]> {
        const providers = this.registry.getProviders()

        if (providers.length === 0) {
            console.warn('[SourceService] No providers registered')
            return []
        }

        // Filter providers by capability
        const supportedProviders = providers.filter((p) => p.capabilities.supportedContentTypes.includes(type === 'movie' ? 'movies' : 'tv'))

        console.log(`[SourceService] Fetching from ${supportedProviders.length} provider(s) ` + `(${providers.length - supportedProviders.length} filtered out)`)

        const promises = supportedProviders.map(async (provider) => {
            try {
                const startTime = Date.now()
                let result: ProviderResult

                if (type === 'movie') {
                    result = await provider.getMovieSources(media)
                } else {
                    result = await provider.getTVSources(media)
                }

                const duration = Date.now() - startTime
                console.log(`[SourceService] Provider '${provider.name}' returned ${result.sources.length} source(s) in ${duration}ms`)

                return result
            } catch (error) {
                console.error(`[SourceService] Provider '${provider.name}' failed:`, error)

                return {
                    sources: [],
                    subtitles: [],
                    diagnostics: [
                        {
                            code: 'PROVIDER_ERROR' as const,
                            message: `Provider '${provider.name}' failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            field: '',
                            severity: 'error' as const,
                        },
                    ],
                }
            }
        })

        const results = await Promise.allSettled(promises)

        return results.filter((r): r is PromiseFulfilledResult<ProviderResult> => r.status === 'fulfilled').map((r) => r.value)
    }

    /**
     * Build final response from provider results
     */
    private buildResponse(results: ProviderResult[]): SourceResponse {
        const allSources = results.flatMap((r) => r.sources)
        const allSubtitles = results.flatMap((r) => r.subtitles)
        const allDiagnostics = results.flatMap((r) => r.diagnostics)

        const failedProviders = results.filter((r) => r.sources.length === 0).length
        if (failedProviders > 0 && allSources.length > 0) {
            allDiagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `Only ${results.length - failedProviders} of ${results.length} providers returned results`,
                field: '',
                severity: 'warning',
            })
        }

        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

        return {
            responseId: uuidv4(),
            expiresAt,
            sources: allSources,
            subtitles: allSubtitles,
            diagnostics: allDiagnostics,
        }
    }

    /**
     * Get mapping info for debugging
     */
    getMappingInfo(responseId: string): ResponseIdMapping | undefined {
        return this.responseIdMap.get(responseId)
    }

    /**
     * Get all mappings count
     */
    getMappingsCount(): number {
        return this.responseIdMap.size
    }

    /**
     * Cleanup on service shutdown
     */
    destroy(): void {
        this.responseIdMap.clear()
        console.log('[SourceService] Destroyed and cleared all mappings')
    }
}

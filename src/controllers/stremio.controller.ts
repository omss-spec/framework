import { FastifyReply, FastifyRequest } from 'fastify'
import { SourceService } from '../services/source.service.js'
import { OMSSConfig, SourceResponse, Source } from '../core/types.js'
import { TMDBService } from '../services/tmdb.service.js'

interface StreamParams {
    type: string
    id: string
}

interface StremioStream {
    url?: string
    ytId?: string
    infoHash?: string
    fileIdx?: number
    name?: string
    title?: string
    description?: string
    behaviorHints?: {
        notWebReady?: boolean
        bingeGroup?: string
    }
}

interface StremioManifest {
    id: string
    version: string
    name: string
    description: string
    logo?: string
    resources: Array<string | { name: string; types: string[] }>
    types: string[]
    catalogs: Array<any>
    idPrefixes?: string[]
}

export class StremioController {
    constructor(
        private readonly sourceService: SourceService,
        private readonly config: OMSSConfig,
        private readonly tmdbService: TMDBService
    ) {}

    /**
     * GET /stremio/manifest.json
     */
    async getManifest(_req: FastifyRequest, reply: FastifyReply) {
        const safeName = this.config.name
            .toLowerCase()
            .replace(/[^a-z\s]/g, '')
            .trim()
            .replace(/\s+/g, '.')

        const manifest: StremioManifest = {
            id: `omss.${safeName}`,
            version: this.config.version,
            name: this.config.name,
            description: this.config.note || 'Your backend exposed as a Stremio addon',
            resources: ['stream'],
            types: ['movie', 'series'],
            catalogs: [],
            idPrefixes: ['tmdb', 'tt'],
        }

        return reply.code(200).send(manifest)
    }

    /**
     * Resolve an incoming Stremio ID to a TMDB ID string.
     *
     * Stremio uses:
     *   - "tt1234567"              → IMDb movie
     *   - "tt1234567:1:2"          → IMDb series S01E02
     *   - "tmdb:603"               → TMDB movie
     *   - "tmdb:1399:1:1"          → TMDB series S01E01
     *
     * Returns null when the ID cannot be resolved.
     */
    private async resolveTmdbId(rawId: string, type: string): Promise<{ tmdbId: string; season?: number; episode?: number } | null> {
        const clean = rawId.replace(/\.json$/, '')
        const parts = clean.split(':')

        if (parts[0].startsWith('tt')) {
            const imdbId = parts[0]
            const season = parts[1] ? parseInt(parts[1], 10) : undefined
            const episode = parts[2] ? parseInt(parts[2], 10) : undefined

            const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie'

            const tmdbId = await this.tmdbService.findTmdbIdByImdbId(imdbId, mediaType)

            if (!tmdbId) return null

            return { tmdbId, season, episode }
        }

        if (parts[0] === 'tmdb' && parts.length >= 2) {
            const tmdbId = parts[1]
            const season = parts[2] ? parseInt(parts[2], 10) : undefined
            const episode = parts[3] ? parseInt(parts[3], 10) : undefined
            return { tmdbId, season, episode }
        }

        return null
    }

    /**
     * GET /stremio/stream/:type/:id.json
     *
     * Supported ID formats:
     *   Movies:   tt1234567 | tmdb:603
     *   Series:   tt1234567:1:2 | tmdb:1399:1:1
     */
    async getStream(request: FastifyRequest<{ Params: StreamParams }>, reply: FastifyReply) {
        const { type, id } = request.params
        const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie'

        const resolved = await this.resolveTmdbId(id, type)

        if (!resolved) {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_PARAMETER',
                    message: 'Invalid ID format or unsupported ID type',
                },
                traceId: request.id,
            })
        }

        const { tmdbId, season, episode } = resolved

        try {
            let omssResponse: SourceResponse | null = null
            const mediaType = type === 'movie' ? 'movie' : 'tv'

            const mediaObject = await this.tmdbService.getMediaObject(mediaType, tmdbId, season, episode)
            const mediaTitle = mediaObject.title ?? tmdbId

            if (type === 'movie') {
                omssResponse = await this.sourceService.getMovieSources(tmdbId)
            } else if (type === 'series' || type === 'tv') {
                if (season === undefined || episode === undefined || !Number.isFinite(season) || !Number.isFinite(episode)) {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_PARAMETER',
                    message: 'An error occurred while processing the request',
                },
                traceId: request.id,
            })
                }
                omssResponse = await this.sourceService.getTVSources(tmdbId, season, episode)
            } else {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_PARAMETER',
                    message: 'An error occurred while processing the request',
                },
                traceId: request.id,
            })
            }

            const streams: StremioStream[] = (omssResponse.sources || []).map((source: Source, index: number): StremioStream => {
                // e.g. "4K UHD • HLS" or "1080p • MP4"
                const name = `${this.config.name} [${source.quality} • ${source.type.toUpperCase()}]`

                // Audio track summary: "EN, FR, DE" or "EN" or omit if empty
                const audioSummary = source.audioTracks.length > 0 ? source.audioTracks.map((t) => t.label || t.language.toUpperCase()).join(', ') : null

                // Multi-line description rendered by Stremio below the name
                const descLines: string[] = [
                    `📡 Provider: ${source.provider.name}`,
                
                ]

                if (audioSummary) {
                    descLines.push(`🔊 ${audioSummary}`)
                }
                descLines.push(`🛡️ Proxied`)

                const bingeGroup = `${this.config.name}-${source.provider.id}-${source.quality}`.toLowerCase().replace(/\s+/g, '-')

                return {
                    url: source.url,
                    name,
                    title: descLines.join('\n'),
                    behaviorHints: {
                        bingeGroup,
                    },
                }
            })

            return reply.code(200).send({ streams })
        } catch (err) {
            request.log.error({ err, type, id }, '[Stremio] Error resolving streams')
            return reply.code(400).send({
                error: {
                    code: 'INVALID_PARAMETER',
                    message: 'An error occurred while processing the request',
                },
                traceId: request.id,
            })
        }
    }
}

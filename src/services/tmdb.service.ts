import axios from 'axios'
import { CacheService } from '../core/cache'
import { ProviderMediaObject } from '../core/types'

export interface TMDBMovieResponse {
    id: number
    title: string
    release_date: string // YYYY-MM-DD
    status: 'Rumored' | 'Planned' | 'In Production' | 'Post Production' | 'Released' | 'Canceled'
    adult: boolean
}

export interface TMDBTVResponse {
    id: number
    name: string
    first_air_date: string // YYYY-MM-DD
    status: 'Returning Series' | 'Planned' | 'In Production' | 'Ended' | 'Canceled' | 'Pilot'
    adult: boolean
    number_of_seasons: number
    seasons: Array<{
        season_number: number
        episode_count: number
        air_date: string
    }>
}

export interface TMDBSeasonResponse {
    id: number
    season_number: number
    air_date: string // YYYY-MM-DD
    episodes: Array<{
        episode_number: number
        air_date: string | null
        name: string
    }>
}

export interface TMDBValidationResult {
    exists: boolean
    released: boolean
    releaseDate?: string
    title?: string
    message?: string
}

export class TMDBService {
    private readonly baseUrl = 'https://api.themoviedb.org/3'
    private readonly apiKey: string
    private readonly cacheTTL: number

    constructor(
        apiKey: string,
        private cache: CacheService,
        cacheTTL = 86400 // 24 hours default
    ) {
        if (!apiKey || apiKey === 'your_tmdb_api_key_here') {
            throw new Error('TMDB_API_KEY is not configured. Get one at https://www.themoviedb.org/settings/api')
        }
        this.apiKey = apiKey
        this.cacheTTL = cacheTTL
    }

    /**
     * Validate a movie exists and has been released
     */
    async validateMovie(tmdbId: string): Promise<TMDBValidationResult> {
        const cacheKey = `tmdb:movie:${tmdbId}`

        // Check cache first
        const cached = await this.cache.get<TMDBValidationResult>(cacheKey)
        if (cached) {
            return cached
        }

        try {
            const response = await axios.get<TMDBMovieResponse>(`${this.baseUrl}/movie/${tmdbId}`, {
                params: { api_key: this.apiKey },
                timeout: 5000,
            })

            const movie = response.data
            const releaseDate = new Date(movie.release_date)
            const now = new Date()
            const released = releaseDate <= now && movie.status === 'Released'

            const result: TMDBValidationResult = {
                exists: true,
                released,
                releaseDate: movie.release_date,
                title: movie.title,
                message: released ? undefined : `Movie "${movie.title}" has not been released yet (release date: ${movie.release_date})`,
            }

            // Cache the result
            await this.cache.set(cacheKey, result, this.cacheTTL)
            return result
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                const result: TMDBValidationResult = {
                    exists: false,
                    released: false,
                    message: `Movie with TMDB ID ${tmdbId} does not exist`,
                }

                // Cache 404s for shorter time (1 hour)
                await this.cache.set(cacheKey, result, 3600)
                return result
            }

            console.error('[TMDBService] Error validating movie:', error)
            throw error
        }
    }

    /**
     * Validate a TV show exists and has aired
     */
    async validateTV(tmdbId: string): Promise<TMDBValidationResult> {
        const cacheKey = `tmdb:tv:${tmdbId}`

        // Check cache first
        const cached = await this.cache.get<TMDBValidationResult>(cacheKey)
        if (cached) {
            return cached
        }

        try {
            const response = await axios.get<TMDBTVResponse>(`${this.baseUrl}/tv/${tmdbId}`, {
                params: { api_key: this.apiKey },
                timeout: 5000,
            })

            const tv = response.data
            const firstAirDate = new Date(tv.first_air_date)
            const now = new Date()
            const aired = firstAirDate <= now

            const result: TMDBValidationResult = {
                exists: true,
                released: aired,
                releaseDate: tv.first_air_date,
                title: tv.name,
                message: aired ? undefined : `TV show "${tv.name}" has not aired yet (first air date: ${tv.first_air_date})`,
            }

            // Cache the result
            await this.cache.set(cacheKey, result, this.cacheTTL)
            return result
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                const result: TMDBValidationResult = {
                    exists: false,
                    released: false,
                    message: `TV show with TMDB ID ${tmdbId} does not exist`,
                }

                // Cache 404s for shorter time (1 hour)
                await this.cache.set(cacheKey, result, 3600)
                return result
            }

            console.error('[TMDBService] Error validating TV show:', error)
            throw error
        }
    }

    /**
     * Validate a specific TV episode exists and has aired
     */
    async validateTVEpisode(tmdbId: string, season: number, episode: number): Promise<TMDBValidationResult> {
        const cacheKey = `tmdb:tv:${tmdbId}:s${season}:e${episode}`

        // Check cache first
        const cached = await this.cache.get<TMDBValidationResult>(cacheKey)
        if (cached) {
            return cached
        }

        try {
            // First validate the TV show exists
            const tvResult = await this.validateTV(tmdbId)
            if (!tvResult.exists || !tvResult.released) {
                return tvResult
            }

            // Get season details
            const response = await axios.get<TMDBSeasonResponse>(`${this.baseUrl}/tv/${tmdbId}/season/${season}`, {
                params: { api_key: this.apiKey },
                timeout: 5000,
            })

            const seasonData = response.data
            const episodeData = seasonData.episodes.find((ep) => ep.episode_number === episode)

            if (!episodeData) {
                const result: TMDBValidationResult = {
                    exists: false,
                    released: false,
                    message: `Episode ${episode} does not exist in season ${season}`,
                }

                // Cache for 1 hour
                await this.cache.set(cacheKey, result, 3600)
                return result
            }

            // Check if episode has aired
            if (!episodeData.air_date) {
                const result: TMDBValidationResult = {
                    exists: true,
                    released: false,
                    title: episodeData.name,
                    message: `Episode "${episodeData.name}" (S${season}E${episode}) does not have an air date yet`,
                }

                // Cache for 1 hour (might get updated soon)
                await this.cache.set(cacheKey, result, 3600)
                return result
            }

            const airDate = new Date(episodeData.air_date)
            const now = new Date()
            const aired = airDate <= now

            const result: TMDBValidationResult = {
                exists: true,
                released: aired,
                releaseDate: episodeData.air_date,
                title: episodeData.name,
                message: aired ? undefined : `Episode "${episodeData.name}" (S${season}E${episode}) has not aired yet (air date: ${episodeData.air_date})`,
            }

            // Cache the result
            await this.cache.set(cacheKey, result, this.cacheTTL)
            return result
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                const result: TMDBValidationResult = {
                    exists: false,
                    released: false,
                    message: `Season ${season} does not exist for TV show ${tmdbId}`,
                }

                // Cache 404s for 1 hour
                await this.cache.set(cacheKey, result, 3600)
                return result
            }

            console.error('[TMDBService] Error validating episode:', error)
            throw error
        }
    }

    /**
     * Get media object for provider
     */
    async getMediaObject(type: 'movie' | 'tv', tmdbId: string, season?: number, episode?: number): Promise<ProviderMediaObject> {
        if (type === 'movie') {
            const validation = await this.validateMovie(tmdbId)

            return {
                type: 'movie',
                tmdbId,
                title: validation.title,
                releaseYear: validation.releaseDate ? new Date(validation.releaseDate).getFullYear().toString() : undefined,
            }
        } else {
            const validation = await this.validateTVEpisode(tmdbId, season!, episode!)

            return {
                type: 'tv',
                tmdbId,
                s: season,
                e: episode,
                title: validation.title,
            }
        }
    }

    /**
     * Get IMDB ID if available (cached)
     */
    async getImdbId(tmdbId: string, type: 'movie' | 'tv'): Promise<string | undefined> {
        const cacheKey = `tmdb:imdb:${type}:${tmdbId}`

        const cached = await this.cache.get<string>(cacheKey)
        if (cached) return cached

        try {
            const endpoint = type === 'movie' ? 'movie' : 'tv'
            const response = await axios.get(`${this.baseUrl}/${endpoint}/${tmdbId}/external_ids`, {
                params: { api_key: this.apiKey },
                timeout: 5000,
            })

            const imdbId = response.data.imdb_id
            if (imdbId) {
                await this.cache.set(cacheKey, imdbId, this.cacheTTL)
            }

            return imdbId
        } catch (error) {
            console.error('[TMDBService] Failed to get IMDB ID:', error)
            return undefined
        }
    }
}

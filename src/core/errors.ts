import { ErrorCode } from './types'
import { v4 as uuidv4 } from 'uuid'

export class OMSSError extends Error {
    constructor(
        public code: ErrorCode,
        public message: string,
        public statusCode: number,
        public details?: Record<string, any>,
        public traceId: string = uuidv4()
    ) {
        super(message)
        this.name = 'OMSSError'
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.message,
                details: this.details,
            },
            traceId: this.traceId,
        }
    }
}

// Factory functions for common errors
export const OMSSErrors = {
    invalidTmdbId: (value: string) =>
        new OMSSError('INVALID_TMDB_ID', 'TMDB ID must be numeric', 400, {
            parameter: 'id',
            value,
            expected: 'numeric string',
        }),

    noSourcesAvailable: (tmdbId: string, providersChecked: number) =>
        new OMSSError('NO_SOURCES_AVAILABLE', `No streaming sources found for TMDB ID: ${tmdbId}`, 404, {
            parameter: 'id',
            value: tmdbId,
            providersChecked,
            allProvidersFailed: true,
        }),

    invalidSeason: (season: number, maxSeason: number) =>
        new OMSSError('INVALID_SEASON', `Season ${season} is out of valid range (max: ${maxSeason})`, 400, { parameter: 's', value: season, maxSeason }),

    invalidEpisode: (episode: number, season: number, maxEpisode: number) =>
        new OMSSError('INVALID_EPISODE', `Episode ${episode} is out of valid range for season ${season}`, 400, { parameter: 'e', value: episode, season, maxEpisode }),

    invalidResponseId: (responseId: string) =>
        new OMSSError('INVALID_RESPONSE_ID', 'Invalid responseId format', 400, {
            parameter: 'responseId',
            value: responseId,
        }),

    responseIdNotFound: (responseId: string) => new OMSSError('RESPONSE_ID_NOT_FOUND', 'ResponseId not found or already refreshed', 404, { parameter: 'responseId', value: responseId }),

    internalError: (message: string) => new OMSSError('INTERNAL_ERROR', message, 500),
}

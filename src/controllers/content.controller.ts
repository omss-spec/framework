import { FastifyRequest, FastifyReply } from 'fastify'
import { SourceService } from '../services/source.service'

interface MovieParams {
    id: string
}

interface TVParams {
    id: string
    s: string
    e: string
}

interface RefreshParams {
    responseId: string
}

export class ContentController {
    constructor(private sourceService: SourceService) {}

    /**
     * GET /v1/movies/:id
     */
    async getMovie(request: FastifyRequest<{ Params: MovieParams }>, reply: FastifyReply) {
        const { id } = request.params
        const response = await this.sourceService.getMovieSources(id)
        return reply.code(200).send(response)
    }

    /**
     * GET /v1/tv/:id/seasons/:s/episodes/:e
     */
    async getTVEpisode(request: FastifyRequest<{ Params: TVParams }>, reply: FastifyReply) {
        const { id, s, e } = request.params
        const season = parseInt(s, 10)
        const episode = parseInt(e, 10)

        const response = await this.sourceService.getTVSources(id, season, episode)
        return reply.code(200).send(response)
    }

    /**
     * GET /v1/refresh/:responseId
     */
    async refreshSource(request: FastifyRequest<{ Params: RefreshParams }>, reply: FastifyReply) {
        const { responseId } = request.params
        await this.sourceService.refreshSource(responseId)
        return reply.code(200).send({ status: 'OK' })
    }
}

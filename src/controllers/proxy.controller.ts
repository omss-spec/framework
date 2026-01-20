import { FastifyRequest, FastifyReply } from 'fastify'
import { ProxyService } from '../services/proxy.service'

interface ProxyQuery {
    data: string
}

export class ProxyController {
    constructor(private proxyService: ProxyService) {}

    /**
     * GET /v1/proxy
     */
    async proxy(request: FastifyRequest<{ Querystring: ProxyQuery }>, reply: FastifyReply) {
        const { data } = request.query

        if (!data) {
            return reply.code(400).send({
                error: {
                    code: 'MISSING_PARAMETER',
                    message: 'Missing required parameter: data',
                },
                traceId: request.id,
            })
        }

        const response = await this.proxyService.proxyRequest(data)

        return reply
            .code(response.statusCode)
            .headers(response.headers || {})
            .type(response.contentType)
            .send(response.data)
    }
}

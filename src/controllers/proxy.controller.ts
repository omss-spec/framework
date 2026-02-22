import { FastifyRequest, FastifyReply } from 'fastify'
import { ProxyService, isStreamingResponse } from '../services/proxy.service.js'

interface ProxyQuery {
    data: string
}

export class ProxyController {
    constructor(private proxyService: ProxyService) {}

    /**
     * GET /v1/proxy
     */
    async proxy(request: FastifyRequest<{ Querystring: ProxyQuery }>, reply: FastifyReply): Promise<FastifyReply> {
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

        // Handle streaming response
        if (isStreamingResponse(response)) {
            reply
                .code(response.statusCode)
                .headers(response.headers)
                .type(response.contentType)
            
            return reply.send(response.stream)
        }

        // Handle buffered response
        return reply
            .code(response.statusCode)
            .headers(response.headers || {})
            .type(response.contentType)
            .send(response.data)
    }
}

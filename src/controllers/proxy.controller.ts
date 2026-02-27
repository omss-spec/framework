import { FastifyRequest, FastifyReply } from 'fastify'
import { ProxyService, isStreamingResponse } from '../services/proxy.service.js'
import { ProxyData } from '../core/types.js'

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

        // Decode and add proxyData with request headers (used for 'Ranges' in streams)
        let proxyDataRaw: ProxyData;
        try {
            const decoded = decodeURIComponent(data);
            proxyDataRaw = JSON.parse(decoded) as ProxyData;
        } catch (error) {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_PARAMETER',
                    message: 'Invalid data parameter format',
                },
                traceId: request.id,
            });
        }

        // Inject request headers
        const proxyData: ProxyData = {
            ...proxyDataRaw,
            // @ts-ignore
            headers: {
                ...proxyDataRaw.headers,
                // Forward range headers from client request
                ...(request.headers.range && { range: request.headers.range }),
                ...(request.headers.Range && { Range: request.headers.Range }),
            }
        };

        // Re-encode with enhanced data
        const enhancedData = encodeURIComponent(JSON.stringify(proxyData));

        const response = await this.proxyService.proxyRequest(enhancedData);

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

import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MCPRequest, MCPResponse } from '../core/types/index.js'
import { SourceService } from '../services/source.service.js'

interface ToolsCallParams {
    name: string
    arguments: {
        tmdbId: string
        mediaType: 'movie'
    } | {
        tmdbId: string
        mediaType: 'tv'
        season: number
        episode: number
    }
}

export class MCPController {
    constructor(private sourceService: SourceService) {}

    async handle(request: FastifyRequest, reply: FastifyReply) {
        const body = request.body as MCPRequest | undefined

        if (!body || !body.method) {
            return reply.code(400).send({
                id: body?.id ?? request.id,
                error: { code: 400, message: 'Invalid MCP request' },
            } satisfies MCPResponse)
        }

        switch (body.method) {
            case 'tools/list':
                return this.handleToolsList(body, reply)
            case 'tools/call':
                return this.handleToolsCall(body, reply)
            default:
                return reply.code(400).send({
                    id: body.id ?? request.id,
                    error: { code: 400, message: `Unsupported method: ${body.method}` },
                } satisfies MCPResponse)
        }
    }

    private async handleToolsList(req: MCPRequest, reply: FastifyReply) {
        const tools =[
            {
                name: 'omss_get_sources',
                description:
                    'Fetches streaming sources for a movie or TV episode by TMDB id using the OMSS backend.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        tmdbId: { type: 'string', description: 'TMDB id (stringified number).' },
                        mediaType: {
                            type: 'string',
                            enum: ['movie', 'tv'],
                            description: 'Type of media to fetch sources for.',
                        },
                        season: {
                            type: 'integer',
                            description: 'Season number (required for tv).',
                        },
                        episode: {
                            type: 'integer',
                            description: 'Episode number (required for tv).',
                        },
                    },
                    required: ['tmdbId', 'mediaType'],
                },
            },
        ]

        const res: MCPResponse = {
            id: req.id,
            result: { tools },
        }
        return reply.send(res)
    }

    private async handleToolsCall(req: MCPRequest, reply: FastifyReply) {
        const params = req.params as ToolsCallParams | undefined
        if (!params || !params.name) {
            return reply.code(400).send({
                id: req.id,
                error: { code: 400, message: 'Missing tool name in params' },
            } satisfies MCPResponse)
        }

        if (params.name !== 'omss_get_sources') {
            return reply.code(400).send({
                id: req.id,
                error: { code: 400, message: `Unknown tool: ${params.name}` },
            } satisfies MCPResponse)
        }

        const args = params.arguments as ToolsCallParams['arguments']
        if (!args?.tmdbId || !args?.mediaType) {
            return reply.code(400).send({
                id: req.id,
                error: {
                    code: 400,
                    message: 'tmdbId and mediaType are required',
                },
            } satisfies MCPResponse)
        }

        try {
            let result
            if (args.mediaType === 'movie') {
                // Reuse the movie path logic
                result = await this.sourceService.getMovieSources(args.tmdbId)
            } else {
                // mediaType === 'tv'
                if (
                    typeof args.season !== 'number' ||
                    typeof args.episode !== 'number'
                ) {
                    return reply.code(400).send({
                        id: req.id,
                        error: {
                            code: 400,
                            message:
                                'season and episode are required for mediaType=tv',
                        },
                    } satisfies MCPResponse)
                }

                result = await this.sourceService.getTVSources(
                    args.tmdbId,
                    args.season,
                    args.episode,
                )
            }

            const res: MCPResponse = {
                id: req.id,
                result, // this is the OMSS SourceResponse
            }
            return reply.send(res)
        } catch (err: any) {
            const res: MCPResponse = {
                id: req.id,
                error: {
                    code: 500,
                    message: 'Failed to fetch sources from OMSS',
                    data: { message: err?.message ?? String(err) },
                },
            }
            return reply.code(500).send(res)
        }
    }
}

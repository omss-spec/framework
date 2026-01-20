import { FastifyRequest, FastifyReply } from 'fastify'
import { HealthService } from '../services/health.service'

export class HealthController {
    constructor(private healthService: HealthService) {}

    /**
     * GET / or /v1 or /v1/health
     */
    async getHealth(request: FastifyRequest, reply: FastifyReply) {
        const health = this.healthService.getHealth()
        return reply.code(200).send(health)
    }
}

import { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { OMSSError } from '../core/errors'

export async function errorHandler(error: FastifyError | OMSSError, request: FastifyRequest, reply: FastifyReply) {
    // Log error for debugging
    console.error('[ErrorHandler]', {
        url: request.url,
        method: request.method,
        error: error.message,
        stack: error.stack,
    })

    // Handle OMSS-specific errors
    if (error instanceof OMSSError) {
        return reply.code(error.statusCode).send(error.toJSON())
    }

    // Handle Fastify validation errors
    if (error.validation) {
        return reply.code(400).send({
            error: {
                code: 'INVALID_PARAMETER',
                message: 'Request validation failed',
                details: error.validation,
            },
            traceId: request.id,
        })
    }

    // Handle 404 errors
    if (error.statusCode === 404) {
        return reply.code(404).send({
            error: {
                code: 'ENDPOINT_NOT_FOUND',
                message: 'The requested endpoint does not exist',
                details: {
                    path: request.url,
                    method: request.method,
                },
            },
            traceId: request.id,
        })
    }

    // Handle generic errors
    const statusCode = error.statusCode || 500
    return reply.code(statusCode).send({
        error: {
            code: 'INTERNAL_ERROR',
            message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
            details:
                process.env.NODE_ENV === 'production'
                    ? undefined
                    : {
                          stack: error.stack,
                      },
        },
        traceId: request.id,
    })
}

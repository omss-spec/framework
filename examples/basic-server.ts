import { OMSSServer } from '../src/index.js' // replace this in your own implementation with '@omss/framework'
import 'dotenv/config'

async function main() {
    const server = new OMSSServer({
        name: 'OMSS Backend',
        version: '1.0.0',
        // note: 'You can add a custom note here.'

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24,
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD,
            },
        },

        // TMDB (required)
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60, // 24h
        },

        proxyConfig: {
            knownThirdPartyProxies: {
                'hls1.vid1.site': [/\/proxy\/(.+)$/],
                'madplay.site': [/\/api\/[^/]+\/proxy\?url=(.+)$/],
                '*': [/\/proxy\/(.+)$/, /\/m3u8-proxy\?url=(.+?)(&|$)/, ],
            },
        },

        // You can override the default cors settings, by passing your own fastify cors options here. By default, it allows all origins.
        /*
        cors: {
            origin: '*',
            methods: ['GET', 'OPTIONS', 'HEAD'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
            exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges'],
        }
        */
    })

    // Register providers
    const registry = server.getRegistry()

    // Your custom providers (auto-discovered from ./src/providers/)
    await registry.discoverProviders('./examples/providers')

    // before starting the server, you can also modify any fastify instance settings, by getting the instance via server.getFastifyInstance() and calling any of its methods. For example, to add a custom route:
    /*
    const fastify = server.getFastifyInstance()
    fastify.get('/custom-route', async (request, reply) => {
        return { message: 'This is a custom route!' }
    })

    or add a custom hook/middleware/fastify plugin, etc...

    NOTE: If you want to add custom routes, hooks, or plugins *before mapping the default routes* (required for oauth2 for example), you cannot do this yet. If you wish to do this, please open an issue or submit a PR to add a new option in the server constructor that allows you to do this. For now, you can add custom routes, hooks, or plugins after the server has started.
    */

    await server.start()
}

main().catch(() => {
    process.exit(1)
})

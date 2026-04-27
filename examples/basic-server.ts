import { OMSSServer } from '../src' // replace this in your own implementation with '@omss/framework'
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

        stremio: {
            enableNativeAddon: true, // Whether to enable the native Stremio addon. can be used for your stremio app
            stremioAddons: [ // you can bind additional addons that will be checked during source discovery. has to end with /manifest.json and follow the stremio addon manifest schema
                /*
                {
                    id: '', // some id for your reference
                    url: '', // the url with /manifest.json at the end, for example: https://example.com/addon/manifest.json
                }
                */
            ]
        },

        // MCP (Model Context Protocol) for exposing your providers and the scraping capabilities of your server to LLMs and other intelligent agents, via a simple JSON-RPC-like API. This is an optional feature, but can be useful when you want to integrate your server with LLMs or other intelligent agents (like when you want to be able to "Hey <agent> i want to watch the dark knight, can you find me a source for that?")
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true', // Whether to enable the MCP controller and endpoints
            path: '/mcp', // default: /mcp - The path where the MCP endpoint will be exposed. You can change this if you want to expose it on a different path.
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
                '*': [/\/proxy\/(.+)$/, /\/m3u8-proxy\?url=(.+?)(&|$)/],
            },
            streamPatterns: [
                /\.mp4($|\?)/i,
                /\.mkv($|\?)/i,
                /\.webm($|\?)/i,
                /\.avi($|\?)/i,
                /\.mov($|\?)/i,
                // here you could add more patterns for other video formats
                // or downloader domains (like pixeldrain, where the video format is not in the url)
            ],
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

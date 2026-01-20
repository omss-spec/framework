import { CacheConfig } from '../core/types'
import Redis from 'ioredis'

export interface CacheService {
    get<T>(key: string): Promise<T | null>
    set(key: string, value: any, ttl?: number): Promise<void>
    delete(key: string): Promise<void>
    clear(): Promise<void>
}

export class MemoryCacheService implements CacheService {
    private cache = new Map<string, { value: any; expiresAt: number }>()
    private cleanupInterval: NodeJS.Timeout

    constructor() {
        // Cleanup expired entries every minute
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000)
    }

    async get<T>(key: string): Promise<T | null> {
        const entry = this.cache.get(key)

        if (!entry) return null

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key)
            return null
        }

        return entry.value as T
    }

    async set(key: string, value: any, ttl: number = 7200): Promise<void> {
        const expiresAt = Date.now() + ttl * 1000
        this.cache.set(key, { value, expiresAt })
    }

    async delete(key: string): Promise<void> {
        this.cache.delete(key)
    }

    async clear(): Promise<void> {
        this.cache.clear()
    }

    private cleanup(): void {
        const now = Date.now()
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key)
            }
        }
    }

    destroy(): void {
        clearInterval(this.cleanupInterval)
        this.cache.clear()
    }
}

export class RedisCacheService implements CacheService {
    private client: Redis

    constructor(config: CacheConfig['redis']) {
        this.client = new Redis({
            host: config?.host || 'localhost',
            port: config?.port || 6379,
            password: config?.password,
            retryStrategy: (times) => Math.min(times * 50, 2000),
        })

        this.client.on('error', (err) => {
            console.error('[Redis] Connection error:', err)
        })

        this.client.on('connect', () => {
            console.log('[Redis] Connected successfully')
        })
    }

    async get<T>(key: string): Promise<T | null> {
        const value = await this.client.get(key)
        return value ? JSON.parse(value) : null
    }

    async set(key: string, value: any, ttl: number = 7200): Promise<void> {
        await this.client.setex(key, ttl, JSON.stringify(value))
    }

    async delete(key: string): Promise<void> {
        await this.client.del(key)
    }

    async clear(): Promise<void> {
        await this.client.flushdb()
    }

    async disconnect(): Promise<void> {
        await this.client.quit()
    }
}

export function createCacheService(config?: CacheConfig): CacheService {
    if (!config || config.type === 'memory') {
        console.log('[Cache] Using in-memory cache')
        return new MemoryCacheService()
    }

    if (config.type === 'redis') {
        console.log('[Cache] Using Redis cache')
        return new RedisCacheService(config.redis)
    }

    throw new Error(`Unknown cache type: ${config.type}`)
}

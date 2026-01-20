import { BaseProvider } from './base-provider'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'

export interface ProviderRegistryConfig {
    proxyBaseUrl?: string
    host?: string
    port?: number
    protocol?: 'http' | 'https'
}

export class ProviderRegistry {
    private providers: Map<string, BaseProvider> = new Map()

    constructor(config?: ProviderRegistryConfig) {
        // Set proxy configuration for all providers
        if (config) {
            BaseProvider.setProxyConfig({
                baseUrl: config.proxyBaseUrl,
                host: config.host,
                port: config.port,
                protocol: config.protocol,
            })
        }
    }

    /**
     * Register a provider instance
     */
    register(provider: BaseProvider): void {
        if (this.providers.has(provider.id)) {
            throw new Error(`Provider with id '${provider.id}' is already registered`)
        }
        this.providers.set(provider.id, provider)
        console.log(`[ProviderRegistry] Registered provider: ${provider.name} (${provider.id})`)
    }

    /**
     * Unregister a provider
     */
    unregister(providerId: string): boolean {
        return this.providers.delete(providerId)
    }

    /**
     * Auto-discover and register providers from a directory
     */
    async discoverProviders(directory: string): Promise<void> {
        try {
            const absoluteDir = path.resolve(directory)

            const dirExists = await fs
                .access(absoluteDir)
                .then(() => true)
                .catch(() => false)
            if (!dirExists) {
                console.warn(`[ProviderRegistry] Directory does not exist: ${absoluteDir}`)
                return
            }

            const files = await fs.readdir(absoluteDir)
            console.log(`[ProviderRegistry] Scanning ${files.length} file(s) in ${absoluteDir}`)

            for (const file of files) {
                if (!file.endsWith('.js') && !file.endsWith('.ts')) continue
                if (file.includes('.test.') || file.includes('.spec.')) continue
                if (file.endsWith('.d.ts')) continue

                const filePath = path.resolve(absoluteDir, file)

                try {
                    const fileUrl = pathToFileURL(filePath).href

                    console.log(`[ProviderRegistry] Loading provider from: ${file}`)
                    const module = await import(fileUrl)

                    let foundProvider = false
                    for (const exportName of Object.keys(module)) {
                        const ExportedClass = module[exportName]

                        if (typeof ExportedClass === 'function' && ExportedClass.prototype instanceof BaseProvider) {
                            const instance = new ExportedClass()
                            this.register(instance)
                            foundProvider = true
                        }
                    }

                    if (!foundProvider) {
                        console.warn(`[ProviderRegistry] No provider classes found in ${file}`)
                    }
                } catch (error) {
                    console.error(`[ProviderRegistry] Failed to load provider from ${file}:`, error)
                }
            }

            console.log(`[ProviderRegistry] Discovery complete. Total providers: ${this.providers.size}`)
        } catch (error) {
            console.error(`[ProviderRegistry] Failed to discover providers in ${directory}:`, error)
        }
    }

    /**
     * Get all providers
     */
    getProviders(): BaseProvider[] {
        return Array.from(this.providers.values())
    }

    /**
     * Get provider by ID
     */
    getProvider(id: string): BaseProvider | undefined {
        return this.providers.get(id)
    }

    /**
     * Get enabled providers only
     */
    getEnabledProviders(): BaseProvider[] {
        return this.getProviders().filter((p) => p.enabled)
    }

    /**
     * Check if a provider exists
     */
    hasProvider(id: string): boolean {
        return this.providers.has(id)
    }

    /**
     * Get provider count
     */
    get count(): number {
        return this.providers.size
    }

    /**
     * Health check all providers
     */
    async healthCheckAll(): Promise<Map<string, boolean>> {
        const results = new Map<string, boolean>()

        for (const provider of this.providers.values()) {
            try {
                const healthy = await provider.healthCheck()
                results.set(provider.id, healthy)
            } catch (error) {
                results.set(provider.id, false)
            }
        }

        return results
    }

    /**
     * List all registered provider IDs
     */
    listProviders(): string[] {
        return Array.from(this.providers.keys())
    }

    /**
     * Clear all providers
     */
    clear(): void {
        this.providers.clear()
        console.log('[ProviderRegistry] Cleared all providers')
    }
}

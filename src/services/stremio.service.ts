import { BaseProvider } from '../providers/base-provider.js'
import type { Diagnostic, StremioAddonConfig, ProviderMediaObject, ProviderResult, Source, Subtitle } from '../core/types/index.js'
import { ProxyService } from './proxy.service.js'
import { safeId } from '../utils/string.js'

interface StremioStream {
    title?: string
    name?: string
    url: string
    description?: string
    behaviorHints?: {
        notWebReady?: boolean
        proxyHeaders?: {
            request: Record<string, string>
        }
    }
}

export class StremioService {
    private proxyService: ProxyService

    constructor(
        private addons: StremioAddonConfig[] = [],
        proxyService: ProxyService
    ) {
        this.proxyService = proxyService
    }

    hasEnabledAddons(): boolean {
        return this.addons.some((a) => a.enabled !== false)
    }

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.fetchStreams('movie', media)
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.fetchStreams('series', media)
    }

    private buildStremioId(type: 'movie' | 'series', media: ProviderMediaObject): string | null {
        // Prefer IMDb if present – most addons expect it
        if (!media.imdbId) return null

        if (type === 'movie') {
            return media.imdbId.startsWith('tt') ? media.imdbId : `tt${media.imdbId}`
        }

        // series: tt{id}:s{season}:e{episode}
        if (media.s != null && media.e != null) {
            return media.imdbId.startsWith('tt') ? `${media.imdbId}:s${media.s}:e${media.e}` : `tt${media.imdbId}:s${media.s}:e${media.e}`
        }

        return null
    }

    private async fetchStreams(type: 'movie' | 'series', media: ProviderMediaObject): Promise<ProviderResult> {
        const startTime = Date.now()

        const enabled = this.addons.filter((a) => a.enabled !== false)
        console.log(`[StremioService] Fetching streams for ${type} (${enabled.length} addon(s) enabled)`)

        if (!enabled.length) {
            console.warn('[StremioService] No enabled addons')
            return { sources: [], subtitles: [], diagnostics: [] }
        }

        const id = this.buildStremioId(type, media)
        if (!id) {
            console.warn('[StremioService] Missing IMDb id, cannot query addons')
            return {
                sources: [],
                subtitles: [],
                diagnostics: [
                    {
                        code: 'PROVIDER_ERROR',
                        message: 'Missing IMDb id – cannot query Stremio addons',
                        field: 'imdbId',
                        severity: 'warning',
                    },
                ],
            }
        }

        const promises = enabled.map((a) =>
            this.fetchAddonStreams(a, type, id).catch((err) => {
                console.log(`[StremioService] Addon '${a.id}' failed:`, err)
                return {
                    addonId: safeId(a.id),
                    streams: [],
                    error: err instanceof Error ? err.message : String(err),
                }
            })
        )

        const results = await Promise.all(promises)

        const allSources: Source[] = []
        const allSubtitles: Subtitle[] = []
        const diagnostics: Diagnostic[] = []

        let totalStreams = 0
        let validStreams = 0

        for (const r of results) {
            if ('error' in r) {
                diagnostics.push({
                    code: 'PROVIDER_ERROR',
                    message: `Stremio addon '${safeId(r.addonId)}' failed: ${r.error}`,
                    field: '',
                    severity: 'error',
                })
                continue
            }

            totalStreams += r.streams.length

            for (const stream of r.streams) {
                if (!stream.url.startsWith('https://')) {
                    console.debug(`[StremioService] Skipping non-HTTPS stream from '${safeId(r.addonId)}': ${stream.url}`)
                    continue
                }

                let url = BaseProvider.getProxyBaseUrl()

                if (stream.behaviorHints?.proxyHeaders?.request) {
                    url += this.proxyService.createProxyUrl(stream.url, stream.behaviorHints.proxyHeaders.request)
                } else {
                    url += this.proxyService.createProxyUrl(stream.url)
                }

                validStreams++

                allSources.push({
                    url,
                    type: this.inferSourceType(stream),
                    quality: this.inferQuality(stream),
                    audioTracks: [
                        {
                            label: 'Unknown (fallback: Stremio Addons do not have a standard way to specify audio track info)',
                            language: 'und',
                        },
                    ],
                    provider: {
                        id: `stremio:${safeId(r.addonId)}`,
                        name: `Stremio ${safeId(r.addonId).replace(/\./g, ' ')}`,
                    },
                })
            }
        }

        const duration = Date.now() - startTime

        return { sources: allSources, subtitles: allSubtitles, diagnostics }
    }

    private async fetchAddonStreams(addon: StremioAddonConfig, type: 'movie' | 'series', id: string): Promise<{ addonId: string; streams: StremioStream[] }> {
        const startTime = Date.now()

        const controller = new AbortController()
        const timeout = addon.timeoutMs != null ? setTimeout(() => controller.abort(), addon.timeoutMs) : null

        try {
            const url = `${addon.url.replace(/\/$/, '')}/stream/${type}/${encodeURIComponent(id)}.json`.replace('/manifest.json', '')

            const res = await fetch(url, { signal: controller.signal })

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`)
            }

            const json = (await res.json()) as unknown as { streams: StremioStream[] }
            const streams = Array.isArray(json.streams) ? json.streams : []

            const duration = Date.now() - startTime

            console.log(`[StremioService] Stremio Addon '${addon.id}' returned ${streams.length} source(s) in ${duration}ms`)

            return { addonId: safeId(addon.id), streams }
        } finally {
            if (timeout) clearTimeout(timeout)
        }
    }

    private inferSourceType(stream: StremioStream): Source['type'] {
        const url = stream.url.toLowerCase()
        const longText = (stream.name ? stream.name + ' ' + stream.title + ' ' + stream.description : '').toLowerCase()

        if (url.includes('.m3u8')) return 'hls'
        if (url.includes('.mpd')) return 'dash'
        if (url.includes('.mp4')) return 'mp4'
        if (url.includes('.mkv')) return 'mkv'
        if (url.includes('.webm')) return 'webm'
        if (longText.includes('gb')) return 'mp4' // most descriptions that have GB in them are mp4 or mkv files

        return 'hls'
    }

    private inferQuality(stream: StremioStream): Source['quality'] {
        const longText = (stream.name ? stream.name + ' ' + stream.title + ' ' + stream.description : '').toLowerCase()
        // find for 'p' and get the number before it, which usually indicates quality (e.g. 1080p, 720p)
        const match = longText.match(/(\d{3,4})p/)
        if (match) {
            return match[1] + 'p'
        }
        // try with 'k' like 4k
        const matchK = longText.match(/(\d{1,2})k/)
        if (matchK) {
            return matchK[1] + 'k'
        }

        return 'Auto'
    }
}

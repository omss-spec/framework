import axios from 'axios'
import { ProxyData } from '../core/types'
import { OMSSError } from '../core/errors'

export interface ProxyResponse {
    data: Buffer | string
    contentType: string
    statusCode: number
    headers?: Record<string, string>
}

export class ProxyService {
    /**
     * Proxy a request to an upstream provider
     */
    async proxyRequest(encodedData: string): Promise<ProxyResponse> {
        // Decode the data parameter
        const proxyData = this.decodeProxyData(encodedData)

        console.log(`[ProxyService] Proxying request to: ${proxyData.url}`)

        try {
            const response = await axios.get(proxyData.url, {
                headers: {
                    ...proxyData.headers,
                    'User-Agent': proxyData.headers?.['User-Agent'] || 'OMSS-Backend/1.0',
                },
                responseType: 'arraybuffer',
                timeout: 30000, // 30 second timeout
                maxRedirects: 5,
                validateStatus: (status) => status < 500, // Accept 4xx errors
            })

            // Check if we need to rewrite manifest files
            const contentType = response.headers['content-type'] || ''
            let responseData = response.data

            if (this.isManifestFile(contentType, proxyData.url)) {
                const manifestContent = response.data.toString('utf-8')
                const rewrittenContent = this.rewriteManifest(manifestContent, proxyData.url, proxyData.headers)
                responseData = Buffer.from(rewrittenContent, 'utf-8')
            }

            return {
                data: responseData,
                contentType: contentType,
                statusCode: response.status,
                headers: {
                    'Cache-Control': response.headers['cache-control'] || 'public, max-age=300',
                    'Access-Control-Allow-Origin': '*',
                },
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response) {
                    throw new OMSSError('INTERNAL_ERROR', `Upstream returned ${error.response.status}`, error.response.status, { url: proxyData.url })
                }

                throw new OMSSError('INTERNAL_ERROR', `Failed to proxy request: ${error.message}`, 500, { url: proxyData.url })
            }

            throw error
        }
    }

    /**
     * Decode proxy data parameter
     */
    private decodeProxyData(encodedData: string): ProxyData {
        try {
            const decoded = decodeURIComponent(encodedData)
            const data = JSON.parse(decoded) as ProxyData

            if (!data.url) {
                throw new Error('Missing url field in proxy data')
            }

            return data
        } catch (error) {
            throw new OMSSError('INVALID_PARAMETER', 'Invalid data parameter format', 400, {
                parameter: 'data',
                error: error instanceof Error ? error.message : 'Unknown',
            })
        }
    }

    /**
     * Check if the response is a manifest file that needs rewriting
     */
    private isManifestFile(contentType: string, url: string): boolean {
        return (
            contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/dash+xml') ||
            (contentType.includes('text/plain') && url.includes('.m3u8')) ||
            url.endsWith('.m3u8') ||
            url.endsWith('.mpd')
        )
    }

    /**
     * Rewrite manifest file URLs to go through proxy
     * Handles all URL formats: absolute (http/https), protocol-relative (//), root-relative (/), and relative
     * Also rewrites URLs in tag attributes like URI="..."
     */
    private rewriteManifest(content: string, baseUrl: string, headers?: Record<string, string>): string {
        const lines = content.split('\n')
        const rewrittenLines: string[] = []

        for (const line of lines) {
            const trimmedLine = line.trim()

            // Handle tag lines with URI attributes (e.g., #EXT-X-KEY)
            if (line.startsWith('#') && this.hasUriAttribute(line)) {
                rewrittenLines.push(this.rewriteTagAttributes(line, baseUrl, headers))
                continue
            }

            // Skip other comments and empty lines
            if (line.startsWith('#') || trimmedLine === '') {
                rewrittenLines.push(line)
                continue
            }

            // Detect if this line contains a URL
            if (this.isUrlLine(trimmedLine)) {
                const resolvedUrl = this.resolveUrl(baseUrl, trimmedLine)
                const proxiedUrl = this.createProxyUrl(resolvedUrl, headers)

                // Preserve original indentation
                const indent = line.match(/^\s*/)?.[0] || ''
                rewrittenLines.push(indent + proxiedUrl)
            } else {
                // Not a URL line, keep as-is
                rewrittenLines.push(line)
            }
        }

        return rewrittenLines.join('\n')
    }

    /**
     * Check if a tag line has URI attributes that need rewriting
     */
    private hasUriAttribute(line: string): boolean {
        return /URI\s*=\s*["']([^"']+)["']/i.test(line)
    }

    /**
     * Rewrite URI attributes in HLS tags
     * Examples:
     *   #EXT-X-KEY:METHOD=AES-128,URI="/storage/enc.key",IV=...
     *   #EXT-X-MAP:URI="init.mp4",BYTERANGE="..."
     */
    private rewriteTagAttributes(line: string, baseUrl: string, headers?: Record<string, string>): string {
        // Match URI="..." or URI='...'
        return line.replace(/URI\s*=\s*["']([^"']+)["']/gi, (match, capturedUrl) => {
            const resolvedUrl = this.resolveUrl(baseUrl, capturedUrl)
            const proxiedUrl = this.createProxyUrl(resolvedUrl, headers)

            // Preserve the quote style from the original
            const quote = match.includes('"') ? '"' : "'"
            return `URI=${quote}${proxiedUrl}${quote}`
        })
    }

    /**
     * Check if a line contains a URL
     */
    private isUrlLine(line: string): boolean {
        // Absolute URLs
        if (line.startsWith('http://') || line.startsWith('https://')) {
            return true
        }

        // Protocol-relative URLs
        if (line.startsWith('//')) {
            return true
        }

        // Root-relative URLs
        if (line.startsWith('/')) {
            return true
        }

        // Relative URLs (files with extensions or paths)
        // Common patterns: segment.ts, playlist.m3u8, path/to/file.mp4
        if (
            line.includes('.ts') ||
            line.includes('.m3u8') ||
            line.includes('.mp4') ||
            line.includes('.m4s') ||
            line.includes('.webm') ||
            line.includes('.vtt') ||
            line.includes('.key') ||
            line.includes('/') ||
            /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/.test(line) // filename.extension pattern
        ) {
            return true
        }

        return false
    }

    /**
     * Resolve a URL against a base URL
     * Handles: absolute, protocol-relative, root-relative, and relative URLs
     */
    private resolveUrl(baseUrl: string, targetUrl: string): string {
        try {
            // Absolute URL (http:// or https://)
            if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
                return targetUrl
            }

            const baseUrlObj = new URL(baseUrl)

            // Protocol-relative URL (//example.com/path)
            if (targetUrl.startsWith('//')) {
                return `${baseUrlObj.protocol}${targetUrl}`
            }

            // Root-relative URL (/path/to/file)
            if (targetUrl.startsWith('/')) {
                return `${baseUrlObj.protocol}//${baseUrlObj.host}${targetUrl}`
            }

            // Relative URL (path/to/file or file.ts)
            // Resolve against the base URL's directory
            const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)
            return new URL(targetUrl, baseDir).toString()
        } catch (error) {
            console.warn(`[ProxyService] Failed to resolve URL: ${targetUrl} against ${baseUrl}`)
            // Fallback: try to construct a valid URL
            try {
                const baseUrlObj = new URL(baseUrl)
                const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)
                return baseDir + targetUrl
            } catch {
                return targetUrl // Last resort: return as-is
            }
        }
    }

    /**
     * Create a proxy URL for a given upstream URL
     * ALWAYS includes headers from the original request
     */
    private createProxyUrl(url: string, headers?: Record<string, string>): string {
        const data = JSON.stringify({ url, headers })
        return `/v1/proxy?data=${encodeURIComponent(data)}`
    }

    /**
     * Encode a URL for proxy usage (helper for providers)
     */
    static encodeProxyUrl(url: string, headers?: Record<string, string>): string {
        const data = JSON.stringify({ url, headers })
        return `/v1/proxy?data=${encodeURIComponent(data)}`
    }
}

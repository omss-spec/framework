import axios, { AxiosResponse } from 'axios'
import { Readable } from 'stream'
import { ProxyData } from '../core/types.js'
import { OMSSError } from '../core/errors.js'

export interface ProxyResponse {
    data: Buffer | string
    contentType: string
    statusCode: number
    headers?: Record<string, string>
}

export interface StreamingProxyResponse {
    stream: Readable
    contentType: string
    statusCode: number
    headers: Record<string, string>
}

export type ProxyResult = ProxyResponse | StreamingProxyResponse

export function isStreamingResponse(response: ProxyResult): response is StreamingProxyResponse {
    return 'stream' in response && true
}

export class ProxyService {
    private isProd: boolean = process.env.NODE_ENV === 'production'
    private streamPatterns: RegExp[]

    constructor(streamPatterns?: RegExp[]) {
        // Default patterns if none provided
        const defaultPatterns: RegExp[] = [/\\.mp4($|\\?)/, /\\.mkv($|\\?)/, /\\.webm($|\\?)/, /\\.avi($|\\?)/, /\\.mov($|\\?)/]

        // Ensure default patterns are included when no streamPatterns are provided
        const patterns = streamPatterns ? [...streamPatterns, ...defaultPatterns] : [...defaultPatterns]

        // Compile regex patterns
        this.streamPatterns = patterns
            .map((pattern) => {
                try {
                    return new RegExp(pattern, 'i') // case-insensitive
                } catch (error) {
                    console.warn(`[ProxyService] Invalid regex pattern: ${pattern}`, error)
                    return null
                }
            })
            .filter((pattern): pattern is RegExp => pattern !== null)
    }

    /**
     * Proxy a request to an upstream provider
     * Returns either buffered response or streaming response based on file type
     */
    async proxyRequest(encodedData: string): Promise<ProxyResult> {
        const proxyData = this.decodeProxyData(encodedData)

        this.isProd ?? console.log(`[ProxyService] Proxying request to: ${proxyData.url}`)

        try {
            // Determine if this should be streamed
            if (this.shouldStream(proxyData.url)) {
                return await this.handleStreamingRequest(proxyData)
            }

            // Handle buffered request for small files
            return await this.handleBufferedRequest(proxyData)
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
     * Determine if a URL should be streamed based on file type
     */
    private shouldStream(url: string): boolean {
        return this.streamPatterns.some(pattern => pattern.test(url))
    }

    /**
     * Handle streaming request for large files
     */
    private async handleStreamingRequest(proxyData: ProxyData): Promise<StreamingProxyResponse> {
        const rangeHeader = proxyData.headers?.['range'] || proxyData.headers?.['Range']

        const axiosHeaders = {
            ...proxyData.headers,
            'User-Agent': proxyData.headers?.['User-Agent'] || 'OMSS-Backend/1.0',
            ...(rangeHeader && { Range: rangeHeader }),
        }

        const response: AxiosResponse<Readable> = await axios.get(proxyData.url, {
            headers: axiosHeaders,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
        })

        const contentType = response.headers['content-type'] || this.getMimeType(proxyData.url)

        // Build headers object
        const headers: Record<string, string> = {
            'Content-Disposition': 'inline; filename="stream"',
            'Cache-Control': response.headers['cache-control'] || 'public, max-age=7200',
            'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Range, Last-Modified, ETag',
            ...(response.headers['accept-ranges'] || response.headers['accept-range']
                ? {
                      'Accept-Ranges': response.headers['accept-ranges'] || response.headers['accept-range'] || 'bytes',
                  }
                : {}),
        }

        // Add optional headers if present
        if (response.headers['content-length']) {
            headers['Content-Length'] = response.headers['content-length']
        }
        if (response.headers['content-range']) {
            headers['Content-Range'] = response.headers['content-range']
        }
        if (response.headers['last-modified']) {
            headers['Last-Modified'] = response.headers['last-modified']
        }
        if (response.headers['etag']) {
            headers['ETag'] = response.headers['etag']
        }

        return {
            stream: response.data,
            contentType,
            statusCode: response.status,
            headers,
        }
    }

    /**
     * Handle buffered request for small files (original implementation)
     */
    private async handleBufferedRequest(proxyData: ProxyData): Promise<ProxyResponse> {
        const response: AxiosResponse<Buffer> = await axios.get(proxyData.url, {
            headers: {
                ...proxyData.headers,
                'User-Agent': proxyData.headers?.['User-Agent'] || 'OMSS-Backend/1.0',
            },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
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
            contentType: contentType || this.getMimeType(proxyData.url),
            statusCode: response.status,
            headers: {
                'Content-Disposition': 'inline',
                'Accept-Ranges': 'bytes',
                'Cache-Control': response.headers['cache-control'] || 'public, max-age=7200',
                ...(response.headers['content-length'] && { 'Content-Length': response.headers['content-length'] }),
                ...(response.headers['content-range'] && { 'Content-Range': response.headers['content-range'] }),
            },
        }
    }

    /**
     * Determine MIME type from URL or content
     */
    private getMimeType(url: string): string {
        if (url.match(/\.vtt$/i)) return 'text/vtt'
        if (url.match(/\.srt$/i)) return 'text/plain'
        if (url.match(/\.ass|\.ssa$/i)) return 'text/plain'
        if (url.match(/\.m3u8$/i)) return 'application/x-mpegURL'
        if (url.match(/\.mpd$/i)) return 'application/dash+xml'
        if (url.match(/\.mp4$/i)) return 'video/mp4'
        if (url.match(/\.mkv$/i)) return 'video/x-matroska'
        if (url.match(/\.webm$/i)) return 'video/webm'
        if (url.match(/\.avi$/i)) return 'video/x-msvideo'
        if (url.match(/\.mov$/i)) return 'video/quicktime'
        if (url.match(/\.ts$/i)) return 'video/mp2t'
        return 'application/octet-stream'
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
        return line.includes('.ts') ||
            line.includes('.m3u8') ||
            line.includes('.mp4') ||
            line.includes('.m4s') ||
            line.includes('.webm') ||
            line.includes('.vtt') ||
            line.includes('.key') ||
            line.includes('/') ||
            /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/.test(line);

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
            this.isProd ?? console.warn(`[ProxyService] Failed to resolve URL: ${targetUrl} against ${baseUrl}`)
            // Fallback: try to construct a valid URL
            try {
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
}

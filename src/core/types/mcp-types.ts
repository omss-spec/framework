export interface MCPConfig {
    enabled: boolean
    path?: string
}

export type MCPMethod = 'tools/list' | 'tools/call'

export interface MCPRequest {
    id: string | number
    method: MCPMethod
    params?: Record<string, unknown>
}

export interface MCPResponse {
    id: string | number
    result?: unknown
    error?: {
        code: number
        message: string
        data?: unknown
    }
}

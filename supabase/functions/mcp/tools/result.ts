import type { CallToolResult } from 'npm:@modelcontextprotocol/server@2.0.0'

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }], structuredContent: value as Record<string, unknown> }
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function str(v: unknown, k: string): string | null {
  if (!v || typeof v !== 'object' || !(k in v)) return null
  const p = (v as Record<string, unknown>)[k]
  return typeof p === 'string' && p ? p : null
}

// Supabase errors carry a code and hint; both help the model fix its next call. Never leak claims or stacks.
export function failFrom(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : str(error, 'message') ?? String(error)
  const code = str(error, 'code'), hint = str(error, 'hint')
  return fail([code ? `[${code}]` : null, message, hint ? `Hint: ${hint}` : null].filter(Boolean).join(' '))
}

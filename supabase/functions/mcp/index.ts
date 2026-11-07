import 'jsr:@supabase/functions-js@2.108.2/edge-runtime.d.ts'

import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { pipeline } from 'npm:@supabase/middleware@1'
import { withOAuthProtectedResource, withSupabase, type SupabaseContext } from 'npm:@supabase/server@1'

import { registerTools, type ToolContext } from './tools/index.ts'

// Intesa's MCP server, one Edge Function:
//   withOAuthProtectedResource  OAuth discovery for Claude, Grok and any other MCP client.
//   withSupabase                Verifies the token and hands tools a client that acts as the signed-in person,
//                               so Row Level Security decides what they can see: their own map, nothing else.
//   handleMcp                   The tools (./tools/index.ts).
// Agents sign in through OAuth; the token carries their client id, which Postgres records on every write.

const env = (k: string, d: string) => Deno.env.get(k)?.trim() || d
const SERVER_NAME = env('MCP_SERVER_NAME', 'intesa')
const SERVER_DESCRIPTION = env(
  'MCP_SERVER_DESCRIPTION',
  'Your Intesa map: the people you know, what you remember about them, and what you owe them.'
)
const SERVER_INSTRUCTIONS =
  `${SERVER_DESCRIPTION} ` +
  'Everything runs as the signed-in person and touches only their own map. ' +
  'People have rings: 1 = known first-hand, 2 = seen beside someone they know, 3 = only mentioned. ' +
  'Prefer search_people before creating anyone, so the same person is not added twice. ' +
  'Writes are recorded with your client id and shown to the person as made by you.'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
}

function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS })
  registerTools(server, context)
  return server
}

async function handleMcp(request: Request, ctx: SupabaseContext): Promise<Response> {
  const handler = createMcpHandler(
    () => createServer({ supabase: ctx.supabase, userClaims: ctx.userClaims!, jwtClaims: ctx.jwtClaims! }),
    { onerror: (error) => console.error('MCP request failed', error) }
  )
  return handler.fetch(request)
}

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: 'user', cors: { headers: CORS_HEADERS } })],
    (request, ctx) => handleMcp(request, ctx)
  )
)

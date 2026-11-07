import type { SupabaseContext } from 'npm:@supabase/server@1'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2'

// Tools see only the user-scoped client and the verified identity. No admin client: RLS is the boundary.
export type ToolContext = {
  supabase: SupabaseClient
  userClaims: NonNullable<SupabaseContext['userClaims']>
  jwtClaims: NonNullable<SupabaseContext['jwtClaims']>
}

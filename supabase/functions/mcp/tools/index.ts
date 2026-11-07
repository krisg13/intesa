import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@^4.1.0'

import { ok, fail, failFrom } from './result.ts'
import type { ToolContext } from './types.ts'

export type { ToolContext } from './types.ts'

// ───────────────────────── shapes ─────────────────────────
const PERSON_COLS =
  'id,name,title,company,school,city,tags,ring,work_email,personal_email,phone,linkedin,facebook,instagram,x_handle,met_where,met_when,sources,created_by,created_at,updated_at'
const personFields = {
  name: z.string().min(1).optional().describe('Full name'),
  title: z.string().optional().describe('Role or job title'),
  company: z.string().optional(),
  school: z.string().optional(),
  city: z.string().optional(),
  tags: z.array(z.string()).optional().describe('Interests, lower case, e.g. ["cycling","fintech"]'),
  ring: z.number().int().min(1).max(3).optional().describe('1 known first-hand, 2 seen beside someone known, 3 only mentioned'),
  work_email: z.string().optional(),
  personal_email: z.string().optional(),
  phone: z.string().optional(),
  linkedin: z.string().optional().describe('URL or handle'),
  facebook: z.string().optional(),
  instagram: z.string().optional(),
  x_handle: z.string().optional(),
  met_where: z.string().optional().describe('Where you met, e.g. "SXSW 2025"'),
  met_when: z.string().optional().describe('When you met, free text, e.g. "Mar 2025"'),
}
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
const YOU = '00000000-0000-0000-0000-000000000000'

// PostgREST filter strings cannot take these characters; strip them from free text.
const clean = (s: string) => s.replace(/[,().%*\\]/g, ' ').trim()
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export function registerTools(server: McpServer, { supabase, userClaims, jwtClaims }: ToolContext): void {
  const clientId = typeof jwtClaims?.client_id === 'string' && jwtClaims.client_id ? jwtClaims.client_id : null

  // Resolve a name or id to one person's id. Names must match exactly one person.
  async function personId(ref: string): Promise<{ id: string } | { error: string }> {
    if (isUuid(ref)) return { id: ref }
    const q = clean(ref)
    if (!q) return { error: 'Give a person id or a name.' }
    const { data, error } = await supabase.from('people').select('id,name').ilike('name', `%${q}%`).limit(5)
    if (error) return { error: error.message }
    const exact = (data ?? []).filter((p) => p.name.toLowerCase() === q.toLowerCase())
    const hits = exact.length ? exact : data ?? []
    if (hits.length === 1) return { id: hits[0].id }
    if (!hits.length) return { error: `Nobody named "${ref}". Use search_people, or create_person.` }
    return { error: `Several people match "${ref}": ${hits.map((p) => `${p.name} (${p.id})`).join(', ')}. Use an id.` }
  }
  async function listId(name: string, create: boolean): Promise<string | null> {
    const { data } = await supabase.from('lists').select('id').ilike('name', clean(name)).limit(1).maybeSingle()
    if (data) return data.id
    if (!create) return null
    const { data: made, error } = await supabase.from('lists').insert({ name }).select('id').single()
    if (error) throw error
    return made.id
  }

  // ───────────────────────── identity ─────────────────────────
  server.registerTool(
    'whoami',
    { description: "The signed-in person's identity and, for an agent, its OAuth client id.", annotations: READ },
    async () => {
      const { data } = await supabase.from('profiles').select('name,city,company').eq('id', userClaims.id).maybeSingle()
      return ok({ id: userClaims.id, email: userClaims.email ?? null, name: data?.name || null, city: data?.city || null, company: data?.company || null, client_id: clientId })
    }
  )

  // ───────────────────────── people ─────────────────────────
  server.registerTool(
    'search_people',
    {
      description:
        'Find people on the map by name, company, title, city, school or tag. Empty query lists everyone, nearest ring first. Call this before create_person.',
      inputSchema: {
        query: z.string().optional().describe('Free text; matched against name, company, title, city, school and tags'),
        ring: z.number().int().min(1).max(3).optional(),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      annotations: READ,
    },
    async ({ query, ring, limit }) => {
      let q = supabase.from('people').select('id,name,title,company,city,school,ring,tags,met_where,met_when,created_by').order('ring').order('name').limit(limit ?? 25)
      if (ring) q = q.eq('ring', ring)
      const t = clean(query ?? '')
      if (t) q = q.or(`name.ilike.%${t}%,company.ilike.%${t}%,title.ilike.%${t}%,city.ilike.%${t}%,school.ilike.%${t}%,tags.cs.{"${t.toLowerCase()}"}`)
      const { data, error } = await q
      if (error) return failFrom(error)
      return ok({ count: data.length, people: data })
    }
  )

  server.registerTool(
    'get_person',
    {
      description: 'Everything on one person: fields, who they are connected to, recent notes, open to-dos. Takes an id or an exact name.',
      inputSchema: { person: z.string().describe('Person id, or a name that matches exactly one person') },
      annotations: READ,
    },
    async ({ person }) => {
      const r = await personId(person)
      if ('error' in r) return fail(r.error)
      const [p, ties, notes, todos] = await Promise.all([
        supabase.from('people').select(PERSON_COLS).eq('id', r.id).single(),
        supabase.from('ties').select('a_id,b_id,kind').or(`a_id.eq.${r.id},b_id.eq.${r.id}`),
        supabase.from('notes').select('id,kind,body,happened_on,created_by,created_at').eq('person_id', r.id).order('created_at', { ascending: false }).limit(20),
        supabase.from('todos').select('id,title,due_on,done_at,created_by').eq('person_id', r.id).is('done_at', null).order('due_on', { ascending: true, nullsFirst: false }),
      ])
      if (p.error) return failFrom(p.error)
      const otherIds = (ties.data ?? []).map((t) => (t.a_id === r.id ? t.b_id : t.a_id)).filter((x): x is string => !!x)
      const others = otherIds.length ? await supabase.from('people').select('id,name,company,ring').in('id', otherIds) : { data: [] }
      const connections = [...((ties.data ?? []).some((t) => t.a_id === null) ? [{ id: 'you', name: 'You' }] : []), ...(others.data ?? [])]
      return ok({ person: p.data, connections, notes: notes.data ?? [], open_todos: todos.data ?? [] })
    }
  )

  server.registerTool(
    'create_person',
    {
      description:
        'Add a person to the map. Ring 1 (default) also ties them to the signed-in person. Pass connected_to to tie them to others already on the map. Search first: duplicates are not merged.',
      inputSchema: {
        ...personFields,
        name: z.string().min(1).describe('Full name'),
        connected_to: z.array(z.string()).optional().describe('Ids or exact names of people they know'),
        source: z.string().optional().describe('Where this came from, e.g. "Claude, from a dinner note"'),
      },
      annotations: WRITE,
    },
    async ({ connected_to, source, ...fields }) => {
      const row = { ...fields, ring: fields.ring ?? 1, sources: [source || (clientId ? 'Added by an agent' : 'Added by you')] }
      const { data, error } = await supabase.from('people').insert(row).select(PERSON_COLS).single()
      if (error) return failFrom(error)
      const tied: string[] = []
      if (row.ring === 1) { await supabase.from('ties').insert({ a_id: null, b_id: data.id }); tied.push('you') }
      for (const ref of connected_to ?? []) {
        const r = await personId(ref)
        if ('error' in r) continue
        const { error: e } = await supabase.from('ties').insert({ a_id: r.id, b_id: data.id })
        if (!e) tied.push(r.id)
      }
      return ok({ person: data, connected_to: tied })
    }
  )

  server.registerTool(
    'update_person',
    {
      description: 'Change fields on a person. Only the fields given are changed; tags replace the whole list.',
      inputSchema: { person: z.string().describe('Person id or exact name'), ...personFields },
      annotations: WRITE,
    },
    async ({ person, ...fields }) => {
      const r = await personId(person)
      if ('error' in r) return fail(r.error)
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      if (!Object.keys(patch).length) return fail('Nothing to change.')
      const { data, error } = await supabase.from('people').update(patch).eq('id', r.id).select(PERSON_COLS).single()
      if (error) return failFrom(error)
      if (patch.ring === 1) await supabase.from('ties').insert({ a_id: null, b_id: r.id })
      if (patch.ring && patch.ring !== 1) await supabase.from('ties').delete().is('a_id', null).eq('b_id', r.id)
      return ok({ person: data })
    }
  )

  server.registerTool(
    'delete_person',
    { description: 'Remove a person and their ties, notes and to-dos. Cannot be undone.', inputSchema: { person: z.string() }, annotations: DESTROY },
    async ({ person }) => {
      const r = await personId(person)
      if ('error' in r) return fail(r.error)
      const { error } = await supabase.from('people').delete().eq('id', r.id)
      return error ? failFrom(error) : ok({ deleted: r.id })
    }
  )

  server.registerTool(
    'connect_people',
    {
      description: 'Record that two people know each other. Use "you" for the signed-in person.',
      inputSchema: { a: z.string().describe('Person id, exact name, or "you"'), b: z.string().describe('Person id or exact name') },
      annotations: WRITE,
    },
    async ({ a, b }) => {
      const ra = a.toLowerCase() === 'you' ? { id: null as string | null } : await personId(a)
      const rb = await personId(b)
      if ('error' in ra) return fail(ra.error)
      if ('error' in rb) return fail(rb.error)
      const { error } = await supabase.from('ties').insert({ a_id: ra.id, b_id: rb.id })
      if (error && error.code !== '23505') return failFrom(error)
      return ok({ connected: [ra.id ?? 'you', rb.id], already: error?.code === '23505' })
    }
  )

  server.registerTool(
    'disconnect_people',
    { description: 'Remove the tie between two people. Use "you" for the signed-in person.', inputSchema: { a: z.string(), b: z.string() }, annotations: DESTROY },
    async ({ a, b }) => {
      const ra = a.toLowerCase() === 'you' ? { id: null as string | null } : await personId(a)
      const rb = await personId(b)
      if ('error' in ra) return fail(ra.error)
      if ('error' in rb) return fail(rb.error)
      let q = supabase.from('ties').delete()
      if (ra.id === null) q = q.is('a_id', null).eq('b_id', rb.id)
      else q = q.or(`and(a_id.eq.${ra.id},b_id.eq.${rb.id}),and(a_id.eq.${rb.id},b_id.eq.${ra.id})`)
      const { error } = await q
      return error ? failFrom(error) : ok({ disconnected: [ra.id ?? 'you', rb.id] })
    }
  )

  // ───────────────────────── notes ─────────────────────────
  const KINDS = ['Conversation', 'Family', 'Background', 'Fact', 'Other'] as const
  server.registerTool(
    'add_note',
    {
      description: 'Remember something about a person: what you talked about, family, background, a fact. Shown on their page as made by you.',
      inputSchema: {
        person: z.string().describe('Person id or exact name'),
        body: z.string().min(1).describe('One or two sentences'),
        kind: z.enum(KINDS).optional().default('Other'),
        happened_on: z.string().optional().describe('YYYY-MM-DD, when it happened; defaults to today'),
      },
      annotations: WRITE,
    },
    async ({ person, body, kind, happened_on }) => {
      const r = await personId(person)
      if ('error' in r) return fail(r.error)
      const row: Record<string, unknown> = { person_id: r.id, body, kind: kind ?? 'Other' }
      if (happened_on) row.happened_on = happened_on
      const { data, error } = await supabase.from('notes').insert(row).select('id,person_id,kind,body,happened_on,created_at').single()
      return error ? failFrom(error) : ok({ note: data })
    }
  )

  server.registerTool(
    'list_notes',
    {
      description: 'Notes, newest first, optionally for one person or matching a word.',
      inputSchema: { person: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional().default(25) },
      annotations: READ,
    },
    async ({ person, query, limit }) => {
      let q = supabase.from('notes').select('id,person_id,kind,body,happened_on,created_by,created_at,people(name)').order('created_at', { ascending: false }).limit(limit ?? 25)
      if (person) { const r = await personId(person); if ('error' in r) return fail(r.error); q = q.eq('person_id', r.id) }
      const t = clean(query ?? '')
      if (t) q = q.ilike('body', `%${t}%`)
      const { data, error } = await q
      return error ? failFrom(error) : ok({ count: data.length, notes: data })
    }
  )

  server.registerTool(
    'delete_note',
    { description: 'Delete one note by id.', inputSchema: { id: z.string().uuid() }, annotations: DESTROY },
    async ({ id }) => {
      const { error } = await supabase.from('notes').delete().eq('id', id)
      return error ? failFrom(error) : ok({ deleted: id })
    }
  )

  // ───────────────────────── lists and to-dos ─────────────────────────
  server.registerTool(
    'list_todos',
    {
      description: 'To-dos, soonest due first. Filter by list name, person, or due date. Done items are left out unless include_done.',
      inputSchema: {
        list: z.string().optional().describe('List name'),
        person: z.string().optional(),
        due_before: z.string().optional().describe('YYYY-MM-DD'),
        include_done: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
      annotations: READ,
    },
    async ({ list, person, due_before, include_done, limit }) => {
      let q = supabase.from('todos').select('id,title,due_on,done_at,created_by,created_at,person_id,people(name),list_id,lists(name)').order('due_on', { ascending: true, nullsFirst: false }).order('created_at').limit(limit ?? 50)
      if (!include_done) q = q.is('done_at', null)
      if (due_before) q = q.lte('due_on', due_before)
      if (list) { const id = await listId(list, false); if (!id) return fail(`No list named "${list}". Use list_lists.`); q = q.eq('list_id', id) }
      if (person) { const r = await personId(person); if ('error' in r) return fail(r.error); q = q.eq('person_id', r.id) }
      const { data, error } = await q
      return error ? failFrom(error) : ok({ count: data.length, todos: data })
    }
  )

  server.registerTool(
    'add_todo',
    {
      description: 'Add a to-do, optionally due on a date, about a person, in a named list (created if new; default "Follow-ups").',
      inputSchema: {
        title: z.string().min(1),
        due_on: z.string().optional().describe('YYYY-MM-DD'),
        person: z.string().optional().describe('Person id or exact name'),
        list: z.string().optional().default('Follow-ups'),
      },
      annotations: WRITE,
    },
    async ({ title, due_on, person, list }) => {
      try {
        const row: Record<string, unknown> = { title, list_id: await listId(list || 'Follow-ups', true) }
        if (due_on) row.due_on = due_on
        if (person) { const r = await personId(person); if ('error' in r) return fail(r.error); row.person_id = r.id }
        const { data, error } = await supabase.from('todos').insert(row).select('id,title,due_on,person_id,list_id,created_at').single()
        return error ? failFrom(error) : ok({ todo: data })
      } catch (e) { return failFrom(e) }
    }
  )

  server.registerTool(
    'update_todo',
    {
      description: 'Change a to-do: retitle, move its date, mark it done or not done, move it to another list.',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().optional(),
        due_on: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
        done: z.boolean().optional(),
        list: z.string().optional(),
        person: z.string().nullable().optional(),
      },
      annotations: WRITE,
    },
    async ({ id, title, due_on, done, list, person }) => {
      try {
        const patch: Record<string, unknown> = {}
        if (title !== undefined) patch.title = title
        if (due_on !== undefined) patch.due_on = due_on
        if (done !== undefined) patch.done_at = done ? new Date().toISOString() : null
        if (list !== undefined) patch.list_id = await listId(list, true)
        if (person === null) patch.person_id = null
        else if (person) { const r = await personId(person); if ('error' in r) return fail(r.error); patch.person_id = r.id }
        if (!Object.keys(patch).length) return fail('Nothing to change.')
        const { data, error } = await supabase.from('todos').update(patch).eq('id', id).select('id,title,due_on,done_at,person_id,list_id').single()
        return error ? failFrom(error) : ok({ todo: data })
      } catch (e) { return failFrom(e) }
    }
  )

  server.registerTool(
    'complete_todo',
    { description: 'Mark a to-do done.', inputSchema: { id: z.string().uuid() }, annotations: WRITE },
    async ({ id }) => {
      const { data, error } = await supabase.from('todos').update({ done_at: new Date().toISOString() }).eq('id', id).select('id,title,done_at').single()
      return error ? failFrom(error) : ok({ todo: data })
    }
  )

  server.registerTool(
    'delete_todo',
    { description: 'Delete a to-do by id.', inputSchema: { id: z.string().uuid() }, annotations: DESTROY },
    async ({ id }) => {
      const { error } = await supabase.from('todos').delete().eq('id', id)
      return error ? failFrom(error) : ok({ deleted: id })
    }
  )

  server.registerTool(
    'list_lists',
    { description: 'The to-do lists and how many open items each holds.', annotations: READ },
    async () => {
      const [l, t] = await Promise.all([
        supabase.from('lists').select('id,name,position').order('position').order('name'),
        supabase.from('todos').select('list_id').is('done_at', null),
      ])
      if (l.error) return failFrom(l.error)
      const open = new Map<string | null, number>()
      for (const x of t.data ?? []) open.set(x.list_id, (open.get(x.list_id) ?? 0) + 1)
      return ok({ lists: l.data.map((x) => ({ ...x, open: open.get(x.id) ?? 0 })), unlisted_open: open.get(null) ?? 0 })
    }
  )

  server.registerTool(
    'create_list',
    { description: 'Create a to-do list.', inputSchema: { name: z.string().min(1) }, annotations: WRITE },
    async ({ name }) => {
      const { data, error } = await supabase.from('lists').insert({ name }).select('id,name').single()
      return error ? failFrom(error) : ok({ list: data })
    }
  )

  // ───────────────────────── overview ─────────────────────────
  server.registerTool(
    'who_is_overdue',
    {
      description: 'People known first-hand who have not been touched (no note, no to-do, no edit) in a while, longest ago first.',
      inputSchema: { days: z.number().int().min(1).optional().default(30), limit: z.number().int().min(1).max(100).optional().default(20) },
      annotations: READ,
    },
    async ({ days, limit }) => {
      const cutoff = new Date(Date.now() - (days ?? 30) * 86400000).toISOString()
      const { data, error } = await supabase.from('people_touch').select('id,name,ring,last_touch,open_todos').eq('ring', 1).lt('last_touch', cutoff).order('last_touch').limit(limit ?? 20)
      return error ? failFrom(error) : ok({ days: days ?? 30, count: data.length, people: data })
    }
  )

  server.registerTool(
    'recent_activity',
    {
      description: 'What changed lately and who changed it: the person themself ("you") or an agent by name.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().default(40) },
      annotations: READ,
    },
    async ({ limit }) => {
      const { data, error } = await supabase.from('activity').select('id,actor,action,entity,entity_id,summary,at').order('at', { ascending: false }).limit(limit ?? 40)
      if (error) return failFrom(error)
      const names = new Map<string, string>([['you', 'you']])
      for (const a of new Set(data.map((x) => x.actor))) {
        if (names.has(a)) continue
        const { data: n } = await supabase.rpc('actor_name', { cid: a })
        names.set(a, typeof n === 'string' ? n : a)
      }
      return ok({ activity: data.map((x) => ({ ...x, actor_name: names.get(x.actor) ?? x.actor })) })
    }
  )
}

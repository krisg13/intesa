Intesa

A map of the people you know, and how you are connected. Phone-first; sample data until you sign in.

Layout
- `index.html` — the whole app, one file. `config.js` says which Supabase project it talks to (empty = sample data only).
- `oauth/consent/` — the page agents send you to when they ask to connect.
- `supabase/` — the backend: `migrations/` (schema, RLS, provenance), `functions/mcp/` (the MCP server), `templates/` (sign-in mail).
- `ios/` — the native iPhone shell (see `ios/README.md`).
- `manifest.webmanifest`, `sw.js`, `icons/`, `fonts/` — install and typography.

Backend
Supabase: Postgres with Row Level Security, so each person sees only their own map; Auth with emailed codes; an Edge Function that
serves the Model Context Protocol so Claude Desktop, Claude Code, Grok and other agents can read and write the map as the signed-in
person. Every row records who wrote it: `you`, or the agent's OAuth client id (shown by name in the app).

Tables: `profiles` (you), `people`, `ties` (a_id null = you), `notes`, `lists`, `todos`, `activity` (who changed what).
MCP tools: whoami, search_people, get_person, create_person, update_person, delete_person, connect_people, disconnect_people,
add_note, list_notes, delete_note, list_todos, add_todo, update_todo, complete_todo, delete_todo, list_lists, create_list,
who_is_overdue, recent_activity.

Run it locally
    brew install supabase/tap/supabase           # once; Docker Desktop must be running
    echo '[]' > supabase/signing_keys.json && supabase gen signing-key --algorithm ES256 --append   # once, never committed
    export INTESA_SITE_URL=http://127.0.0.1:8765/intesa
    supabase start                                # API on :54421, Studio on :54423, mail catcher on :54424
    cp supabase/functions/mcp/.env.example supabase/functions/.env
    supabase functions serve mcp --env-file supabase/functions/.env
Serve this folder at http://127.0.0.1:8765/intesa/ (e.g. a symlink named `intesa` inside a folder served by `python3 -m http.server 8765`),
then in the browser: localStorage.setItem('intesa.supabase', JSON.stringify({url:'http://127.0.0.1:54421', anonKey:'<publishable key from supabase status>'})).
Sign-in codes arrive in the mail catcher.

Deploy the backend
    supabase link --project-ref <ref>
    INTESA_SITE_URL=https://krisg13.github.io/intesa supabase config push     # auth settings, OAuth server, mail template
    supabase db push                                                          # migrations
    supabase functions deploy mcp
Then put the project URL and publishable key into `config.js` and push this repo (GitHub Pages serves it). The MCP address agents use
is `<project url>/functions/v1/mcp`; the consent page must be reachable at `<site url>/oauth/consent/`.

Redeploy the page
Copy the working file over `index.html`, run `ios/sync-web.sh`, commit, push. Bump `VERSION` in `sw.js` when the shell changes.

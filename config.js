// Where this copy of Intesa keeps your map. With no url, the page shows sample data and offers no sign-in.
// A developer can point a browser at another project by storing {"url":"…","anonKey":"…"} under localStorage "intesa.supabase".
window.INTESA_SUPABASE = { url: '', anonKey: '' };
try { const o = JSON.parse(localStorage.getItem('intesa.supabase') || 'null'); if (o && o.url && o.anonKey) window.INTESA_SUPABASE = o; } catch (e) {}

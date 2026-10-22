// テスト用の Supabase の代わり。データは localStorage の "fake.db" に置き、端末を替えても残る
const load = () => JSON.parse(localStorage.getItem("fake.db") || '{"vault_keys":[],"vault_items":[]}');
const save = db => localStorage.setItem("fake.db", JSON.stringify(db));
let seq = 0;
const stamp = () => new Date(Date.now() + (seq++)).toISOString();
class Query {
  constructor(t) { this.t = t; this.filters = []; this.op = "select"; }
  select() { return this; }
  eq(c, v) { this.filters.push(r => r[c] === v); return this; }
  gt(c, v) { this.filters.push(r => r[c] > v); return this; }
  order(c, o) { this.ord = [c, o.ascending]; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(r) { this.op = "insert"; this.rows = [].concat(r); return this; }
  upsert(r) { this.op = "upsert"; this.rows = r; return this; }
  delete() { this.op = "delete"; return this; }
  then(a, b) { return Promise.resolve().then(() => this.exec()).then(a, b); }
  exec() {
    const db = load(); const tbl = db[this.t] || (db[this.t] = []);
    if (window.__offline) return { error: { message: "offline" } };
    if (this.op === "insert") { for (const r of this.rows) tbl.push({ ...r, updated_at: stamp() }); save(db); return { error: null }; }
    if (this.op === "upsert") {
      for (const r of this.rows) { const i = tbl.findIndex(x => x.user_id === r.user_id && x.kind === r.kind && x.item_id === r.item_id); const row = { ...r, updated_at: stamp() }; if (i >= 0) tbl[i] = row; else tbl.push(row); }
      save(db); return { error: null };
    }
    let rows = tbl.filter(r => this.filters.every(f => f(r)));
    if (this.op === "delete") { db[this.t] = tbl.filter(r => !rows.includes(r)); save(db); return { error: null }; }
    if (this.ord) rows.sort((a, b) => (a[this.ord[0]] < b[this.ord[0]] ? -1 : 1) * (this.ord[1] ? 1 : -1));
    if (this.lim) rows = rows.slice(0, this.lim);
    if (this.single) return { data: rows[0] || null, error: null };
    return { data: rows.map(r => ({ ...r })), error: null };
  }
}
export function createClient() {
  let session = JSON.parse(localStorage.getItem("fake.session") || "null");
  const listeners = [];
  return {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOtp({ email }) { window.__otpTo = email; return { error: null }; },
      async verifyOtp({ email, token }) {
        if (token !== "123456") return { data: {}, error: { message: "bad" } };
        session = { user: { id: "uid-" + email, email } };
        localStorage.setItem("fake.session", JSON.stringify(session));
        setTimeout(() => listeners.forEach(cb => cb("SIGNED_IN", session)));
        return { data: { session }, error: null };
      },
      async signOut() { session = null; localStorage.removeItem("fake.session"); listeners.forEach(cb => cb("SIGNED_OUT", null)); return { error: null }; }
    },
    from: t => new Query(t),
    functions: {
      async invoke(name, { body }) {
        (window.__coachCalls = window.__coachCalls || []).push(body);
        if (!session) return { data: null, error: { context: { json: async () => ({ error: "not_signed_in" }) } } };
        return { data: { data: window.__fakeCoach ? window.__fakeCoach(body) : defaultCoach(body) }, error: null };
      }
    }
  };
}
function defaultCoach(b) {
  if (b.kind === "teach") return (b.ja || "").length < 6 ? { worth: false, skip_reason: "短い" } : { worth: true, model: "Example answer lol", alts: ["Another way"], point: "ポイント", phrase: "example", phrase_ja: "例" };
  return { model: "Example answer", alts: [], verdict: "correct", feedback: "伝わっています。", natural: "", natural_why: "", phrase: "example", phrase_ja: "例" };
}

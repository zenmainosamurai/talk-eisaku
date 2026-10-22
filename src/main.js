// トーク英作：アプリ本体（Web版とスマホアプリ版で共通）
import { LS, Store } from "./store.js";
import { Cloud } from "./cloud.js";
import { Voice, Speech, isNative, saveTextFile, onBackButton, onSharedText, shareTargetSupported } from "./native.js";

/* ============ 基本ユーティリティ ============ */
const DAY = 86400000;
const pad2 = n => String(n).padStart(2, "0");
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (day, n) => { const d = new Date(day); d.setDate(d.getDate() + n); return startOfDay(d); };
const len = s => Array.from(s).length;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const avg = xs => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const smart = s => String(s || "").replace(/(\w)'(\w)/g, "$1\u2019$2").replace(/(^|[\s(])"([^"]+)"/g, "$1\u201C$2\u201D").replace(/(^|[\s(])'([^']+)'/g, "$1\u2018$2\u2019");
function fmtDate(d) { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${y}年${+m}月${+dd}日`; }
function fmtMD(t) { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function fmtMDW(t) { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; }
function relDays(n) { if (n <= 0) return "今日"; if (n === 1) return "明日"; if (n < 30) return `${n}日後`; if (n < 365) return `約${Math.round(n / 30)}か月後`; return "約1年後"; }
function whenText(t) { return relDays(Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY)); }

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // 固定のSVGアイコン専用
    else if (k === "value") el.value = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
let toastTimer = null;
function toast(msg, ms = 3800) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/* ============ 保存（この端末） ============ */
// トーク履歴は端末の外に出さない。学習記録と回答履歴は、暗号化して Cloud が同期する
const K = { settings: "tk.settings.v1", mem: "tk.memory.v1", metaAt: "tk.metaAt.v1", wipedAt: "tk.wipedAt.v1", aiConsent: "tk.aiConsent.v1", oldPool: "tk.pool.v1", oldCards: "tk.cards.v1" };
const pending = {};
function saveLater(key, ms = 300) {
  clearTimeout(pending[key]);
  pending[key] = setTimeout(() => flushOne(key), ms);
}
function flushOne(key) {
  clearTimeout(pending[key]); delete pending[key];
  const v = key === "cards" ? S.cards : key === "log" ? S.log : S.pool;
  const p = v == null ? Store.del(key) : Store.set(key, v);
  Promise.resolve(p).then(ok => { if (ok === false) toast("データを保存できませんでした。端末の空き容量を確認してください。", 6000); });
}
function flushAll() { for (const k of Object.keys(pending)) flushOne(k); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { flushAll(); Cloud.flush(); }
  else if (S.ready) Cloud.sync();
});
const saveCards = () => saveLater("cards");
const saveLog = () => saveLater("log");
const savePool = () => saveLater("pool", 50);
function persistSettings() {
  LS.set(K.settings, S.settings);
  S.metaAt = Date.now(); LS.set(K.metaAt, S.metaAt);
  Cloud.markMeta();
}
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// 学習記録を変えたら、同期の対象にする
function touch(card, eventTime) {
  card.u = Date.now();
  Cloud.markCard(card.id);
  if (eventTime) Cloud.markDay(dayKey(eventTime));
}
const canStudy = () => Cloud.signedIn() && Cloud.status !== "checking";


/* ============ 状態 ============ */
const DEFAULT_SETTINGS = { newPerDay: 10, rate: 0.95, autoSpeak: true, sendContext: true, level: "intermediate" };
const S = {
  view: "home",
  pool: null,            // { v:2, sources:[{key, partner, me, meIdx, names, msgs, count, at}], items:[{id, d, ja, src, mi}] }
  poolIndex: new Map(), srcByKey: new Map(),
  cards: {},             // id -> { id, ja, d, src, mi, en, alts, tip, ph, phj, created, S, last, lapses }
  log: [],               // 回答履歴 { id, t, k: learn|correct|close|wrong|init|seen, p?, dt?, s?, l? }
  mem: { m: 1, s0: 1, n: 0, nAt: 0, fitted: false, at: 0 },  // あなた向けの記憶モデル
  settings: { ...DEFAULT_SETTINGS },
  metaAt: 0, wipedAt: 0, vaultLater: false,
  aiConsent: null,       // AIへの送信の同意 { v, at }。この端末にだけ保存し、サーバーには送らない
  pendingPlan: null, consentFrom: null,
  ready: false, plan: null, session: null, setup: null, micBlocked: false
};
const allCards = () => Object.values(S.cards);

/* ============ LINEトーク履歴の読み込み ============ */
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
function parseLineExport(raw) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const head = /^\[LINE\]\s*(.+?)とのトーク履歴/.exec(lines[0] || "");
  const partner = head ? head[1].trim() : null;
  const reDate = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})(\(.{1,3}\)|\s+\S{1,4})?\s*$/;
  const reMsg = /^(\d{1,2}):(\d{2})\t(.*)$/;
  const msgs = [];
  let date = null, cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (i < 3 && (/^\[LINE\]/.test(ln) || /^保存日時/.test(ln))) continue;
    let m;
    if ((m = reDate.exec(ln))) { date = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`; cur = null; continue; }
    if ((m = reMsg.exec(ln))) {
      const rest = m[3].split("\t");
      const named = rest.length >= 2;
      cur = { d: date, t: `${pad2(m[1])}:${m[2]}`, name: named ? rest[0].trim() : "", text: named ? rest.slice(1).join("\t") : rest[0] };
      msgs.push(cur);
      continue;
    }
    if (cur) cur.text += "\n" + ln;
  }
  for (const m of msgs) {
    let t = m.text.replace(/\s+$/, "");
    if (t.length > 1 && t.startsWith('"') && t.endsWith('"') && t.includes("\n")) t = t.slice(1, -1).replace(/""/g, '"');
    m.text = t;
  }
  const speakers = {};
  for (const m of msgs) if (m.name) speakers[m.name] = (speakers[m.name] || 0) + 1;
  return { partner, msgs, speakers };
}
const RE_MEDIA = /^\[[^\]\n]{1,20}\]$/;
const RE_SYSTEM = /通話をキャンセル|通話時間|不在着信|送信を取り消し|☎|がメッセージの送信|アルバム.*(作成|追加)|ノートに投稿/;
const coreOf = t => String(t).replace(/[\s笑ｗwW!！?？。、,.…・〜~ー\-()（）「」『』]/g, "").replace(/\p{Extended_Pictographic}/gu, "");
function cleanText(t) {
  t = t.trim();
  if (!t || RE_MEDIA.test(t) || /https?:\/\//.test(t) || RE_SYSTEM.test(t)) return null;
  if (t.split("\n").length > 3 || len(t) > 80) return null;
  const core = coreOf(t);
  const jp = (core.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) || []).length;
  if (!jp || jp / Math.max(1, len(core)) < 0.6) return null;
  return t;
}
function buildSource(parsed, me) {
  const names = Object.keys(parsed.speakers);
  const idx = new Map(names.map((n, i) => [n, i]));
  const partner = parsed.partner || "トーク";
  return { key: partner + "|" + me, partner, me, meIdx: idx.get(me), names, at: Date.now(), count: 0,
    msgs: parsed.msgs.map(m => [m.name ? idx.get(m.name) : -1, m.d, m.text]) };
}
function buildItems(msgs, me, key) {
  const items = [], seen = new Set();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.name !== me) continue;
    const ja = cleanText(m.text);
    if (!ja || seen.has(ja)) continue;
    seen.add(ja);
    items.push({ id: cyrb53(m.d + "|" + m.t + "|" + ja), d: m.d, ja, src: key, mi: i });
  }
  return items;
}
function indexPool() {
  S.poolIndex = new Map((S.pool?.items || []).map(it => [it.id, it]));
  S.srcByKey = new Map((S.pool?.sources || []).filter(s => s.key).map(s => [s.key, s]));
}
function addSource(src, items) {
  const pool = S.pool || { v: 2, sources: [], items: [] };
  const ex = pool.sources.findIndex(s => s.key === src.key || (!s.msgs && s.partner === src.partner && s.me === src.me));
  if (ex >= 0) { src.count = pool.sources[ex].count || 0; pool.sources[ex] = src; } else pool.sources.push(src);
  const byId = new Map(pool.items.map(i => [i.id, i])), haveJa = new Set(pool.items.map(i => i.ja));
  let added = 0;
  for (const it of items) {
    const old = byId.get(it.id);
    if (old) { old.src = it.src; old.mi = it.mi; delete old.ctx; delete old.cn; continue; }
    if (haveJa.has(it.ja)) continue;
    pool.items.push(it); haveJa.add(it.ja); added++;
  }
  src.count += added;
  for (const it of items) { const c = S.cards[it.id]; if (c) { c.src = it.src; c.mi = it.mi; } }
  pool.v = 2; S.pool = pool; indexPool(); savePool(); saveCards();
  return added;
}
const needsReimport = () => !!(S.pool && S.pool.items.some(i => !i.src));
// 前後のやり取り（同じ日のみ）。システムメッセージは除き、スタンプ・写真はそのまま残す
function contextOf(item) {
  const empty = { before: [], after: [] };
  if (!item) return empty;
  const src = item.src && S.srcByKey.get(item.src);
  if (!src || item.mi == null || !src.msgs[item.mi]) return item.ctx ? { before: [{ me: false, name: item.cn || "相手", text: item.ctx }], after: [] } : empty;
  const m = src.msgs, day = m[item.mi][1];
  const take = (start, dir, n) => {
    const out = [];
    for (let j = start; j >= 0 && j < m.length && out.length < n; j += dir) {
      const [ni, d, text] = m[j];
      if (d !== day) break;
      if (ni < 0) continue;
      const tt = String(text).trim();
      if (!tt || RE_SYSTEM.test(tt)) continue;
      out.push({ me: ni === src.meIdx, name: src.names[ni] || "相手", text: Array.from(tt).slice(0, 140).join("") });
    }
    return dir < 0 ? out.reverse() : out;
  };
  return { before: take(item.mi - 1, -1, 3), after: take(item.mi + 1, 1, 2) };
}
const itemFor = id => S.cards[id] || S.poolIndex.get(id);

/* ============ 記憶モデル（あなた向けにフィッティングする忘却曲線） ============ */
// 定着率 R(t) = (1 + F·t/S)^-0.5。S（安定度・日）たった時点で R = 90%
const F = 19 / 81, DECAY = -0.5, TARGET = 0.9, G0 = 15.7;
const R = (t, s) => Math.pow(1 + F * Math.max(0, t) / Math.max(s, 0.01), DECAY);
const LV_NAME = ["", "まだ不安定", "覚えたて", "なじんできた", "ほぼ定着", "定着"];
function grow(s, r, m, partial) {
  const g = G0 * m * Math.pow(s, -0.15) * (Math.exp(1.2 * (1 - r)) - 1) * (partial ? 0.4 : 1);
  return s * (1 + g);
}
const lapse = s => Math.max(0.15, 0.3 * Math.pow(s, 0.6));
function step(st, ev, P) {
  if (ev.k === "seen") return st;
  if (ev.k === "init") return { S: ev.s, last: ev.t, lapses: ev.l || 0 };
  if (ev.k === "learn") return { S: P.s0, last: ev.t, lapses: st ? st.lapses : 0 };
  if (!st) st = { S: P.s0, last: ev.t, lapses: 0 };
  const r = R((ev.t - st.last) / DAY, st.S);
  const s2 = ev.k === "wrong" ? lapse(st.S) : grow(st.S, r, P.m, ev.k === "close");
  return { S: Math.min(s2, 3650), last: ev.t, lapses: st.lapses + (ev.k === "wrong" ? 1 : 0) };
}
const stateOf = c => (c && c.last ? { S: c.S, last: c.last, lapses: c.lapses || 0 } : null);
const dueOf = c => c.last + c.S * DAY;
const rNow = (c, now = Date.now()) => R((now - c.last) / DAY, c.S);
// 定着度 = 今の状態から計算した「1週間後にも思い出せる見込み」
function levelOf(c, now = Date.now()) {
  if (!c || !c.last) return 1;
  const r7 = R((now - c.last) / DAY + 7, c.S);
  return r7 < 0.5 ? 1 : r7 < 0.7 ? 2 : r7 < 0.85 ? 3 : r7 < 0.95 ? 4 : 5;
}
const isReview = e => e.k === "correct" || e.k === "close" || e.k === "wrong";
const yOf = e => (e.k === "wrong" ? 0 : e.k === "close" ? 0.7 : 1);
function groupLog() {
  const by = new Map();
  for (const e of S.log) { if (!by.has(e.id)) by.set(e.id, []); by.get(e.id).push(e); }
  for (const evs of by.values()) evs.sort((a, b) => a.t - b.t);
  return by;
}
function replayAll() {
  for (const [id, evs] of groupLog()) {
    const c = S.cards[id];
    if (!c) continue;
    let st = null;
    for (const e of evs) st = step(st, e, S.mem);
    if (st) { c.S = st.S; c.last = st.last; c.lapses = st.lapses; }
  }
}
function logLik(P, by) {
  let ll = 0, n = 0;
  for (const evs of by.values()) {
    let st = null;
    for (const e of evs) {
      if (st && isReview(e)) {
        const t = (e.t - st.last) / DAY;
        if (t >= 0.05) {
          const p = clamp(R(t, st.S), 0.001, 0.999), y = yOf(e);
          ll += y * Math.log(p) + (1 - y) * Math.log(1 - p); n++;
        }
      }
      st = step(st, e, P);
    }
  }
  return { ll, n };
}
const MS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];
const S0S = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3];
function fitModel(force) {
  if (!force && S.log.length - (S.mem.nAt || 0) < 10 && Date.now() - (S.mem.at || 0) < DAY) return;
  const by = groupLog();
  const n = logLik({ m: 1, s0: 1 }, by).n;
  let best = { m: 1, s0: 1 };
  if (n >= 20) {
    let top = -Infinity;
    for (const m of MS) for (const s0 of S0S) {
      const score = logLik({ m, s0 }, by).ll - 4 * (Math.log(m) ** 2 + Math.log(s0) ** 2);
      if (score > top) { top = score; best = { m, s0 }; }
    }
  }
  S.mem = { ...best, n, nAt: S.log.length, fitted: n >= 20, at: Date.now() };
  LS.set(K.mem, S.mem);
  replayAll(); saveCards();
}
// 予測の当たり具合：「定着率が高い」と出していた問題の、実際の正解率
function calibInfo() {
  const evs = [];
  for (let i = S.log.length - 1; i >= 0 && evs.length < 60; i--) {
    const e = S.log[i];
    if (isReview(e) && e.p != null && e.p >= 0.85 && (e.dt || 0) >= 0.5) evs.push(e);
  }
  if (!evs.length) return { n: 0 };
  return { n: evs.length, pred: avg(evs.map(e => e.p)), act: avg(evs.map(yOf)) };
}
// 確認問題の割合：予測より忘れているほど増やし、当たってきたら減らす
function exploreShare() {
  const c = calibInfo();
  if (c.n < 8) return 0.15;
  return clamp(0.05 + 2 * Math.max(0, c.pred - c.act), 0.05, 0.35);
}

/* ============ 英語レベルと「問題にするか」の判定 ============ */
const LEVELS = {
  beginner: { name: "初級", note: "日常の短いやり取りも出題します。専門用語や言葉遊びが多い発言は飛ばします。",
    rule: "The learner is a BEGINNER (about CEFR A1-A2). Worth practicing: short everyday messages that teach basic, high-frequency English (thanks, plans, feelings, simple questions and reactions). Not worth it: messages whose natural English needs advanced vocabulary or idioms, or that depend on niche jargon." },
  intermediate: { name: "中級", note: "ふだんの会話の発言を出題します。相づちだけの返事などは飛ばします。",
    rule: "The learner is INTERMEDIATE (about CEFR B1-B2). Worth practicing: everyday messages with something to learn (a common expression, a useful structure, natural phrasing they could reuse). Not worth it: bare acknowledgements or reactions with nothing to learn (OK, I see, thanks), and messages too specialized to be useful." },
  advanced: { name: "上級", note: "基本的な言い回しは飛ばし、言い方に工夫がいる発言を中心に出題します。",
    rule: "The learner is ADVANCED (about CEFR C1 or above). Worth practicing: messages whose natural English needs nuance, idioms, the right tone or phrasing a strong learner might still get wrong. Not worth it: anything a capable learner can already say easily (basic greetings, thanks, simple facts or simple questions)." }
};
const levelKey = () => (LEVELS[S.settings.level] ? S.settings.level : "intermediate");
// 飛ばした発言は保存しない。アプリを開いている間だけ、同じ発言を続けて引かないよう覚えておく
const skippedNow = new Set();
const isSkipped = id => skippedNow.has(id);

/* ============ 出題計画 ============ */
const REVIEW_CAP = 40;
function daySet(day) {
  const end = addDays(day, 1), s = new Set();
  for (const e of S.log) if (e.t >= day && e.t < end && S.cards[e.id]) s.add(e.id);
  return s;
}
const newToday = () => { const t = startOfDay(Date.now()); return S.log.filter(e => e.k === "learn" && e.t >= t).length; };
function sampleN(arr, n) {
  const a = arr.slice(), out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]);
  return out;
}
function pickFresh(n) {
  if (n <= 0 || !S.pool) return [];
  const known = new Set(allCards().map(c => c.ja));
  const cand = S.pool.items.filter(it => !S.cards[it.id] && !known.has(it.ja) && !isSkipped(it.id));
  const good = cand.filter(it => len(it.ja) <= 45);
  return sampleN(good.length >= n ? good : cand, n);
}
function makePlan(extraNew = 0) {
  const now = Date.now(), today = startOfDay(now);
  const studied = allCards().filter(c => c.last && c.en);
  // 1) 定着率が低い順
  const due = studied.filter(c => rNow(c, now) < TARGET).sort((a, b) => rNow(a, now) - rNow(b, now)).slice(0, REVIEW_CAP);
  const dueIds = new Set(due.map(c => c.id));
  const slots = extraNew || Math.max(0, S.settings.newPerDay - newToday());
  const fresh = pickFresh(slots);
  // 2) モデルの確認用に、定着率が高いと計算された問題も混ぜる
  const seen = daySet(today);
  const cand = studied.filter(c => !dueIds.has(c.id) && !seen.has(c.id) && now - c.last > DAY / 2);
  const nProbe = extraNew ? 0 : Math.min(cand.length, Math.round(exploreShare() * Math.max(5, due.length + fresh.length)));
  const probes = sampleN(cand, nProbe);
  const reviews = due.map(c => c.id);
  for (const p of probes) reviews.splice(Math.floor(Math.random() * (reviews.length + 1)), 0, p.id);
  return { reviews, probes: new Set(probes.map(p => p.id)), fresh };
}

/* ============ 音声（入力・読み上げ） ============ */
let rec = null;
function stopListening() { if (rec) { const r = rec; rec = null; r.stop(); } }
function toggleListening(ta, btn, onChange) {
  if (rec) { stopListening(); return; }
  if (!Voice.supported() || S.micBlocked) { toast("この端末では音声入力が使えません。キーボードのマイクで英語を話してください。", 6000); return; }
  const before = ta.value.trim() ? ta.value.trim() + " " : "";
  const setOn = on => { btn.classList.toggle("on", on); btn.innerHTML = on ? ICON.stop : ICON.mic; btn.setAttribute("aria-label", on ? "音声入力を止める" : "英語で話す"); };
  const waiting = { cancelled: false, stop() { this.cancelled = true; setOn(false); } };
  rec = waiting; setOn(true);
  Voice.start({
    onText: s => { ta.value = before + s; onChange(); },
    onEnd: () => { if (rec === waiting || (rec && rec !== waiting)) rec = null; setOn(false); },
    onError: code => {
      rec = null; setOn(false);
      if (code === "not-allowed") { S.micBlocked = true; toast("マイクの使用が許可されていません。端末の設定で許可するか、キーボードのマイクを使ってください。", 6500); }
      else if (code === "no-speech") toast("声が聞き取れませんでした。もう一度どうぞ。");
      else if (code !== "aborted") toast("音声入力を開始できませんでした。");
    }
  }).then(ctrl => {
    if (!ctrl) return;
    if (waiting.cancelled) { ctrl.stop(); return; }
    if (rec === waiting) rec = ctrl;
  });
}
const TTS = {
  init() { Speech.init(); },
  speak(text, auto = false) {
    if (!text) return;
    Speech.speak(text, S.settings.rate).then(ok => { if (!ok && !auto) toast("読み上げできませんでした。"); });
  }
};

const speakBtn = text => h("button", { class: "icon-btn", type: "button", "aria-label": "読み上げる", html: ICON.speak, onclick: () => TTS.speak(text) });

// 発音しない要素（lol・haha・絵文字・顔文字など）を取り除く
function speakable(s) {
  if (!s) return s;
  let t = String(s)
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/(^|\s)[:;=xX8][-^']?[)(DPpO3\]\[\/\\|*]+(?=$|\s|[.,!?])/g, "$1")
    .replace(/(^|[\s(])\(?(?:lol+|lmao+|lmfao|rofl|ha(?:ha)+h?|he(?:he)+|ha(?: ha)+|xd)\)?(?=$|[\s.,!?)])/gi, "$1")
    .replace(/(^|\s)[wｗ]{2,}(?=$|\s)/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/^[\s,.;:!]+/, "")
    .replace(/[\s,;:]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!t) return String(s).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ============ AIコーチ（Supabase Edge Function 経由） ============ */
// AIに送る前に、同意画面で同意を得る。同意はこの端末にだけ保存する
// 同意画面の文案を大きく変えたら CONSENT_VERSION を上げて、同意を取り直す
const CONSENT_VERSION = 1;
const AI_NOTE = "AIの回答は誤ることがあります。";
const hasConsent = () => !!(S.aiConsent && S.aiConsent.v >= CONSENT_VERSION);
function setConsent(on) {
  S.aiConsent = on ? { v: CONSENT_VERSION, at: Date.now() } : null;
  if (on) LS.set(K.aiConsent, S.aiConsent); else LS.del(K.aiConsent);
}
// 「はじめる」：同意がまだなら、先に同意画面を出す
function requestStart(plan) {
  if (hasConsent()) { startSession(plan); return; }
  S.pendingPlan = plan; S.consentFrom = "start"; go("consent");
}
// 指示文（プロンプト）はサーバー側の supabase/functions/coach/prompts.ts にある
// 端末から送るのは、問題文・回答・前後のやり取り（話し手は Me / Friend に置き換え、名前は送らない）だけ
function contextPayload(item) {
  if (!S.settings.sendContext) return null;
  const cx = contextOf(item);
  if (!cx.before.length && !cx.after.length) return null;
  const labels = new Map();
  const who = m => {
    if (m.me) return "Me";
    if (!labels.has(m.name)) labels.set(m.name, labels.size === 0 ? "Friend" : "Friend " + String.fromCharCode(66 + labels.size - 1));
    return labels.get(m.name);
  };
  const line = m => ({ who: who(m), text: m.text });
  return { before: cx.before.map(line), after: cx.after.map(line) };
}
async function grade(item, answer, ref) {
  if (!hasConsent()) throw { code: "no_consent" };
  const r = await Cloud.coach({ kind: "grade", ja: item.ja, answer, ref: ref || "", level: levelKey(), context: contextPayload(item) });
  if (!r || typeof r.model !== "string" || !r.model.trim()) throw { code: "invalid_json" };
  const str = v => (typeof v === "string" ? v.trim() : "");
  const norm = x => x.toLowerCase().replace(/[\u2019`]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();
  let natural = speakable(str(r.natural));
  if (natural && (!answer || norm(natural) === norm(answer) || norm(natural) === norm(speakable(answer)))) natural = "";
  return {
    model: speakable(r.model.trim()),
    alts: Array.isArray(r.alts) ? r.alts.map(str).map(speakable).filter(Boolean).slice(0, 2) : [],
    verdict: ["correct", "close", "wrong"].includes(r.verdict) ? r.verdict : "close",
    feedback: str(r.feedback), natural, natural_why: natural ? str(r.natural_why) : "",
    phrase: speakable(str(r.phrase)), phrase_ja: str(r.phrase_ja)
  };
}
async function teach(item) {
  if (!hasConsent()) throw { code: "no_consent" };
  const r = await Cloud.coach({ kind: "teach", ja: item.ja, level: levelKey(), context: contextPayload(item) });
  const str = v => (typeof v === "string" ? v.trim() : "");
  if (r && (r.worth === false || r.worth === "false")) return { skip: true, reason: str(r.skip_reason) };
  if (!r || typeof r.model !== "string" || !r.model.trim()) throw { code: "invalid_json" };
  return { model: speakable(r.model.trim()), alts: Array.isArray(r.alts) ? r.alts.map(str).map(speakable).filter(Boolean).slice(0, 2) : [], point: str(r.point), phrase: speakable(str(r.phrase)), phrase_ja: str(r.phrase_ja) };
}
const PERMANENT = new Set(["unconfigured", "not_signed_in", "no_subscription", "no_consent"]);
function errorCopy(code) {
  if (code === "unconfigured") return "サーバーの設定がまだのため、お手本と採点が使えません。";
  if (code === "not_signed_in") return "お手本と採点を使うには、ログインしてください。";
  if (code === "no_consent") return "お手本と採点を使うには、AIへの送信に同意してください。";
  if (code === "no_subscription") return "お手本と採点は、サブスク会員向けの機能です。";
  if (code === "daily_limit") return "今日の利用上限に達しました。明日また使えます。";
  if (code === "rate_limited") return "短時間に使いすぎたため、少し待ってから、もう一度試してください。";
  if (code === "overloaded") return "Claudeが混み合っています。少し待ってから、もう一度試してください。";
  if (code === "offline") return "インターネットに接続されていません。接続してから、もう一度試してください。";
  if (code === "network") return "サーバーに接続できませんでした。電波の状態を確認して、もう一度試してください。";
  if (code === "refused") return "この文は採点できませんでした。とばして次へ進んでください。";
  return "Claudeから返事を受け取れませんでした。もう一度試してください。";
}

/* ============ セッション ============ */
function startSession(plan) {
  const p = plan || makePlan();
  const fresh = new Map(p.fresh.map(it => [it.id, it]));
  const queue = [...p.reviews, ...p.fresh.map(it => it.id)];
  if (!queue.length) return;
  S.session = { queue, fresh, probes: p.probes || new Set(), total: queue.length, seen: {}, first: {}, missed: [], phase: "ask", cur: null, answer: "", result: null, lesson: null, error: null, kind: "" };
  nextQuestion();
}
function newCard(item) {
  return { id: item.id, ja: item.ja, d: item.d || null, src: item.src || null, mi: item.mi ?? null, ctx: item.ctx || null, cn: item.cn || null,
    en: null, alts: [], tip: null, ph: null, phj: null, created: Date.now(), S: null, last: 0, lapses: 0, ans: null };
}
const baseCard = id => S.cards[id] || newCard(S.session.fresh.get(id) || S.poolIndex.get(id));
function nextQuestion() {
  const ss = S.session;
  if (!ss.queue.length) { S.view = "done"; render(); scheduleRefit(); return; }
  const id = ss.queue.shift();
  ss.kind = ss.seen[id] ? "again" : !S.cards[id] ? "new" : ss.probes.has(id) ? "probe" : "review";
  ss.seen[id] = (ss.seen[id] || 0) + 1;
  Object.assign(ss, { cur: id, phase: ss.kind === "new" ? "learn-loading" : "ask", answer: "", result: null, lesson: null, error: null, giveUp: false });
  S.view = "quiz"; render(); window.scrollTo(0, 0);
  if (ss.kind === "new") loadLesson();
  prefetchNext();
}
const lessons = new Map();
function lessonFor(item) {
  const key = item.id + ":" + levelKey() + (S.settings.sendContext ? ":c" : "");
  if (!lessons.has(key)) lessons.set(key, teach(item).catch(e => { lessons.delete(key); throw e; }));
  return lessons.get(key);
}
// 飛ばしたときに待たないよう、この先2問分の新しい表現を先に用意する
function prefetchNext() {
  const ss = S.session;
  if (!ss) return;
  for (const nid of ss.queue.slice(0, 3).filter(id => !S.cards[id] && !ss.seen[id]).slice(0, 2)) {
    const it = ss.fresh.get(nid);
    if (it) lessonFor(it).catch(() => {});
  }
}
// Claudeが「問題にしない」と判定したら、何も表示せずに代わりの問題を1つ入れて次へ進む
function skipCurrent() {
  const ss = S.session, id = ss.cur;
  skippedNow.add(id);
  delete ss.seen[id];
  ss.skipped = (ss.skipped || 0) + 1;
  let rep = null;
  if (ss.skipped <= 20) {
    const used = new Set([...ss.queue, ...Object.keys(ss.seen), ...ss.fresh.keys()]);
    rep = pickFresh(10).find(x => !used.has(x.id)) || null;
  }
  if (rep) { ss.fresh.set(rep.id, rep); ss.queue.unshift(rep.id); }
  else ss.total = Math.max(Object.keys(ss.seen).length, ss.total - 1);
  S.plan = null;
  nextQuestion();
}
async function loadLesson() {
  const ss = S.session, id = ss.cur, base = baseCard(id);
  ss.phase = "learn-loading"; ss.error = null; render();
  try {
    const res = await lessonFor(base);
    if (S.session !== ss || ss.cur !== id) return;
    if (res.skip) { skipCurrent(); return; }
    ss.lesson = { ...base, en: res.model, alts: res.alts, tip: res.point, ph: res.phrase, phj: res.phrase_ja };
    ss.phase = "learn"; render(); scrollToEnd();
    if (S.settings.autoSpeak) TTS.speak(res.model, true);
  } catch (e) {
    if (S.session !== ss || ss.cur !== id) return;
    ss.phase = "error"; ss.error = (e && e.code) || "upstream_error"; render(); scrollToEnd();
  }
}
// 「覚えた」：あなたの記憶モデルが「90%を下回る」と見積もった頃に初出題
function learned() {
  const ss = S.session, c0 = ss && ss.lesson;
  if (!c0) return;
  const now = Date.now(), ev = { id: c0.id, t: now, k: "learn" };
  const st = step(null, ev, S.mem);
  const c = { ...c0, created: now, S: st.S, last: st.last, lapses: 0 };
  S.cards[c.id] = c; S.log.push(ev); touch(c, ev.t); saveCards(); saveLog();
  if (!ss.first[c.id]) ss.first[c.id] = "learned";
  ss.lesson = null;
}
async function check(giveUp) {
  const ss = S.session, id = ss.cur, base = baseCard(id);
  const answer = giveUp ? "" : ss.answer.trim();
  if (!giveUp && !answer) return;
  stopListening();
  ss.giveUp = giveUp; ss.shown = answer; ss.phase = "grading"; ss.error = null;
  render(); scrollToEnd();
  if (giveUp && base.en) { reveal(base, { model: base.en, alts: base.alts, verdict: "wrong", feedback: "", phrase: base.ph, phrase_ja: base.phj }); return; }
  try {
    const res = await grade(base, answer, base.en);
    if (S.session !== ss || ss.cur !== id) return;
    reveal(base, res);
  } catch (e) {
    if (S.session !== ss || ss.cur !== id) return;
    ss.phase = "error"; ss.error = (e && e.code) || "upstream_error"; render(); scrollToEnd();
  }
}
function reveal(base, res) {
  const ss = S.session;
  const verdict = ss.giveUp ? "wrong" : res.verdict;
  const card = { ...base, en: res.model || base.en, alts: res.alts && res.alts.length ? res.alts : base.alts || [],
    tip: res.feedback || base.tip, ph: res.phrase || base.ph, phj: res.phrase_ja || base.phj, ans: ss.giveUp ? null : ss.shown };
  const now = Date.now(), st = stateOf(card);
  const opt = k => step(st, { id: card.id, t: now, k }, S.mem);
  ss.result = { res, card, now, chosen: verdict, auto: verdict, options: { correct: opt("correct"), close: opt("close"), wrong: opt("wrong") } };
  ss.phase = "result"; render(); scrollToEnd();
  if (S.settings.autoSpeak) TTS.speak(card.en, true);
}
function commit() {
  const ss = S.session, r = ss && ss.result;
  if (!r) return;
  const c = r.card, st = stateOf(c);
  const ev = { id: c.id, t: r.now, k: r.chosen };
  if (st) { ev.p = Math.round(R((r.now - st.last) / DAY, st.S) * 1000) / 1000; ev.dt = Math.round((r.now - st.last) / DAY * 100) / 100; }
  const ns = step(st, ev, S.mem);
  const final = { ...c, S: ns.S, last: ns.last, lapses: ns.lapses };
  S.cards[final.id] = final; S.log.push(ev); touch(final, ev.t); saveCards(); saveLog();
  if (!ss.first[final.id]) ss.first[final.id] = r.chosen;
  if (r.chosen === "wrong") {
    if (!ss.missed.includes(final.id)) ss.missed.push(final.id);
    if (ss.seen[final.id] < 3) ss.queue.splice(Math.min(3, ss.queue.length), 0, final.id);
  }
  ss.result = null;
}
function quit() {
  stopListening();
  if (S.session && S.session.phase === "result") commit();
  const hadAny = S.session && Object.keys(S.session.first).length;
  S.view = hadAny ? "done" : "home";
  if (!hadAny) { S.session = null; S.plan = null; }
  render(); scheduleRefit();
}
let refitTimer = null;
function scheduleRefit() { clearTimeout(refitTimer); refitTimer = setTimeout(() => { fitModel(false); S.plan = null; if (S.view === "home") render(); }, 400); }
function scrollToEnd() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => document.querySelector(".thread-end")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "end" }));
}

/* ============ 画面 ============ */
const app = document.getElementById("app");
// 実際に表示する画面。ログイン直後は、復元キーの作成・入力を先に済ませる
function shownView() {
  const v = S.view;
  if (v !== "setup" && v !== "login" && v !== "deleteAccount") {
    if (Cloud.status === "needsSetup") return "vaultSetup";
    if (Cloud.status === "needsKey" && !S.vaultLater) return "vaultUnlock";
  }
  return v;
}
function render() {
  if (!S.ready) { app.replaceChildren(h("div", { class: "view" }, h("p", { class: "loading" }, "読み込んでいます…"))); return; }
  const v = shownView();
  const node = v === "setup" ? viewSetup() : v === "login" ? viewLogin() : v === "vaultSetup" ? viewVaultSetup() : v === "vaultUnlock" ? viewVaultUnlock() : v === "quiz" ? viewQuiz() : v === "done" ? viewDone()
    : v === "weak" ? viewWeak() : v === "settings" ? viewSettings() : v === "consent" ? viewConsent() : v === "deleteAccount" ? viewDeleteAccount() : viewHome();
  app.replaceChildren(node);
}
function go(view) { stopListening(); closeConfirm(); S.view = view; if (view === "home") S.plan = null; render(); window.scrollTo(0, 0); }

/* --- 確認の小さな画面 --- */
function closeConfirm() { document.querySelector(".confirm-overlay")?.remove(); }
function confirmBox(message, note, okLabel, onOk) {
  closeConfirm();
  const box = h("div", { class: "confirm-overlay", role: "dialog", "aria-modal": "true", onclick: e => { if (e.target === box) closeConfirm(); } },
    h("div", { class: "confirm-card" },
      h("p", { class: "confirm-title" }, message),
      note ? h("p", { class: "note" }, note) : null,
      h("div", { class: "btn-row" },
        h("button", { class: "btn ghost", type: "button", onclick: closeConfirm }, "続ける"),
        h("button", { class: "btn primary", type: "button", onclick: () => { closeConfirm(); onOk(); } }, okLabel))));
  document.body.append(box);
}

/* --- Android の戻るボタン --- */
// 画面にある「戻る」と同じ動きをする。ホームなど最初の画面では false を返し、アプリを裏に回す
function handleBack() {
  if (!S.ready) return false;
  if (document.querySelector(".confirm-overlay")) { closeConfirm(); return true; }
  if (rec) { stopListening(); return true; }
  const v = shownView();
  if (v === "quiz") {
    confirmBox("問題を終了しますか？", "ここまでの回答は保存されます。", "終了する", quit);
    return true;
  }
  if (v === "done") { S.session = null; go("home"); return true; }
  if (v === "settings" || v === "weak" || v === "login") { go("home"); return true; }
  if (v === "deleteAccount") { if (!DELETE.busy) go("settings"); return true; }
  if (v === "consent") {
    const to = S.consentFrom === "settings" ? "settings" : "home";
    S.pendingPlan = null; S.consentFrom = null; go(to); return true;
  }
  if (v === "vaultUnlock") { S.vaultLater = true; go("home"); return true; }
  if (v === "setup") {
    if (S.setup) { S.setup = null; render(); return true; }
    if (S.pool || allCards().length) { go("home"); return true; }
    return false;
  }
  if (v === "home" && CAL.open) { CAL.open = null; render(); return true; }
  return false; // ホーム・はじめての画面・復元キーの作成中
}

/* --- はじめての読み込み / トーク追加 --- */
function viewSetup() {
  const st = S.setup;
  const back = (S.pool || allCards().length) ? h("button", { class: "link", type: "button", onclick: () => { S.setup = null; go("home"); } }, "戻る") : null;
  const fileBtn = label => h("label", { class: "btn primary block file-btn" }, label,
    h("input", { type: "file", onchange: e => onFile(e.target.files && e.target.files[0]) }));
  if (!st) {
    return h("div", { class: "view" },
      h("div", { class: "bar" }, h("div", { class: "grow" }), back),
      h("div", { class: "intro" },
        h("p", { class: "title" }, "自分のトークで、英語を話す。"),
        h("p", null, "あなたが実際にLINEで送ったメッセージが、英作文の問題になります。")),
      h("section", { style: "border-top:0" },
        h("ol", { class: "steps" },
          h("li", null, "LINEで練習に使いたいトークを開き、右上のメニュー → 設定 → 「トーク履歴を送信」を選びます。"),
          h("li", null, shareTargetSupported()
            ? "送信先の一覧から「トーク英作」を選ぶと、そのまま読み込めます。一覧にないときは、端末に保存（「ファイルに保存」など。機種によって名前が違います）してから、下のボタンでそのファイルを選びます。"
            : "送信先の一覧から、この端末に保存する方法（「ファイルに保存」など。機種によって名前が違います）を選び、下のボタンでそのファイルを選びます。",
            "トーク履歴には相手の発言も含まれるので、ほかの人には送らないでください。読み込んだ内容はこの端末にだけ保存されます。"),
          h("li", null, "まず英語のお手本を見て「覚えた」を押します。忘れかけた頃に英語で答える問題として出題され、あなたの回答に合わせて出題のタイミングが調整されます。")),
        fileBtn("トーク履歴を選ぶ"),
        h("p", { class: "note", style: "margin:12px 0 0" },
          h("a", { href: LINE_EXPORT_HELP, target: "_blank", rel: "noopener" }, "くわしい手順（LINE公式ヘルプ）"))));
  }
  const speakers = Object.entries(st.parsed.speakers).sort((a, b) => b[1] - a[1]);
  const items = buildItems(st.parsed.msgs, st.me, "preview");
  const already = S.pool ? items.filter(it => S.poolIndex.has(it.id)).length : 0;
  const examples = items.filter(it => len(it.ja) >= 8 && len(it.ja) <= 40).slice(0, 400).sort(() => Math.random() - .5).slice(0, 3);
  return h("div", { class: "view" },
    h("div", { class: "bar" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => { S.setup = null; render(); } }, "選び直す")),
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, (st.parsed.partner ? st.parsed.partner + " とのトーク" : st.name)),
      h("p", null, `${st.parsed.msgs.length.toLocaleString()}件のメッセージを読み込みました。`)),
    h("section", null,
      h("label", { class: "field", for: "me" }, "あなたの名前"),
      h("select", { id: "me", onchange: e => { st.me = e.target.value; render(); } },
        speakers.map(([n, c]) => h("option", { value: n, selected: n === st.me }, `${n}（${c.toLocaleString()}件）`))),
      h("p", { class: "note", style: "margin-top:10px" }, `この名前の発言から、${items.length.toLocaleString()}問を作れます。スタンプ・写真・URLだけの発言は除いています。問題にする意味があるかは、出題するときにClaudeがあなたの英語レベルに合わせて判定します。`
        + (already ? `うち${already.toLocaleString()}問は読み込み済みです（前後の文脈を追加します）。` : ""))),
    examples.length ? h("section", null, h("h2", null, "問題の例"),
      examples.map(it => h("div", { class: "row me" }, h("div", { class: "bubble mine" }, it.ja)))) : null,
    h("div", { style: "padding:8px 0 28px" },
      h("button", { class: "btn primary block", type: "button", disabled: !items.length, onclick: () => {
        const src = buildSource(st.parsed, st.me);
        const added = addSource(src, buildItems(st.parsed.msgs, st.me, src.key));
        S.setup = null; S.plan = null;
        toast(added ? `${added.toLocaleString()}問を追加しました。` : "前後の文脈を更新しました。");
        go("home");
      } }, "この内容で始める")));
}
const LINE_EXPORT_HELP = "https://help.line.me/line/smartphone?lang=ja&contentId=20007388";
// トーク履歴の文字列を読み取り、読み込みの確認画面を出す（ファイルを選んだときと、共有で届いたときの両方で使う）
function loadTalkText(text, name) {
  const parsed = parseLineExport(text);
  const names = Object.keys(parsed.speakers);
  if (!parsed.msgs.length || !names.length) { toast("LINEのトーク履歴として読み取れませんでした。「トーク履歴を送信」で作ったファイルを選んでください。", 6500); return; }
  const guess = Object.entries(parsed.speakers).filter(([n]) => n !== parsed.partner).sort((a, b) => b[1] - a[1])[0];
  stopListening(); closeConfirm();
  S.setup = { parsed, me: guess ? guess[0] : names[0], name: name || "トーク履歴" };
  S.view = "setup"; render(); window.scrollTo(0, 0);
}
async function onFile(file) {
  if (!file) return;
  let text;
  try { text = await file.text(); } catch { toast("ファイルを読み込めませんでした。"); return; }
  loadTalkText(text, file.name);
}
// 共有で届いたトーク履歴。問題の途中なら、そこまでの回答を保存してから読み込みに移る
function onShared(r) {
  if (r.error) { toast(r.error === "too_large" ? "ファイルが大きすぎて読み込めませんでした。" : "共有されたファイルを読み込めませんでした。", 6000); return; }
  if (S.view === "quiz" && S.session) quit();
  loadTalkText(r.text, r.name);
}

/* --- ホーム --- */
function viewHome() {
  if (!S.pool && !allCards().length) return viewSetup();
  if (!S.plan) S.plan = makePlan();
  const plan = S.plan;
  const nRev = plan.reviews.length, nNew = plan.fresh.length, total = nRev + nNew;
  const unstudied = S.pool ? S.pool.items.filter(it => !S.cards[it.id] && !isSkipped(it.id)).length : 0;

  const today = total
    ? h("div", { class: "todayrow" },
        h("div", { class: "info" }, h("span", { class: "lbl" }, "今日の問題"),
          h("span", { class: "num" }, h("b", null, total), "問", h("small", null, "（" + [nRev ? `復習${nRev}` : "", nNew ? `新しい表現${nNew}` : ""].filter(Boolean).join("・") + "）"))),
        h("button", { class: "btn primary", type: "button", disabled: !canStudy(), onclick: () => requestStart(S.plan) }, "はじめる"))
    : h("div", { class: "todayrow" },
        h("div", { class: "info" }, h("span", { class: "lbl" }, "今日の問題"), h("span", { class: "num" }, "すべて終わりました")),
        h("button", { class: "btn ghost", type: "button", disabled: !canStudy() || !unstudied, onclick: () => requestStart(makePlan(5)) }, "あと5問"));

  const banners = [];
  if (Cloud.status === "unconfigured") banners.push(h("p", { class: "banner" }, "サーバーが未設定です。開発用の .env にSupabaseの接続先を書いてください。"));
  else if (!Cloud.signedIn()) banners.push(h("p", { class: "banner" }, "お手本と採点を使うには、ログインが必要です。",
    h("br"), h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("login") }, "ログインする")));
  else if (Cloud.status === "needsKey") banners.push(h("p", { class: "banner" }, "復元キーを入力すると、ほかの端末の学習記録と同期できます。",
    h("br"), h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => { S.vaultLater = false; render(); } }, "復元キーを入力する")));
  if (!S.pool) banners.push(h("p", { class: "banner" }, "トーク履歴が読み込まれていないため、新しい問題は出せません（復習はできます）。",
    h("br"), h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("setup") }, "トーク履歴を読み込む")));
  else if (needsReimport() && S.settings.sendContext) banners.push(h("p", { class: "banner" }, "前後の文脈を踏まえて訳すには、トーク履歴をもう一度読み込んでください。",
    h("br"), h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("setup") }, "トーク履歴を読み込み直す")));

  const studied = allCards().filter(c => c.last).length;
  return h("div", { class: "view" },
    h("div", { class: "bar" }, h("h1", null, "トーク英作"),
      h("button", { class: "link", type: "button", onclick: () => go("weak") }, "苦手"),
      h("button", { class: "link", type: "button", onclick: () => go("settings") }, "設定")),
    today, banners, calendar(),
    h("p", { class: "foot" }, studied ? `${studied.toLocaleString()}件の表現を学習中。` : "", S.pool ? `まだ出ていない問題が${unstudied.toLocaleString()}問あります。` : ""));
}

/* --- カレンダー（月・週・日） --- */
const CAL = { mode: "month", sel: startOfDay(Date.now()), open: null, tap: { day: 0, t: 0 } };
function calIndex() {
  const now = Date.now(), today = startOfDay(now);
  const done = new Map();
  for (const e of S.log) {
    if (!S.cards[e.id]) continue;
    const d = startOfDay(e.t);
    if (!done.has(d)) done.set(d, new Set());
    done.get(d).add(e.id);
  }
  const planned = new Map(), doneToday = done.get(today) || new Set();
  for (const c of allCards()) {
    if (!c.last || !c.en) continue;
    let d = startOfDay(dueOf(c));
    if (d < today) d = today;
    if (d === today && doneToday.has(c.id)) continue;
    if (!planned.has(d)) planned.set(d, []);
    planned.get(d).push(c.id);
  }
  return { done, planned, today, now };
}
function dayDots(ix, day) {
  const done = [...(ix.done.get(day) || [])].map(id => S.cards[id]).filter(Boolean)
    .map(c => ({ c, lv: levelOf(c, ix.now) })).sort((a, b) => a.lv - b.lv);
  const plan = day >= ix.today ? (ix.planned.get(day) || []).map(id => S.cards[id]).filter(Boolean)
    .map(c => ({ c, lv: levelOf(c, ix.now) })).sort((a, b) => a.lv - b.lv) : [];
  return { done, plan };
}
const nextLine = (c, now) => (dueOf(c) <= now ? "今日の復習に入っています" : "次の出題 " + fmtMD(dueOf(c)));
function calMove(dir) {
  if (CAL.mode === "month") {
    const d = new Date(CAL.sel), day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + dir);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    CAL.sel = startOfDay(d);
  } else CAL.sel = addDays(CAL.sel, dir * (CAL.mode === "week" ? 7 : 1));
  CAL.open = null; render();
}
function calZoom(dir) {
  const order = ["month", "week", "day"];
  const next = order[clamp(order.indexOf(CAL.mode) + dir, 0, 2)];
  if (next !== CAL.mode) { CAL.mode = next; CAL.open = null; render(); }
}
function calTitle(ix) {
  const d = new Date(CAL.sel);
  if (CAL.mode === "month") return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  if (CAL.mode === "day") return fmtMDW(CAL.sel);
  const s = addDays(CAL.sel, -d.getDay()), e = addDays(s, 6), sd = new Date(s), ed = new Date(e);
  return `${sd.getMonth() + 1}月${sd.getDate()}日〜` + (sd.getMonth() === ed.getMonth() ? "" : `${ed.getMonth() + 1}月`) + `${ed.getDate()}日`;
}
function calendar() {
  const ix = calIndex();
  const unit = { month: "月", week: "週", day: "日" }[CAL.mode];
  const zbtn = (m, label) => h("button", { type: "button", "aria-pressed": String(CAL.mode === m), onclick: () => { CAL.mode = m; CAL.open = null; render(); } }, label);
  const body = CAL.mode === "month" ? monthView(ix) : CAL.mode === "week" ? weekView(ix) : dayView(ix);
  const card = h("div", { class: "cal", "aria-label": "学習カレンダー" },
    h("div", { class: "zseg", role: "group", "aria-label": "表示の単位" }, zbtn("month", "月"), zbtn("week", "週"), zbtn("day", "日")),
    h("div", { class: "cal-head" },
      h("div", { class: "ttl" }, calTitle(ix), CAL.mode === "day" && CAL.sel === ix.today ? h("small", null, "今日") : null),
      h("button", { class: "nav-btn", type: "button", "aria-label": "前の" + unit, html: ICON.prev, onclick: () => calMove(-1) }),
      h("button", { class: "nav-btn", type: "button", "aria-label": "次の" + unit, html: ICON.next, onclick: () => calMove(1) })),
    body,
    CAL.mode === "day" ? null : h("div", { class: "legend" },
      h("span", null, "定着度"), h("span", null, "低"),
      h("span", { class: "ramp", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map(l => h("span", { class: "dot s9 l" + l }))),
      h("span", null, "高"),
      h("span", { class: "plan-key" }, h("span", { class: "dot s9 plan", "aria-hidden": "true" }), "復習予定")));
  attachGestures(card);
  return [card, CAL.mode === "month" ? monthSummary(ix) : null];
}
// ピンチで拡大・縮小、横スワイプで前後へ
function attachGestures(el) {
  let pinch = null, swipe = null;
  const dist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  el.addEventListener("touchstart", e => {
    if (e.touches.length === 2) { pinch = { d0: dist(e.touches) }; swipe = null; }
    else if (e.touches.length === 1) swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    if (pinch && e.touches.length === 2) {
      const r = dist(e.touches) / pinch.d0;
      if (r > 1.3) { pinch = null; calZoom(1); } else if (r < 0.75) { pinch = null; calZoom(-1); }
    }
  }, { passive: true });
  el.addEventListener("touchend", e => {
    if (swipe && e.changedTouches.length === 1 && !pinch) {
      const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - swipe.t < 700) calMove(dx < 0 ? 1 : -1);
    }
    if (e.touches.length === 0) { pinch = null; swipe = null; }
  }, { passive: true });
}
function tapDay(day) {
  const t = Date.now();
  if (CAL.tap.day === day && t - CAL.tap.t < 400) { CAL.tap = { day: 0, t: 0 }; CAL.sel = day; CAL.mode = "day"; render(); return; }
  CAL.tap = { day, t }; CAL.sel = day; render();
}
function monthView(ix) {
  const sel = new Date(CAL.sel), y = sel.getFullYear(), mo = sel.getMonth();
  const lead = new Date(y, mo, 1).getDay(), nDays = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h("div", { class: "mcell", "aria-hidden": "true" }));
  for (let d = 1; d <= nDays; d++) {
    const day = new Date(y, mo, d).getTime();
    const { done, plan } = dayDots(ix, day);
    const all = [...done.map(x => "l" + x.lv), ...plan.map(() => "plan")];
    const cls = ["mcell", day === ix.today ? "today" : "", day === CAL.sel ? "sel" : "", day > ix.today ? "future" : ""].filter(Boolean).join(" ");
    cells.push(h("button", { class: cls, type: "button", "aria-pressed": String(day === CAL.sel),
      "aria-label": `${mo + 1}月${d}日、${done.length}問` + (plan.length ? `、復習予定${plan.length}問` : ""), onclick: () => tapDay(day) },
      h("span", { class: "num" }, d),
      h("span", { class: "mdots", "aria-hidden": "true" }, all.slice(0, 24).map(k => h("span", { class: "dot " + k }))),
      h("span", { class: "more", "aria-hidden": "true" }, all.length > 24 ? "+" + (all.length - 24) : "")));
  }
  return [h("div", { class: "wk", "aria-hidden": "true" }, WD.map(w => h("div", null, w))), h("div", { class: "mgrid" }, cells)];
}
function monthSummary(ix) {
  const { done, plan } = dayDots(ix, CAL.sel);
  if (!done.length && !plan.length) return h("div", { class: "msum" }, h("div", { class: "row1" }, h("b", null, fmtMDW(CAL.sel)), h("span", null, "問題はありません")));
  const weak = done.filter(x => x.lv === 1).length;
  return h("div", { class: "msum" },
    h("div", { class: "row1" }, h("b", null, fmtMDW(CAL.sel)),
      h("span", null, [done.length ? `${done.length}問` : "", plan.length ? `復習予定${plan.length}問` : ""].filter(Boolean).join("、")),
      h("span", { class: "grow", style: "flex:1" }),
      h("button", { class: "link", type: "button", onclick: () => { CAL.mode = "day"; render(); } }, "日表示で見る")),
    h("div", { class: "dots", "aria-hidden": "true" }, [...done.map(x => h("span", { class: "dot m l" + x.lv })), ...plan.map(() => h("span", { class: "dot m plan" }))]),
    weak ? h("p", { class: "note", style: "margin:0" }, `まだ不安定な表現が${weak}つあります。`) : null);
}
function weekView(ix) {
  const start = addDays(CAL.sel, -new Date(CAL.sel).getDay());
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i), dd = new Date(day);
    const { done, plan } = dayDots(ix, day);
    const open = CAL.open && CAL.open.day === day ? CAL.open : null;
    const pick = id => () => { CAL.open = open && open.id === id ? null : { day, id }; CAL.sel = day; render(); };
    const dots = [
      ...done.map(x => h("button", { class: "wdot" + (open && open.id === x.c.id ? " picked" : ""), type: "button", "aria-label": `${LV_NAME[x.lv]}：${x.c.ja}`, onclick: pick(x.c.id) }, h("span", { class: "dot m l" + x.lv }))),
      ...plan.map(x => h("button", { class: "wdot" + (open && open.id === x.c.id ? " picked" : ""), type: "button", "aria-label": `復習予定：${x.c.ja}`, onclick: pick(x.c.id) }, h("span", { class: "dot m plan" })))
    ];
    const count = [done.length ? `${done.length}問` : "", plan.length ? `予定${plan.length}問` : ""].filter(Boolean).join("・");
    rows.push(h("div", { class: "wrow" + (open ? " open" : "") },
      h("div", { class: "wline" },
        h("div", { class: "wlab" },
          h("div", null, h("span", { class: "wnum" + (day === ix.today ? " today" : day > ix.today ? " future" : "") }, dd.getDate()),
            h("span", { class: "wwd" }, WD[dd.getDay()] + (day === ix.today ? "・今日" : ""))),
          h("span", { class: "wcount" }, count)),
        h("div", { class: "wdots" }, dots)),
      open ? popCard(ix, day, open.id) : null));
  }
  return h("div", null, rows);
}
function popCard(ix, day, id) {
  const c = S.cards[id];
  if (!c) return null;
  const lv = levelOf(c, ix.now);
  return h("div", { class: "pop" },
    h("div", { class: "pop-meta" }, h("span", { class: "dot s10 l" + lv }), h("span", null, LV_NAME[lv]), h("span", { class: "grow" }), h("span", null, nextLine(c, ix.now))),
    h("div", { class: "pop-ja" }, c.ja),
    h("div", { class: "en-line" }, h("div", { class: "txt", lang: "en" }, smart(c.en)), speakBtn(c.en)),
    h("button", { class: "link", style: "padding-left:0;align-self:flex-start", type: "button", onclick: () => { CAL.mode = "day"; CAL.sel = day; CAL.open = null; render(); } }, "この日の問題をすべて見る"));
}
function dayItems(list, ix) {
  const groups = [];
  for (const l of [1, 2, 3, 4, 5]) {
    const g = list.filter(x => x.lv === l);
    if (!g.length) continue;
    groups.push(h("div", { class: "dgroup" }, h("span", { class: "dot s12 l" + l, "aria-hidden": "true" }), h("span", null, LV_NAME[l]), h("span", null, `${g.length}問`)));
    for (const x of g) groups.push(h("div", { class: "ditem" },
      h("div", { class: "body" },
        h("div", { class: "ja" }, x.c.ja),
        h("div", { class: "en", lang: "en" }, smart(x.c.en)),
        h("div", { class: "meta" }, (x.c.lapses ? `まちがい${x.c.lapses}回。` : "") + nextLine(x.c, ix.now))),
      speakBtn(x.c.en)));
  }
  return groups;
}
function dayView(ix) {
  const day = CAL.sel, { done, plan } = dayDots(ix, day);
  if (!done.length && !plan.length) return h("p", { class: "cal-empty" }, day > ix.today ? "この日に復習する予定の問題はありません。" : "この日は問題に答えていません。");
  const main = done.length ? done : plan;
  const counts = [0, 0, 0, 0, 0, 0];
  main.forEach(x => counts[x.lv]++);
  const label = done.length ? `この日に出た${done.length}問の、いまの定着度` : `この日に復習する予定の${plan.length}問の、いまの定着度`;
  return h("div", null,
    h("div", { class: "dsum" }, h("div", { class: "note" }, label),
      h("div", { class: "dbar", role: "img", "aria-label": [1, 2, 3, 4, 5].filter(l => counts[l]).map(l => `${LV_NAME[l]}${counts[l]}問`).join("、") },
        [1, 2, 3, 4, 5].filter(l => counts[l]).map(l => h("span", { class: "b" + l, style: `flex-grow:${counts[l]}` })))),
    dayItems(main, ix),
    done.length && plan.length ? [h("div", { class: "dgroup", style: "padding-top:20px" }, h("span", { class: "dot s12 plan", "aria-hidden": "true" }), h("span", null, "このあと復習する予定"), h("span", null, `${plan.length}問`)),
      dayItems(plan, ix)] : null);
}
function cardItem(c) {
  const now = Date.now();
  return h("div", { class: "item" },
    h("div", { class: "ja" }, c.ja),
    h("div", { class: "en-line", style: "margin-top:4px" }, h("div", { class: "txt" }, smart(c.en)), speakBtn(c.en)),
    c.ph ? h("div", { class: "meta" }, h("span", { class: "phrase" }, smart(c.ph)), c.phj ? `：${c.phj}` : "") : null,
    h("div", { class: "meta" }, (c.lapses ? `まちがい${c.lapses}回。` : "") + nextLine(c, now) + "。"));
}

/* --- 出題 --- */
function viewQuiz() {
  const ss = S.session, id = ss.cur, base = baseCard(id);
  const cx = contextOf(itemFor(id) || base);
  const doneCount = Object.keys(ss.seen).length;
  const kindLabel = { new: "新しい表現", review: "復習", probe: "確認", again: "もう一度" }[ss.kind];
  const header = h("div", null,
    h("div", { class: "bar" },
      h("button", { class: "link", style: "padding-left:0", type: "button", onclick: quit }, "終了"),
      h("div", { class: "grow" }),
      h("span", { class: "kind" }, kindLabel),
      h("span", { class: "count" }, `${Math.min(doneCount, ss.total)} / ${ss.total}`)),
    h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": ss.total, "aria-valuenow": doneCount },
      h("span", { style: `width:${Math.round((Math.min(doneCount, ss.total) / ss.total) * 100)}%` })));
  const ctxRows = cx.before.slice(-2).map(m => m.me
    ? h("div", { class: "row me" }, h("div", { class: "bubble ctxme" }, m.text))
    : h("div", { class: "row them" }, h("div", { class: "who" }, m.name), h("div", { class: "bubble them small" }, m.text)));
  const thread = h("div", { class: "thread" },
    base.d ? h("div", { class: "date-chip" }, fmtDate(base.d)) : null,
    ctxRows,
    h("div", { class: "row me" }, h("div", { class: "bubble mine" }, base.ja),
      ss.phase === "ask" || ss.kind === "new" ? h("div", { class: "under" }, "あなたが送ったメッセージ") : null));
  if (ss.phase !== "ask" && ss.kind !== "new") {
    if (ss.giveUp) thread.append(h("div", { class: "row me" }, h("div", { class: "under" }, "答えを見ました")));
    else thread.append(h("div", { class: "row me" }, h("div", { class: "bubble en", lang: "en" }, ss.shown)));
  }
  if (ss.phase === "grading" || ss.phase === "learn-loading") thread.append(h("div", { class: "row them" }, h("div", { class: "who" }, "AIコーチ"),
    h("div", { class: "bubble them", "aria-live": "polite" }, h("span", { class: "typing", "aria-label": ss.phase === "grading" ? "採点中" : "お手本を用意中" }, h("i"), h("i"), h("i")))));
  if (ss.phase === "learn") thread.append(lessonBubble(ss.lesson));
  if (ss.phase === "error") thread.append(errorBubble(ss.error));
  if (ss.phase === "result") thread.append(resultBubble(ss.result));
  thread.append(h("div", { class: "thread-end" }));
  return h("div", { class: "view" }, header, thread, ss.kind === "new" ? learnComposer(ss) : ss.phase === "result" ? resultComposer(ss.result) : askComposer(ss));
}
function askComposer(ss) {
  const busy = ss.phase === "grading";
  const ta = h("textarea", { rows: 1, lang: "en", placeholder: "英語で話すか、入力してください", "aria-label": "英語の回答", autocapitalize: "sentences", autocomplete: "off", spellcheck: "false", enterkeyhint: "send", disabled: busy, value: ss.answer });
  const send = h("button", { class: "btn primary", type: "button", disabled: busy || !ss.answer.trim(), onclick: () => check(false) }, busy ? "採点中…" : "答え合わせ");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; };
  const onChange = () => { ss.answer = ta.value; send.disabled = busy || !ta.value.trim(); grow(); };
  ta.addEventListener("input", onChange);
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (ta.value.trim()) check(false); } });
  requestAnimationFrame(grow);
  const showMic = Voice.supported() && !S.micBlocked;
  const mic = showMic ? h("button", { class: "mic", type: "button", "aria-label": "英語で話す", html: ICON.mic, disabled: busy, onclick: () => toggleListening(ta, mic, onChange) }) : null;
  return h("div", { class: "composer" },
    h("div", { class: "ask-row" }, ta, mic),
    h("div", { class: "btn-row" },
      h("button", { class: "btn ghost", type: "button", disabled: busy, onclick: () => check(true) }, "わからない"), send),
    showMic ? null : h("p", { class: "hint" }, "音声で答えるときは、キーボードのマイクを英語にして話してください。"));
}
function errorBubble(code) {
  const ss = S.session;
  return h("div", { class: "row them" }, h("div", { class: "who" }, "AIコーチ"),
    h("div", { class: "coach", role: "alert" },
      h("p", null, errorCopy(code)),
      h("div", { class: "btn-row" },
        PERMANENT.has(code) ? h("button", { class: "btn ghost", type: "button", onclick: () => {
          if (S.session) quit();
          if (code === "no_consent") { S.consentFrom = "home"; go("consent"); } else go(code === "not_signed_in" ? "login" : "settings");
        } }, code === "not_signed_in" ? "ログインする" : code === "no_consent" ? "送る内容を見る" : "設定を開く") : null,
        !PERMANENT.has(code) && code !== "refused" ? h("button", { class: "btn ghost", type: "button", onclick: () => (ss.kind === "new" ? loadLesson() : check(ss.giveUp)) }, "もう一度") : null,
        h("button", { class: "btn ghost", type: "button", onclick: nextQuestion }, "この問題をとばす"))));
}
const VERDICT = { correct: "○ 正解", close: "△ おしい", wrong: "× もう一歩" };
function resultBubble(r) {
  const c = r.card, ss = S.session;
  return h("div", { class: "row them" }, h("div", { class: "who" }, "AIコーチ"),
    h("div", { class: "coach", "aria-live": "polite" },
      ss.giveUp ? null : h("span", { class: "verdict " + r.auto }, VERDICT[r.auto]),
      (r.res.feedback || (ss.giveUp && c.tip)) ? h("p", { style: ss.giveUp ? "" : "margin-top:10px" }, r.res.feedback || c.tip) : null,
      ss.giveUp ? null : r.res.natural
        ? h("div", { class: "natural" }, h("div", { class: "lbl" }, "ネイティブならこう言う"),
            h("div", { class: "en-line" }, h("div", { class: "txt", lang: "en" }, smart(r.res.natural)), speakBtn(r.res.natural)),
            r.res.natural_why ? h("p", { class: "why" }, r.res.natural_why) : null)
        : r.auto !== "wrong" ? h("p", { class: "already" }, "ネイティブにも自然な言い方です。") : null,
      h("div", { class: "sec" }, h("div", { class: "lbl" }, "お手本"),
        h("div", { class: "en-line" }, h("div", { class: "txt model", lang: "en" }, smart(c.en)), speakBtn(c.en))),
      c.alts && c.alts.length ? h("div", { class: "sec" }, h("div", { class: "lbl" }, "ほかの言い方"),
        c.alts.map(a => h("div", { class: "en-line alt" }, h("div", { class: "txt", lang: "en" }, smart(a)), speakBtn(a)))) : null,
      c.ph ? h("div", { class: "sec" }, h("div", { class: "lbl" }, "覚えたい表現"),
        h("p", null, h("span", { class: "phrase", lang: "en" }, smart(c.ph)), c.phj ? `　${c.phj}` : "")) : null),
    h("p", { class: "ai-note" }, AI_NOTE));
}
function lessonBubble(c) {
  return h("div", { class: "row them" }, h("div", { class: "who" }, "AIコーチ"),
    h("div", { class: "coach", "aria-live": "polite" },
      h("div", { class: "lbl" }, "英語ではこう送る"),
      h("div", { class: "en-line" }, h("div", { class: "txt model", lang: "en" }, smart(c.en)), speakBtn(c.en)),
      c.tip ? h("p", { style: "margin-top:10px" }, c.tip) : null,
      c.alts && c.alts.length ? h("div", { class: "sec" }, h("div", { class: "lbl" }, "ほかの言い方"),
        c.alts.map(a => h("div", { class: "en-line alt" }, h("div", { class: "txt", lang: "en" }, smart(a)), speakBtn(a)))) : null,
      c.ph ? h("div", { class: "sec" }, h("div", { class: "lbl" }, "覚えたい表現"),
        h("p", null, h("span", { class: "phrase", lang: "en" }, smart(c.ph)), c.phj ? `　${c.phj}` : "")) : null),
    h("p", { class: "ai-note" }, AI_NOTE));
}
function learnComposer(ss) {
  const ready = ss.phase === "learn";
  const when = whenText(Date.now() + S.mem.s0 * DAY);
  return h("div", { class: "composer" },
    h("p", { class: "next-due", style: "margin-top:0" }, `声に出して言えるようになったら「覚えた」へ。${when === "今日" ? "今日のうちに" : when + "、"}英語で答える問題として出ます。`),
    h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", disabled: !ready, onclick: () => { learned(); nextQuestion(); } }, ss.phase === "learn-loading" ? "お手本を用意しています…" : "覚えた")));
}
function resultComposer(r) {
  const ss = S.session;
  const nextText = () => {
    if (r.chosen === "wrong") return ss.seen[r.card.id] < 3 ? "このあと、もう一度出ます。" : "近いうちに、また復習に出ます。";
    return `次の出題は${whenText(r.now + r.options[r.chosen].S * DAY)}です。`;
  };
  const due = h("p", { class: "next-due" }, nextText());
  const seg = h("div", { class: "seg", role: "group", "aria-label": "判定（タップで変更できます）" },
    ["correct", "close", "wrong"].map(v => h("button", { class: v, type: "button", "aria-pressed": String(r.chosen === v), onclick: () => {
      r.chosen = v;
      seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.classList.contains(v))));
      due.textContent = nextText();
    } }, VERDICT[v])));
  return h("div", { class: "composer" },
    ss.giveUp ? null : seg, due,
    h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", onclick: () => { commit(); nextQuestion(); } }, ss.queue.length ? "次へ" : "結果を見る")));
}

/* --- 結果 --- */
function doneSummary(firsts, n) {
  const L = n("learned"), Rv = firsts.length - L, parts = [];
  if (L) parts.push(`新しい表現を${L}個覚えました。`);
  if (Rv) parts.push(`復習${Rv}問に答えました（正解${n("correct")}、おしい${n("close")}、もう一歩${n("wrong")}）。`);
  return parts.join("");
}
function viewDone() {
  const ss = S.session;
  const firsts = ss ? Object.values(ss.first) : [];
  const n = v => firsts.filter(x => x === v).length;
  const missed = ss ? ss.missed.map(id => S.cards[id]).filter(Boolean) : [];
  const learnedCards = ss ? Object.entries(ss.first).filter(([, v]) => v === "learned").map(([id]) => S.cards[id]).filter(Boolean) : [];
  return h("div", { class: "view" },
    h("div", { class: "intro" }, h("p", { class: "title" }, "おつかれさまでした"), h("p", null, doneSummary(firsts, n))),
    learnedCards.length ? h("section", null, h("h2", null, "今日覚えた表現"), learnedCards.map(cardItem)) : null,
    missed.length ? h("section", null, h("h2", null, "今日まちがえた表現"),
      h("p", { class: "note", style: "margin:-6px 0 4px" }, "忘れかけた頃に、また出題します。"), missed.map(cardItem)) : null,
    h("div", { style: "padding:12px 0 28px" }, h("button", { class: "btn primary block", type: "button", onclick: () => { S.session = null; go("home"); } }, "ホームへ")));
}

/* --- 苦手 --- */
function viewWeak() {
  const list = allCards().filter(c => c.lapses > 0 && c.en && c.last).sort((a, b) => (b.lapses - a.lapses) || (b.last - a.last));
  return h("div", { class: "view" },
    h("div", { class: "bar" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("home") }, "戻る"), h("h1", { style: "font-size:1.0625rem" }, "苦手な表現")),
    list.length ? h("div", null, h("p", { class: "note" }, `${list.length}件。まちがえた回数が多い順です。`), list.map(cardItem))
      : h("p", { class: "empty" }, "まだ苦手な表現はありません。問題に答えると、まちがえた表現がここにたまります。"));
}

/* --- ログイン（メールに届く6桁のコード） --- */
const LOGIN = { email: "", sent: false, busy: false };
function viewLogin() {
  const back = h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("home") }, "戻る");
  const emailIn = h("input", { class: "text-in", id: "email", type: "email", inputmode: "email", autocomplete: "email", autocapitalize: "off", placeholder: "you@example.com", value: LOGIN.email });
  const codeIn = h("input", { class: "text-in", id: "code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "10", placeholder: "123456" });
  const send = h("button", { class: "btn primary block", type: "button", disabled: LOGIN.busy, onclick: async () => {
    const email = emailIn.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("メールアドレスを確認してください。"); return; }
    LOGIN.email = email; LOGIN.busy = true; render();
    try { await Cloud.sendCode(email); LOGIN.sent = true; toast("確認コードを送りました。メールを確認してください。"); }
    catch (e) { toast(e && e.code === "rate_limited" ? "送信回数が多すぎます。少し待ってから、もう一度試してください。" : "確認コードを送れませんでした。"); }
    finally { LOGIN.busy = false; render(); }
  } }, LOGIN.sent ? "コードを送り直す" : "確認コードを送る");
  const verify = h("button", { class: "btn primary block", type: "button", disabled: LOGIN.busy, onclick: async () => {
    const code = codeIn.value.replace(/\D/g, "");
    if (code.length < 6) { toast("メールに届いたコードを入力してください。"); return; }
    LOGIN.busy = true; render();
    try { await Cloud.verifyCode(LOGIN.email, code); LOGIN.sent = false; S.view = "home"; S.plan = null; }
    catch { toast("コードが正しくないか、有効期限が切れています。"); }
    finally { LOGIN.busy = false; render(); }
  } }, "ログイン");
  return h("div", { class: "view" },
    h("div", { class: "bar" }, back),
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, "ログイン"),
      h("p", null, "お手本と採点を使うため、またほかの端末と学習記録を同期するために、ログインします。")),
    h("section", { style: "border-top:0" },
      h("label", { class: "field", for: "email" }, "メールアドレス"), emailIn,
      h("div", { style: "margin-top:12px" }, LOGIN.sent ? null : send),
      LOGIN.sent ? [
        h("p", { class: "note", style: "margin:4px 0 12px" }, `${LOGIN.email} に届いた6桁のコードを入力してください。`),
        h("label", { class: "field", for: "code" }, "確認コード"), codeIn,
        h("div", { style: "margin-top:12px" }, verify),
        h("div", { style: "margin-top:10px" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => { LOGIN.sent = false; render(); } }, "メールアドレスを変える"))
      ] : null));
}

/* --- AIに送る前の同意 --- */
const fmtYMD = t => { const d = new Date(t); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
function viewConsent() {
  const from = S.consentFrom, plan = S.pendingPlan;
  const back = () => { S.pendingPlan = null; S.consentFrom = null; go(from === "settings" ? "settings" : "home"); };
  const agree = () => {
    setConsent(true);
    S.pendingPlan = null; S.consentFrom = null;
    if (from === "start" && plan) { startSession(plan); if (S.view !== "consent") return; }
    toast("AIへの送信に同意しました。");
    go(from === "settings" ? "settings" : "home");
  };
  const decline = () => { back(); toast("同意しない場合、お手本と採点は使えません。"); };
  const li = t => h("li", null, t);
  return h("div", { class: "view" },
    h("div", { class: "bar" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: back }, "戻る")),
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, "AIコーチを使う前に"),
      h("p", null, "お手本づくりと採点には、Anthropic社のAI「Claude」を使います。AIコーチを使うと、次の内容が運営者のサーバーを経由してAnthropic社に送られます。")),
    h("section", { style: "border-top:0" },
      h("ul", { class: "consent-list" },
        li("問題にするあなたの発言（問題にしないと判断された発言も、判断のために送ります）"),
        li("あなたの英語の回答と、前に表示したお手本"),
        li("設定した英語のレベル"),
        li(S.settings.sendContext
          ? "前後のやり取り（前3件・後ろ2件。相手の発言を含みます。名前は送りません。設定でオフにできます）"
          : "前後のやり取り：今の設定では送りません（設定でオンにすると、前3件・後ろ2件を相手の発言も含めて送ります。名前は送りません）")),
      h("p", { class: "note", style: "margin:12px 0 0" }, "運営者のサーバーには、これらを保存しません。Anthropic社での取り扱いは、同社のプライバシーポリシー（",
        h("a", { href: "https://www.anthropic.com/legal", target: "_blank", rel: "noopener" }, "www.anthropic.com/legal"), "）に従います。"),
      h("p", { class: "banner" }, AI_NOTE + "お手本や判定は参考としてお使いください。")),
    h("div", { style: "padding:8px 0 28px" },
      hasConsent()
        ? [h("p", { class: "note", style: "margin:0 0 12px" }, `${fmtYMD(S.aiConsent.at)}に同意しています。取り消すときは、設定の「データの扱い」から取り消せます。`),
           h("button", { class: "btn ghost block", type: "button", onclick: back }, "戻る")]
        : h("div", { class: "btn-row", style: "margin-top:0" },
            h("button", { class: "btn ghost", type: "button", onclick: decline }, "同意しない"),
            h("button", { class: "btn primary", type: "button", onclick: agree }, from === "start" ? "同意してはじめる" : "同意する"))));
}

/* --- アカウントの削除 --- */
// この端末に保存しているものをすべて消し、はじめて開いたときの状態に戻す
async function wipeThisDevice() {
  for (const k of Object.keys(pending)) clearTimeout(pending[k]), delete pending[k];
  stopListening();
  Object.assign(S, { pool: null, cards: {}, log: [], mem: { m: 1, s0: 1, n: 0, nAt: 0, fitted: false, at: 0 }, settings: { ...DEFAULT_SETTINGS },
    metaAt: 0, wipedAt: 0, aiConsent: null, pendingPlan: null, consentFrom: null, vaultLater: false, plan: null, session: null, setup: null });
  indexPool(); lessons.clear(); skippedNow.clear();
  await Promise.all(["pool", "cards", "log", "skips", "vaultKeys", "sync"].map(k => Store.del(k)));
  for (const key of Object.values(K)) LS.del(key);
}
const DELETE = { understood: false, busy: false };
function viewDeleteAccount() {
  const back = h("button", { class: "link", style: "padding-left:0", type: "button", disabled: DELETE.busy, onclick: () => go("settings") }, "戻る");
  const li = t => h("li", null, t);
  const check = h("input", { type: "checkbox", id: "understood", checked: DELETE.understood, disabled: DELETE.busy, onchange: e => { DELETE.understood = e.target.checked; del.disabled = !DELETE.understood; } });
  const del = h("button", { class: "btn primary danger block", type: "button", disabled: !DELETE.understood || DELETE.busy, onclick: async () => {
    DELETE.busy = true; render();
    try {
      await Cloud.deleteAccount();
      await wipeThisDevice();
      DELETE.busy = false; DELETE.understood = false;
      toast("アカウントを削除しました。");
      go("home");
    } catch (e) {
      DELETE.busy = false; render();
      const code = e && e.code;
      toast(code === "offline" ? "インターネットに接続されていません。接続してから、もう一度試してください。"
        : code === "not_signed_in" ? "ログインの有効期限が切れています。ログインし直してから、もう一度試してください。"
        : "アカウントを削除できませんでした。電波の状態を確認して、もう一度試してください。", 6000);
    }
  } }, DELETE.busy ? "削除しています…" : "アカウントを削除する");
  return h("div", { class: "view" },
    h("div", { class: "bar" }, back),
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, "アカウントを削除する"),
      h("p", null, "アカウントを削除すると、次のものがすべて消えます。元に戻すことはできません。")),
    h("section", { style: "border-top:0" },
      h("ul", { class: "consent-list" },
        li(`ログインに使っているアカウント（${Cloud.email()}）`),
        li("サーバーに保存している学習記録と回答履歴（暗号化したもの）と、復元キーで開く鍵"),
        li("この端末に保存しているトーク履歴・学習記録・設定")),
      h("p", { class: "note", style: "margin:12px 0 0" }, "ほかの端末でもこのアカウントを使っていた場合、その端末はログアウトされます。その端末に残っている記録は、その端末でアプリを削除すると消えます。"),
      h("p", { class: "banner" }, "サブスクに登録している場合、アカウントを削除しても自動では解約されません。App Store または Google Play の定期購入の画面で解約してください。"),
      h("p", { class: "note", style: "margin:12px 0 0" }, "記録を手元に残したい場合は、先にバックアップをファイルに保存してください。"),
      h("button", { class: "btn ghost block", type: "button", style: "margin-top:10px", disabled: DELETE.busy, onclick: exportBackup }, "バックアップを保存する")),
    h("section", null,
      h("label", { class: "check" }, check, h("span", null, "元に戻せないことを理解しました")),
      h("div", { style: "margin-top:14px" }, del)),
    h("div", { style: "height:24px" }));
}

/* --- 復元キーの作成（はじめてのログイン） --- */
const VAULT = { key: null, saved: false, busy: false, input: "", armedReset: false };
function viewVaultSetup() {
  if (!VAULT.key && !VAULT.busy) {
    VAULT.busy = true;
    Cloud.beginSetup().then(k => { VAULT.key = k; VAULT.busy = false; render(); });
  }
  const check = h("input", { type: "checkbox", id: "saved", checked: VAULT.saved, onchange: e => { VAULT.saved = e.target.checked; done.disabled = !VAULT.saved; } });
  const done = h("button", { class: "btn primary block", type: "button", disabled: !VAULT.saved || !VAULT.key, onclick: async () => {
    done.disabled = true;
    try { await Cloud.finishSetup(); VAULT.key = null; VAULT.saved = false; toast("学習記録の同期を始めました。"); go("home"); }
    catch { toast("保存できませんでした。電波の状態を確認して、もう一度試してください。"); done.disabled = false; }
  } }, "保存したので次へ");
  return h("div", { class: "view" },
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, "復元キーを保存してください"),
      h("p", null, "学習記録は、この端末で暗号化してから保存します。機種変更のときや別の端末で使うときは、この復元キーで記録を戻します。")),
    h("section", { style: "border-top:0" },
      h("div", { class: "rkey", "aria-label": "復元キー" }, VAULT.key ? VAULT.key.replace(/^((?:[A-Z0-9]{4}-){2}[A-Z0-9]{4})-/, "$1-\n") : "作成しています…"),
      VAULT.key ? h("button", { class: "btn ghost block", type: "button", style: "margin-top:10px", onclick: () => {
        (navigator.clipboard ? navigator.clipboard.writeText(VAULT.key) : Promise.reject()).then(() => toast("コピーしました。パスワード管理アプリなどに保存してください。"), () => toast("コピーできませんでした。書き写して保存してください。"));
      } }, "コピーする") : null,
      h("p", { class: "banner" }, "運営者は復元キーを保管していません。なくすと、運営者にも学習記録を戻せません。スクリーンショットだけでなく、パスワード管理アプリなどにも保存しておくと安心です。"),
      h("label", { class: "check" }, check, h("span", null, "復元キーを安全な場所に保存しました")),
      h("div", { style: "margin-top:14px" }, done)));
}

/* --- 復元キーの入力（別の端末・再インストール） --- */
function viewVaultUnlock() {
  const keyIn = h("input", { class: "text-in rkey-in", id: "rk", type: "text", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", value: VAULT.input,
    oninput: e => { VAULT.input = e.target.value; } });
  const go1 = h("button", { class: "btn primary block", type: "button", disabled: VAULT.busy, onclick: async () => {
    VAULT.busy = true; go1.disabled = true; go1.textContent = "確認しています…";
    try { await Cloud.unlock(keyIn.value); VAULT.input = ""; toast("学習記録を戻しました。"); S.plan = null; go("home"); }
    catch (e) { toast(e && e.code === "wrong_key" ? "復元キーが違います。もう一度確認してください。" : "確認できませんでした。電波の状態を確認してください。"); }
    finally { VAULT.busy = false; if (go1.isConnected) { go1.disabled = false; go1.textContent = "記録を戻す"; } }
  } }, "記録を戻す");
  const reset = h("button", { class: "link danger", style: "padding-left:0", type: "button", onclick: async () => {
    if (!VAULT.armedReset) { VAULT.armedReset = true; reset.textContent = "もう一度タップすると、サーバー上の学習記録を消して作り直します"; setTimeout(() => { VAULT.armedReset = false; if (reset.isConnected) reset.textContent = "復元キーをなくした"; }, 5000); return; }
    VAULT.armedReset = false;
    try { await Cloud.resetVault(); render(); } catch { toast("作り直せませんでした。"); }
  } }, "復元キーをなくした");
  return h("div", { class: "view" },
    h("div", { class: "intro" },
      h("p", { class: "title", style: "font-size:1.5rem" }, "復元キーを入力してください"),
      h("p", null, `${Cloud.email()} の学習記録を、この端末に戻します。最初のログインのときに保存した24文字の復元キーを入力してください。`)),
    h("section", { style: "border-top:0" },
      h("label", { class: "field", for: "rk" }, "復元キー"), keyIn,
      h("div", { style: "margin-top:12px" }, go1),
      h("div", { style: "margin-top:16px" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => { S.vaultLater = true; go("home"); } }, "あとで入力する")),
      h("p", { class: "note", style: "margin:14px 0 6px" }, "復元キーをなくした場合は、サーバー上の学習記録を消して作り直せます。この端末にある記録は残り、新しい復元キーで保存し直します。"),
      reset));
}

/* --- 設定 --- */
let resetArmed = false;
function memoryNotes() {
  const m = S.mem, c = calibInfo(), eps = Math.round(exploreShare() * 100);
  const out = [];
  if (!m.fitted) out.push(`回答が20件たまると、あなた向けの調整を始めます（いま${m.n || 0}件）。それまでは標準的な忘れ方で計算します。`);
  else {
    out.push(`あなたの回答${m.n.toLocaleString()}件から調整しています。`);
    out.push(`覚えた直後の記憶の持ち：約${m.s0 < 1 ? Math.round(m.s0 * 24) + "時間" : m.s0 + "日"}（標準は約1日）`);
    out.push(`復習で記憶が伸びる度合い：標準の${m.m}倍`);
  }
  if (c.n >= 8) out.push(`「定着率が高い」と予測した問題の正解率：予測${Math.round(c.pred * 100)}%に対して実際${Math.round(c.act * 100)}%（直近${c.n}問）`);
  out.push(`予測を確かめるために混ぜる問題：約${eps}%`);
  return out;
}
function syncLine() {
  const st = Cloud.status;
  if (st === "unconfigured") return "サーバーが未設定のため、この端末だけで動いています。";
  if (st === "signedOut") return "ログインしていません。";
  if (st === "needsKey") return "復元キーが未入力のため、学習記録を同期していません。";
  if (st === "needsSetup") return "復元キーの作成が終わっていません。";
  if (st === "checking") return "確認しています…";
  if (Cloud.syncError) return "前回の同期に失敗しました。電波の状態を確認してください。";
  if (Cloud.syncing) return "同期しています…";
  if (!Cloud.lastSyncAt) return "学習記録は暗号化して同期します。";
  const d = new Date(Cloud.lastSyncAt);
  return `学習記録は暗号化して同期しています（最終同期 ${pad2(d.getHours())}:${pad2(d.getMinutes())}）。`;
}
function viewSettings() {
  const st = S.settings;
  const segBtn = n => h("button", { class: "plain", type: "button", "aria-pressed": String(st.newPerDay === n), onclick: () => { st.newPerDay = n; persistSettings(); S.plan = null; render(); } }, `${n}問`);
  const rateLbl = h("span", { class: "note" }, `${st.rate.toFixed(2)}倍`);
  const sw = (on, label, fn) => { const b = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, onclick: () => { fn(); b.setAttribute("aria-checked", String(b.getAttribute("aria-checked") !== "true")); } }); return b; };
  const resetBtn = h("button", { class: "btn ghost block danger", type: "button", onclick: async () => {
    if (!resetArmed) { resetArmed = true; resetBtn.textContent = "もう一度タップすると、すべての学習記録を消去します"; setTimeout(() => { resetArmed = false; if (resetBtn.isConnected) resetBtn.textContent = "学習記録を消去する"; }, 4000); return; }
    resetArmed = false; S.cards = {}; S.log = []; S.mem = { m: 1, s0: 1, n: 0, nAt: 0, fitted: false, at: 0 }; LS.set(K.mem, S.mem);
    S.wipedAt = Date.now(); LS.set(K.wipedAt, S.wipedAt);
    saveCards(); saveLog(); S.plan = null;
    try { await Cloud.wipeRemote(); } catch {}
    toast("学習記録を消去しました。"); go("home");
  } }, "学習記録を消去する");
  const fileBtn = h("label", { class: "btn ghost block file-btn" }, "トーク履歴を追加・読み込み直す",
    h("input", { type: "file", onchange: e => onFile(e.target.files && e.target.files[0]) }));
  const importBtn = h("label", { class: "btn ghost block file-btn", style: "margin-top:10px" }, "バックアップから復元する",
    h("input", { type: "file", onchange: e => importBackup(e.target.files && e.target.files[0]) }));
  const note = (text, last) => h("p", { class: "note", style: last ? "margin:0" : "margin:0 0 6px" }, text);
  const account = Cloud.signedIn()
    ? [note(Cloud.email()), note(syncLine(), true),
        h("div", { class: "btn-row" },
          Cloud.status === "needsKey" ? h("button", { class: "btn ghost", type: "button", onclick: () => { S.vaultLater = false; go("home"); } }, "復元キーを入力") : null,
          Cloud.status === "ready" ? h("button", { class: "btn ghost", type: "button", onclick: () => Cloud.sync() }, "今すぐ同期") : null,
          h("button", { class: "btn ghost", type: "button", onclick: async () => { await Cloud.signOut(); toast("ログアウトしました。"); go("home"); } }, "ログアウト")),
        h("button", { class: "link danger", style: "padding-left:0;margin-top:6px", type: "button", onclick: () => { DELETE.understood = false; go("deleteAccount"); } }, "アカウントを削除する")]
    : [note(syncLine(), true), Cloud.configured() ? h("div", { class: "btn-row" }, h("button", { class: "btn primary", type: "button", onclick: () => go("login") }, "ログイン")) : null];

  return h("div", { class: "view" },
    h("div", { class: "bar" }, h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => go("home") }, "戻る"), h("h1", { style: "font-size:1.0625rem" }, "設定")),
    h("section", { style: "border-top:0;padding-top:4px" }, h("h2", null, "アカウント"), account),
    h("section", null, h("h2", null, "翻訳と採点"),
      h("div", { class: "row-set" }, h("span", null, "前後のやり取りも踏まえて訳す"), sw(st.sendContext, "前後のやり取りも踏まえて訳す", () => { st.sendContext = !st.sendContext; persistSettings(); })),
      h("p", { class: "note", style: "margin:8px 0 0" }, "オンにすると、対象の発言の前3件・後ろ2件（同じ日のやり取り）も、相手の発言を含めてClaudeに送ります。話し手の名前は送りません。")),
    h("section", null, h("h2", null, "英語のレベル"),
      h("div", { class: "seg" }, Object.entries(LEVELS).map(([k, v]) => h("button", { class: "plain", type: "button", "aria-pressed": String(levelKey() === k),
        onclick: () => { st.level = k; persistSettings(); skippedNow.clear(); S.plan = null; render(); } }, v.name))),
      h("p", { class: "note", style: "margin:8px 0 0" }, "新しい表現を出題するとき、問題にする意味があるかをClaudeがこのレベルで判定します。" + LEVELS[levelKey()].note)),
    h("section", null, h("h2", null, "1日の新しい問題"), h("div", { class: "seg" }, [5, 10, 20, 30].map(segBtn))),
    h("section", null,
      h("div", { class: "row-set" }, h("h2", { style: "margin:0" }, "読み上げの速さ"), rateLbl),
      h("input", { type: "range", min: "0.6", max: "1.2", step: "0.05", value: String(st.rate), "aria-label": "読み上げの速さ",
        oninput: e => { st.rate = +e.target.value; rateLbl.textContent = `${st.rate.toFixed(2)}倍`; }, onchange: persistSettings }),
      h("button", { class: "link", style: "padding-left:0", type: "button", onclick: () => TTS.speak("Hey, are you free this weekend?") }, "試しに聞く"),
      h("div", { class: "row-set", style: "margin-top:12px" }, h("span", null, "お手本を自動で読み上げる"), sw(st.autoSpeak, "お手本を自動で読み上げる", () => { st.autoSpeak = !st.autoSpeak; persistSettings(); }))),
    h("section", null, h("h2", null, "あなた向けの記憶モデル"),
      memoryNotes().map((t, i, a) => note(t, i === a.length - 1)),
      h("p", { class: "note", style: "margin:10px 0 0" }, "カレンダーの定着度は、このモデルで計算した「1週間後にも思い出せる見込み」です。")),
    h("section", null, h("h2", null, "トーク履歴"),
      S.pool && S.pool.sources.length ? S.pool.sources.map(s => note(`${s.partner} とのトーク（${s.me}として、${(s.count || 0).toLocaleString()}問）` + (s.msgs ? "" : "：文脈なし"))) : note("読み込まれていません。"),
      shareTargetSupported() ? note("LINEの「トーク履歴を送信」で「トーク英作」を選んでも追加できます。") : null,
      h("div", { style: "margin-top:10px" }, fileBtn),
      S.pool ? h("button", { class: "link danger", style: "padding-left:0;margin-top:6px", type: "button", onclick: () => { S.pool = null; indexPool(); savePool(); S.plan = null; toast("読み込んだトーク履歴を削除しました。学習記録は残っています。"); render(); } }, "読み込んだトーク履歴を削除する") : null),
    h("section", null, h("h2", null, "バックアップ"),
      h("p", { class: "note", style: "margin:0 0 10px" }, "同期とは別に、学習記録・回答履歴・トーク履歴をファイルとして手元に保存できます。"),
      h("button", { class: "btn ghost block", type: "button", onclick: exportBackup }, "バックアップを保存する"),
      importBtn),
    h("section", null, h("h2", null, "データの扱い"),
      note("トーク履歴は、この端末にだけ保存され、サーバーには保存しません。"),
      note("学習記録と回答履歴は、この端末で暗号化してからサーバーに保存します。運営者は中身を読めません。復元キーをなくすと、運営者にも記録を戻せません。"),
      note(`お手本や採点を作るときは、問題文（あなたの発言。問題にしないと判断された発言も含みます）・あなたの回答・前に表示したお手本・英語のレベル${st.sendContext ? "・前後のやり取り" : ""}が、運営者のサーバーを経由してAnthropic社のClaude APIに送られます。運営者のサーバーには保存しません。`),
      note(AI_NOTE + "お手本や判定は参考としてお使いください。"),
      hasConsent()
        ? [note(`AIへの送信に同意しています（${fmtYMD(S.aiConsent.at)}）。`, true),
           h("div", { class: "btn-row" },
             h("button", { class: "btn ghost", type: "button", onclick: () => { S.consentFrom = "settings"; go("consent"); } }, "送る内容を見る"),
             h("button", { class: "btn ghost danger", type: "button", onclick: () => { setConsent(false); toast("同意を取り消しました。AIへの送信を止めます。"); render(); } }, "同意を取り消す"))]
        : [note("AIへの送信には、まだ同意していません。「はじめる」を押したときに確認します。", true),
           h("div", { class: "btn-row" },
             h("button", { class: "btn ghost", type: "button", onclick: () => { S.consentFrom = "settings"; go("consent"); } }, "送る内容を見て同意する"))]),
    h("section", null, resetBtn),
    h("div", { style: "height:24px" }));
}


/* ============ 同期のつなぎ込み ============ */
// サーバーに送る学習記録。端末だけの情報（トーク履歴の位置・相手の発言）は含めない
const CARD_FIELDS = ["id", "ja", "d", "en", "alts", "tip", "ph", "phj", "created", "ans", "S", "last", "lapses", "u"];
function cardPayload(id) {
  const c = S.cards[id];
  if (!c) return null;
  const o = {};
  for (const f of CARD_FIELDS) if (c[f] !== undefined) o[f] = c[f];
  return o;
}
const logKey = e => e.id + "|" + e.t + "|" + e.k;
const cloudHooks = {
  store: Store,
  changed(quiet) { if (!S.ready) return; if (quiet && S.view === "quiz") return; if (S.view !== "quiz") render(); },
  cardIds: () => Object.keys(S.cards),
  dayKeys: () => [...new Set(S.log.map(e => dayKey(e.t)))],
  cardPayload,
  dayEvents: day => S.log.filter(e => dayKey(e.t) === day),
  metaPayload: () => ({ at: S.metaAt, wipedAt: S.wipedAt, settings: { newPerDay: S.settings.newPerDay, rate: S.settings.rate, autoSpeak: S.settings.autoSpeak, sendContext: S.settings.sendContext, level: S.settings.level } }),
  async resetLocalLearning() {
    S.cards = {}; S.log = []; S.plan = null;
    await Store.set("cards", S.cards); await Store.set("log", S.log);
  },
  // ほかの端末の変更を取り込む
  mergeRemote({ cards, days, meta }) {
    let changed = false;
    if (meta && (meta.wipedAt || 0) > (S.wipedAt || 0)) {
      // ほかの端末で「学習記録を消去」された
      S.cards = {}; S.log = []; S.wipedAt = meta.wipedAt; LS.set(K.wipedAt, S.wipedAt); changed = true;
    }
    for (const rc of cards) {
      if (!rc || !rc.id) continue;
      const lc = S.cards[rc.id];
      if (rc.deleted) { if (lc && (rc.u || 0) > (lc.u || 0)) { delete S.cards[rc.id]; changed = true; } continue; }
      if (!lc || (rc.u || 0) > (lc.u || 0)) {
        const it = S.poolIndex.get(rc.id);
        S.cards[rc.id] = { ...rc, src: lc?.src ?? it?.src ?? null, mi: lc?.mi ?? it?.mi ?? null };
        changed = true;
      }
    }
    if (days.length) {
      const have = new Set(S.log.map(logKey));
      for (const d of days) for (const e of d.events || []) if (e && e.id && e.t && e.k && e.t > (S.wipedAt || 0) && !have.has(logKey(e))) { S.log.push(e); have.add(logKey(e)); changed = true; }
      S.log.sort((a, b) => a.t - b.t);
    }
    if (meta && meta.settings && (meta.at || 0) > (S.metaAt || 0)) {
      Object.assign(S.settings, meta.settings); S.metaAt = meta.at;
      LS.set(K.settings, S.settings); LS.set(K.metaAt, S.metaAt); changed = true;
    }
    if (changed) { replayAll(); saveCards(); saveLog(); S.plan = null; scheduleRefit(); }
  }
};

/* ============ バックアップ ============ */
function exportBackup() {
  flushAll();
  const data = { app: "talk-eisaku", v: 3, exportedAt: new Date().toISOString(), settings: S.settings, cards: S.cards, log: S.log, pool: S.pool, mem: S.mem };
  saveTextFile(`talk-eisaku-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data))
    .then(() => toast("バックアップを保存しました。"), () => toast("バックアップを保存できませんでした。"));
}
function mergePool(p2) {
  if (!p2 || !Array.isArray(p2.items)) return;
  const pool = S.pool || { v: 2, sources: [], items: [] };
  for (const s of p2.sources || []) {
    if (!s || !s.partner) continue;
    const i = pool.sources.findIndex(x => (s.key && x.key === s.key) || (x.partner === s.partner && x.me === s.me));
    if (i < 0) pool.sources.push(s); else if (s.msgs && !pool.sources[i].msgs) pool.sources[i] = s;
  }
  const byId = new Map(pool.items.map(i => [i.id, i])), haveJa = new Set(pool.items.map(i => i.ja));
  for (const it of p2.items) {
    if (!it || !it.id || !it.ja) continue;
    const old = byId.get(it.id);
    if (old) { if (it.src && !old.src) { old.src = it.src; old.mi = it.mi; } continue; }
    if (haveJa.has(it.ja)) continue;
    pool.items.push(it); haveJa.add(it.ja);
  }
  pool.v = 2; S.pool = pool; indexPool(); savePool();
}
// 以前の版（復習間隔だけを持っていた記録）を、回答履歴の形に変換する
function convertLegacy() {
  const have = new Set(S.log.map(e => e.id));
  let n = 0;
  for (const c of allCards()) {
    if (have.has(c.id) || !c.last) continue;
    const s = c.reps === 0 && c.lapses > 0 ? 0.3 : Math.max(0.3, c.ivl || 1);
    if (c.created && startOfDay(c.created) !== startOfDay(c.last)) S.log.push({ id: c.id, t: c.created, k: "seen" });
    S.log.push({ id: c.id, t: c.last, k: "init", s, l: c.lapses || 0 });
    n++;
  }
  if (n) S.log.sort((a, b) => a.t - b.t);
  return n;
}
async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "talk-eisaku" || !data.cards || typeof data.cards !== "object") throw 0;
    let n = 0;
    for (const [id, c] of Object.entries(data.cards)) {
      if (!c || typeof c !== "object" || !c.ja || !c.en) continue;
      const l = S.cards[id];
      if (!l || (c.last || 0) > (l.last || 0)) { S.cards[id] = { ...c, u: Date.now() }; n++; }
    }
    if (Array.isArray(data.log)) {
      const keyOf = e => e.id + "|" + e.t + "|" + e.k, have = new Set(S.log.map(keyOf));
      for (const e of data.log) if (e && e.id && e.t && e.k && !have.has(keyOf(e))) { S.log.push(e); have.add(keyOf(e)); }
      S.log.sort((a, b) => a.t - b.t);
    }
    convertLegacy();
    if (data.pool) mergePool(data.pool);
    if (data.settings && typeof data.settings === "object") { Object.assign(S.settings, data.settings); persistSettings(); }
    fitModel(true); saveCards(); saveLog(); S.plan = null; Cloud.markAll();
    toast(`バックアップから${n.toLocaleString()}件の学習記録を復元しました。`); go("home");
  } catch { toast("バックアップファイルとして読み取れませんでした。"); }
}


/* ============ 起動 ============ */
async function boot() {
  const st = LS.get(K.settings); if (st) { delete st.model; Object.assign(S.settings, st); }
  const mem = LS.get(K.mem); if (mem) Object.assign(S.mem, mem);
  S.metaAt = LS.get(K.metaAt) || 0; S.wipedAt = LS.get(K.wipedAt) || 0;
  S.aiConsent = LS.get(K.aiConsent) || null;
  render();
  await Store.init();
  let [pool, cards, log] = await Promise.all([Store.get("pool"), Store.get("cards"), Store.get("log")]);
  Store.del("skips"); // 以前の版で保存した「飛ばした発言」の記録を消す
  let migrated = false;
  if (!pool) { const p = LS.get(K.oldPool); if (p && Array.isArray(p.items)) { pool = p; migrated = true; } }
  if (!cards) { const c = LS.get(K.oldCards); if (c && typeof c === "object") { cards = c; migrated = true; } }
  S.pool = pool || null; S.cards = cards || {}; S.log = Array.isArray(log) ? log : [];
  indexPool();
  const converted = convertLegacy();
  for (const c of allCards()) {
    const en = c.en && speakable(c.en), alts = (c.alts || []).map(speakable), ph = c.ph && speakable(c.ph);
    if (en !== c.en || ph !== c.ph || alts.some((a, i) => a !== c.alts[i])) { c.en = en; c.alts = alts; c.ph = ph; c.u = Date.now(); }
  }
  replayAll();
  if (migrated || converted) {
    const ok = [await Store.set("pool", S.pool), await Store.set("cards", S.cards), await Store.set("log", S.log)].every(x => x !== false);
    if (ok && migrated) { LS.del(K.oldPool); LS.del(K.oldCards); }
  }
  S.ready = true; render();
  onSharedText(onShared);
  try { await Cloud.init(cloudHooks); } catch (e) { console.warn("cloud init failed"); }
  render();
  setTimeout(() => { fitModel(false); S.plan = null; if (S.view === "home") render(); }, 300);
}
if (typeof window !== "undefined" && window.__TK_TEST) window.__tk = { S, CAL, Cloud, render, go, handleBack, onShared, replayAll, fitModel, makePlan, pickFresh, flushAll, levelOf, dueOf, rNow, DAY, startOfDay, newCard, step, indexPool };
TTS.init();
onBackButton(handleBack);
boot();
if (!isNative() && "serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !/localhost|127\.0\.0\.1/.test(location.hostname)) navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

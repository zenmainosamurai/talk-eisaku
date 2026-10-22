// 学習記録の暗号化。鍵は端末の外に出さず、運営者は中身を読めない
// 復元キー（24文字）→ PBKDF2 → 鍵暗号鍵 → マスター鍵を包む → HKDF で暗号用の鍵とID用の鍵を作る
const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; };
export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// 見間違えやすい I・O・0・1 を除いた32文字。24文字で120ビット
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryKey() {
  let s = "";
  for (const x of rand(24)) s += ALPHA[x & 31];
  return s.match(/.{4}/g).join("-");
}
export function normalizeRecoveryKey(input) {
  const t = String(input || "").toUpperCase().replace(/[\s-]/g, "");
  if (t.length !== 24 || [...t].some(c => !ALPHA.includes(c))) return null;
  return t;
}
const ITERATIONS = 150000;
async function kekFrom(recovery, salt, iterations) {
  const base = await subtle().importKey("raw", te.encode(recovery), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function deriveKeys(master) {
  const base = await subtle().importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(32);
  const enc = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("talk-eisaku/enc/v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const mac = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("talk-eisaku/id/v1") }, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  return { enc, mac };
}
// 新しい保管庫：サーバーに置くのは「包んだマスター鍵」とソルトだけ
export async function createVault(recoveryInput) {
  const recovery = normalizeRecoveryKey(recoveryInput);
  if (!recovery) throw new Error("bad_recovery_key");
  const master = rand(32), salt = rand(16), iv = rand(12);
  const kek = await kekFrom(recovery, salt, ITERATIONS);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, kek, master));
  const keys = await deriveKeys(master);
  master.fill(0);
  return { record: { wrapped: toB64(concat(iv, ct)), salt: toB64(salt), iterations: ITERATIONS }, keys };
}
// 復元キーが違えば null
export async function openVault(recoveryInput, record) {
  const recovery = normalizeRecoveryKey(recoveryInput);
  if (!recovery || !record) return null;
  const kek = await kekFrom(recovery, fromB64(record.salt), record.iterations);
  const w = fromB64(record.wrapped);
  let master;
  try { master = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: w.slice(0, 12) }, kek, w.slice(12))); }
  catch { return null; }
  const keys = await deriveKeys(master);
  master.fill(0);
  return keys;
}
export async function seal(keys, obj) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, keys.enc, te.encode(JSON.stringify(obj))));
  return toB64(concat(iv, ct));
}
export async function unseal(keys, blob) {
  const b = fromB64(blob);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, keys.enc, b.slice(12));
  return JSON.parse(td.decode(pt));
}
// サーバーに置くID。中身から計算した問題IDをそのまま置くと照合される余地があるので、鍵付きハッシュにする
export async function blindId(keys, kind, id) {
  const sig = new Uint8Array(await subtle().sign("HMAC", keys.mac, te.encode(kind + ":" + id)));
  return [...sig.slice(0, 16)].map(x => x.toString(16).padStart(2, "0")).join("");
}

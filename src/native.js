// スマホアプリ（Capacitor）ではネイティブの音声認識・戻るボタン・共有の受け取りを使い、Webではブラウザの機能を使う
// AndroidのWebViewはブラウザの音声認識に対応していないため、アプリではプラグインが必要
// 読み上げの音声は OpenAI で作ったもの（cloud.js の tts）を、ここで再生するだけ（端末の読み上げ機能は使わない）
import { Capacitor, registerPlugin } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { App } from "@capacitor/app";

export const isNative = () => Capacitor.isNativePlatform();

// ---- 共有の受け取り（Android） ----
// LINE の「トーク履歴を送信」などで「トーク英作」が選ばれたとき、届いたファイルの中身を handler に渡す
// 中身は端末の中だけで扱う。iPhone は共有用の拡張機能がまだないため、対応していない
const ShareReceiver = registerPlugin("ShareReceiver");
export const shareTargetSupported = () => isNative() && Capacitor.getPlatform() === "android";
export function onSharedText(handler) {
  if (!shareTargetSupported()) return;
  const take = async () => {
    try {
      const r = await ShareReceiver.takePending();
      if (r && (r.text || r.error)) handler(r);
    } catch {}
  };
  ShareReceiver.addListener("shared", take);
  take();
}

// ---- Android の戻るボタン ----
// handler() が false を返したとき（ホームなど最初の画面）は、アプリを閉じずに裏に回す
export function onBackButton(handler) {
  if (!isNative()) return;
  App.addListener("backButton", () => {
    let handled = false;
    try { handled = handler(); } catch {}
    if (!handled) App.minimizeApp().catch(() => {});
  });
}

// ---- 音声入力 ----
// start() に { onText, onEnd, onError } を渡す。戻り値の stop() で止める
export const Voice = {
  supported() {
    if (isNative()) return true;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },
  async start({ onText, onEnd, onError }) {
    if (isNative()) return startNative({ onText, onEnd, onError });
    return startWeb({ onText, onEnd, onError });
  }
};
async function startNative({ onText, onEnd, onError }) {
  const subs = [];
  let ended = false;
  const finish = () => { if (ended) return; ended = true; subs.forEach(s => { try { s.remove(); } catch {} }); onEnd(); };
  try {
    const { available } = await SpeechRecognition.available();
    if (!available) { onError("unavailable"); return null; }
    const perm = await SpeechRecognition.requestPermissions();
    if (!Object.values(perm || {}).every(v => v === "granted")) { onError("not-allowed"); return null; }
    subs.push(await SpeechRecognition.addListener("partialResults", d => { if (d && d.matches && d.matches[0]) onText(d.matches[0]); }));
    subs.push(await SpeechRecognition.addListener("listeningState", d => { if (d && d.status === "stopped") finish(); }));
    await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: true, popup: false });
    return { stop: async () => { try { await SpeechRecognition.stop(); } catch {} finish(); } };
  } catch {
    finish(); onError("failed"); return null;
  }
}
function startWeb({ onText, onEnd, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onError("unavailable"); return null; }
  const r = new SR();
  r.lang = "en-US"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  r.onresult = e => { let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript; onText(s); };
  r.onerror = e => onError(e.error === "service-not-allowed" ? "not-allowed" : e.error);
  r.onend = () => onEnd();
  try { r.start(); } catch { onError("failed"); return null; }
  return { stop: async () => { try { r.stop(); } catch {} } };
}

// ---- 読み上げ ----
// 音声（mp3）を再生する。速さは再生の速さで変える（声の高さは変えない）
// iPhone の Safari は、ユーザーが画面に触れたときに一度鳴らした audio 要素でないと、あとから（通信を待ってから）鳴らせない。
// そのため audio 要素を1つだけ使い回し、最初のタップで無音を鳴らしておく
let audioEl = null, playerUrl = null, finish = null, unlocked = false;
const audio = () => audioEl || (audioEl = new Audio());
function silentWavUrl() {
  const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf), w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
const UNLOCK_EVENTS = ["touchend", "click", "keydown"];
function unlockAudio() {
  if (unlocked || finish) return;
  const a = audio(), url = silentWavUrl();
  a.src = url;
  const p = a.play();
  const end = ok => { URL.revokeObjectURL(url); if (ok) { unlocked = true; UNLOCK_EVENTS.forEach(t => document.removeEventListener(t, unlockAudio, true)); } };
  if (p && p.then) p.then(() => { if (!finish) a.pause(); end(true); }, () => end(false)); else end(true);
}
if (typeof document !== "undefined") UNLOCK_EVENTS.forEach(t => document.addEventListener(t, unlockAudio, true));

export const Speech = {
  // 止める（途中で止めたものは、失敗とは扱わない）
  stop() {
    if (finish) finish(true);
    if (audioEl) { try { audioEl.pause(); } catch {} }
  },
  // 最後まで再生できたら true
  play(blob, rate) {
    this.stop();
    return new Promise(res => {
      const a = audio(), url = URL.createObjectURL(blob);
      let settled = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        if (finish === done) finish = null;
        a.onended = a.onerror = null;
        if (playerUrl === url) playerUrl = null;
        URL.revokeObjectURL(url);
        res(ok);
      };
      finish = done; playerUrl = url;
      a.onended = () => done(true);
      a.onerror = () => done(false);
      a.src = url;
      a.defaultPlaybackRate = rate; a.playbackRate = rate; a.preservesPitch = true;
      a.play().catch(e => done(!!e && e.name === "AbortError"));
    });
  }
};

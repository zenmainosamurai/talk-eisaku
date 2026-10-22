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
let player = null, playerUrl = null;
export const Speech = {
  stop() {
    if (player) { try { player.pause(); } catch {} player = null; }
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  },
  // 最後まで再生できたら true
  play(blob, rate) {
    this.stop();
    return new Promise(res => {
      const url = URL.createObjectURL(blob), a = new Audio(url);
      player = a; playerUrl = url;
      a.defaultPlaybackRate = rate; a.playbackRate = rate; a.preservesPitch = true;
      const done = ok => { if (player === a) this.stop(); res(ok); };
      a.onended = () => done(true);
      a.onerror = () => done(false);
      a.play().catch(e => done(!!e && e.name === "AbortError"));
    });
  }
};

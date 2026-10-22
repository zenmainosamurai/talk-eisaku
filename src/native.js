// スマホアプリ（Capacitor）ではネイティブの音声認識・読み上げ・共有を使い、Webではブラウザの機能を使う
// AndroidのWebViewはブラウザの音声認識・読み上げに対応していないため、アプリではプラグインが必要
import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { App } from "@capacitor/app";

export const isNative = () => Capacitor.isNativePlatform();

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
let webVoice = null;
export const Speech = {
  init() {
    if (isNative() || !("speechSynthesis" in window)) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      webVoice = vs.find(v => /en[-_]US/i.test(v.lang) && /google/i.test(v.name)) || vs.find(v => /en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
    };
    pick();
    try { speechSynthesis.addEventListener("voiceschanged", pick); } catch {}
  },
  // 成功したら true
  async speak(text, rate) {
    if (!text) return false;
    if (isNative()) {
      try { await TextToSpeech.stop(); } catch {}
      try { await TextToSpeech.speak({ text, lang: "en-US", rate, pitch: 1.0, volume: 1.0, category: "playback" }); return true; }
      catch { return false; }
    }
    if (!("speechSynthesis" in window)) return false;
    return new Promise(res => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; if (webVoice) u.voice = webVoice; u.rate = rate;
      u.onend = () => res(true);
      u.onerror = e => res(e.error === "interrupted" || e.error === "canceled");
      speechSynthesis.speak(u);
    });
  }
};

// ---- ファイルの書き出し（バックアップ） ----
export async function saveTextFile(name, text) {
  if (isNative()) {
    const r = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, url: r.uri, dialogTitle: "バックアップを保存" });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

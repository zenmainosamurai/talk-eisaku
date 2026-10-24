// スマホアプリ（Capacitor）ではネイティブの音声認識・戻るボタン・共有の受け取りを使い、Webではブラウザの機能を使う
// AndroidのWebViewはブラウザの音声認識に対応していないため、アプリではプラグインが必要
// 読み上げの音声は Google で作ったもの（cloud.js の tts）を、ここで再生するだけ（端末の読み上げ機能は使わない）
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
// onText には話し始めてからの英文全体を渡す。onEnd・onError はどちらか1回だけ呼ぶ
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
// Android の音声認識（プラグイン @capacitor-community/speech-recognition 7）の動き：
//  - start() は聞き始めるとすぐに終わる。途中の結果も、最後の結果も "partialResults" で届く
//  - 少し黙ると1回分が終わり、"listeningState: stopped" のあとに最後の結果が届く（先に聞くのをやめると最後の結果を取りこぼす）
//  - 何も話さなかったときや聞き取れなかったときは、何も知らせずに止まる（isListening() が false になる）
//  - stop() は返事をしない（待つと、いつまでも「認識中」のままになる）
// そこで、止めるボタンを押すまで1回分ずつ聞き直して、英文をつなげる（聞き直すときに端末の効果音が鳴ることがある）
// 何も話さないまま1回分が終わったら、話し終えたとみなして止める
const FINAL_WAIT = 1200, POLL_MS = 500, MAX_MS = 90000;
let nativeSession = null;
async function startNative({ onText, onEnd, onError }) {
  if (nativeSession) nativeSession.dispose(); // 前の回が残っていたら、知らせずに片付ける
  try {
    const { available } = await SpeechRecognition.available();
    if (!available) { onError("unavailable"); return null; }
    const perm = await SpeechRecognition.requestPermissions();
    if (!Object.values(perm || {}).every(v => v === "granted")) { onError("not-allowed"); return null; }
  } catch { onError("failed"); return null; }

  // done：確定した英文、seg：今の1回分、heard：今の1回分で何か聞き取れたか、any：始めてから何か聞き取れたか
  let done = "", seg = "", heard = false, any = false;
  let phase = "starting"; // starting → listening → waitFinal → （次の回へ）… → over
  let userStopped = false, notified = false, finalTimer = null, poll = null, subs = [];
  const t0 = Date.now();
  const text = () => [done, seg].filter(Boolean).join(" ");
  const self = {
    dispose() { if (phase === "over") return; phase = "over"; clearTimeout(finalTimer); clearInterval(poll); subs.forEach(x => { try { x.remove(); } catch {} }); subs = []; if (nativeSession === self) nativeSession = null; }
  };
  nativeSession = self;
  const end = err => {
    if (phase === "over") return;
    const mine = nativeSession === self;
    self.dispose();
    if (mine) SpeechRecognition.stop().catch(() => {}); // 返事は待たない
    if (!notified) { notified = true; err ? onError(err) : onEnd(); }
  };
  const waitFinal = () => { phase = "waitFinal"; clearTimeout(finalTimer); finalTimer = setTimeout(segmentDone, FINAL_WAIT); };
  // 1回分が終わった（最後の結果が届いた、または待ちきれなかった）
  function segmentDone() {
    if (phase === "over") return;
    clearTimeout(finalTimer);
    if (seg) { done = text(); seg = ""; }
    if (userStopped) return end();
    if (!heard || Date.now() - t0 > MAX_MS) return end(any ? null : "no-speech");
    listen();
  }
  async function listen() {
    seg = ""; heard = false; phase = "starting";
    try { await SpeechRecognition.start({ language: "en-US", maxResults: 1, partialResults: true, popup: false }); }
    catch { return end(any ? null : "failed"); }
    if (phase === "starting") phase = "listening";
  }
  try {
    subs.push(await SpeechRecognition.addListener("partialResults", d => {
      const m = d && d.matches && d.matches[0];
      if (!m || phase === "over") return;
      seg = m; heard = any = true; onText(text());
      if (phase === "waitFinal") segmentDone(); // 最後の結果が届いた
    }));
    subs.push(await SpeechRecognition.addListener("listeningState", d => {
      if (d && d.status === "stopped" && (phase === "listening" || phase === "starting")) waitFinal();
    }));
  } catch { end("failed"); return null; }
  // 知らせなしに止まったとき（何も話さなかった・聞き取れなかった）を見つける
  poll = setInterval(async () => {
    if (phase !== "listening") return;
    let listening = true;
    try { ({ listening } = await SpeechRecognition.isListening()); } catch {}
    if (!listening && phase === "listening") { if (heard) waitFinal(); else segmentDone(); }
  }, POLL_MS);
  listen();
  return {
    // 止めるボタン：画面はすぐに戻し、そこまでに話した分の最後の結果は少しだけ待って入れる
    stop() {
      if (phase === "over") return;
      userStopped = true;
      if (!notified) { notified = true; onEnd(); }
      if (phase === "waitFinal") return;
      if (!heard) return end();
      SpeechRecognition.stop().catch(() => {});
      waitFinal();
    }
  };
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

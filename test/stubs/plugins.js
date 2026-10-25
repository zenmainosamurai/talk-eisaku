// テスト用のプラグインの代わり
// 音声認識：本物のプラグイン（Android）と同じ動きをまねる
// window.__srAvailable = false で「この端末にない」、window.__srPerm = "denied" で「許可されない」
// window.__srScript：1回分ずつの台本の配列
//   { say: ["hello", "hello there"], final: "hello there" } 話して少し黙った回（途中の結果 → stopped → 最後の結果）
//   { say: [...], nomatch: true } 話したが聞き取れなかった回（最後の結果が来ない）
//   { silent: true } 何も話さなかった回（知らせずに止まる）
//   gap：途中の結果の間隔（ミリ秒）。台本がなくなったら何も話さない回になる
// 台本がないときは window.__srText（なければ "hello there"）を1回分として話す
const L = {}; let listening = false, timers = [], lastSaid = "";
const emit = (name, data) => (L[name] || []).slice().forEach(f => f(data));
const later = (ms, f) => timers.push(setTimeout(f, ms));
export const SpeechRecognition = {
  async available() { return { available: window.__srAvailable !== false }; },
  async requestPermissions() { return { speechRecognition: window.__srPerm || "granted" }; },
  async addListener(name, fn) { (L[name] = L[name] || []).push(fn); return { remove() { L[name] = (L[name] || []).filter(f => f !== fn); } }; },
  async isListening() { return { listening }; },
  async start() {
    window.__srStarted = (window.__srStarted || 0) + 1;
    timers.forEach(clearTimeout); timers = []; lastSaid = ""; // 前の回は取り消す（本物も cancel する）
    if (!window.__srScript) window.__srScript = [{ say: [window.__srText || "hello there"] }];
    const step = window.__srScript.shift() || { silent: true };
    listening = true;
    if (step.silent) { later(step.wait || 300, () => { listening = false; }); return; }
    const gap = step.gap || 60; let t = 50;
    for (const w of step.say || []) later(t += gap, () => { lastSaid = w; emit("partialResults", { matches: [w] }); });
    later(t += gap, () => { if (!listening) return; listening = false; emit("listeningState", { status: "stopped" }); });
    if (!step.nomatch) later(t += (step.finalDelay || 150), () => emit("partialResults", { matches: [step.final || (step.say || []).slice(-1)[0]] }));
  },
  // 本物と同じく返事をしない。聞いている途中なら、そこまでに話した分が最後の結果として届く
  stop() {
    window.__srStopCalls = (window.__srStopCalls || 0) + 1;
    if (listening) {
      listening = false; timers.forEach(clearTimeout); timers = [];
      const said = lastSaid;
      later(40, () => emit("listeningState", { status: "stopped" }));
      if (said) later(200, () => emit("partialResults", { matches: [said + (window.__srFinalSuffix || "")] }));
    }
    return new Promise(() => {});
  }
};
export const App = { async addListener() { return { remove() {} }; }, async minimizeApp() {}, async exitApp() {} };

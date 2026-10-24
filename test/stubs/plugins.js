// テスト用のプラグインの代わり
// 音声認識：window.__srAvailable = false で「この端末にない」、window.__srPerm = "denied" で「許可されない」をまねる。話した内容は window.__srText
export const SpeechRecognition = {
  async available() { return { available: window.__srAvailable !== false }; },
  async requestPermissions() { return { speechRecognition: window.__srPerm || "granted" }; },
  async addListener(name, fn) { (window.__srL = window.__srL || {})[name] = fn; return { remove() {} }; },
  async start() {
    window.__srStarted = (window.__srStarted || 0) + 1;
    setTimeout(() => {
      const l = window.__srL || {};
      if (l.partialResults) l.partialResults({ matches: [window.__srText || "hello there"] });
      if (l.listeningState) l.listeningState({ status: "stopped" });
    }, 50);
  },
  async stop() {}
};
export const App = { async addListener() { return { remove() {} }; }, async minimizeApp() {}, async exitApp() {} };

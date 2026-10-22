export const Capacitor = { isNativePlatform: () => !!window.__fakeNative, getPlatform: () => (window.__fakeNative ? "android" : "web") };
// テスト用：window.__fakeShared に { text, name } を入れておくと、共有で届いたものとして渡す
export function registerPlugin() {
  return {
    async takePending() { const r = window.__fakeShared || {}; window.__fakeShared = null; return r; },
    async addListener(_name, fn) { window.__fakeShareNotify = fn; return { remove() {} }; }
  };
}

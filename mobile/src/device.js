import { Capacitor, registerPlugin } from '@capacitor/core';
export const native = Capacitor.isNativePlatform();
const plugin = registerPlugin('CourtDevice');
export const device = native ? plugin : {
  async login() { throw new Error('请在 Android App 中使用学校登录；网页预览可以导入 JSON'); },
  async readState() { return { value: localStorage.getItem('szu-mobile-v1') }; },
  async writeState({ value }) { localStorage.setItem('szu-mobile-v1', value); },
  async request() { throw new Error('网页仅用于界面预览。请安装 Android APK 连接学校。'); },
  async setExecution() { throw new Error('请在 Android App 内执行预约'); },
  async copy({ text }) { await navigator.clipboard.writeText(text); },
  async addListener() { return { remove() {} }; },
};

// Preserve individual Set-Cookie headers; no shared WebView cookie jar.
export function nativeTransport(device, token = null) {
  return async (url, options) => {
    const result = await device.request({ url: String(url), method: options.method,
      headers: options.headers, body: options.body?.toString(), token, timeoutMs: 8000 });
    const values = Object.fromEntries(Object.entries(result.headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { status: result.status, ok: result.status >= 200 && result.status < 300,
      headers: { get: (name) => values[name.toLowerCase()]?.join(', ') ?? null,
        getSetCookie: () => values['set-cookie'] ?? [] }, text: async () => result.body };
  };
}

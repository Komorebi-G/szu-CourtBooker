export function parseSessionText(text) {
  const raw = text.trim().startsWith('{') ? JSON.parse(text) : sessionFromCurl(text);
  const session = raw.session ?? raw;
  if (!Array.isArray(session.cookies) || !session.cookies.length || session.cookies.length > 100
    || typeof session.userAgent !== 'string' || !session.userAgent || /[\r\n]/.test(session.userAgent)) {
    throw new Error('登录文件格式无效，请导入本工具导出的 JSON 或浏览器 cURL');
  }
  const cookies = session.cookies.map((cookie) => {
    if (!cookie || typeof cookie.name !== 'string' || !cookie.name || /[;=\r\n]/.test(cookie.name)
      || typeof cookie.value !== 'string' || /[;\r\n]/.test(cookie.value)
      || !['ehall.szu.edu.cn', '.ehall.szu.edu.cn'].includes(cookie.domain)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) {
      throw new Error('Cookie 格式或域名无效，只接受 ehall.szu.edu.cn 登录状态');
    }
    return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: Boolean(cookie.httpOnly), secure: Boolean(cookie.secure), sameSite: cookie.sameSite ?? 'Lax' };
  });
  const names = new Set(cookies.map((cookie) => cookie.name));
  if (!names.has('MOD_AUTH_CAS') || !names.has('_WEU')) throw new Error('登录 Cookie 不完整，需要 MOD_AUTH_CAS 和 _WEU');
  return { version: 1, savedAt: new Date().toISOString(), source: 'import', userAgent: session.userAgent, cookies };
}

export function sessionFromCurl(curlText) {
  const headerCookieMatch = /(?:-H|--header)\s+(?:'cookie:\s*([^']+)'|"cookie:\s*([^"]+)")/i.exec(curlText);
  const optionCookieMatch = /(?:-b|--cookie)\s+(?:'([^']+)'|"([^"]+)")/i.exec(curlText);
  const rawCookie = headerCookieMatch?.[1] ?? headerCookieMatch?.[2]
    ?? optionCookieMatch?.[1] ?? optionCookieMatch?.[2]
    ?? (/^(?:cookie:\s*)?([^\r\n]+)$/i.exec(curlText.trim())?.[1]);
  if (!rawCookie || !rawCookie.includes('=')) {
    throw new Error('没有找到 Cookie。请复制已登录请求的“cURL (bash)”完整内容');
  }
  const userAgentMatch = /(?:-H|--header)\s+(?:'user-agent:\s*([^']+)'|"user-agent:\s*([^"]+)")/i.exec(curlText);
  const userAgent = userAgentMatch?.[1] ?? userAgentMatch?.[2]
    ?? /(?:-A|--user-agent)\s+(?:'([^']+)'|"([^"]+)")/i.exec(curlText)?.slice(1).find(Boolean)
    ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
  const pathScoped = new Set(['EMAP_LANG', '_WEU']);
  const cookies = rawCookie.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return null;
    const name = part.slice(0, separator).trim();
    return {
      name,
      value: part.slice(separator + 1).trim(),
      domain: 'ehall.szu.edu.cn',
      path: pathScoped.has(name) ? '/qljfwapp/' : '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    };
  }).filter(Boolean);
  const names = new Set(cookies.map((cookie) => cookie.name));
  const missing = ['MOD_AUTH_CAS', '_WEU'].filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(`Cookie 不完整，缺少 ${missing.join(', ')}；请从 ehall.szu.edu.cn 的已登录请求复制 cURL`);
  }
  const session = {
    version: 1,
    savedAt: new Date().toISOString(),
    source: 'browser-curl',
    userAgent,
    cookies,
  };
  return session;
}

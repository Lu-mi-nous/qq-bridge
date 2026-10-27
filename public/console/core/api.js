// 控制台 API 封装（C1）。
//
// 与 legacy.js 里的 api() 行为一致：自动带 x-console-token，401 时提示输入。
// 单独成模块是为了让新卡片/注册表不再依赖 legacy 的全局函数。

export async function api(path, method = 'GET', body, _retried = 0) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  const token = localStorage.getItem('consoleToken');
  if (token) headers['x-console-token'] = token;
  const res = await fetch(path, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    if (_retried >= 2) {
      localStorage.removeItem('consoleToken');
      throw new Error('未授权');
    }
    const t = prompt('请输入控制台访问令牌：');
    if (t) {
      localStorage.setItem('consoleToken', t.trim());
      return api(path, method, body, _retried + 1);
    }
    localStorage.removeItem('consoleToken');
    throw new Error('未授权');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

// 统一 JSON 状态存储（重构 R2）。
//
// 目标（见桌面的 qq-bridge-重构方案.md）：
//   - 每个状态域只有一个读写入口；
//   - 写入串行、原子替换，避免多个定时器/回调互相覆盖；
//   - 文件带版本号，损坏时备份并回落到默认值，而不是静默返回空对象。
//
// 这是**基础设施**，不改变任何业务字段；旧文件不带 __version 时按版本 0
// 处理，migrate 返回原结构即可。后续 R2-2 再逐个域接入。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION_KEY = '__version';

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {object} opts
 * @param {string} opts.file 绝对路径
 * @param {number} [opts.version=1]
 * @param {() => object} opts.defaults 缺失/损坏时的默认值工厂（每次返回新对象）
 * @param {(data:any, fromVersion:number) => any} [opts.migrate]
 * @param {(msg:string) => void} [opts.log]
 * @param {boolean} [opts.array=false] 顶层是数组时置 true；磁盘格式为 `{__version, items:[]}`
 * @param {boolean} [opts.reloadOnMtime=false] 每次 read 比对 mtime，供多进程状态使用
 */
export function createJsonStore({
  file,
  version = 1,
  defaults = () => ({}),
  migrate = null,
  log = () => {},
  array = false,
  reloadOnMtime = false
} = {}) {
  if (!file || typeof file !== 'string') throw new Error('createJsonStore: file 不能为空');
  let cache = null;
  let loaded = false;
  let lastMtimeMs = 0;

  function defaultCopy() {
    const d = defaults();
    if (array) return Array.isArray(d) ? clone(d) : [];
    return clone(d && typeof d === 'object' && !Array.isArray(d) ? d : {});
  }

  function fileMtimeMs() {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  }

  function backupCorrupt(error) {
    try {
      if (!fs.existsSync(file)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${file}.corrupt-${stamp}`;
      fs.copyFileSync(file, backup);
      log(`[state] 状态文件损坏，已备份到 ${backup}：${error?.message ?? error}`);
    } catch (backupError) {
      log(`[state] 状态文件损坏且备份失败：${backupError?.message ?? backupError}`);
    }
  }

  function read() {
    if (loaded && (!reloadOnMtime || fileMtimeMs() === lastMtimeMs)) return cache;
    loaded = true;
    lastMtimeMs = fileMtimeMs();
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      let parsed = JSON.parse(text);
      if (array) {
        let fromVersion = 0;
        if (Array.isArray(parsed)) {
          // 旧格式：裸数组。按版本 0 处理，写回时升级为 {__version, items}。
          parsed = { items: parsed };
        } else if (parsed && typeof parsed === 'object') {
          fromVersion = Number(parsed[VERSION_KEY]) || 0;
          if (!Array.isArray(parsed.items)) throw new Error('数组状态文件缺少 items 数组');
        } else {
          throw new Error('数组状态文件格式不合法');
        }
        let items = parsed.items;
        if (typeof migrate === 'function' && fromVersion !== version) {
          items = migrate(items, fromVersion);
        }
        if (!Array.isArray(items)) throw new Error('migrate 返回的不是数组');
        cache = items;
      } else {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('状态文件不是 JSON 对象');
        }
        const fromVersion = Number(parsed[VERSION_KEY]) || 0;
        if (typeof migrate === 'function' && fromVersion !== version) {
          parsed = migrate(parsed, fromVersion);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('migrate 返回的不是对象');
          }
        }
        cache = parsed;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') backupCorrupt(error);
      cache = defaultCopy();
    }
    return cache;
  }

  function write(value) {
    if (array) {
      if (!Array.isArray(value)) throw new Error('state.write 需要 JSON 数组');
    } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('state.write 需要 JSON 对象');
    }
    const body = array
      ? { [VERSION_KEY]: version, items: value }
      : { ...value, [VERSION_KEY]: version };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    cache = array ? value : body;
    loaded = true;
    lastMtimeMs = fileMtimeMs();
    return body;
  }

  /** 读-改-写：fn 收到深拷贝，返回新对象；同步执行，不会与同进程的其它 update 交错。 */
  function update(fn) {
    if (typeof fn !== 'function') throw new Error('state.update 需要函数');
    const draft = clone(read());
    const next = fn(draft);
    return write(next === undefined ? draft : next);
  }

  /** 把当前缓存再落一次盘（正常写入已即时落盘，供优雅退出兜底）。 */
  function flush() {
    if (cache) write(cache);
    return cache;
  }

  /** 丢弃缓存，下次 read 重新读文件（测试/外部恢复用）。 */
  function clearCache() {
    cache = null;
    loaded = false;
    lastMtimeMs = 0;
  }

  return { file, version, read, write, update, flush, clearCache };
}

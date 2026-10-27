import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = 'C:/qq-bridge';
const p = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], { stdio: ['pipe','pipe','pipe'] });
let buf = '';
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
p.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) send({ jsonrpc:'2.0', id:2, method:'tools/list' });
    if (m.id === 2) {
      const names = (m.result?.tools ?? []).map(t => t.name);
      console.log('工具总数:', names.length);
      console.log('含 qq_token_report:', names.includes('qq_token_report'));
      console.log('token 相关工具:', names.filter(n => /token/i.test(n)).join(', ') || '(无)');
      process.exit(0);
    }
  }
});
p.stderr.on('data', () => {});
send({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'p', version:'1' } } });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 20000);

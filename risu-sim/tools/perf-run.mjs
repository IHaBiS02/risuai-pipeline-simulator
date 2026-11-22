// 성능 측정 실행기 — headless chromium 을 원격 디버깅으로 띄워 tools/perf-bench.html 을 연다.
//   python3 -m http.server 8901 &   (risu-sim 에서)
//   node tools/perf-run.mjs [반복 횟수]
// 실행 버튼 1번마다: 벽시계 시간(클릭 → run() 끝 → 다음 프레임), 스크립트·스타일·레이아웃 시간
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = Number(process.argv[2] || 5);
const port = 9400 + Math.floor(Math.random() * 400);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-perf-'));
const ch = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--user-data-dir=' + prof,
  '--remote-debugging-port=' + port, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(100);
}
const sock = new WebSocket(wsUrl);
await new Promise((r) => (sock.onopen = r));
let id = 0; const pend = new Map();
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));

try {
  await send('Performance.enable');
  await send('Page.navigate', { url: process.env.BENCH_URL || 'http://127.0.0.1:8901/tools/perf-bench.html?v=' + Date.now() });
  let loaded;
  for (let t = 0; t < 120 && !loaded; t++) { await sleep(500); const v = await ev("document.getElementById('out')?.textContent"); if (v && v.startsWith('LOADED')) loaded = v; }
  console.log(loaded);
  // 실험용: 측정 전에 iframe 문서에서 실행할 코드 (예: BENCH_PRE="d.querySelectorAll('textarea').forEach(t=>t.wrap='off')")
  if (process.env.BENCH_PRE) await ev(`(()=>{const w=window.__w,d=window.__d;${process.env.BENCH_PRE}})()`);
  const rows = [];
  for (let i = 0; i < N; i++) {
    await sleep(800);
    const a = await metrics();
    const wall = await ev(`(async()=>{const w=window.__w,d=window.__d;const n=w.__simRuns||0;const t=performance.now();
      d.getElementById('runBtn').click();
      while((w.__simRuns||0)===n) await new Promise(r=>setTimeout(r,2));
      d.body.offsetHeight; await new Promise(r=>w.requestAnimationFrame(()=>setTimeout(r,0)));
      return Math.round(performance.now()-t)})()`);
    await sleep(800); // 배경 렌더 등 뒤따르는 비동기 작업까지
    const b = await metrics();
    const ms = (k) => Math.round((b[k] - a[k]) * 1000);
    rows.push({ wall, task: ms('TaskDuration'), script: ms('ScriptDuration'), style: ms('RecalcStyleDuration'), layout: ms('LayoutDuration') });
  }
  console.table(rows);
  const avg = (k) => Math.round(rows.slice(1).reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length - 1));
  console.log('평균(첫 회 제외): wall=' + avg('wall') + 'ms task=' + avg('task') + 'ms layout=' + avg('layout') + 'ms style=' + avg('style') + 'ms');
} finally {
  ch.kill();
  fs.rmSync(prof, { recursive: true, force: true });
}

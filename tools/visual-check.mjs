/**
 * 视觉/布局自动化验证工具（零依赖）。
 *
 * 用 Node 内置的 WebSocket 直接说 CDP 协议驱动无头 Chrome，做两件事：
 *   1. 量真实布局：找出**溢出视口的元素**，而不是靠肉眼看截图猜
 *   2. 按设备像素比出图（DPR=2 + mobile），得到与真机接近的截图
 *
 * 为什么值得单独写：CSS 溢出这类问题在截图里只能看出"被裁掉了"，
 * 但量一次 rect 就能直接定位到是哪个元素、宽了多少。
 *
 * 用法：
 *   node tools/visual-check.mjs --url http://localhost:4173/ --out docs/shot.png
 *   node tools/visual-check.mjs --url http://localhost:4173/ --width 390 --height 844 --measure
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function parseArgs(argv) {
  const out = { width: 390, height: 844, dpr: 2, waitMs: 4500, measure: false, out: null, url: null, eval: null, evalFile: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--url') out.url = v;
    else if (k === '--out') out.out = v;
    else if (k === '--width') out.width = Number(v);
    else if (k === '--height') out.height = Number(v);
    else if (k === '--dpr') out.dpr = Number(v);
    else if (k === '--wait') out.waitMs = Number(v);
    else if (k === '--measure') out.measure = true;
    else if (k === '--eval') out.eval = v;
    else if (k === '--eval-file') out.evalFile = v;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（支持 flatten 会话） */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const key = `${msg.sessionId ?? ''}:${msg.method}`;
        const handlers = this.events.get(key) ?? [];
        this.events.delete(key);
        handlers.forEach((h) => h(msg.params));
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }

  once(method, sessionId) {
    const key = `${sessionId ?? ''}:${method}`;
    return new Promise((resolve) => {
      const list = this.events.get(key) ?? [];
      list.push(resolve);
      this.events.set(key, list);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge 可执行文件');
}

/** 注入到页面里跑的测量脚本：找出所有越过视口右边界的元素 */
const MEASURE_SCRIPT = `(() => {
  const vw = window.innerWidth;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right) }; };
  const overflowing = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      const cls = typeof el.className === 'string' ? el.className : '';
      overflowing.push({ sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : ''), ...rect(el) });
    }
  }
  const pick = (s) => { const el = document.querySelector(s); return el ? rect(el) : null; };
  return JSON.stringify({
    innerWidth: vw,
    dpr: window.devicePixelRatio,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    shell: pick('.app-shell'),
    topbar: pick('.topbar'),
    connBar: pick('.conn-bar'),
    content: pick('.content'),
    card: pick('.card'),
    row: pick('.quote-row'),
    tabbar: pick('.tabbar'),
    overflowingCount: overflowing.length,
    overflowing: overflowing.slice(0, 14),
  }, null, 2);
})()`;

function describeException(details) {
  if (!details) return '未知异常';
  const desc = details.exception?.description ?? details.exception?.value ?? details.text ?? '';
  return `${details.text ?? ''} ${desc}`.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) throw new Error('缺少 --url');
  // --eval-file 优先：Windows 上 PowerShell 会吞掉内嵌双引号，脚本走文件最稳
  if (args.evalFile) args.eval = readFileSync(resolve(args.evalFile), 'utf8');
  const hasEval = Boolean(args.eval);

  const chromePath = findChrome();
  const port = 9333 + Math.floor(Math.random() * 400);
  const userDataDir = resolve(tmpdir(), `dsh-visual-${randomUUID()}`);
  mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => rmSync(userDataDir, { recursive: true, force: true }), 300);
  };

  try {
    // 等调试端口就绪
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        version = await res.json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('Chrome 调试端口未就绪');

    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: args.width, height: args.height, deviceScaleFactor: args.dpr, mobile: true },
      sessionId,
    );

    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: args.url }, sessionId);
    await Promise.race([loaded, sleep(15000)]);

    // 等实时行情推几帧进来，否则截到的是空列表
    await sleep(args.waitMs);

    let report = null;
    if (args.measure || (!args.out && !hasEval)) {
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression: MEASURE_SCRIPT, returnByValue: true, awaitPromise: false },
        sessionId,
      );
      if (res.exceptionDetails) throw new Error(`测量脚本异常: ${describeException(res.exceptionDetails)}`);
      report = JSON.parse(res.result.value);
    }

    // --eval：在页面上下文里执行任意表达式，用来核验**实际渲染结果**
    // （文字、计算样式、状态），而不是靠肉眼看截图猜
    if (args.eval) {
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression: args.eval, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (res.exceptionDetails) {
        throw new Error(
          `eval 异常: ${describeException(res.exceptionDetails)}\n表达式: ${args.eval.slice(0, 300)}`,
        );
      }
      console.log('[页面求值]');
      console.log(typeof res.result.value === 'string' ? res.result.value : JSON.stringify(res.result.value, null, 2));
    }

    if (args.out) {
      const shot = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false, fromSurface: true },
        sessionId,
      );
      const outPath = resolve(args.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      console.log(`[截图] ${outPath}  (${args.width}x${args.height} @${args.dpr}x)`);
    }

    if (report) {
      console.log('[布局测量]');
      console.log(JSON.stringify(report, null, 2));
      if (report.overflowingCount > 0) {
        console.log(`\n⚠ 有 ${report.overflowingCount} 个元素越过视口边界（上面列出了前 14 个）`);
      } else {
        console.log('\n✓ 无元素溢出视口');
      }
    }

    cdp.close();
    cleanup();
    process.exit(0);
  } catch (e) {
    cleanup();
    throw e;
  }
}

main().catch((e) => {
  console.error(`视觉验证失败：${e.message}`);
  process.exit(1);
});

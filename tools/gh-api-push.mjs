/**
 * 通过 GitHub Git Data API 推送（`git push` 到 github.com 被重置时的备胎通道）。
 *
 * ## 为什么需要它
 * 某些网络下 `api.github.com` 完全正常，但 `github.com:443` 的 git 通道会被重置：
 * `git push` 报 `Recv failure: Connection was reset`，`git ls-remote` 直接卡死。
 * 此时改用 Git Data API（只依赖 api.github.com）就能把代码推上去。
 *
 * ## 一致性策略
 * - **内容以 tree 为准（硬校验）**：建完 tree 后断言远端 tree SHA == 本地 `HEAD^{tree}`，
 *   不等就中止且不动 ref。commit SHA 会因服务端规范化元数据而变化，tree 不会。
 * - **SHA 尽量一致**：把本地元数据原样传给服务端，尽量让服务端算出与本地相同的 SHA。
 * - **对不齐就对齐**：若服务端规范化导致 SHA 不同，则从 API 读回服务端提交的元数据，
 *   在本地穷举重建出**字节完全相同**的提交对象，再把本地 refs 指过去 ——
 *   于是本地与远端始终是同一个提交，永远不会出现 ahead / 分叉。
 *
 * ## 实测得到的服务端规范化规则（照这些写才能命中相同的 SHA）
 * 1. **消息逐字节保存**：传什么存什么。（坑：API 返回的 `message` 字段会**去掉尾部空白**，
 *    照它去比对会误以为"服务端改了消息"，本机实测被这一点误导过。）
 * 2. **时区取自入参的 UTC 偏移**：传 `+08:00` 就存 `+0800`，传 `Z` 就存 `+0000`。
 *    所以**不要**用 `toISOString()`（那会变成 Z），要用 `toIsoWithOffset()` 保住原始偏移。
 * 3. 时间戳（秒）原样保留，不取整。
 *
 * ## 安全防护
 * 本工具在需要对齐时会执行 `git reset --hard`，**会丢弃未提交的改动** ——
 * 本机就真的被它冲掉过一次尚未提交的修复。所以启动时先检查工作区，
 * 不干净就直接拒绝运行（确需继续用 `--allow-dirty`，那样会跳过本地 refs 对齐）。
 *
 * ## 用法
 *   node tools/gh-api-push.mjs                 # 推送当前分支到 origin
 *   node tools/gh-api-push.mjs --dry-run       # 只算不上传
 *   node tools/gh-api-push.mjs --repo owner/name --branch main
 *
 * 凭据从系统凭据管理器取（`git credential fill`），不落盘、不打印。
 * Windows 上凭据按 `git:https://<user>@github.com` 分账号存储，
 * 必须带 username，否则 GCM 会退化成交互提示而卡住。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);
const API = 'https://api.github.com';

// ------------------------------------------------------------------ 参数

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = flag('--dry-run');
const ALLOW_DIRTY = flag('--allow-dirty');
const BRANCH = opt('--branch', 'main');
const GH_USER = process.env.GH_USER ?? '';

const git = (args, encoding = 'utf8') =>
  execFileP('git', args, { maxBuffer: 256 * 1024 * 1024, encoding }).then((r) => r.stdout);

async function resolveRepo() {
  const explicit = opt('--repo', '');
  if (explicit) return explicit;
  const url = (await git(['remote', 'get-url', 'origin'])).trim();
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`无法从 origin 解析 owner/repo: ${url}`);
  return `${m[1]}/${m[2]}`;
}

// ------------------------------------------------------------------ 凭据

function readCredential(user) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['credential', 'fill'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('取凭据超时（GCM 可能在等待交互）'));
    }, 25_000);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`spawn git 失败: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`git credential fill 退出码 ${code}: ${err.trim()}`));
      const f = {};
      for (const line of out.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) f[line.slice(0, i)] = line.slice(i + 1);
      }
      if (!f.password) {
        return reject(
          new Error(
            `凭据管理器里没有 ${user}@github.com 的 token。\n` +
              `  提示：Windows 上凭据目标应形如 git:https://${user}@github.com`,
          ),
        );
      }
      resolve(f.password);
    });
    p.stdin.write(`protocol=https\nhost=github.com\nusername=${user}\n\n`);
    p.stdin.end();
  });
}

// ------------------------------------------------------------------ git 对象工具

/** git 对象 SHA = sha1("<type> <字节长度>\0" + 内容)。长度按字节算，含中文时 ≠ 字符数 */
function objectSha(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`commit ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** 从 ISO 日期里取出 (unix 秒, ±HHMM) */
function toGitDate(iso) {
  const ts = Math.floor(Date.parse(iso) / 1000);
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  return { ts, tz: m ? `${m[1]}${m[2]}${m[3]}` : '+0000' };
}

/**
 * 还原成**带原始 UTC 偏移**的 ISO 字符串。
 * 千万不能用 toISOString()：那会变成 Z 形式，服务端就会把提交对象写成 +0000，SHA 与本地不一致。
 */
function toIsoWithOffset(ts, tz) {
  const sign = tz.startsWith('-') ? -1 : 1;
  const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const wall = new Date((ts + offMin * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, '');
  return `${wall}${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
}

/** 把 commit 对象写进本地对象库 */
function writeGitObject(payload) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['hash-object', '-t', 'commit', '-w', '--stdin']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    p.stdin.end(Buffer.from(payload, 'utf8'));
  });
}

// ------------------------------------------------------------------ 主流程

const repoSlug = await resolveRepo();
const user = GH_USER || repoSlug.split('/')[0];

// ---- 安全检查：工作区必须干净（后面可能 reset --hard）
{
  const dirty = (await git(['status', '--porcelain'])).trim();
  if (dirty && !ALLOW_DIRTY) {
    console.error('✗ 工作区有未提交的改动，拒绝运行。');
    console.error('  原因：本工具在需要对齐 refs 时会执行 git reset --hard，会丢弃这些改动。');
    console.error('  处理：先 git commit（推荐），或显式加 --allow-dirty（那样会跳过本地 refs 对齐）\n');
    console.error(dirty.split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n'));
    process.exit(1);
  }
  if (dirty) console.warn('! --allow-dirty：工作区不干净，若需要对齐 refs 将跳过本地 reset\n');
}

const token = await readCredential(user);

let apiCalls = 0;
async function api(method, path, body) {
  apiCalls += 1;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gh-api-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, json };
}

// ---- 本地状态
const localSha = (await git(['rev-parse', 'HEAD'])).trim();
const localTree = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
const rawCommit = (await git(['cat-file', 'commit', 'HEAD'], 'buffer')).toString('utf8');
const sepIdx = rawCommit.indexOf('\n\n');
const rawHeader = rawCommit.slice(0, sepIdx);
const rawMessage = rawCommit.slice(sepIdx + 2);

const headerLines = rawHeader.split('\n');
const parseIdent = (line) => {
  const m = /^(author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  return m ? { name: m[2], email: m[3], ts: Number(m[4]), tz: m[5] } : null;
};
const aIdent = parseIdent(headerLines.find((l) => l.startsWith('author ')));
const cIdent = parseIdent(headerLines.find((l) => l.startsWith('committer ')));

const listing = (await git(['ls-tree', '-r', '-z', 'HEAD'], 'buffer')).toString('utf8');
const entries = listing
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, sha] = meta.split(' ');
    return { mode, type, sha, path };
  })
  .filter((e) => e.type === 'blob');

console.log(`仓库   ${repoSlug}  (分支 ${BRANCH})`);
console.log(`本地   ${localSha.slice(0, 12)}  tree ${localTree.slice(0, 12)}  ${entries.length} 个文件`);
console.log(`作者   ${aIdent.name} <${aIdent.email}> ${aIdent.ts} ${aIdent.tz}`);
if (DRY_RUN) console.log('模式   干跑（不做任何写入）');

// ---- 远端状态
let remoteSha = null;
let remoteTree = null;
{
  const r = await api('GET', `/repos/${repoSlug}/git/ref/heads/${BRANCH}`);
  if (r.ok) {
    remoteSha = r.json.object.sha;
    const c = await api('GET', `/repos/${repoSlug}/git/commits/${remoteSha}`);
    remoteTree = c.json.tree.sha;
    console.log(`远端   ${remoteSha.slice(0, 12)}  tree ${remoteTree.slice(0, 12)}`);
  } else {
    console.log(`远端   ${BRANCH} 不存在（HTTP ${r.status}），将先用 Contents API 播种空仓库`);
  }
}

/** 本地对象库里是否已有该对象 */
async function objectExists(sha) {
  try {
    await git(['cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 穷举参数空间，重建某个服务端 commit 对象的**字节内容**。
 *
 * 不预设"服务端会怎么规范化"：时区按 15 分钟粒度覆盖 -12:00 ~ +14:00，消息试几种结尾，
 * 时间戳先信服务端报告的；都不中再放开时间戳偏移。规则会变，SHA 校验不会骗人。
 */
async function reconstructCommit(c) {
  const parents = (c.parents ?? []).map((p) => p.sha);
  const aTs = Math.floor(Date.parse(c.author.date) / 1000);
  const cTs = Math.floor(Date.parse(c.committer.date) / 1000);
  const base = c.message.replace(/\n+$/, '');
  const messages = [...new Set([c.message, base, `${base}\n`, `${base}\n\n`])];

  const zones = [];
  for (let m = -12 * 60; m <= 14 * 60; m += 15) {
    const sign = m < 0 ? '-' : '+';
    const abs = Math.abs(m);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    zones.push(`${sign}${hh}${mm}`);
  }

  const build = (tz, msg, a, k) => {
    const lines = [`tree ${c.tree.sha}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${c.author.name} <${c.author.email}> ${a} ${tz}`);
    lines.push(`committer ${c.committer.name} <${c.committer.email}> ${k} ${tz}`);
    return `${lines.join('\n')}\n\n${msg}`;
  };

  // 阶段 1：时间戳信服务端，穷举 时区 × 消息
  for (const tz of zones) {
    for (const msg of messages) {
      const cand = build(tz, msg, aTs, cTs);
      if (objectSha(cand) === c.sha) return cand;
    }
  }
  // 阶段 2：时间戳也放开（±1 天，1 分钟粒度）
  for (const tz of ['+0000', '+0800', aIdent.tz]) {
    for (const msg of messages) {
      for (let d = -86400; d <= 86400; d += 60) {
        const cand = build(tz, msg, aTs + d, cTs + d);
        if (objectSha(cand) === c.sha) return cand;
      }
    }
  }
  return null;
}

/**
 * 递归把远端某条提交链补进本地对象库。
 *
 * 必须递归：本地与远端一旦在某个祖先处分叉，尖端对象的父提交在本地就是缺失的，
 * 只重建尖端会留下断链对象，`git reset --hard` 也会失败。
 * 本机实测踩过：跳过了 1846e598 这个父提交，导致对齐一直做不成。
 */
async function ensureCommitsLocal(sha, seen = new Set()) {
  if (seen.has(sha)) return true;
  seen.add(sha);
  if (await objectExists(sha)) return true;

  const r = await api('GET', `/repos/${repoSlug}/git/commits/${sha}`);
  if (!r.ok) {
    console.error(`  读取远端提交 ${sha.slice(0, 12)} 失败 HTTP ${r.status}`);
    return false;
  }
  const c = r.json;
  for (const p of (c.parents ?? []).map((x) => x.sha)) {
    if (!(await ensureCommitsLocal(p, seen))) return false;
  }
  const payload = await reconstructCommit(c);
  if (!payload) {
    console.error(`  无法重建提交对象 ${sha.slice(0, 12)}（参数空间已穷举）`);
    return false;
  }
  await writeGitObject(payload);
  console.log(`  已重建 ${sha.slice(0, 12)}`);
  return true;
}

/**
 * 把本地 refs 对齐到服务端提交。
 *
 * 若不先把整条缺失链补进本地对象库就 reset，会得到断链的仓库 —— 所以顺序是
 * 「递归重建 → 写对象 → 更新 refs → reset」。
 */
async function alignLocally(target) {
  if (!(await ensureCommitsLocal(target))) {
    console.error(`  可连上 github.com 时执行：git fetch origin && git reset --hard origin/${BRANCH}`);
    return false;
  }
  if (ALLOW_DIRTY) {
    console.error('  --allow-dirty：已补齐对象但跳过本地 refs 对齐');
    return false;
  }
  await git(['update-ref', `refs/heads/${BRANCH}`, target]);
  await git(['update-ref', `refs/remotes/origin/${BRANCH}`, target]);
  await git(['reset', '--hard', target]);
  try {
    await git(['branch', `--set-upstream-to=origin/${BRANCH}`, BRANCH]);
  } catch {
    /* 上游已设置则忽略 */
  }
  console.log('✓ 本地 refs 已对齐到服务端提交（tree 不变，内容不受影响）');
  return true;
}

// ---- 内容已经一致：只需处理提交对象差异
if (remoteTree === localTree) {
  console.log('\n✓ 远端 tree 与本地完全一致 —— 没有内容需要推送');
  if (remoteSha === localSha) {
    console.log('✓ 本地与服务端是同一个提交，无需对齐');
    process.exit(0);
  }
  console.log(`△ 但提交对象不同：本地 ${localSha.slice(0, 12)} / 远端 ${remoteSha.slice(0, 12)}，尝试对齐…`);
  const aligned = await alignLocally(remoteSha);
  console.log(`\n分支状态: ${(await git(['status', '-sb'])).trim().split('\n')[0]}`);
  process.exit(aligned ? 0 : 2);
}

// ---- 空仓库播种（Git Data API 对空仓库返回 409 Git Repository is empty）
if (!remoteSha) {
  if (DRY_RUN) {
    console.log('[干跑] 跳过播种');
  } else {
    const seed = await api('PUT', `/repos/${repoSlug}/contents/README.md`, {
      message: 'chore: initialize repository',
      content: Buffer.from('# initialize\n').toString('base64'),
    });
    if (!seed.ok && seed.status !== 201) {
      console.error(`播种失败 HTTP ${seed.status}: ${JSON.stringify(seed.json).slice(0, 300)}`);
      process.exit(1);
    }
    const r = await api('GET', `/repos/${repoSlug}/git/ref/heads/${BRANCH}`);
    remoteSha = r.json.object.sha;
    const c = await api('GET', `/repos/${repoSlug}/git/commits/${remoteSha}`);
    remoteTree = c.json.tree.sha;
    console.log(`       已播种 → ${remoteSha.slice(0, 12)}`);
  }
}

// ---- 复用远端已有 blob（path → sha），未变化的文件不重传
const existing = new Map();
if (remoteTree) {
  const t = await api('GET', `/repos/${repoSlug}/git/trees/${remoteTree}?recursive=1`);
  for (const node of t.json?.tree ?? []) {
    if (node.type === 'blob') existing.set(node.path, node.sha);
  }
}

const remoteEntries = [];
let uploaded = 0;
let reused = 0;
for (const e of entries) {
  const already = existing.get(e.path);
  if (already === e.sha) {
    remoteEntries.push({ path: e.path, mode: e.mode, type: 'blob', sha: already });
    reused += 1;
    continue;
  }
  if (DRY_RUN) {
    remoteEntries.push({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha });
    uploaded += 1;
    continue;
  }
  const content = await git(['cat-file', 'blob', e.sha], 'buffer');
  const res = await api('POST', `/repos/${repoSlug}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  if (!res.ok) {
    console.error(`上传 ${e.path} 失败 HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
    process.exit(1);
  }
  remoteEntries.push({ path: e.path, mode: e.mode, type: 'blob', sha: res.json.sha });
  uploaded += 1;
  if (uploaded % 20 === 0) console.log(`  已上传 ${uploaded} 个…`);
}
console.log(`[blob] 复用 ${reused} 个，上传 ${uploaded} 个`);

if (DRY_RUN) {
  console.log(`[干跑] 将创建 tree（base_tree=${remoteTree?.slice(0, 12)}，${remoteEntries.length} 项）`);
  console.log(`[干跑] API 调用 ${apiCalls} 次，未做任何写入`);
  process.exit(0);
}

// ---- 建 tree 并强校验
const treeRes = await api('POST', `/repos/${repoSlug}/git/trees`, {
  base_tree: remoteTree,
  tree: remoteEntries,
});
if (!treeRes.ok) {
  console.error(`建 tree 失败 HTTP ${treeRes.status}: ${JSON.stringify(treeRes.json).slice(0, 300)}`);
  process.exit(1);
}
console.log(`[tree] 远端 ${treeRes.json.sha.slice(0, 12)}  vs  本地 ${localTree.slice(0, 12)}`);
if (treeRes.json.sha !== localTree) {
  console.error('✗ tree 不一致 —— 内容发生漂移，已中止（ref 未改动）');
  process.exit(1);
}
console.log('✓ tree 完全一致（内容等价，这是唯一硬性标准）');

// ---- 建 commit：消息**逐字节原样**发送，日期带原始 UTC 偏移
let finalSha = null;
let hitExact = false;
{
  const res = await api('POST', `/repos/${repoSlug}/git/commits`, {
    message: rawMessage,
    tree: treeRes.json.sha,
    parents: remoteSha ? [remoteSha] : [],
    author: { name: aIdent.name, email: aIdent.email, date: toIsoWithOffset(aIdent.ts, aIdent.tz) },
    committer: {
      name: cIdent.name,
      email: cIdent.email,
      date: toIsoWithOffset(cIdent.ts, cIdent.tz),
    },
  });
  if (!res.ok) {
    console.error(`建 commit 失败 HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
    process.exit(1);
  }
  finalSha = res.json.sha;
  hitExact = finalSha === localSha;
  console.log(
    `[commit] 服务端 ${finalSha.slice(0, 12)}  ${
      hitExact ? '✓ 与本地完全相同' : `△ 与本地 ${localSha.slice(0, 12)} 不同`
    }`,
  );
}

// ---- 更新 ref
const patch = await api('PATCH', `/repos/${repoSlug}/git/refs/heads/${BRANCH}`, {
  sha: finalSha,
  force: true,
});
if (!patch.ok) {
  console.error(`更新 ref 失败 HTTP ${patch.status}: ${JSON.stringify(patch.json).slice(0, 300)}`);
  process.exit(1);
}
console.log(`✓ ${BRANCH} → ${patch.json.object.sha.slice(0, 12)}`);

// ---- 对齐本地 refs
if (hitExact) {
  await git(['update-ref', `refs/remotes/origin/${BRANCH}`, finalSha]);
  try {
    await git(['branch', `--set-upstream-to=origin/${BRANCH}`, BRANCH]);
  } catch {
    /* 上游已设置则忽略 */
  }
} else {
  const ok = await alignLocally(finalSha);
  if (!ok) process.exitCode = 2;
}

console.log(`\n仓库地址: https://github.com/${repoSlug}`);
console.log(`分支状态: ${(await git(['status', '-sb'])).trim().split('\n')[0]}`);
console.log(`工作区  : ${(await git(['status', '--short'])).trim() || 'clean'}`);
console.log(`API 调用: ${apiCalls} 次`);

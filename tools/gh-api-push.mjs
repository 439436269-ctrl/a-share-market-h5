/**
 * 通过 GitHub Git Data API 推送（`git push` 到 github.com 被重置时的备胎通道）。
 *
 * ## 为什么需要它
 * 某些网络下 `api.github.com` 完全正常，但 `github.com:443` 的 git 通道会被重置：
 * `git push` 报 `Recv failure: Connection was reset`，`git ls-remote` 直接卡死。
 * 此时改用 Git Data API（只有 api.github.com）就能把代码推上去。
 *
 * ## 它和 `git push` 的差别
 * commit 对象由服务端生成，author/committer/时间戳/消息结尾都可能被规范化，
 * 因此**服务端算出的 SHA 通常与本地不同**。本脚本的处理方式是：
 *   1. 建 tree 后**断言**远端 tree SHA == 本地 `HEAD^{tree}`，不等就中止（ref 不动）；
 *   2. 建 commit 时把本地元数据全部传过去，并试几种消息结尾写法，
 *      尽量命中与本地**完全相同的 SHA**；
 *   3. 无论是否命中，最后都把本地 refs 对齐到服务端提交 ——
 *      保证本地与远端始终是同一个提交，不会出现 ahead/分叉。
 *
 * 换句话说：**内容以 tree 为准（强校验），SHA 以服务端为准（自动对齐）**。
 *
 * ## 用法
 *   node tools/gh-api-push.mjs                 # 推送当前分支到 origin
 *   node tools/gh-api-push.mjs --dry-run       # 只算不上传
 *   node tools/gh-api-push.mjs --repo owner/name --branch main
 *
 * 凭据从系统凭据管理器取（`git credential fill`），不落盘、不打印。
 * Windows 上凭据按 `git:https://<user>@github.com` 分账号存储，
 * 所以必须带 username，否则会退化成交互提示而卡住。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);
const API = 'https://api.github.com';
const GH_USER = process.env.GH_USER ?? '';

// ------------------------------------------------------------------ 参数

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = flag('--dry-run');
const BRANCH = opt('--branch', 'main');

const git = (args, encoding = 'utf8') =>
  execFileP('git', args, { maxBuffer: 256 * 1024 * 1024, encoding }).then((r) => r.stdout);

/** 从 origin 里解析出 owner/repo，并顺带拿到凭据用的用户名 */
async function resolveRepo() {
  const explicit = opt('--repo', '');
  if (explicit) return explicit;
  const url = (await git(['remote', 'get-url', 'origin'])).trim();
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`无法从 origin 解析 owner/repo: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function resolveUser(repoSlug) {
  return GH_USER || repoSlug.split('/')[0];
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
              `  提示：Windows 上请确认凭据目标形如 git:https://${user}@github.com`,
          ),
        );
      }
      resolve(f.password);
    });
    p.stdin.write(`protocol=https\nhost=github.com\nusername=${user}\n\n`);
    p.stdin.end();
  });
}

// ------------------------------------------------------------------ 工具

/** git 对象 SHA = sha1("<type> <字节长度>\0" + 内容)。长度按字节算，含中文时 ≠ 字符数 */
function objectSha(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`commit ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

/** git 提交对象里的时间格式：<unix-ts> <±HHMM> */
function toGitDate(iso) {
  const ts = Math.floor(Date.parse(iso) / 1000);
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  return { ts, tz: m ? `${m[1]}${m[2]}${m[3]}` : '+0000' };
}

// ------------------------------------------------------------------ 主流程

const repoSlug = await resolveRepo();
const user = resolveUser(repoSlug);
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
const localParents = headerLines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));

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
if (DRY_RUN) console.log('模式   干跑（不上传）');

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

if (remoteTree === localTree) {
  console.log('\n✓ 远端 tree 与本地完全一致 —— 没有内容需要推送');
  process.exit(0);
}

// ---- 空仓库播种（Git Data API 对空仓库会返回 409 Git Repository is empty）
if (!remoteSha) {
  if (DRY_RUN) {
    console.log('[干跑] 跳过播种');
  } else {
    // 种子文件必须选「本地树里也有、随后会被覆盖」的那个，最终 tree 才会恰好等于本地 tree
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

// ---- 复用远端已有 blob（避免每次推送重传所有文件，含图片）
const existing = new Map();
if (remoteTree) {
  const t = await api('GET', `/repos/${repoSlug}/git/trees/${remoteTree}?recursive=1`);
  for (const node of t.json?.tree ?? []) {
    if (node.type === 'blob') existing.set(node.path, node.sha);
  }
}

// ---- 上传 blob
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
  if (res.json.sha !== e.sha) {
    console.warn(`  ! ${e.path} blob SHA 不一致（本地 ${e.sha.slice(0, 8)} / 远端 ${res.json.sha.slice(0, 8)}）`);
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

// ---- 建 commit：试几种消息结尾，尽量命中与本地相同的 SHA
// 经验：服务端会在消息末尾补一个换行，所以要先减一个再发
const messageCandidates = [
  rawMessage,
  rawMessage.replace(/\n$/, ''),
  rawMessage.replace(/\n+$/, ''),
  `${rawMessage.replace(/\n+$/, '')}\n`,
];
const seen = new Set();
const uniqMessages = messageCandidates.filter((m) => !seen.has(m) && seen.add(m));

let finalSha = null;
let hitExact = false;
for (const [i, msg] of uniqMessages.entries()) {
  const res = await api('POST', `/repos/${repoSlug}/git/commits`, {
    message: msg,
    tree: treeRes.json.sha,
    parents: remoteSha ? [remoteSha] : [],
    author: { name: aIdent.name, email: aIdent.email, date: new Date(aIdent.ts * 1000).toISOString() },
    committer: { name: cIdent.name, email: cIdent.email, date: new Date(cIdent.ts * 1000).toISOString() },
  });
  if (!res.ok) {
    console.error(`建 commit 失败 HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
    process.exit(1);
  }
  const sha = res.json.sha;
  const exact = sha === localSha;
  console.log(`[commit] 候选 ${i + 1}/${uniqMessages.length} 消息结尾=${JSON.stringify(msg.slice(-2))} → ${sha.slice(0, 12)}${exact ? '  ✓ 与本地相同' : ''}`);
  finalSha = sha;
  if (exact) {
    hitExact = true;
    break;
  }
}
// 未命中时以最后一个为准（parent 与本地一致时，通常第一个候选即命中）
console.log(hitExact ? '✓ commit SHA 与本地完全一致' : '△ commit SHA 与本地不同（内容仍等价），稍后把本地 refs 对齐到服务端');

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

// ---- 对齐本地 refs：始终让本地与远端是同一个提交
if (!hitExact) {
  const lines = [`tree ${treeRes.json.sha}`];
  if (remoteSha) lines.push(`parent ${remoteSha}`);
  lines.push(`author ${aIdent.name} <${aIdent.email}> ${aIdent.ts} ${aIdent.tz}`);
  lines.push(`committer ${cIdent.name} <${cIdent.email}> ${cIdent.ts} ${cIdent.tz}`);
  const bodyNoTail = rawMessage.replace(/\n+$/, '');
  const candidates = [`${lines.join('\n')}\n\n${bodyNoTail}\n\n`, `${lines.join('\n')}\n\n${bodyNoTail}\n`];
  let payload = null;
  for (const c of candidates) {
    if (objectSha(c) === finalSha) {
      payload = c;
      break;
    }
  }
  if (payload) {
    await new Promise((resolve, reject) => {
      const p = spawn('git', ['hash-object', '-t', 'commit', '-w', '--stdin']);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('写入对象失败'))));
      p.stdin.end(Buffer.from(payload, 'utf8'));
    });
    await git(['update-ref', `refs/heads/${BRANCH}`, finalSha]);
    await git(['update-ref', `refs/remotes/origin/${BRANCH}`, finalSha]);
    await git(['reset', '--hard', finalSha]);
    console.log('✓ 已重建服务端提交对象并把本地 refs 对齐（tree 不变，内容不受影响）');
  } else {
    console.error('! 无法在本地重建服务端提交对象，本地 refs 未对齐');
    console.error(`  下一次能连上 github.com 时执行：git fetch origin && git reset --hard origin/${BRANCH}`);
  }
} else {
  await git(['update-ref', `refs/remotes/origin/${BRANCH}`, finalSha]);
  try {
    await git(['branch', `--set-upstream-to=origin/${BRANCH}`, BRANCH]);
  } catch {
    /* 上游已设置则忽略 */
  }
}

console.log(`\n仓库地址: https://github.com/${repoSlug}`);
console.log(`分支状态: ${(await git(['status', '-sb'])).trim().split('\n')[0]}`);
console.log(`工作区  : ${(await git(['status', '--short'])).trim() || 'clean'}`);
console.log(`API 调用: ${apiCalls} 次`);

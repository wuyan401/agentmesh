/* ============================================================================
   AgentMesh 观察台 · 应用逻辑
   纯原生 ES module：零依赖、零构建。只读，不向平台写入任何状态。
   ========================================================================== */

/* --- 常量 ----------------------------------------------------------------- */
const STATUS_ORDER = [
  'draft', 'ready', 'claimed', 'in_progress', 'submitted', 'reviewing',
  'approved', 'merged', 'rejected', 'blocked', 'cancelled',
];
/** 主流程 8 站（轨道）。rejected / blocked / cancelled 是轨道外的终态。 */
const PIPE = ['draft', 'ready', 'claimed', 'in_progress', 'submitted', 'reviewing', 'approved', 'merged'];
const OFF_TRACK = new Set(['rejected', 'blocked', 'cancelled']);
const STATUS_ZH = {
  draft: '草稿', ready: '待领取', claimed: '已认领', in_progress: '进行中',
  submitted: '已提交', reviewing: '审查中', approved: '已通过', merged: '已合并',
  rejected: '已驳回', blocked: '已阻塞', cancelled: '已取消',
};
const VIEWS = ['overview', 'board', 'sessions', 'audit', 'messages', 'agents'];
const VIEW_TITLE = { overview: '总览', board: '看板', sessions: '会话', audit: '审计', messages: '消息', agents: 'Agent' };
const SEARCH_PH = {
  overview: '搜索任务…', board: '搜索 id / 标题 / 角色 / scope / 人…',
  sessions: '搜索会话 / agent / 任务…', audit: '搜索异常 / 合并 / kind…',
  messages: '搜索消息正文 / 类型…', agents: '搜索 agent / 能力…',
};
const SORTS = {
  updated_desc: { label: '更新时间 ↓', fn: (a, b) => ts(b.updated_at) - ts(a.updated_at) },
  updated_asc: { label: '更新时间 ↑', fn: (a, b) => ts(a.updated_at) - ts(b.updated_at) },
  id_asc: { label: 'ID ↑', fn: (a, b) => a.task_id.localeCompare(b.task_id) },
  id_desc: { label: 'ID ↓', fn: (a, b) => b.task_id.localeCompare(a.task_id) },
  status: { label: '状态', fn: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) },
  role: { label: '角色', fn: (a, b) => String(a.role).localeCompare(String(b.role)) },
};
const THEME_KEY = 'agentmesh.theme';

/* --- 数据层 --------------------------------------------------------------- */
const store = {
  overview: null, tasks: null, sessions: null, audit: null, messages: null,
  tasksById: new Map(), logs: new Map(), docs: new Map(), contexts: new Map(),
  errors: new Map(),
  stream: 'connecting',
  live: null,
  countsAt: null,
};
const inflight = new Map();

class ApiError extends Error {
  constructor(path, status, detail) {
    super(detail || `HTTP ${status}`);
    this.path = path;
    this.status = status;
  }
}

async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (e) {
    throw new ApiError(path, 0, `无法连接后端（${e.message}）`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && (body.error || body.detail) ? String(body.error || body.detail) : '';
    } catch { /* 忽略非 JSON 错误体 */ }
    throw new ApiError(path, res.status, detail);
  }
  return res.json();
}

/** 统一的一次性加载：同一 key 并发只发一次请求，失败记录在 store.errors。 */
function once(key, loader) {
  if (inflight.has(key)) return inflight.get(key);
  const p = loader()
    .then((value) => { store.errors.delete(key); return value; })
    .catch((err) => { store.errors.set(key, err); throw err; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

const loaders = {
  overview: () => once('overview', async () => { store.overview = await api('/api/overview'); return store.overview; }),
  tasks: () => once('tasks', async () => { const r = await api('/api/tasks'); store.tasks = r.tasks || []; return store.tasks; }),
  sessions: () => once('sessions', async () => { const r = await api('/api/sessions'); store.sessions = r.sessions || []; return store.sessions; }),
  audit: () => once('audit', async () => {
    const r = await api('/api/audit');
    store.audit = {
      violations: r.violations || [], merges: r.merges || [], reviews: r.reviews || [],
      events: r.events || [], digest: r.digest || null,
    };
    if (r.digest) store.docs.set('digest', r.digest);
    return store.audit;
  }),
  messages: () => once('messages', async () => {
    const r = await api('/api/messages');
    store.messages = { messages: r.messages || [], dead: r.dead || [] };
    return store.messages;
  }),
};

function loadTask(id) {
  if (store.tasksById.has(id)) return Promise.resolve(store.tasksById.get(id));
  return once(`task:${id}`, async () => {
    const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
    store.tasksById.set(id, t);
    return t;
  });
}

function loadLog(id) {
  if (store.logs.has(id)) return Promise.resolve(store.logs.get(id));
  return once(`log:${id}`, async () => {
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(id)}/log?lines=200`);
      const entry = { log: r.log || '', at: Date.now(), missing: false };
      store.logs.set(id, entry);
      return entry;
    } catch (e) {
      // 404 = 这个会话没有落盘日志，是正常情况，不该报成错误
      if (e instanceof ApiError && e.status === 404) {
        const entry = { log: '', at: Date.now(), missing: true };
        store.logs.set(id, entry);
        store.errors.delete(`log:${id}`);
        return entry;
      }
      throw e;
    }
  });
}

function loadContext(taskId) {
  if (store.contexts.has(taskId)) return Promise.resolve(store.contexts.get(taskId));
  return once(`ctx:${taskId}`, async () => {
    const r = await api(`/api/context?task=${encodeURIComponent(taskId)}`);
    store.contexts.set(taskId, r.context);
    return r.context;
  });
}

function loadDoc(kind) {
  if (store.docs.has(kind)) return Promise.resolve(store.docs.get(kind));
  const url = kind === 'decisions' ? '/api/decisions' : kind === 'protocol' ? '/api/protocol' : '/api/audit';
  return once(`doc:${kind}`, async () => {
    if (kind === 'digest') {
      const r = await api('/api/audit');
      store.docs.set('digest', r.digest);
      return r.digest;
    }
    const r = await api(url);
    store.docs.set(kind, r.markdown);
    return r.markdown;
  });
}

/** 需要重新拉取的 key（保留已打开的面板与滚动位置）。 */
function refresh(keys, opts = {}) {
  keys.forEach((k) => {
    if (k.startsWith('task:')) store.tasksById.delete(k.slice(5));
    else if (k.startsWith('log:')) store.logs.delete(k.slice(4));
    else store[k] = null;
  });
  if (!opts.silent) toast(`重新拉取：${keys.map(friendlyKey).join(' · ')}`);
}
function friendlyKey(k) {
  return { overview: '总览', tasks: '任务', sessions: '会话', audit: '审计', messages: '消息' }[k] || k;
}

/* --- 格式化 --------------------------------------------------------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function attr(s) { return esc(s).replace(/\n/g, ' '); }
function ts(iso) { const t = Date.parse(iso || ''); return Number.isNaN(t) ? 0 : t; }
function pad2(n) { return String(n).padStart(2, '0'); }

function rel(iso) {
  const t = ts(iso);
  if (!t) return '—';
  const d = Date.now() - t;
  if (d < 0) return '刚刚';
  const s = Math.floor(d / 1000);
  if (s < 30) return '刚刚';
  if (s < 90) return '1 分钟前';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd} 天前`;
  return abs(iso).slice(0, 10);
}
function abs(iso) {
  const t = ts(iso);
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function mmdd(iso) {
  const t = ts(iso);
  if (!t) return '—';
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function shortSha(sha, n = 7) { return sha ? String(sha).slice(0, n) : '—'; }
function age(iso) {
  const t = ts(iso);
  if (!t) return { text: '无心跳', stale: true };
  const h = (Date.now() - t) / 36e5;
  return { text: rel(iso), stale: h > 1 };
}
function statusPill(status, size = '') {
  const s = String(status || 'unknown');
  return `<span class="pill st-${esc(s)} ${size}" title="${esc(STATUS_ZH[s] || s)}"><i class="dotmark" aria-hidden="true"></i>${esc(s)}</span>`;
}
function railHtml(status, large = false) {
  const s = String(status || '');
  const off = OFF_TRACK.has(s);
  const idx = off ? PIPE.indexOf('reviewing') : PIPE.indexOf(s);
  const parts = [];
  for (let i = 0; i < PIPE.length; i++) {
    let cls = '';
    if (i < idx) cls = 'done';
    if (i === idx) cls = 'cur';
    parts.push(`<i class="${cls}"></i>`);
  }
  const pos = off ? '轨道外' : `${idx + 1}/${PIPE.length}`;
  return `<span class="rail ${large ? 'rail-lg' : ''} ${off ? 'is-broken' : ''} st-${esc(s)}" aria-hidden="true" title="流程位置：${esc(s)}（${esc(pos)}）">${parts.join('')}</span>`;
}

/** 长文本截断：在换行或空格处切断，全文留在 data-full 里供展开。 */
function shortText(text, limit = 460) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return { text: s, more: false };
  let cut = s.slice(0, limit);
  const nl = cut.lastIndexOf('\n');
  if (nl > limit * 0.55) cut = cut.slice(0, nl);
  else {
    const sp = cut.lastIndexOf(' ');
    if (sp > limit * 0.65) cut = cut.slice(0, sp);
  }
  return { text: cut.replace(/[\s，、,;；]+$/, '') + '…', more: true };
}

/** 可展开的长文本块（evidence / 提交说明 / 消息正文）。 */
function longText(text, cls = 'evidence') {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return `<p class="${cls} dim2">（无内容）</p>`;
  const t = shortText(s);
  return `<p class="${cls}" data-short="${esc(t.text)}" data-full="${esc(s)}">${esc(t.text)}</p>
    ${t.more ? `<button class="evidence-toggle" type="button" data-act="expand">展开全文 · ${s.length} 字符</button>` : ''}`;
}

/** 卡片上的「判词」：这张卡此刻发生了什么、平台裁了什么。 */
function verdictLine(t) {
  const reviews = t.review_records || [];
  const rev = reviews.length ? reviews[reviews.length - 1] : null;
  const m = t.merge;
  switch (t.status) {
    case 'merged':
      return m
        ? `<strong>${esc(m.mode || 'merge')} 合并</strong> · ${esc(shortSha(m.merge_commit))} · ${(m.files || []).length} 文件`
        : '<strong>已合并</strong>';
    case 'approved':
      return rev ? `<strong>${esc(rev.review_id)} ${esc(rev.verdict)}</strong> · 等 integrator 合并` : '审查通过 · 等合并';
    case 'reviewing':
      return rev ? `<strong>${esc(rev.review_id)} ${esc(rev.verdict)}</strong>` : '<strong>审查中</strong> · 尚无判词';
    case 'submitted':
      return t.submission ? `<strong>等审查</strong> · ${esc(shortSha(t.submission.commit))}` : '已提交';
    case 'in_progress':
    case 'claimed':
      return `${esc(t.claimed_by || '—')} 认领${t.implementer_agent ? ` · ${esc(t.implementer_agent)}` : ''}`;
    case 'rejected':
      return rev ? `<strong>${esc(rev.review_id)} 驳回</strong>` : '被驳回';
    case 'blocked':
      return t.blocked_reason ? `<strong>阻塞</strong> · ${esc(t.blocked_reason)}` : '被阻塞';
    case 'ready':
      return '待调度器分派';
    case 'draft':
      return '未发布';
    case 'cancelled':
      return '已取消';
    default:
      return esc(t.status);
  }
}

/**
 * 滞留信号：完全由 updated_at 推导（不是平台字段），
 * 用于回答「卡了多久没人动」。等审查的阈值比 agent 干活的短。
 */
function stuck(t) {
  const waiting = t.status === 'submitted' || t.status === 'reviewing' || t.status === 'approved';
  const working = t.status === 'claimed' || t.status === 'in_progress';
  if (!waiting && !working) return null;
  const mins = (Date.now() - ts(t.updated_at)) / 60000;
  const limit = waiting ? 3 : 20;
  if (mins < limit) return null;
  return { mins: Math.round(mins), level: mins > 30 ? 'hot' : 'warm' };
}

function pinHtml(t) {
  const s = stuck(t);
  if (!s) return '';
  const label = s.mins >= 60 ? `${Math.round(s.mins / 60)} 小时` : `${s.mins} 分钟`;
  return `<span class="pin" data-level="${s.level}" title="按 updated_at 推导：这张卡已经 ${s.mins} 分钟没有状态变化">滞留 ${esc(label)}</span>`;
}

/* --- markdown（够用的子集） ---------------------------------------------- */
function mdInline(text) {
  const codes = [];
  let out = esc(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function mdRender(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*?)\s*#*$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        `<div class="md-tbl"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${mdRender(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      out.push(`<ul>${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      out.push(`<ol>${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    const buf = [];
    while (
      i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length) out.push(`<p>${mdInline(buf.join(' '))}</p>`);
    else i++;
  }
  return out.join('\n');
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/* --- 状态 / 路由 ---------------------------------------------------------- */
const ui = {
  view: 'board', q: '', status: '', role: '', sort: 'updated_desc', mode: 'lanes',
  task: '', tab: 'verdict', s: '', thread: '', atab: 'violations', doc: 'digest',
  aliveOnly: false, logFor: '',
};

function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [rawView, qs] = raw.split('?');
  const view = VIEWS.includes(rawView) ? rawView : 'board';
  return { view, params: new URLSearchParams(qs || '') };
}

function syncUiFromRoute(route) {
  const p = route.params;
  ui.view = route.view;
  ui.q = p.get('q') || '';
  ui.status = p.get('status') || '';
  ui.role = p.get('role') || '';
  ui.sort = SORTS[p.get('sort')] ? p.get('sort') : 'updated_desc';
  ui.mode = p.get('mode') === 'table' ? 'table' : 'lanes';
  ui.task = p.get('task') || '';
  ui.tab = ['verdict', 'submission', 'timeline', 'context'].includes(p.get('tab')) ? p.get('tab') : 'verdict';
  ui.s = p.get('s') || '';
  ui.thread = p.get('thread') || '';
  ui.atab = ['violations', 'merges', 'reviews', 'events'].includes(p.get('atab')) ? p.get('atab') : 'violations';
  ui.doc = ['digest', 'decisions', 'protocol'].includes(p.get('doc')) ? p.get('doc') : 'digest';
}

function currentParams() {
  const p = new URLSearchParams();
  const put = (k, v) => { if (v) p.set(k, v); };
  put('q', ui.q.trim());
  if (ui.view === 'board') {
    put('status', ui.status);
    put('role', ui.role);
    put('sort', ui.sort !== 'updated_desc' ? ui.sort : '');
    put('mode', ui.mode !== 'lanes' ? ui.mode : '');
  }
  if (ui.view === 'board' || ui.task) put('task', ui.task);
  if (ui.task) put('tab', ui.tab !== 'verdict' ? ui.tab : '');
  if (ui.view === 'sessions') put('s', ui.s);
  if (ui.view === 'messages') put('thread', ui.thread);
  if (ui.view === 'audit') {
    put('atab', ui.atab !== 'violations' ? ui.atab : '');
    put('doc', ui.doc !== 'digest' ? ui.doc : '');
  }
  return p.toString();
}

function setHash(replace = false) {
  const hash = `#/${ui.view}${currentParams() ? '?' + currentParams() : ''}`;
  if (hash === location.hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}
/** 改 UI 状态并同步 URL，然后重绘（不依赖 hashchange）。 */
function update(patch, { replace = true, reset = false } = {}) {
  Object.assign(ui, patch);
  setHash(replace);
  render({ reset });
}
function go(view, patch = {}) {
  const next = { view, ...patch, task: patch.task || '' };
  Object.assign(ui, next);
  setHash(false);
  render({ reset: true });
}

/* --- DOM 小工具 ----------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 2400);
}

function loadingBlock(rows = 3) {
  return `<div class="loading-block" aria-busy="true" aria-live="polite"><span class="sr-only">加载中</span>${
    Array.from({ length: rows }, (_, i) => `<div class="skel skel-line ${['w40', 'w80', 'w60', 'w100'][i % 4]}"></div>`).join('')
  }</div>`;
}

function errorBlock(key, err, label = '数据') {
  const msg = err ? err.message : '未知错误';
  const status = err && err.status ? `HTTP ${err.status}` : '';
  const offline = !err || !err.status;
  return `<div class="view-error" role="alert">
    <div class="err-title"><svg class="ico" aria-hidden="true"><use href="#i-x" /></svg>${esc(label)}加载失败</div>
    <div class="err-detail">${esc(status ? status + ' · ' : '')}${esc(msg)}</div>
    <div class="err-hint">${offline
      ? '浏览器连不上后端：确认 <code>mesh serve</code> 进程还在跑，以及页面与 API 同源。'
      : '后端返回了错误：这条数据可能已被清理，或接口参数不对。'}</div>
    <button class="btn" type="button" data-act="retry" data-key="${esc(key)}">重试</button>
  </div>`;
}

function emptyState(title, hint, action = '') {
  return `<div class="empty">
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-hint">${esc(hint)}</div>
    ${action}
  </div>`;
}

/* --- 总览条 --------------------------------------------------------------- */
function renderStrip() {
  const el = $('#strip');
  if (!el) return;
  const ov = store.overview;
  if (!ov) {
    const err = store.errors.get('overview');
    el.innerHTML = `<div class="strip-inner">${
      err
        ? `<div class="cell"><span class="cell-k">后端</span><span class="cell-v" style="font-size:12px;color:var(--s-rejected)">连接失败</span></div>
           <div class="cell"><button class="btn" type="button" data-act="retry" data-key="overview">重试</button></div>`
        : Array.from({ length: 5 }, () => '<span class="strip-skel" aria-hidden="true"></span>').join('')
    }</div>`;
    return;
  }
  const counts = store.countsAt || ov.counts || {};
  const statuses = STATUS_ORDER.filter((s) => (counts[s] || 0) > 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const live = store.live == null ? (ov.live_sessions || []).length : store.live;
  const lastMerge = (ov.recent_merges || [])[(ov.recent_merges || []).length - 1] || null;
  const highSev = (ov.recent_violations || []).some((v) => v.severity === 'high');

  const cells = [];
  cells.push(`<button class="cell ${ui.status ? '' : 'is-active'}" type="button" data-act="filter-status" data-status="" aria-pressed="${ui.status ? 'false' : 'true'}" title="清除状态筛选">
    <span class="cell-k">任务</span><span class="cell-v num">${total}</span></button>`);
  for (const s of statuses) {
    const active = ui.status === s;
    cells.push(`<button class="cell st-${s}" type="button" data-act="filter-status" data-status="${esc(s)}" aria-pressed="${active}" title="筛选 ${esc(s)}（${esc(STATUS_ZH[s] || s)}）">
      <span class="cell-k"><i class="dotmark" aria-hidden="true"></i>${esc(s)}</span>
      <span class="cell-v num">${counts[s]}</span></button>`);
  }
  cells.push(`<button class="cell" type="button" data-act="nav" data-view="sessions" title="活跃会话：status = active 的会话数">
    <span class="cell-k">活跃会话</span><span class="cell-v num">${live}<small>个</small></span></button>`);
  cells.push(`<button class="cell" type="button" data-act="nav" data-view="audit" data-atab="merges" title="${lastMerge ? `最近合并：${attr(lastMerge.task_id || '')} ${attr(lastMerge.merge_commit || '')}` : '尚无合并'}">
    <span class="cell-k">最近合并</span>
    <span class="cell-v" style="font-size:12px">${lastMerge ? `<span class="mono">${esc(lastMerge.task_id || '—')}</span> <small class="sha">${esc(shortSha(lastMerge.merge_commit))} · </small><small>${esc(rel(lastMerge.at))}</small>` : '<span class="dim2">无</span>'}</span></button>`);
  cells.push(`<button class="cell" type="button" data-act="nav" data-view="audit" data-atab="violations" title="查看审计异常">
    <span class="cell-k">审计异常${highSev ? '<i class="dotmark" style="background:var(--s-rejected)" aria-hidden="true"></i>' : ''}</span>
    <span class="cell-v num">${ov.violations}${highSev ? '<small style="color:var(--s-rejected)">含 high</small>' : ''}</span></button>`);

  const cfg = ov.config || {};
  cells.push(`<div class="cell-flags" aria-label="平台配置">
    <span class="flag" data-on="${cfg.auto_review ? 'true' : 'false'}"><i class="dotmark" aria-hidden="true"></i>自动审查 ${cfg.auto_review ? '开' : '关'}</span>
    <span class="flag" data-on="${cfg.auto_integrate ? 'true' : 'false'}"><i class="dotmark" aria-hidden="true"></i>自动集成 ${cfg.auto_integrate ? '开' : '关'}</span>
    <span class="flag"><i class="dotmark" aria-hidden="true"></i>并发上限 ${esc(cfg.max_concurrent_sessions ?? '—')}</span>
  </div>`);

  const banner = store.stream === 'poll'
    ? `<div class="banner" role="status"><svg class="ico" aria-hidden="true"><use href="#i-refresh" /></svg><strong>实时连接中断</strong><span>已降级为每 8 秒轮询；数字可能略有延迟。</span></div>`
    : '';

  el.innerHTML = `<div class="strip-inner">${cells.join('')}</div>${banner}`;
}

function setLive(state, text) {
  const el = $('#live');
  if (!el) return;
  el.dataset.state = state;
  const t = $('.live-text', el);
  if (t) t.textContent = text;
}

/* --- 视图：总览 ----------------------------------------------------------- */
function renderOverview() {
  if (!store.overview) {
    return store.errors.get('overview')
      ? errorBlock('overview', store.errors.get('overview'), '总览')
      : loadingBlock(5);
  }
  const ov = store.overview;
  const counts = ov.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const byRole = Object.entries(ov.counts_by_role || {}).sort((a, b) => b[1] - a[1]);
  const live = ov.live_sessions || [];
  const merges = (ov.recent_merges || []).slice().reverse();
  const viols = (ov.recent_violations || []).slice().reverse();
  const cfg = ov.config || {};

  const statusRows = STATUS_ORDER.filter((s) => counts[s]).map((s) => `
    <div class="mini-row"><span class="k">${statusPill(s)}</span><span class="v num">${counts[s]}</span></div>`).join('');

  return `
  <div class="view-head">
    <div class="view-title"><h1>总览</h1><span class="count">只读 · 平台状态快照</span></div>
    <div class="view-tools">
      <span class="micro">创建于 ${esc(mmdd(ov.created_at))}</span>
    </div>
  </div>
  <div class="ov-grid">
    <section class="ov-block">
      <div class="ov-h"><h2>任务</h2><span class="micro">按状态</span></div>
      <div class="big-num">${total}<small>张任务卡</small></div>
      <div class="mini-list" style="margin-top:8px">${statusRows || '<div class="mini-row"><span class="k dim">暂无任务</span></div>'}</div>
      ${byRole.length ? `<div class="ov-h" style="margin-top:12px"><h2>按角色</h2></div>
      <div class="mini-list">${byRole.map(([r, n]) => `<div class="mini-row"><span class="k mono">${esc(r)}</span><span class="v num">${n}</span></div>`).join('')}</div>` : ''}
    </section>

    <section class="ov-block">
      <div class="ov-h"><h2>会话</h2><span class="micro">status = active</span></div>
      <div class="big-num">${live.length}<small>个活跃会话</small></div>
      <div class="mini-list" style="margin-top:8px">
        ${live.length ? live.map((s) => `<div class="mini-row">
          <span class="k"><span class="mono">${esc(s.session_id)}</span> <span class="dim">${esc(s.role)}</span></span>
          <span class="v">${s.alive ? '<span style="color:var(--s-merged)">pid 存活</span>' : '<span class="dim2">无进程</span>'} · ${esc(age(s.heartbeat).text)}</span>
        </div>`).join('') : '<div class="mini-row"><span class="k dim">无</span></div>'}
      </div>
    </section>

    <section class="ov-block">
      <div class="ov-h"><h2>最近合并</h2><span class="micro">平台产出</span></div>
      <div class="mini-list">
        ${merges.length ? merges.map((m) => `<div class="mini-row">
          <span class="k"><span class="mono">${esc(m.task_id || '—')}</span> <span class="dim">${esc(m.mode || '')}</span></span>
          <span class="v">${esc(shortSha(m.merge_commit))} · ${esc(rel(m.at))}</span>
        </div>`).join('') : '<div class="mini-row"><span class="k dim">尚无合并</span></div>'}
      </div>
    </section>

    <section class="ov-block">
      <div class="ov-h"><h2>审计异常</h2><span class="micro">detect-only</span></div>
      <div class="mini-list">
        ${viols.length ? viols.map((v) => `<div class="mini-row">
          <span class="k"><span class="sev" data-sev="${esc(v.severity)}">${esc(v.severity)}</span> <span class="mono dim">${esc(v.kind)}</span></span>
          <span class="v">${esc(rel(v.at))}</span>
        </div>`).join('') : '<div class="mini-row"><span class="k dim">无</span></div>'}
      </div>
    </section>

    <section class="ov-block">
      <div class="ov-h"><h2>平台配置</h2><span class="micro">config.json</span></div>
      <div class="cfglist">
        ${Object.entries(cfg).map(([k, v]) => `<div class="cfgrow"><span class="ck">${esc(k)}</span><span class="cv">${esc(typeof v === 'boolean' ? (v ? 'true' : 'false') : v)}</span></div>`).join('')}
      </div>
    </section>

    <section class="ov-block">
      <div class="ov-h"><h2>坐标</h2><span class="micro">paths</span></div>
      <div class="cfglist">
        <div class="cfgrow"><span class="ck">project</span><span class="cv">${esc(ov.project)}</span></div>
        <div class="cfgrow"><span class="ck">main</span><span class="cv">${esc(ov.main_branch)}</span></div>
        <div class="cfgrow"><span class="ck">root</span><span class="cv">${esc(ov.root)}</span></div>
        <div class="cfgrow"><span class="ck">mesh_dir</span><span class="cv">${esc(ov.mesh_dir)}</span></div>
        <div class="cfgrow"><span class="ck">base</span><span class="cv">${esc(ov.base_commit)}</span></div>
      </div>
    </section>
  </div>`;
}

/* --- 视图：看板 ----------------------------------------------------------- */
function visibleTasks() {
  const q = ui.q.trim().toLowerCase();
  const list = (store.tasks || []).filter((t) => {
    if (ui.status && t.status !== ui.status) return false;
    if (ui.role && t.role !== ui.role) return false;
    if (!q) return true;
    const hay = [
      t.task_id, t.title, t.role, t.implementer_agent, t.claimed_by, t.status,
      ...(t.scope && t.scope.write ? t.scope.write : []),
      ...(t.scope && t.scope.read ? t.scope.read : []),
      ...(t.review_records || []).map((r) => `${r.reviewer_agent} ${r.reviewer_session}`),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const sorter = (SORTS[ui.sort] || SORTS.updated_desc).fn;
  return list.sort(sorter);
}

function pipeBlock() {
  const counts = store.countsAt || (store.overview && store.overview.counts) || {};
  const max = Math.max(1, ...PIPE.map((s) => counts[s] || 0));
  const stations = PIPE.map((s) => {
    const n = counts[s] || 0;
    const pct = n === 0 ? 2 : Math.max(8, Math.round((n / max) * 100));
    return `<button class="station st-${s}" type="button" data-act="filter-status" data-status="${esc(s)}"
      aria-pressed="${ui.status === s ? 'true' : 'false'}" data-zero="${n === 0 ? 'true' : 'false'}"
      title="只看 ${esc(s)}（${esc(STATUS_ZH[s])}）">
      <span class="station-top"><span class="station-count num">${n}</span></span>
      <span class="station-bar"><i style="height:${pct}%"></i></span>
      <span class="station-label">${esc(s)}</span>
    </button>`;
  }).join('');
  return `<section class="pipe-block" aria-label="流程站点与任务数">
    <div class="pipe-head">
      <span class="micro">流程站点 · 全部任务分布（点站点筛选）</span>
      <span class="micro dim2">draft → merged 共 ${PIPE.length} 站</span>
    </div>
    <div class="pipe">${stations}</div>
  </section>`;
}

function filterBar() {
  const chips = [];
  if (ui.status) chips.push(`<button class="chip" type="button" data-act="filter-status" data-status="">状态 ${esc(ui.status)} ✕</button>`);
  if (ui.role) chips.push(`<button class="chip" type="button" data-act="filter-role" data-role="">角色 ${esc(ui.role)} ✕</button>`);
  if (ui.q.trim()) chips.push(`<button class="chip" type="button" data-act="filter-q">关键词 “${esc(ui.q.trim())}” ✕</button>`);
  if (!chips.length) return '';
  return `<div class="filterbar"><span class="micro">筛选</span>${chips.join('')}<button class="btn" data-kind="ghost" type="button" data-act="clear-filters">全部清除</button></div>`;
}

function taskCard(t) {
  const scope = t.scope && t.scope.write && t.scope.write.length ? t.scope.write.join(', ') : '（无 write scope）';
  const reviewers = (t.review_records || []).map((r) => r.reviewer_agent).filter(Boolean);
  return `<button class="card st-${esc(t.status)}" type="button" data-act="open-task" data-task="${esc(t.task_id)}" aria-current="${ui.task === t.task_id ? 'true' : 'false'}">
    <div class="card-top">
      <span class="card-id">${esc(t.task_id)}</span>
      <span class="card-time" title="${esc(abs(t.updated_at))}">${esc(rel(t.updated_at))}</span>
    </div>
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">
      <span class="k">role</span><span class="mono">${esc(t.role)}</span>
      <span class="k">scope</span><span class="card-scope" title="${attr(scope)}">${esc(scope)}</span>
    </div>
    <div class="card-verdict"><span class="v">${verdictLine(t)}</span>${pinHtml(t)}</div>
    <div class="card-foot">
      ${railHtml(t.status)}
      <span class="card-meta" style="margin:0">
        <span class="k">impl</span><span class="mono">${esc(t.implementer_agent || '—')}</span>
        <span class="k">rev</span><span class="mono">${esc(reviewers.join(',') || '—')}</span>
      </span>
    </div>
  </button>`;
}

function tasksTable(list) {
  const sortHead = (key, label) => {
    const active = ui.sort.startsWith(key);
    const dir = ui.sort.endsWith('asc') ? 'ascending' : 'descending';
    const state = active ? (dir === 'ascending' ? 'asc' : 'desc') : 'none';
    const next = active && dir === 'ascending' ? 'desc' : 'asc';
    return `<th scope="col" aria-sort="${active ? dir : 'none'}"><button class="th-sort" type="button" data-act="sort" data-sort="${key}_${next}" data-state="${state}">${label}<span class="arrow" aria-hidden="true"></span></button></th>`;
  };
  const rows = list.map((t) => {
    const reviewers = (t.review_records || []).map((r) => r.reviewer_agent).filter(Boolean);
    const scope = t.scope && t.scope.write && t.scope.write.length ? t.scope.write.join(', ') : '—';
    const pin = pinHtml(t);
    return `<tr class="st-${esc(t.status)} ${OFF_TRACK.has(t.status) ? 'row-broken' : ''}" data-act="open-task" data-task="${esc(t.task_id)}" aria-current="${ui.task === t.task_id ? 'true' : 'false'}">
      <td class="c-id"><button class="linklike mono" type="button" data-act="open-task" data-task="${esc(t.task_id)}">${esc(t.task_id)}</button></td>
      <td>${statusPill(t.status)}</td>
      <td class="c-mono">${esc(t.role)}</td>
      <td class="c-title">${esc(t.title)}<span class="c-sub">${verdictLine(t)}${pin ? ' · ' : ''}${pin}</span></td>
      <td class="c-scope" title="${attr(scope)}">${esc(scope.length > 34 ? scope.slice(0, 32) + '…' : scope)}</td>
      <td class="c-mono">${esc(t.implementer_agent || '—')}</td>
      <td class="c-mono">${esc(reviewers.join(',') || '—')}</td>
      <td class="c-rail">${railHtml(t.status)}</td>
      <td class="c-time" title="${esc(abs(t.updated_at))}">${esc(rel(t.updated_at))}</td>
    </tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table class="tbl">
    <caption class="sr-only">任务列表，按状态与更新时间排序</caption>
    <thead><tr>
      ${sortHead('id', 'ID')}
      <th scope="col">状态</th>
      ${sortHead('role', '角色')}
      <th scope="col">标题</th>
      <th scope="col">scope</th>
      <th scope="col">实现者</th>
      <th scope="col">审查者</th>
      <th scope="col">轨道</th>
      ${sortHead('updated', '更新')}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderBoard() {
  if (!store.tasks || !store.overview) {
    const err = store.errors.get('tasks') || store.errors.get('overview');
    return err ? errorBlock('tasks', err, '看板') : `${loadingBlock(4)}`;
  }
  const all = store.tasks;
  const list = visibleTasks();
  const roles = Array.from(new Set(all.map((t) => t.role).filter(Boolean))).sort();

  const head = `<div class="view-head">
    <div class="view-title">
      <h1>看板</h1>
      <span class="count">显示 ${list.length} / ${all.length} 张</span>
    </div>
    <div class="view-tools">
      <div class="seg" role="group" aria-label="视图模式">
        <button class="seg-btn" type="button" data-act="mode" data-mode="lanes" aria-pressed="${ui.mode === 'lanes'}">分组</button>
        <button class="seg-btn" type="button" data-act="mode" data-mode="table" aria-pressed="${ui.mode === 'table'}">表格</button>
      </div>
      <label class="micro" for="role-filter">角色</label>
      <select class="select" id="role-filter" data-act="role-select">
        <option value="">全部</option>
        ${roles.map((r) => `<option value="${esc(r)}" ${ui.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>
      <label class="micro" for="sort-filter">排序</label>
      <select class="select" id="sort-filter" data-act="sort-select">
        ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select>
    </div>
  </div>`;

  if (!all.length) {
    return head + `<div class="empty">
      <div class="empty-title">还没有任务卡</div>
      <div class="empty-hint">平台启动后由 coordinator 创建任务卡、scheduler 分派给 agent。卡片出现在这里时，说明平台已经在跑流水线了。</div>
    </div>`;
  }

  const body = !list.length
    ? emptyState(
      '没有匹配的任务',
      '当前的状态 / 角色 / 关键词组合把全部任务卡都过滤掉了。上面站点图里的数字是全部任务卡的分布，不受筛选影响。',
      '<div class="empty-actions"><button class="btn" type="button" data-act="clear-filters">清除全部筛选</button></div>',
    )
    : ui.mode === 'table' ? tasksTable(list) : lanesView(list, all);

  return head + filterBar() + pipeBlock() + body;
}

function lanesView(list, all) {
  const groups = STATUS_ORDER
    .map((s) => ({ s, items: list.filter((t) => t.status === s) }))
    .filter((g) => g.items.length);
  const emptyStatuses = STATUS_ORDER.filter((s) => !all.some((t) => t.status === s));

  const lanes = groups.map((g) => `<section class="lane st-${g.s}" aria-label="${esc(g.s)} 分组">
    <div class="lane-gutter">
      <div class="lane-status"><i class="dotmark" style="background:var(--st)" aria-hidden="true"></i><span class="name">${esc(g.s)}</span></div>
      <div class="lane-count">${g.items.length}<small>张 · ${esc(STATUS_ZH[g.s] || '')}</small></div>
    </div>
    <div class="lane-body">${g.items.map(taskCard).join('')}</div>
  </section>`).join('');

  return `<div class="lanes" role="list">${lanes}</div>
    ${emptyStatuses.length ? `<p class="lanes-foot dim2">其余 ${emptyStatuses.length} 个状态当前为空：${emptyStatuses.map((s) => `<span class="mono">${esc(s)}</span>`).join(' · ')}</p>` : ''}`;
}

/* --- 详情面板 ------------------------------------------------------------- */
function panelShell(task) {
  const tabs = [['verdict', '裁决', (task.review_records || []).length], ['submission', '提交', (task.submission && task.submission.files ? task.submission.files.length : 0)],
    ['timeline', '时间线', (task.history || []).length], ['context', '上下文包', '']];
  return `<div class="panel-head">
    <div class="panel-head-top">
      <div class="panel-id"><span class="id">${esc(task.task_id)}</span>${statusPill(task.status, 'pill-lg')}</div>
      <button class="icon-btn" type="button" data-act="close-panel" aria-label="关闭详情（Esc）">
        <svg class="ico" aria-hidden="true"><use href="#i-x" /></svg>
      </button>
    </div>
    <h2 class="panel-title">${esc(task.title)}</h2>
    <div class="panel-meta">
      <span><span class="micro">role</span> <span class="mono">${esc(task.role)}</span></span>
      <span><span class="micro">by</span> <span class="mono">${esc(task.created_by || '—')}</span></span>
      <span><span class="micro">更新</span> <span title="${esc(abs(task.updated_at))}">${esc(rel(task.updated_at))}</span></span>
      <span><span class="micro">context</span> <span class="mono">${esc(task.context_level || '—')}</span></span>
      <span><span class="micro">estimate</span> <span class="mono">${esc(task.estimate || '—')}</span></span>
    </div>
    <div class="panel-rail">${railHtml(task.status, true)}<span class="micro">${esc(task.status)} · ${OFF_TRACK.has(task.status) ? '轨道外' : `${PIPE.indexOf(task.status) + 1}/${PIPE.length}`}</span></div>
  </div>
  <div class="panel-tabs" role="tablist" aria-label="详情分区">
    ${tabs.map(([id, label, n]) => `<button class="tab" type="button" role="tab" id="tab-${id}"
      aria-selected="${ui.tab === id}" aria-controls="panel-body" tabindex="${ui.tab === id ? 0 : -1}"
      data-act="panel-tab" data-tab="${id}">${label}${n ? `<span class="num">${n}</span>` : ''}</button>`).join('')}
  </div>`;
}

function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd class="${mono ? 'mono' : ''} ${v ? '' : 'empty-val'}">${v || '—'}</dd>`).join('')}</dl>`;
}

function evidenceBlock(text, label = 'evidence') {
  if (!text) return `<p class="dim2" style="font-size:11px">（无 ${esc(label)}）</p>`;
  return longText(text, 'evidence');
}

function renderVerdictTab(task) {
  const reviews = task.review_records || [];
  const latest = reviews.length ? reviews[reviews.length - 1] : null;
  const acceptance = task.acceptance || [];
  const criteria = reviews.flatMap((r) => (r.criteria || []).map((c) => ({ ...c, review: r })));
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const used = new Set();

  const match = (text) => {
    const target = norm(text);
    let hit = criteria.find((c, i) => !used.has(i) && norm(c.criterion) === target);
    if (!hit) hit = criteria.find((c, i) => !used.has(i) && (norm(c.criterion).includes(target) || target.includes(norm(c.criterion))));
    if (hit) used.add(criteria.indexOf(hit));
    return hit || null;
  };

  const chain = acceptance.map((text) => {
    const hit = match(text);
    const pass = hit ? (hit.pass ? 'true' : 'false') : 'null';
    const glyph = hit ? (hit.pass ? '✓' : '✕') : '?';
    return `<div class="chain-item" data-pass="${pass}">
      <div class="chain-mark"><span class="glyph" aria-hidden="true">${glyph}</span><span class="wire"></span></div>
      <div class="chain-body">
        <div class="chain-crit">${esc(text)}</div>
        <div class="chain-verdict">
          <span class="verdict">${hit ? (hit.pass ? 'PASS' : 'FAIL') : '未裁决'}</span>
          ${hit
            ? `<span>${esc(hit.review.review_id)} · ${esc(hit.review.reviewer_agent || '')}${hit.review.independent ? ' · 独立审查' : ''}</span>`
            : '<span>没有审查记录明确对应这条验收标准</span>'}
        </div>
        ${hit ? evidenceBlock(hit.evidence) : '<p class="dim2" style="font-size:11px">验收标准未在审查 criteria 中出现，只能等平台裁决。</p>'}
      </div>
    </div>`;
  }).join('');

  const extra = criteria.filter((c, i) => !used.has(i));
  const extraHtml = extra.length ? `<div class="sec-head" style="margin-top:14px"><h3 class="sec-title"><span class="n">01b</span>审查额外项</h3><span class="sec-note">验收标准之外的检查</span></div>
    <div class="chain">${extra.map((c) => `<div class="chain-item" data-pass="${c.pass ? 'true' : 'false'}">
      <div class="chain-mark"><span class="glyph" aria-hidden="true">${c.pass ? '✓' : '✕'}</span><span class="wire"></span></div>
      <div class="chain-body">
        <div class="chain-crit">${esc(c.criterion)}</div>
        <div class="chain-verdict"><span class="verdict">${c.pass ? 'PASS' : 'FAIL'}</span><span>${esc(c.review.review_id)}</span></div>
        ${evidenceBlock(c.evidence)}
      </div>
    </div>`).join('')}</div>` : '';

  const sc = task.scope_check || { ok: true, out_of_scope: [], files: [], checked: false };
  const scPill = !sc.checked
    ? '<span class="pill st-draft"><i class="dotmark" aria-hidden="true"></i>未复核</span>'
    : sc.ok
      ? '<span class="pill st-merged"><i class="dotmark" aria-hidden="true"></i>干净</span>'
      : '<span class="pill st-rejected"><i class="dotmark" aria-hidden="true"></i>越界</span>';
  const scNote = !sc.checked
    ? '平台未返回 scope 复核结果（checked = false）。常见原因：任务分支已合并或已清理，或任务尚未提交。合并门禁的实际结果以下方合并记录中的 stripped 为准。'
    : sc.ok
      ? `复核通过：diff 内 ${sc.files.length} 个文件全部落在 scope.write 内。`
      : `复核未通过：${sc.out_of_scope.length} 个文件越界。`;

  const merge = task.merge;
  const mergeRows = merge
    ? [
      ['合并提交', `<span class="mono">${esc(merge.merge_commit || '—')}</span>`],
      ['提交提交', `<span class="mono">${esc(merge.commit || '—')}</span>`],
      ['模式', `<span class="mono">${esc(merge.mode || '—')}</span>${merge.mode === 'strip' ? ' <span class="tag-broken">文件被剥离</span>' : ''}`],
      ['剥离文件', (merge.stripped || []).length ? (merge.stripped || []).map((f) => `<span class="mono">${esc(f)}</span>`).join('<br />') : '无'],
      ['合入文件', `${(merge.files || []).length} 个`],
      ['合并会话', `<span class="mono">${esc(merge.session_id || '—')}</span>`],
      ['合并时间', `<span title="${esc(abs(merge.merged_at))}">${esc(abs(merge.merged_at))}</span>`],
    ]
    : [];

  const reviewNotes = latest ? `
    <div class="sec-head" style="margin-top:14px"><h3 class="sec-title"><span class="n">04</span>审查记录</h3>
      <span class="sec-note">${reviews.length} 条 · 最新 ${esc(latest.review_id)}</span></div>
    ${reviews.map((r) => `<div style="padding:8px 0;border-top:1px solid var(--line-soft)">
      <div class="chain-verdict" style="margin:0 0 5px">
        <span class="verdict" style="color:${r.verdict === 'approved' ? 'var(--s-merged)' : 'var(--s-rejected)'}">${esc(r.verdict)}</span>
        <span class="mono">${esc(r.review_id)}</span>
        <span>审查者 ${esc(r.reviewer_agent || '—')} / ${esc(r.reviewer_session || '—')}</span>
        <span>实现者 ${esc(r.implementer_agent || '—')}</span>
        <span>${r.independent ? '独立' : '非独立'}</span>
        <span>strip 合并 ${r.allow_strip_merge ? '允许' : '不允许'}</span>
      </div>
      ${evidenceBlock(r.notes, 'notes')}
    </div>`).join('')}` : '';

  return `
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>验收标准 × 审查裁决</h3>
      <span class="sec-note">${acceptance.length} 条验收 · ${criteria.length} 条审查项</span></div>
    ${acceptance.length ? `<div class="chain">${chain}</div>` : '<p class="dim">这张任务卡没有验收标准。</p>'}
    ${extraHtml}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">02</span>scope 终审</h3>${scPill}</div>
    <p style="font-size:11.5px;color:var(--ink-3);margin-bottom:8px">${esc(scNote)}</p>
    ${kv([
      ['越界文件', (sc.out_of_scope || []).length ? (sc.out_of_scope || []).map((f) => `<span class="mono" style="color:var(--s-rejected)">${esc(f)}</span>`).join('<br />') : '无'],
      ['复核文件', (sc.files || []).length ? (sc.files || []).map((f) => `<span class="mono">${esc(f)}</span>`).join('<br />') : '—'],
      ['write scope', (task.scope && task.scope.write && task.scope.write.length) ? task.scope.write.map((f) => `<span class="mono">${esc(f)}</span>`).join('<br />') : '—'],
      ['read scope', (task.scope && task.scope.read && task.scope.read.length) ? task.scope.read.map((f) => `<span class="mono">${esc(f)}</span>`).join('<br />') : '—'],
    ])}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">03</span>合并裁决</h3>
      <span class="sec-note">${merge ? '已合并' : '未合并'}</span></div>
    ${merge ? kv(mergeRows) : '<p class="dim">这张卡还没有合并记录。</p>'}
  </section>
  <section class="sec">${reviewNotes || '<div class="sec-head"><h3 class="sec-title"><span class="n">04</span>审查记录</h3></div><p class="dim">还没有审查记录。</p>'}</section>`;
}

function renderSubmissionTab(task) {
  const sub = task.submission;
  if (!sub) {
    return `<section class="sec"><div class="sec-head"><h3 class="sec-title"><span class="n">01</span>提交</h3></div>
      <p class="dim">还没有提交。agent 在沙箱里 commit 到 <span class="mono">${esc(task.branch || '—')}</span> 后调用 <span class="mono">hub.submit</span>，这里才会出现提交内容。</p></section>`;
  }
  const files = sub.files || [];
  return `
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>提交</h3><span class="sec-note">${files.length} 个文件</span></div>
    ${kv([
      ['commit', `<span class="mono">${esc(sub.commit || '—')}</span>`],
      ['branch', `<span class="mono">${esc(sub.branch || task.branch || '—')}</span>`],
      ['session', `<span class="mono">${esc(sub.session_id || '—')}</span>`],
      ['提交时间', `<span title="${esc(abs(sub.submitted_at))}">${esc(abs(sub.submitted_at))}</span>`],
      ['基线', `<span class="mono">${esc(shortSha(task.base_commit, 12))}</span> → <span class="mono">${esc(shortSha(sub.commit, 12))}</span>`],
      ['worktree', `<span class="mono">${esc(task.worktree || '—')}</span>`],
    ])}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">02</span>本次提交的 diff 文件清单</h3></div>
    <ul class="filelist">${files.map((f) => `<li><span class="mark" aria-hidden="true">M</span><span>${esc(f)}</span></li>`).join('')}</ul>
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">03</span>提交说明</h3></div>
    ${longText(sub.summary || '', 'note-block')}
  </section>`;
}

function sessionRow(s, current) {
  const a = age(s.last_heartbeat_at);
  return `<div class="sess-row st-${esc(s.status)}" style="${current ? 'background:var(--raised)' : ''}">
    <div>
      <div class="sess-id">${esc(s.session_id)} <span class="mono dim2">${esc(s.agent_id || '')}</span></div>
      <div class="sess-sub">
        <span>${esc(s.role)}</span>
        ${s.task ? `<button class="linklike mono" type="button" data-act="open-task" data-task="${esc(s.task)}">${esc(s.task)}</button>` : '<span class="dim2">无任务</span>'}
        <span class="dim2">${esc(s.lifespan || '')}</span>
        <span class="${a.stale ? 'dim2' : 'dim'}" title="${esc(abs(s.last_heartbeat_at))}">心跳 ${esc(a.text)}</span>
        ${s.pid ? `<span class="mono dim2">pid ${esc(s.pid)} · ${s.alive ? '存活' : '已退出'}</span>` : '<span class="dim2">无 pid</span>'}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${statusPill(s.status)}
      <button class="btn" data-kind="ghost" type="button" data-act="open-log" data-s="${esc(s.session_id)}">日志</button>
    </div>
  </div>`;
}

function renderTimelineTab(task) {
  const history = task.history || [];
  const sessions = task.sessions || [];
  const openLog = store.logs.get(ui.logFor || '');
  const logBlock = ui.logFor && store.logs.has(ui.logFor)
    ? `<div class="log-box"><div class="log-head"><span class="log-path">${esc(ui.logFor)}</span>
        <button class="btn" data-kind="ghost" type="button" data-act="open-log" data-s="${esc(ui.logFor)}">重新载入</button></div>
        <pre class="log" tabindex="0" aria-label="日志尾部">${esc((openLog && openLog.log) || '（空日志）')}</pre></div>`
    : (ui.logFor ? `<div class="log-box"><div class="log-box loading">${loadingBlock(2)}</div></div>` : '');

  return `
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>状态历史</h3><span class="sec-note">${history.length} 次变迁</span></div>
    ${history.length ? `<div class="timeline">${history.map((h) => `<div class="tl-item">
      <div class="tl-time" title="${esc(abs(h.at))}">${esc(mmdd(h.at))}</div>
      <div class="tl-main">
        <div class="tl-move">
          ${h.from ? statusPill(h.from) : '<span class="dim2 mono">∅</span>'}
          <span class="arrow" aria-hidden="true">→</span>
          ${statusPill(h.to)}
        </div>
        ${h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}
        <div class="tl-by">by ${esc(h.by || '—')}</div>
      </div>
    </div>`).join('')}</div>` : '<p class="dim">没有状态变迁记录。</p>'}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">02</span>相关会话</h3><span class="sec-note">${sessions.length} 个</span></div>
    ${sessions.length ? sessions.map((s) => sessionRow(s, ui.logFor === s.session_id)).join('') : '<p class="dim">没有关联会话。</p>'}
    ${logBlock}
    <p class="dim2" style="font-size:11px;margin-top:8px">日志只取尾部 200 行；完整文件路径见「会话」页。</p>
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">03</span>任务卡原始字段</h3></div>
    ${kv([
      ['task_id', `<span class="mono">${esc(task.task_id)}</span>`],
      ['branch', `<span class="mono">${esc(task.branch || '—')}</span>`],
      ['base', `<span class="mono">${esc(task.base_commit || '—')}</span>`],
      ['claimed_by', `<span class="mono">${esc(task.claimed_by || '—')}</span>`],
      ['context', `<span class="mono">${esc(task.context_package || '—')}</span>`],
      ['depends_on', (task.depends_on || []).length ? (task.depends_on || []).map((d) => `<span class="mono">${esc(d)}</span>`).join('<br />') : '无'],
      ['blocked', task.blocked_reason ? esc(task.blocked_reason) : '无'],
    ])}
  </section>`;
}

function renderContextTab(task) {
  const md = store.contexts.get(task.task_id);
  const err = store.errors.get(`ctx:${task.task_id}`);
  if (err) {
    return `<section class="sec"><div class="sec-head"><h3 class="sec-title"><span class="n">01</span>上下文包</h3></div>
      ${errorBlock(`ctx:${task.task_id}`, err, '上下文包')}</section>`;
  }
  if (md === undefined || md === null) {
    return `<section class="sec"><div class="sec-head"><h3 class="sec-title"><span class="n">01</span>上下文包</h3></div>${loadingBlock(6)}</section>`;
  }
  return `<section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>上下文包原文</h3><span class="sec-note mono">${esc(task.context_package || '')}</span></div>
    ${md ? `<div class="md">${mdRender(md)}</div>` : '<p class="dim">平台没有为这张卡生成上下文包。</p>'}
  </section>`;
}

function renderPanel() {
  const panel = $('#panel');
  const ws = $('#workspace');
  if (!panel || !ws) return;
  if (!ui.task) {
    panel.hidden = true;
    panel.innerHTML = '';
    ws.classList.remove('has-panel');
    return;
  }
  ws.classList.add('has-panel');
  panel.hidden = false;

  const task = store.tasksById.get(ui.task);
  if (!task) {
    const err = store.errors.get(`task:${ui.task}`);
    panel.innerHTML = `<div class="panel-head"><div class="panel-head-top">
        <div class="panel-id"><span class="id">${esc(ui.task)}</span></div>
        <button class="icon-btn" type="button" data-act="close-panel" aria-label="关闭"><svg class="ico" aria-hidden="true"><use href="#i-x" /></svg></button>
      </div></div>
      <div class="panel-body">${err ? errorBlock(`task:${ui.task}`, err, '任务详情') : loadingBlock(6)}</div>`;
    return;
  }

  const body = ui.tab === 'submission' ? renderSubmissionTab(task)
    : ui.tab === 'timeline' ? renderTimelineTab(task)
      : ui.tab === 'context' ? renderContextTab(task)
        : renderVerdictTab(task);

  panel.innerHTML = panelShell(task) +
    `<div class="panel-body" id="panel-body" role="tabpanel" tabindex="0" aria-labelledby="tab-${ui.tab}">${body}</div>`;

  // 按需拉取（错误态由 errorBlock 呈现，避免无限重试）
  const ctxKey = `ctx:${task.task_id}`;
  if (ui.tab === 'context' && !store.contexts.has(task.task_id) && !store.errors.has(ctxKey)) {
    loadContext(task.task_id).then(() => renderPanel()).catch(() => renderPanel());
  }
  if (ui.tab === 'timeline' && ui.logFor) {
    const logKey = `log:${ui.logFor}`;
    if (!store.logs.has(ui.logFor) && !store.errors.has(logKey)) {
      loadLog(ui.logFor).then(() => renderPanel()).catch(() => renderPanel());
    }
  }
}

/** 当前选中的会话；没选过就优先挑有进程的会话（daemon 会话通常没有落盘日志）。 */
function currentSession(list) {
  const all = store.sessions || [];
  const pool = list && list.length ? list : all;
  const hit = pool.find((s) => s.session_id === ui.s);
  if (hit) return hit;
  return pool.find((s) => s.pid) || pool[0] || null;
}

/* --- 视图：会话 ----------------------------------------------------------- */
function renderSessions() {
  if (!store.sessions) {
    const err = store.errors.get('sessions');
    return err ? errorBlock('sessions', err, '会话') : loadingBlock(5);
  }
  const q = ui.q.trim().toLowerCase();
  const all = store.sessions;
  const list = all.filter((s) => {
    if (ui.aliveOnly && !s.alive) return false;
    if (!q) return true;
    return [s.session_id, s.agent_id, s.role, s.task, s.status, s.sandbox].join(' ').toLowerCase().includes(q);
  });
  const alive = all.filter((s) => s.alive).length;
  const selected = currentSession(list);

  const head = `<div class="view-head">
    <div class="view-title"><h1>会话</h1>
      <span class="count">${all.length} 个 · 进程存活 ${alive} 个 · 显示 ${list.length}</span></div>
    <div class="view-tools">
      <div class="seg" role="group" aria-label="过滤">
        <button class="seg-btn" type="button" data-act="alive" data-alive="false" aria-pressed="${!ui.aliveOnly}">全部</button>
        <button class="seg-btn" type="button" data-act="alive" data-alive="true" aria-pressed="${ui.aliveOnly}">仅存活</button>
      </div>
    </div>
  </div>`;

  if (!all.length) return head + emptyState('还没有会话', '平台启动 agent 后会创建 P-Session，这里显示每个进程的身份、沙箱与心跳。');
  if (!list.length) return head + emptyState('没有匹配的会话', '换个关键词，或切回「全部」。');

  const rows = list.map((s) => {
    const a = age(s.last_heartbeat_at);
    const cur = selected && s.session_id === selected.session_id;
    return `<button class="sess-item st-${esc(s.status)} ${cur ? 'is-sel' : ''}" type="button"
      data-act="select-session" data-s="${esc(s.session_id)}" aria-current="${cur ? 'true' : 'false'}">
      <span class="sess-item-top">
        <span class="sess-id">${esc(s.session_id)}</span>
        ${statusPill(s.status)}
        ${s.alive ? '<span class="alive-dot" title="进程存活" aria-label="进程存活"></span>' : '<span class="dim2" style="font-size:10px">无进程</span>'}
      </span>
      <span class="sess-item-row"><span class="k">role</span><span class="mono">${esc(s.role)}</span><span class="k">agent</span><span class="mono">${esc(s.agent_id)}</span></span>
      <span class="sess-item-row"><span class="k">task</span><span class="mono">${esc(s.task || '—')}</span><span class="k">心跳</span><span class="${a.stale ? 'dim2' : ''}" title="${esc(abs(s.last_heartbeat_at))}">${esc(a.text)}</span></span>
    </button>`;
  }).join('');

  return head + `<div class="split">
    <div class="split-left" role="list" aria-label="会话列表">${rows}</div>
    <div class="split-right">${renderLogPane(selected)}</div>
  </div>`;
}

function renderLogPane(s) {
  if (!s) return emptyState('未选择会话', '左侧点一个会话查看日志尾部。');
  const entry = store.logs.get(s.session_id);
  const err = store.errors.get(`log:${s.session_id}`);  const a = age(s.last_heartbeat_at);
  const head = `<div class="logpane-head">
    <div>
      <div class="logpane-id">${esc(s.session_id)} ${statusPill(s.status)} ${s.alive ? '<span class="alive-dot" aria-label="进程存活"></span>' : ''}</div>
      <div class="sess-sub" style="margin-top:3px">
        <span class="mono">${esc(s.agent_id)}</span><span>${esc(s.role)}</span>
        <span>${esc(s.lifespan || '')}</span>
        ${s.pid ? `<span class="mono dim2">pid ${esc(s.pid)}</span>` : ''}
        <span title="${esc(abs(s.last_heartbeat_at))}">心跳 ${esc(a.text)}</span>
        ${s.task ? `<button class="linklike mono" type="button" data-act="open-task" data-task="${esc(s.task)}">${esc(s.task)}</button>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn" data-kind="ghost" type="button" data-act="reload-log" data-s="${esc(s.session_id)}">重载日志</button>
    </div>
  </div>
  <div class="logpane-meta"><span class="log-path" title="${attr(s.log)}">${esc(s.log || '（无日志路径）')}</span></div>`;

  let body;
  if (err) body = errorBlock(`log:${s.session_id}`, err, '日志');
  else if (!entry) body = `<div class="log-box loading">${loadingBlock(4)}</div>`;
  else if (entry.missing) body = `<div class="log-empty">这个会话没有日志文件。daemon 会话不落盘，或日志已被清理——会话的 pid / 心跳 / 状态仍然有效。</div>`;
  else if (!entry.log.trim()) body = `<div class="log-empty">日志文件是空的。会话还没写过东西。</div>`;
  else body = `<pre class="log log-full" id="log-pre" tabindex="0" aria-label="会话 ${esc(s.session_id)} 的日志尾部">${esc(entry.log)}</pre>`;

  return head + `<div class="logpane-body">${body}</div>`;
}

/* --- 视图：审计 ----------------------------------------------------------- */
function renderAudit() {
  const at = store.audit;
  if (!at) {
    const err = store.errors.get('audit');
    return err ? errorBlock('audit', err, '审计') : loadingBlock(5);
  }
  const doc = store.docs.get(ui.doc);
  const docErr = store.errors.get(`doc:${ui.doc}`);

  const head = `<div class="view-head">
    <div class="view-title"><h1>审计</h1>
      <span class="count">${at.violations.length} 异常 · ${at.merges.length} 合并 · ${at.reviews.length} 审查 · ${at.events.length} 事件</span></div>
    <div class="view-tools"><span class="micro">平台产出，detect-only</span></div>
  </div>`;

  const tab = ui.atab;
  const bodyLeft = tab === 'violations' ? violationsList(at.violations)
    : tab === 'merges' ? mergesList(at.merges)
      : tab === 'reviews' ? reviewsList(at.reviews)
        : eventsList(at.events);

  const docPane = docErr ? errorBlock(`doc:${ui.doc}`, docErr, '文档')
    : doc ? `<div class="md">${mdRender(doc)}</div>`
      : loadingBlock(6);

  return head + `<div class="audit-layout">
    <section class="audit-left" aria-label="审计记录">
      <div class="audit-left-head">
        <div class="seg" role="group" aria-label="审计分类">
          <button class="seg-btn" type="button" data-act="atab" data-atab="violations" aria-pressed="${tab === 'violations'}">异常<span class="num">${at.violations.length}</span></button>
          <button class="seg-btn" type="button" data-act="atab" data-atab="merges" aria-pressed="${tab === 'merges'}">合并<span class="num">${at.merges.length}</span></button>
          <button class="seg-btn" type="button" data-act="atab" data-atab="reviews" aria-pressed="${tab === 'reviews'}">审查<span class="num">${at.reviews.length}</span></button>
          <button class="seg-btn" type="button" data-act="atab" data-atab="events" aria-pressed="${tab === 'events'}">事件<span class="num">${at.events.length}</span></button>
        </div>
      </div>
      <div class="audit-left-body">${bodyLeft}</div>
    </section>
    <section class="audit-right" aria-label="文档阅读">
      <div class="audit-right-head">
        <div class="seg" role="group" aria-label="文档">
          <button class="seg-btn" type="button" data-act="doc" data-doc="digest" aria-pressed="${ui.doc === 'digest'}">digest</button>
          <button class="seg-btn" type="button" data-act="doc" data-doc="decisions" aria-pressed="${ui.doc === 'decisions'}">decisions.md</button>
          <button class="seg-btn" type="button" data-act="doc" data-doc="protocol" aria-pressed="${ui.doc === 'protocol'}">protocol</button>
        </div>
      </div>
      <div class="audit-right-body">${docPane}</div>
    </section>
  </div>`;
}

function violationsList(list) {
  if (!list.length) return emptyState('没有审计异常', 'platform 的 sentinel 没发现越界、drift 或 scope 违规。');
  return `<div class="vlist">${list.slice().reverse().map((v) => `<div class="vrow" data-sev="${esc(v.severity)}">
    <div class="vrow-head">
      <span class="sev" data-sev="${esc(v.severity)}">${esc(v.severity)}</span>
      <span class="vkind">${esc(v.kind)}</span>
      <span class="chip">${esc(v.violation_id)}</span>
    </div>
    <div class="vdetail">${esc(v.detail)}</div>
    <div class="vmeta">
      <span title="${esc(abs(v.at))}">${esc(abs(v.at))}</span>
      ${v.task_id ? `<button type="button" data-act="open-task" data-task="${esc(v.task_id)}">${esc(v.task_id)}</button>` : '<span>无任务</span>'}
      ${v.session_id ? `<span>${esc(v.session_id)}</span>` : ''}
      ${v.agent_id ? `<span>${esc(v.agent_id)}</span>` : ''}
      <span>notified ${v.notified ? 'true' : 'false'}</span>
    </div>
    ${v.evidence && Object.keys(v.evidence).length ? `<div class="evidence-mini">${esc(JSON.stringify(v.evidence, null, 2))}</div>` : ''}
  </div>`).join('')}</div>`;
}
function mergesList(list) {
  if (!list.length) return emptyState('还没有合并', '任务经审查通过后由 integrator 执行 scope 终审合并，这里记录每次合入。');
  return `<div class="vlist">${list.slice().reverse().map((m) => `<div class="vrow" data-sev="info">
    <div class="vrow-head">
      <span class="vkind">${esc(m.mode || 'merge')}</span>
      ${m.task_id ? `<button class="linklike mono" type="button" data-act="open-task" data-task="${esc(m.task_id)}">${esc(m.task_id)}</button>` : ''}
      <span class="chip">${esc(shortSha(m.merge_commit, 12))}</span>
    </div>
    <div class="vdetail"><span class="mono">${esc(m.branch || '')}</span> → 主分支</div>
    <div class="vmeta">
      <span title="${esc(abs(m.at))}">${esc(abs(m.at))}</span>
      <span>${esc((m.files || []).length)} 个文件</span>
      ${(m.stripped || []).length ? `<span style="color:var(--s-rejected)">剥离 ${esc((m.stripped || []).length)}</span>` : '<span>未剥离</span>'}
      <span>${esc(m.actor || '')}</span>
      ${m.review_id ? `<span>${esc(m.review_id)}</span>` : ''}
    </div>
    ${(m.files || []).length ? `<div class="evidence-mini">${esc((m.files || []).join('\n'))}</div>` : ''}
  </div>`).join('')}</div>`;
}
function reviewsList(list) {
  if (!list.length) return emptyState('还没有审查', 'supervisor 对提交给出 verdict 后，审查记录出现在这里。');
  return `<div class="vlist">${list.slice().reverse().map((r) => `<div class="vrow" data-sev="${r.verdict === 'approved' ? 'info' : 'high'}">
    <div class="vrow-head">
      <span class="vkind" style="color:${r.verdict === 'approved' ? 'var(--s-merged)' : 'var(--s-rejected)'}">${esc(r.verdict)}</span>
      <span class="chip">${esc(r.review_id)}</span>
      ${r.task_id ? `<button class="linklike mono" type="button" data-act="open-task" data-task="${esc(r.task_id)}">${esc(r.task_id)}</button>` : ''}
    </div>
    <div class="vdetail">${esc(r.reviewer_agent || '—')} 审 ${esc(r.implementer_agent || '—')} · ${(r.criteria || []).length} 条 criteria · ${r.independent ? '独立' : '非独立'}</div>
    <div class="vmeta"><span title="${esc(abs(r.at))}">${esc(abs(r.at))}</span><span>by ${esc(r.reviewer_session || '')}</span>
      <span>strip ${r.allow_strip_merge ? '允许' : '不允许'}</span></div>
    ${(r.criteria || []).length ? `<div class="evidence-mini">${esc((r.criteria || []).map((c) => `${c.pass ? '[PASS]' : '[FAIL]'} ${c.criterion}`).join('\n'))}</div>` : ''}
  </div>`).join('')}</div>`;
}
function eventsList(list) {
  if (!list.length) return emptyState('没有事件', '平台内核的每次动作都会落 audit 事件。');
  return `<div class="events">${list.slice().reverse().map((e) => {
    const who = e.agent_id || e.from || e.session_id || '';
    const extra = [e.role, e.to_role, e.thread, e.type, e.task_id, e.kind, e.severity].filter(Boolean).join(' · ');
    return `<div class="ev"><div class="ev-t" title="${esc(abs(e.at))}">${esc(mmdd(e.at))}</div>
      <div class="ev-n">${esc(e.event)}${who ? ` <span class="who">${esc(who)}</span>` : ''}${extra ? ` <span class="who">${esc(extra)}</span>` : ''}</div></div>`;
  }).join('')}</div>`;
}

/* --- 视图：消息 ----------------------------------------------------------- */
function renderMessages() {
  if (!store.messages) {
    const err = store.errors.get('messages');
    return err ? errorBlock('messages', err, '消息') : loadingBlock(5);
  }
  const { messages, dead } = store.messages;
  const all = messages || [];
  const threads = Array.from(new Set(all.map((m) => m.thread).filter(Boolean)));
  const q = ui.q.trim().toLowerCase();

  const inThread = (m) => !ui.thread || m.thread === ui.thread || (m.thread === '*' && ui.thread !== '*');
  const list = all.filter((m) => {
    if (!inThread(m)) return false;
    if (!q) return true;
    return [m.msg_id, m.type, m.body, m.from && m.from.agent, m.from && m.from.role, m.to && m.to.role, m.thread]
      .join(' ').toLowerCase().includes(q);
  });
  const queued = list.filter((m) => m.resolved == null).length;

  const head = `<div class="view-head">
    <div class="view-title"><h1>消息</h1>
      <span class="count">${list.length} 条 · 排队中 ${queued} 条 · 死信 ${(dead || []).length} 条</span></div>
    <div class="view-tools"><span class="micro">角色线程寻址 · 只读</span></div>
  </div>`;

  const threadBar = `<div class="thread-bar">
    <div class="seg" role="group" aria-label="按线程过滤">
      <button class="seg-btn" type="button" data-act="thread" data-thread="" aria-pressed="${!ui.thread}">全部 <span class="num">${all.length}</span></button>
      ${threads.map((t) => {
        const n = all.filter((m) => m.thread === t).length;
        const label = t === '*' ? '全局 *' : t;
        return `<button class="seg-btn" type="button" data-act="thread" data-thread="${esc(t)}" aria-pressed="${ui.thread === t}">${esc(label)} <span class="num">${n}</span></button>`;
      }).join('')}
    </div>
  </div>`;

  if (!all.length) return head + emptyState('消息总线是空的', 'agent 之间不发点对点消息，一切经 hub.send 走角色线程；这里会显示全部投递、读回与死信。');
  if (!list.length) return head + threadBar + emptyState('这条线程没有消息', '换一条线程，或清掉关键词。');

  const rows = list.slice().reverse().map((m) => {
    const resolved = m.resolved == null;
    const body = String(m.body || '');
    return `<article class="msg">
      <div class="msg-side">
        <div class="msg-time" title="${esc(abs(m.created_at))}">${esc(mmdd(m.created_at))}</div>
        <div class="msg-from">${esc(m.from && m.from.agent || '—')}<br /><span class="role">${esc(m.from && m.from.role || '')} · ${esc(m.from && m.from.session || '')}</span></div>
      </div>
      <div class="msg-body-wrap">
        <div class="msg-head">
          <span class="msg-type">${esc(m.type)}</span>
          <span class="msg-route">${esc(m.from && m.from.role || '?')}<span class="arrow" aria-hidden="true">→</span>${esc(m.to && m.to.role || '?')}<span class="dim2"> @${esc(m.thread)}</span></span>
          ${resolved
            ? `<span class="badge-queued">排队中（角色空缺）</span>`
            : `<span class="badge-queued badge-ok">已解决</span>`}
          ${m.attachments && m.attachments.length ? `<span class="chip">附件 ${m.attachments.length}</span>` : ''}
        </div>
        ${longText(body, 'msg-body')}
        <div class="msg-foot">
          <span>${esc(m.msg_id)}</span>
          <span class="dim2">TTL 至 ${esc(mmdd(m.expires_at))}</span>
          ${resolved ? '<span class="state-queued">未读 · 等目标角色上线认领</span>' : `<span>已读 ${esc(m.read_by || '')} ${esc(mmdd(m.read_at))}</span>`}
        </div>
      </div>
    </article>`;
  }).join('');

  const deadHtml = `<section class="deadsec">
    <div class="sec-head"><h3 class="sec-title">死信</h3><span class="sec-note">${(dead || []).length} 条 · 无角色认领且已过期的投递</span></div>
    ${(dead || []).length ? (dead || []).map((d) => `<div class="vrow" data-sev="high">
      <div class="vrow-head"><span class="vkind">${esc(d.type || d.msg_id || '死信')}</span><span class="chip">${esc(d.msg_id || '')}</span></div>
      <div class="vdetail">${esc(d.reason || d.body || '')}</div>
      <div class="vmeta"><span>${esc(abs(d.at || d.created_at))}</span><span>${esc(d.thread || '')}</span></div>
    </div>`).join('') : '<p class="dim">没有死信。消息都有落点。</p>'}
  </section>`;

  return head + threadBar + `<div class="msg-list">${rows}</div>` + deadHtml;
}

/* --- 视图：Agent --------------------------------------------------------- */
function renderAgents() {
  if (!store.overview) {
    const err = store.errors.get('overview');
    return err ? errorBlock('overview', err, 'Agent 注册表') : loadingBlock(5);
  }
  const agents = store.overview.agents || [];
  const q = ui.q.trim().toLowerCase();
  const list = agents.filter((a) => !q || [a.agent_id, a.display_name, a.kind, ...(a.capabilities || []), a.mcp_inject, a.transport]
    .join(' ').toLowerCase().includes(q));
  const enabled = agents.filter((a) => a.enabled).length;

  const head = `<div class="view-head">
    <div class="view-title"><h1>Agent 注册表</h1>
      <span class="count">${agents.length} 个 · 启用 ${enabled} 个 · 显示 ${list.length}</span></div>
    <div class="view-tools"><span class="micro">能力决定角色 · 通道决定注入方式</span></div>
  </div>`;

  if (!agents.length) return head + emptyState('没有注册的 agent', '用 mesh agent add 把 CLI agent 注册进平台，它才能被拉起干活。');
  if (!list.length) return head + emptyState('没有匹配的 agent', '清掉关键词再试。');

  const rows = list.map((a) => `<tr class="${a.enabled ? '' : 'row-disabled'}">
    <td class="c-id">${esc(a.agent_id)}</td>
    <td class="c-title">${esc(a.display_name)}</td>
    <td class="c-mono">${esc(a.kind)}</td>
    <td>${a.enabled
      ? '<span class="pill st-merged"><i class="dotmark" aria-hidden="true"></i>启用</span>'
      : '<span class="pill st-draft"><i class="dotmark" aria-hidden="true"></i>停用</span>'}</td>
    <td><div class="cap-list">${(a.capabilities || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div></td>
    <td class="c-num">${esc(a.concurrency)}</td>
    <td class="c-mono">${esc(a.transport)}</td>
    <td class="c-mono">${esc(a.mcp_inject)}</td>
    <td class="notes">${esc(a.notes || '')}</td>
  </tr>`).join('');

  return head + `<div class="tbl-wrap"><table class="tbl">
    <caption class="sr-only">Agent 注册表</caption>
    <thead><tr>
      <th scope="col">ID</th><th scope="col">名称</th><th scope="col">kind</th><th scope="col">状态</th>
      <th scope="col">capabilities</th><th scope="col">并发</th><th scope="col">通道</th><th scope="col">注入</th><th scope="col">备注</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* --- 渲染主循环 ----------------------------------------------------------- */
let lastView = '';
let lastTab = '';
let lastTask = '';

function render(opts = {}) {
  const { reset = false } = opts;
  const route = parseHash();
  syncUiFromRoute(route);
  const view = route.view;

  // 记录焦点与面板滚动位置：重绘后尽量还原，避免键盘用户丢失位置
  const active = document.activeElement;
  const focusId = active && active.id ? active.id : '';
  const panelBody = $('#panel-body');
  const panelScroll = panelBody ? panelBody.scrollTop : 0;
  const tabChanged = lastTab !== ui.tab || lastTask !== ui.task;

  // 导航 / 搜索 / 标题
  $$('.nav-link').forEach((a) => {
    const on = a.dataset.nav === view;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const qEl = $('#q');
  if (qEl && document.activeElement !== qEl) qEl.value = ui.q;
  if (qEl) qEl.placeholder = SEARCH_PH[view] || '搜索…';
  document.title = `${VIEW_TITLE[view]} · AgentMesh 观察台`;

  renderStrip();

  const host = $('#view');
  if (!host) return;
  const html = view === 'overview' ? renderOverview()
    : view === 'board' ? renderBoard()
      : view === 'sessions' ? renderSessions()
        : view === 'audit' ? renderAudit()
          : view === 'messages' ? renderMessages()
            : renderAgents();

  const scroller = $('#view-scroll');
  host.innerHTML = html;
  if (view !== lastView || reset) scroller.scrollTop = 0;

  renderPanel();
  const newPanelBody = $('#panel-body');
  if (newPanelBody) newPanelBody.scrollTop = tabChanged ? 0 : panelScroll;

  lastView = view;
  lastTab = ui.tab;
  lastTask = ui.task;

  // 焦点还原（搜索框不参与重绘，天然保留）
  if (focusId && document.activeElement !== document.getElementById(focusId)) {
    const el = document.getElementById(focusId);
    if (el && el.focus) el.focus({ preventScroll: true });
  }

  // 拉取缺失数据（渲染会再进来一次）
  ensureViewData(view).then((changed) => { if (changed) render({ reset: false }); });

  if (ui.task && !store.tasksById.has(ui.task) && !store.errors.has(`task:${ui.task}`)) {
    loadTask(ui.task).then(() => renderPanel()).catch(() => renderPanel());
  }
  if (view === 'sessions') {
    const sel = currentSession(null);
    const key = sel ? `log:${sel.session_id}` : '';
    if (sel && !store.logs.has(sel.session_id) && !store.errors.has(key)) {
      loadLog(sel.session_id).then(() => { if (ui.view === 'sessions') render({ reset: false }); }).catch(() => render({ reset: false }));
    }
  }
  if (view === 'audit' && !store.docs.has(ui.doc) && !store.errors.has(`doc:${ui.doc}`)) {
    loadDoc(ui.doc).then(() => { if (ui.view === 'audit') render({ reset: false }); }).catch(() => render({ reset: false }));
  }

  // 日志自动滚到底
  const pre = $('#log-pre');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

/** 按视图决定要拉什么；返回是否有数据被补上。 */
async function ensureViewData(view) {
  const need = [];
  const missing = (k) => store[k] == null && !store.errors.get(k);
  if (view === 'overview') { if (missing('overview')) need.push('overview'); }
  if (view === 'board') { if (missing('overview')) need.push('overview'); if (missing('tasks')) need.push('tasks'); }
  if (view === 'sessions') { if (missing('sessions')) need.push('sessions'); }
  if (view === 'audit') { if (missing('audit')) need.push('audit'); }
  if (view === 'messages') { if (missing('messages')) need.push('messages'); }
  if (view === 'agents') { if (missing('overview')) need.push('overview'); }
  if (!need.length) return false;
  let ok = false;
  await Promise.all(need.map((k) => loaders[k]().then(() => { ok = true; }).catch(() => { ok = true; })));
  return ok;
}

/* --- 实时流 --------------------------------------------------------------- */
let stream = null;
let pollTimer = 0;
let reconnectTimer = 0;

function connectStream() {
  if (stream) { stream.close(); stream = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  setLive('connecting', '连接中');
  try {
    stream = new EventSource('/api/stream');
  } catch {
    degradeToPolling();
    return;
  }
  stream.onopen = () => {
    store.stream = 'live';
    setLive('live', '实时');
    stopPolling();
  };
  stream.onmessage = (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { return; }
    store.stream = 'live';
    setLive('live', '实时');
    const prev = store.overview && store.overview.counts ? JSON.stringify(store.overview.counts) : '';
    const liveChanged = store.live !== data.live;
    store.live = typeof data.live === 'number' ? data.live : null;
    store.countsAt = data.counts || null;
    store.countsAt = data.counts || null;
    if (store.overview) {
      const next = JSON.stringify(data.counts || {});
      if (prev !== next) {
        store.overview.counts = data.counts;
        renderStrip();
        scheduleReload();
      } else if (liveChanged) {
        renderStrip();
      }
    } else {
      renderStrip();
    }
  };
  stream.onerror = () => { degradeToPolling(); };
}

function degradeToPolling() {
  if (store.stream === 'poll') return;
  store.stream = 'poll';
  setLive('poll', '轮询');
  if (stream) { stream.close(); stream = null; }
  renderStrip();
  startPolling();
  // 20 秒后尝试恢复实时
  reconnectTimer = setTimeout(() => { connectStream(); }, 20000);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const ov = await api('/api/overview');
      store.overview = ov;
      store.errors.delete('overview');
      store.live = (ov.live_sessions || []).length;
      renderStrip();
      if (ui.view === 'overview' || ui.view === 'agents') render({ reset: false });
      else if (ui.view === 'board') { store.tasks = null; render({ reset: false }); }
    } catch { /* 保持轮询，界面已提示降级 */ }
  }, 8000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

let reloadTimer = 0;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    store.tasks = null;
    store.audit = null;
    if (['board', 'overview', 'agents', 'audit'].includes(ui.view)) render({ reset: false });
  }, 1200);
}

/* --- 交互 ----------------------------------------------------------------- */
function bind() {
  // 导航
  document.addEventListener('click', (ev) => {
    const nav = ev.target.closest('.nav-link');
    if (nav) { ev.preventDefault(); go(nav.dataset.nav); return; }

    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'filter-status') {
      update({ status: el.dataset.status || '' }, { reset: false });
    } else if (act === 'filter-role') {
      update({ role: el.dataset.role || '' }, { reset: false });
    } else if (act === 'filter-q') {
      update({ q: '' }, { reset: false });
      const q = $('#q'); if (q) q.value = '';
    } else if (act === 'clear-filters') {
      update({ status: '', role: '', q: '' }, { reset: false });
      const q = $('#q'); if (q) q.value = '';
    } else if (act === 'nav') {
      const patch = {};
      if (el.dataset.atab) patch.atab = el.dataset.atab;
      go(el.dataset.view, patch);
    } else if (act === 'mode') {
      update({ mode: el.dataset.mode }, { reset: false });
    } else if (act === 'sort') {
      update({ sort: el.dataset.sort }, { reset: false });
    } else if (act === 'open-task') {
      ev.preventDefault();
      openTask(el.dataset.task);
    } else if (act === 'close-panel') {
      update({ task: '' }, { reset: false });
      const sc = $('#view-scroll'); if (sc) sc.focus({ preventScroll: true });
    } else if (act === 'retry') {
      const key = el.dataset.key;
      store.errors.delete(key);
      if (key.startsWith('task:')) store.tasksById.delete(key.slice(5));
      else if (key.startsWith('log:')) store.logs.delete(key.slice(4));
      else if (key.startsWith('ctx:')) store.contexts.delete(key.slice(4));
      else if (key.startsWith('doc:')) store.docs.delete(key.slice(4));
      else store[key] = null;
      render({ reset: false });
    } else if (act === 'expand') {
      const block = el.parentElement.querySelector('[data-full]');
      if (!block) return;
      const open = block.dataset.open === 'true';
      block.dataset.open = open ? 'false' : 'true';
      block.textContent = open ? block.dataset.short : block.dataset.full;
      el.textContent = open ? `展开全文 · ${block.dataset.full.length} 字符` : '收起';
    } else if (act === 'panel-tab') {
      update({ tab: el.dataset.tab }, { reset: false });
    } else if (act === 'atab') {
      update({ atab: el.dataset.atab }, { reset: false });
    } else if (act === 'doc') {
      update({ doc: el.dataset.doc }, { reset: false });
      loadDoc(el.dataset.doc).then(() => { if (ui.view === 'audit') render({ reset: false }); }).catch(() => render({ reset: false }));
    } else if (act === 'thread') {
      update({ thread: el.dataset.thread || '' }, { reset: false });
    } else if (act === 'alive') {
      ui.aliveOnly = el.dataset.alive === 'true';
      render({ reset: false });
    } else if (act === 'select-session') {
      update({ s: el.dataset.s }, { reset: false });
      loadLog(el.dataset.s).then(() => render({ reset: false })).catch(() => render({ reset: false }));
    } else if (act === 'reload-log') {
      store.logs.delete(el.dataset.s);
      render({ reset: false });
      loadLog(el.dataset.s).then(() => render({ reset: false })).catch(() => render({ reset: false }));
    } else if (act === 'open-log') {
      ui.logFor = ui.logFor === el.dataset.s ? '' : el.dataset.s;
      render({ reset: false });
      if (ui.logFor) loadLog(ui.logFor).then(() => render({ reset: false })).catch(() => {});
    } else if (act === 'help') {
      openHelp();
    } else if (act === 'close-help') {
      closeHelp();
    }
  });

  // select 控件
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'role-select') update({ role: el.value }, { reset: false });
    if (el.dataset.act === 'sort-select') update({ sort: el.value }, { reset: false });
  });

  // 搜索
  const qEl = $('#q');
  let qTimer = 0;
  if (qEl) {
    qEl.addEventListener('input', () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => update({ q: qEl.value }, { replace: true, reset: false }), 180);
    });
    qEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (qEl.value) { qEl.value = ''; update({ q: '' }, { reset: false }); }
        else qEl.blur();
      }
    });
  }

  // 刷新
  const btnRefresh = $('#btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      refresh(['overview', 'tasks', 'sessions', 'audit', 'messages']);
      store.tasksById.clear();
      store.logs.clear();
      store.docs.delete('digest');
      render({ reset: false });
    });
  }

  // 主题
  const btnTheme = $('#btn-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐私模式忽略 */ }
    });
  }

  // 面板页签左右键
  document.addEventListener('keydown', (ev) => {
    const tab = ev.target.closest && ev.target.closest('.panel-tabs [role="tab"]');
    if (!tab) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const tabs = $$('.panel-tabs [role="tab"]');
    const idx = tabs.indexOf(tab);
    const next = tabs[(idx + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next) { ev.preventDefault(); next.focus(); update({ tab: next.dataset.tab }, { reset: false }); }
  });

  // 全局快捷键
  let gPending = 0;
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    if (ev.key === 'Escape') {
      if (document.querySelector('.help[open]')) return; // 交给 dialog
      if (ui.task) { ev.preventDefault(); update({ task: '' }, { reset: false }); return; }
      if (ui.status || ui.role || ui.q) {
        update({ status: '', role: '', q: '' }, { reset: false });
        return;
      }
      if (typing && t.blur) t.blur();
      return;
    }
    if (typing) return;

    if (ev.key === '/') {
      ev.preventDefault();
      const q = $('#q');
      if (q) { q.focus(); q.select(); }
      return;
    }
    if (ev.key === '?') { ev.preventDefault(); openHelp(); return; }
    if (ev.key === 'g') { gPending = Date.now(); return; }
    if (gPending && Date.now() - gPending < 1200) {
      const map = { b: 'board', s: 'sessions', a: 'audit', m: 'messages', o: 'overview', g: 'agents' };
      const dest = map[ev.key];
      if (dest) { ev.preventDefault(); gPending = 0; go(dest); return; }
    }
    if (ev.key === 't' && ui.view === 'board') {
      ev.preventDefault();
      update({ mode: ui.mode === 'lanes' ? 'table' : 'lanes' }, { reset: false });
    }
  });

  window.addEventListener('hashchange', () => render({ reset: true }));

  // 面板关闭按钮之外的 Esc 已在全局处理
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.stream === 'poll') connectStream();
  });
}

function openTask(id) {
  if (!id) return;
  Object.assign(ui, { task: id, tab: 'verdict', logFor: '' });
  setHash(true);
  render({ reset: false });
  loadTask(id).then(() => { if (ui.task === id) renderPanel(); }).catch(() => renderPanel());
  const panel = $('#panel');
  if (panel) { const body = $('#panel-body'); if (body) body.scrollTop = 0; }
}

function openHelp() {
  const dlg = $('#help');
  if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
}
function closeHelp() {
  const dlg = $('#help');
  if (dlg && dlg.open) dlg.close();
}

/* --- 启动 ----------------------------------------------------------------- */
function boot() {
  let theme = 'dark';
  try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* ignore */ }
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';

  if (!location.hash) history.replaceState(null, '', '#/board');
  bind();
  render({ reset: true });
  connectStream();

  // 顶栏坐标：项目 / 主分支 / 基线
  loaders.overview().then((ov) => {
    const p = $('#tb-project'); if (p) p.textContent = ov.project;
    const b = $('#tb-branch'); if (b) b.textContent = ov.main_branch;
    const base = $('#tb-base'); if (base) base.textContent = shortSha(ov.base_commit, 8);
    const fp = $('#foot-project'); if (fp) fp.textContent = ov.project;
    const flags = $('#tb-flags');
    if (flags) {
      const c = ov.config || {};
      flags.innerHTML = `<span class="flag" data-on="${c.auto_review ? 'true' : 'false'}"><i class="dotmark" aria-hidden="true"></i>review</span>
        <span class="flag" data-on="${c.auto_integrate ? 'true' : 'false'}"><i class="dotmark" aria-hidden="true"></i>integrate</span>`;
    }
    render({ reset: false });
  }).catch(() => { render({ reset: false }); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

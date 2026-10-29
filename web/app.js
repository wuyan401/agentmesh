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
  // mission 状态机（V2）。只用于 tooltip / 副标题，不进 STATUS_ORDER，所以不影响看板与总览。
  intake: '已接单', planning: '拆解中', executing: '执行中', integrating: '整合中',
  final_review: '二次验收', completed: '已完成',
};
const VIEWS = ['overview', 'missions', 'board', 'sessions', 'audit', 'messages', 'agents'];
const VIEW_TITLE = { overview: '总览', missions: '任务单', board: '看板', sessions: '会话', audit: '审计', messages: '消息', agents: 'Agent' };
const SEARCH_PH = {
  overview: '搜索任务…', missions: '搜索 mission / 标题 / lead…', board: '搜索 id / 标题 / 角色 / scope / 人…',
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
  /** missions: { list: [], history: '.mesh/HISTORY.md', history_exists: bool } | null */
  missions: null,
  missionDetail: new Map(),
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
  missions: () => once('missions', async () => {
    const r = await api('/api/missions');
    store.missions = {
      list: dedupeMissions(r.missions || []),
      history: r.history || '',
      history_exists: !!r.history_exists,
    };
    return store.missions;
  }),
};

/**
 * `/api/missions` 会返回重复条目：`listFiles()` 是递归的，于是
 * `.mesh/missions/<id>/tasks.json` 也被当成一张 mission 卡读了出来，同一个
 * mission_id 出现两次 —— 一份来自 `<id>.json`（teammates 是字符串数组），
 * 一份来自 `tasks.json`（teammates 是 buildTeammates 的对象数组）。
 * 接口不改（只读约定），前端按 mission_id 去重，优先留 teammates 干净的那份。
 */
function dedupeMissions(list) {
  const byId = new Map();
  for (const m of list) {
    if (!m || !m.mission_id) continue;
    const clean = Array.isArray(m.teammates) && m.teammates.every((t) => typeof t === 'string');
    const prev = byId.get(m.mission_id);
    if (!prev || (clean && !prev.clean)) byId.set(m.mission_id, { card: m, clean });
  }
  return Array.from(byId.values())
    .map((x) => x.card)
    .sort((a, b) => ts(b.created_at) - ts(a.created_at) || String(b.mission_id).localeCompare(String(a.mission_id)));
}

function loadMission(id) {
  if (!id) return Promise.resolve(null);
  if (store.missionDetail.has(id)) return Promise.resolve(store.missionDetail.get(id));
  return once(`mission:${id}`, async () => {
    const d = await api(`/api/missions/${encodeURIComponent(id)}`);
    store.missionDetail.set(id, d);
    return d;
  });
}

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
  return { overview: '总览', tasks: '任务', sessions: '会话', audit: '审计', messages: '消息', missions: 'mission' }[k] || k;
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

/** 可展开的长文本块（evidence / 提交说明 / 消息正文 / 画像维度）。
 *  limit 可由调用方给：窄格子（九维画像）截得比正文早，但展开的是同一份全文。 */
function longText(text, cls = 'evidence', limit = 460) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return `<p class="${cls} dim2">（无内容）</p>`;
  const t = shortText(s, limit);
  return `<p class="${cls}" data-short="${esc(t.text)}" data-full="${esc(s)}">${esc(t.text)}</p>
    ${t.more ? `<button class="evidence-toggle" type="button" data-act="expand">展开全文 · ${s.length} 字符</button>` : ''}`;
}

/* --- 空值条款 -------------------------------------------------------------
   这个界面的规矩：空不是空白，也不是 undefined。
   任何「后端没给这一项」的位置都写一句人话，并把原因留在 title 里 ——
   空格子让人以为界面坏了，一句「无 / 还没有 / 未填（字段为空）」才是实话。 */
function hasText(v) { return v != null && String(v).trim() !== ''; }
function none(word = '无', why = '') {
  return `<span class="none"${why ? ` title="${attr(why)}"` : ''}>${esc(word)}</span>`;
}
/** 数组 → 渲染；空数组也走 none()，绝不吐出一段空 HTML。 */
function listOrNone(arr, render, word = '无', why = '') {
  const list = (Array.isArray(arr) ? arr : []).filter((x) => hasText(x));
  return list.length ? render(list) : none(word, why);
}
/** 代码路径清单（scope 写/读、文件列表）：等宽小片，长路径可断行。 */
function codeChips(arr) {
  return (Array.isArray(arr) ? arr : []).map((f) => `<span class="mono codechip">${esc(f)}</span>`).join('');
}
function lineCount(s) {
  const t = String(s == null ? '' : s);
  if (!t) return 0;
  return t.replace(/\r\n?/g, '\n').split('\n').length;
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
  /** mission 子路径：`#/missions/M-000001` 里的 M-000001（只对 missions 视图有意义） */
  mission: '', mfail: false,
};

/**
 * 路由：`#/<view>[/<sub>][?query]`。
 * 子路径目前只有 missions 用（`#/missions/M-000001`）；其它视图的第二段一律忽略，
 * 这样 `#/board?task=T-000001&tab=verdict` 这类查询式视图的行为一个字节都没变。
 */
function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [rawPath, qs] = raw.split('?');
  const segs = String(rawPath || '').split('/').filter(Boolean);
  const view = VIEWS.includes(segs[0]) ? segs[0] : 'board';
  let sub = '';
  if (view === 'missions' && segs[1]) {
    try { sub = decodeURIComponent(segs[1]); } catch { sub = segs[1]; }
  }
  return { view, sub, params: new URLSearchParams(qs || '') };
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
  ui.mission = route.sub || '';
  ui.mfail = p.get('fail') === '1';
}

function currentParams() {
  const p = new URLSearchParams();
  const put = (k, v) => { if (v) p.set(k, v); };
  put('q', ui.q.trim());
  if (ui.view === 'missions') put('fail', ui.mfail ? '1' : '');
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

/** 当前 UI 状态对应的 hash（view + 可选子路径 + 查询串）。 */
function hashFor() {
  const sub = ui.view === 'missions' && ui.mission ? `/${encodeURIComponent(ui.mission)}` : '';
  const qs = currentParams();
  return `#/${ui.view}${sub}${qs ? `?${qs}` : ''}`;
}

function setHash(replace = false) {
  const hash = hashFor();
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
  const next = { view, ...patch, task: patch.task || '', mission: patch.mission || '' };
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
      <span><span class="micro">role</span> <span class="mono">${esc(task.role || '—')}</span></span>
      <span><span class="micro">实现者</span> ${hasText(task.implementer_agent)
        ? `<span class="mono">${esc(task.implementer_agent)}</span>`
        : none('未记录', 'implementer_agent 为空：这张卡还没被谁领取并实现')}</span>
      <span><span class="micro">认领</span> ${hasText(task.claimed_by)
        ? `<span class="mono" title="${attr(`claimed_by = ${task.claimed_by}`)}">${esc(task.claimed_by)}</span>`
        : none('无', 'claimed_by 为空')}</span>
      ${Number(task.rejection_count) ? `<span class="tag-broken">打回 ${esc(String(task.rejection_count))} 次</span>` : ''}
      <span><span class="micro">开卡</span> <span class="mono">${esc(task.created_by || '—')}</span></span>
      <span><span class="micro">更新</span> <span title="${attr(abs(task.updated_at))}">${esc(rel(task.updated_at))}</span></span>
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
    ${reviews.map((r) => {
    const crits = (r.criteria || []).map(critOf);
    const passN = crits.filter((c) => c.ok === true).length;
    const failN = crits.filter((c) => c.ok === false).length;
    return `<div style="padding:8px 0;border-top:1px solid var(--line-soft)">
      <div class="chain-verdict" style="margin:0 0 5px">
        <span class="verdict" style="color:${r.verdict === 'approved' ? 'var(--s-merged)' : 'var(--s-rejected)'}">${esc(r.verdict || '无结论')}</span>
        <span class="mono">${esc(r.review_id || '—')}</span>
        <span>审查者 <span class="mono">${esc(r.reviewer_agent || '—')}</span> / ${esc(r.reviewer_session || '—')}</span>
        <span>审的是 <span class="mono">${esc(r.implementer_agent || '—')}</span> 的提交</span>
        <span>${crits.length ? `${crits.length} 条 criteria · ${passN} PASS / ${failN} FAIL` : none('无逐条 criteria', '这次审查只给了判词，没有留下逐条 criteria')}</span>
        <span>${r.independent ? '独立审查' : '非独立（自审）'}</span>
        <span>strip 合并 ${r.allow_strip_merge ? '允许' : '不允许'}</span>
        <span title="${attr(abs(r.at))}">${esc(mmdd(r.at))}</span>
      </div>
      ${crits.length ? `<ul class="crit-sum">${crits.map((c) => `<li data-pass="${c.ok === true ? 'true' : c.ok === false ? 'false' : 'null'}"><span class="glyph" aria-hidden="true">${c.ok === true ? '✓' : c.ok === false ? '✕' : '?'}</span><span>${esc(c.text || '（条款文字为空）')}</span></li>`).join('')}</ul>` : ''}
      ${evidenceBlock(r.notes, 'notes')}
    </div>`;
  }).join('')}` : '';

  // 打回：`rejected_by` 记的是「被打回时这张卡的实现者」（调度器据此在重派时避开他），
  // `rejection_count` 是这张卡被打回的次数。两样都是真字段，空也要说清楚。
  const rejCount = Number(task.rejection_count) || 0;
  const rejectedBy = Array.isArray(task.rejected_by) ? task.rejected_by.filter(hasText) : [];

  return `
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>验收标准 × 审查裁决</h3>
      <span class="sec-note">${acceptance.length} 条验收 · ${criteria.length} 条审查项</span></div>
    ${acceptance.length ? `<div class="chain">${chain}</div>` : '<p class="dim">这张任务卡没有验收标准。</p>'}
    ${extraHtml}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01b</span>打回记录</h3>
      <span class="sec-note">${rejCount ? `被打回 ${esc(String(rejCount))} 次` : '一次都没被打回'}</span></div>
    ${kv([
      ['打回次数', rejCount ? `<strong style="color:var(--s-rejected)">${esc(String(rejCount))}</strong>` : none('0 次 · 无打回', 'rejection_count = 0')],
      ['被打回的实现者', rejectedBy.length
        ? rejectedBy.map((a) => `<span class="mono">${esc(a)}</span>`).join('<br />')
        : none('无', 'rejected_by 为空：这张卡没有因打回而换过人')],
      ['说明', '<span style="font-size:11px;color:var(--ink-3)">被打回时记下当时的实现者，平台重派时会避开他（reassign_after_rejections）。</span>'],
    ])}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">02</span>scope 终审</h3>${scPill}</div>
    <p style="font-size:11.5px;color:var(--ink-3);margin-bottom:8px">${esc(scNote)}</p>
    ${kv([
      ['越界文件', (sc.out_of_scope || []).length ? (sc.out_of_scope || []).map((f) => `<span class="mono" style="color:var(--s-rejected)">${esc(f)}</span>`).join('<br />') : none('无', 'out_of_scope 为空')],
      ['复核文件', (sc.files || []).length ? (sc.files || []).map((f) => `<span class="mono">${esc(f)}</span>`).join('<br />') : none('未复核', 'scope_check.files 为空（卡片还没提交或分支已清理）')],
    ])}
    <div class="scope-pair">
      <div class="scope-row"><span class="micro">写 scope</span><span class="scope-vals">${listOrNone(task.scope && task.scope.write, codeChips, '无（这张卡不授权写任何文件）', 'scope.write 为空')}</span></div>
      <div class="scope-row"><span class="micro">读 scope</span><span class="scope-vals">${listOrNone(task.scope && task.scope.read, codeChips, '无（没有声明额外只读文件）', 'scope.read 为空')}</span></div>
    </div>
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
  const write = Array.isArray(task.scope && task.scope.write) ? task.scope.write : [];
  const read = Array.isArray(task.scope && task.scope.read) ? task.scope.read : [];
  const scopeBlock = `<section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">02</span>本卡授权范围</h3>
      <span class="sec-note">写 ${write.length} 路径 · 读 ${read.length} 路径</span></div>
    <div class="scope-pair">
      <div class="scope-row"><span class="micro">写 scope</span><span class="scope-vals">${listOrNone(write, codeChips, '无（这张卡不授权写任何文件）', 'scope.write 为空')}</span></div>
      <div class="scope-row"><span class="micro">读 scope</span><span class="scope-vals">${listOrNone(read, codeChips, '无（没有声明额外只读文件）', 'scope.read 为空')}</span></div>
    </div>
  </section>`;

  if (!sub) {
    return `<section class="sec"><div class="sec-head"><h3 class="sec-title"><span class="n">01</span>提交</h3>
        <span class="sec-note">还没有提交</span></div>
      <p class="dim">还没有提交。agent 在沙箱里 commit 到 <span class="mono">${esc(task.branch || '—')}</span> 后调用 <span class="mono">hub.submit</span>，这里才会出现提交内容。</p>
      ${kv([
      ['实现者', hasText(task.implementer_agent) ? `<span class="mono">${esc(task.implementer_agent)}</span>` : none('未记录', 'implementer_agent 为空')],
      ['认领会话', hasText(task.claimed_by) ? `<span class="mono">${esc(task.claimed_by)}</span>` : none('无', 'claimed_by 为空')],
      ['分支', `<span class="mono">${esc(task.branch || '—')}</span>`],
    ])}
    </section>${scopeBlock}`;
  }
  const files = sub.files || [];
  const summary = String(sub.summary || '');
  return `
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">01</span>提交</h3><span class="sec-note">${files.length} 个文件</span></div>
    ${kv([
      ['实现者', hasText(task.implementer_agent) ? `<span class="mono">${esc(task.implementer_agent)}</span>` : none('未记录', 'implementer_agent 为空')],
      ['认领会话', hasText(task.claimed_by) ? `<span class="mono">${esc(task.claimed_by)}</span>` : none('无', 'claimed_by 为空')],
      ['提交会话', hasText(sub.session_id) ? `<span class="mono">${esc(sub.session_id)}</span>` : none('未记录', 'submission.session_id 为空')],
      ['commit', hasText(sub.commit) ? `<span class="mono">${esc(sub.commit)}</span>` : none('无', 'submission.commit 为空')],
      ['branch', `<span class="mono">${esc(sub.branch || task.branch || '—')}</span>`],
      ['提交时间', hasText(sub.submitted_at) ? `<span title="${attr(abs(sub.submitted_at))}">${esc(abs(sub.submitted_at))}</span>` : none('未记录', 'submission.submitted_at 为空')],
      ['基线', `<span class="mono">${esc(shortSha(task.base_commit, 12))}</span> → <span class="mono">${esc(shortSha(sub.commit, 12))}</span>`],
      ['worktree', `<span class="mono">${esc(task.worktree || '—')}</span>`],
    ])}
  </section>
  ${scopeBlock}
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">03</span>本次提交的 diff 文件清单</h3>
      <span class="sec-note">${files.length ? `${files.length} 个` : '空'}</span></div>
    ${files.length
      ? `<ul class="filelist">${files.map((f) => `<li><span class="mark" aria-hidden="true">M</span><span>${esc(f)}</span></li>`).join('')}</ul>`
      : `<p class="dim">提交里没有列出文件（submission.files 为空）。</p>`}
  </section>
  <section class="sec">
    <div class="sec-head"><h3 class="sec-title"><span class="n">04</span>提交说明</h3>
      <span class="sec-note">${summary.trim() ? `${esc(String(summary.length))} 字符 · ${esc(String(lineCount(summary)))} 行` : '空'}</span></div>
    ${summary.trim() ? longText(summary, 'note-block') : `<p class="dim">这次提交没有写说明（submission.summary 为空）。</p>`}
  </section>`;
}

/**
 * 面板里的会话行。
 * 注意两处返回的 sessions[] 形状不同：
 *   /api/sessions → {lifespan, last_heartbeat_at, pid, alive, task, log}
 *   mission / task 详情 → {session_id, agent_id, role, status, created_at?, exit?}
 * 之前这里只按前者的字段读，于是详情页每个会话都写着「心跳 无心跳」、
 * 「无任务」—— 不是空，是错配。这里两种形状都认，谁的字段在就报谁。
 */
function sessionRow(s, current) {
  const hb = hasText(s.last_heartbeat_at) ? age(s.last_heartbeat_at) : null;
  const exit = s.exit && typeof s.exit === 'object' ? s.exit : null;
  const bits = [];
  if (hasText(s.created_at)) {
    bits.push(`<span class="dim" title="${attr(`建会话：${abs(s.created_at)}`)}">建于 ${esc(mmdd(s.created_at))}</span>`);
  }
  if (hb) {
    bits.push(`<span class="${hb.stale ? 'dim2' : 'dim'}" title="${attr(`最后心跳：${abs(s.last_heartbeat_at)}`)}">心跳 ${esc(hb.text)}</span>`);
  }
  if (exit) {
    const code = exit.code == null ? '—' : String(exit.code);
    bits.push(`<span class="dim" title="${attr(`退出：${abs(exit.at)}${hasText(exit.note) ? ` · ${exit.note}` : ''}`)}">退出 code ${esc(code)}${hasText(exit.at) ? ` · ${esc(mmdd(exit.at))}` : ''}${hasText(exit.note) ? ` · ${esc(exit.note)}` : ''}</span>`);
  }
  if (hasText(s.lifespan)) bits.push(`<span class="dim2">${esc(s.lifespan)}</span>`);
  if (s.pid) bits.push(`<span class="mono dim2">pid ${esc(s.pid)} · ${s.alive ? '存活' : '已退出'}</span>`);
  if (hasText(s.task)) {
    bits.push(`<button class="linklike mono" type="button" data-act="open-task" data-task="${esc(s.task)}">${esc(s.task)}</button>`);
  }
  if (!bits.length) {
    bits.push(none('时间字段未返回', '这张卡的 sessions[] 只含 session_id / agent_id / role / status；created_at 与 exit 在 mission 详情的 tasks[].sessions 里（mission 卡片上已摊开显示）'));
  }
  return `<div class="sess-row st-${esc(s.status)}" data-row-s="${esc(s.session_id)}" style="${current ? 'background:var(--raised)' : ''}">
    <div>
      <div class="sess-id">${esc(s.session_id)} <span class="mono dim2">${esc(s.agent_id || '—')}</span></div>
      <div class="sess-sub"><span>${esc(s.role || '未标角色')}</span>${bits.join('')}</div>
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
    <div class="sec-head"><h3 class="sec-title"><span class="n">03</span>任务卡原始字段</h3>
      <span class="sec-note">id / 归属 / 范围</span></div>
    ${kv([
      ['task_id', `<span class="mono">${esc(task.task_id)}</span>`],
      ['实现者', hasText(task.implementer_agent) ? `<span class="mono">${esc(task.implementer_agent)}</span>` : none('未记录', 'implementer_agent 为空')],
      ['claimed_by', hasText(task.claimed_by) ? `<span class="mono">${esc(task.claimed_by)}</span>` : none('无', 'claimed_by 为空')],
      ['打回', Number(task.rejection_count)
        ? `<span style="color:var(--s-rejected)">${esc(String(task.rejection_count))} 次</span> · 涉及 ${listOrNone(task.rejected_by, (l) => l.map((a) => `<span class="mono">${esc(a)}</span>`).join('、'), '无', 'rejected_by 为空')}`
        : none('无打回', 'rejection_count = 0')],
      ['上级 mission', hasText(task.parent)
        ? `<a class="linklike mono" href="#/missions/${encodeURIComponent(task.parent)}">${esc(task.parent)}</a>`
        : none('无（独立卡）', 'parent 为空：这张卡不属于任何 mission')],
      ['branch', `<span class="mono">${esc(task.branch || '—')}</span>`],
      ['base', `<span class="mono">${esc(task.base_commit || '—')}</span>`],
      ['context', `<span class="mono">${esc(task.context_package || '—')}</span>`],
      ['depends_on', (task.depends_on || []).length ? (task.depends_on || []).map((d) => `<span class="mono">${esc(d)}</span>`).join('<br />') : none('无依赖', 'depends_on 为空')],
      ['blocked', hasText(task.blocked_reason) ? esc(task.blocked_reason) : none('无', 'blocked_reason 为空')],
      ['tags', (task.tags || []).length ? (task.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(' ') : none('无标签', 'tags 为空')],
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
  // 面板每次都是整块重建（panel.innerHTML = …），旧 #panel-body 连同滚动位置一起没了。
  // render() 里虽然会复原一次，但 renderPanel() 也会被异步加载单独调用（loadLog /
  // loadContext 的 .then），那条路径没人复原，于是点「日志」展开后面板跳回顶部。
  // 所以复原要落在 renderPanel() 自己身上：谁重建，谁负责把位置还回去。
  const prevBody = $('#panel-body');
  const prevScroll = prevBody ? prevBody.scrollTop : 0;
  // 焦点同理：异步加载（上下文包 / 日志）会再进来重建一次面板，重建后焦点掉到 body，
  // 于是「← → 换页签」按一下就断（第一次能换，第二次没人接着）。谁重建，谁负责还焦点。
  const prevFocus = document.activeElement;
  const prevTabId = prevFocus && prevFocus.closest && prevFocus.closest('.panel-tabs [role="tab"]') ? prevFocus.id : '';
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

  // 把位置还回去（内容变高时浏览器会自己夹住，不会越界）。
  const nextBody = $('#panel-body');
  if (nextBody && prevScroll > 0) nextBody.scrollTop = prevScroll;
  // 页签焦点也还回去（preventScroll 保证不跟上面的滚动复原打架）。
  if (prevTabId) {
    const tabEl = document.getElementById(prevTabId);
    if (tabEl && tabEl.focus && document.activeElement !== tabEl) tabEl.focus({ preventScroll: true });
  }

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
/** 互评的四个维度：后端 scores 的键 → 中文。未知键原样显示，不吞数据。 */
const PEER_DIMS = [
  ['quality', '质量'], ['cooperation', '协作'], ['evidence', '证据'], ['speed', '速度'],
];
const PEER_ZH = new Map(PEER_DIMS);
/** 九个维度的兜底顺序不走前端翻译：label 一律用后端 dimensions[].label。 */

function agentHay(a) {
  const p = a.profile || {};
  return [
    a.agent_id, a.display_name, a.kind, a.mcp_inject, a.transport, a.notes,
    ...(a.capabilities || []),
    p.personality, p.capability_notes, p.speed_notes,
    ...(p.strengths || []), ...(p.weaknesses || []), ...(p.specialties || []),
    ...(p.peer_reviews || []).map((r) => [r.by_agent, r.comment, r.mission_id, r.task_id].join(' ')),
  ].join(' ').toLowerCase();
}

/** 九维画像：后端给几条就画几行（正常是 9 条），label 与 value 成对渲染，绝不分开取。 */
function agentDims(dims) {
  if (!Array.isArray(dims) || !dims.length) {
    return `<p class="dim2" style="font-size:11.5px">后端没有返回 <span class="mono">dimensions[]</span>：这个 agent 的九维画像还没建立。</p>`;
  }
  const filled = dims.filter((d) => hasText(d && d.value)).length;
  return `<div class="dims-head">
      <span class="micro">九维画像</span>
      <span class="dims-fill">${esc(String(filled))}/${esc(String(dims.length))} 维已填</span>
    </div>
    <dl class="dims">${dims.map((d) => `<dt>${esc(d.label || d.key || '未命名维度')}</dt>
      <dd>${hasText(d.value)
      ? longText(d.value, 'dimval', 110)
      : none('未填', `后端维度 ${d.key || '?'} 的 value 为空：这个维度还没人写过`)}</dd>`).join('')}</dl>`;
}

/** 战绩：profile.stats（missions/tasks/approved/rejected/rounds）+ success_rate。
 *  success_rate 是 **agent 这一层**的字段（不是 profile 里的），别在 profile 上取。 */
function agentStats(a) {
  const s = (a.profile && a.profile.stats) || {};
  const cells = [
    ['missions', '带过 mission', s.missions],
    ['tasks', '任务卡', s.tasks],
    ['approved', '通过', s.approved],
    ['rejected', '打回', s.rejected],
    ['rounds', '轮次', s.rounds],
  ];
  const rate = a.success_rate;
  const hasRate = typeof rate === 'number' && Number.isFinite(rate);
  return `<div class="stats">
    ${cells.map(([key, label, n]) => {
    const v = Number(n) || 0;
    return `<span class="stat" title="profile.stats.${esc(key)} = ${esc(String(v))}"><span class="sk">${esc(label)}</span><span class="sv num" data-zero="${v ? 'false' : 'true'}">${esc(String(v))}</span></span>`;
  }).join('')}
    <span class="stat stat-rate" title="${hasRate ? 'success_rate = 通过 / (通过 + 打回)' : 'success_rate 为 null：还没有审查结论，算不出成功率'}">
      <span class="sk">成功率</span>
      ${hasRate
      ? `<span class="sv num">${esc(String(rate))}%</span><span class="ratebar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, rate))}%"></i></span>`
      : none('暂无', 'success_rate 为 null：还没有审查结论')}
    </span>
  </div>`;
}

/** 互评：谁给谁打的、四个维度分数、评论（长文可展开）、时间、关联 mission/task。 */
function agentPeerReviews(p, agentId) {
  const list = Array.isArray(p.peer_reviews) ? p.peer_reviews : [];
  const head = `<div class="dims-head"><span class="micro">互评</span>
    <span class="dims-fill">${list.length ? `${esc(String(list.length))} 条` : '还没有'}</span></div>`;
  if (!list.length) {
    return `${head}<p class="none" style="font-size:11.5px">还没有人给 ${esc(agentId)} 打过分（peer_reviews 为空）。</p>`;
  }
  const rows = list.slice().sort((a, b) => ts(b.at) - ts(a.at)).map((r) => {
    const scores = r.scores && typeof r.scores === 'object' ? r.scores : {};
    const known = PEER_DIMS.filter(([k]) => scores[k] !== undefined);
    const extra = Object.keys(scores).filter((k) => !PEER_ZH.has(k));
    const scoreCells = [
      ...known.map(([k, label]) => `<span class="score" title="scores.${esc(k)}"><span class="sc-k">${esc(label)}</span><span class="sc-v num">${esc(String(scores[k]))}</span></span>`),
      ...extra.map((k) => `<span class="score" title="scores.${esc(k)}（未登记的维度）"><span class="sc-k">${esc(k)}</span><span class="sc-v num">${esc(String(scores[k]))}</span></span>`),
    ].join('');
    return `<div class="peer">
      <div class="peer-head">
        <span class="peer-route"><span class="mono">${esc(r.by_agent || '未知评审人')}</span><span class="arrow" aria-hidden="true">→</span><span class="mono">${esc(agentId)}</span></span>
        ${hasText(r.at) ? `<span class="dim2 mono" title="${attr(abs(r.at))}">${esc(mmdd(r.at))}</span>` : none('时间未记录', 'peer_reviews[].at 为空')}
        ${hasText(r.mission_id) ? `<a class="linklike mono" href="#/missions/${encodeURIComponent(r.mission_id)}" title="关联 mission">${esc(r.mission_id)}</a>` : ''}
        ${hasText(r.task_id) ? `<a class="linklike mono" href="#/board?task=${encodeURIComponent(r.task_id)}" title="关联任务卡">${esc(r.task_id)}</a>` : ''}
      </div>
      ${scoreCells ? `<div class="scores">${scoreCells}</div>` : `<p class="none" style="font-size:11px">这条互评没有打分维度（scores 为空）。</p>`}
      ${hasText(r.comment)
        ? `<div class="peer-comment">${longText(r.comment, 'note-block', 180)}</div>`
        : `<p class="none" style="font-size:11px">这条互评没写评论（comment 为空）。</p>`}
    </div>`;
  }).join('');
  return `${head}<div class="peers">${rows}</div>`;
}

/** 单个 agent 的档案卡：身份 + 锁定 + 通道 + 能力 + 九维 + 战绩 + 互评。
 *  这张卡是自足的 —— 窄屏把上面的注册表收起来以后，档案卡单独也能说清「它是谁、能干什么」。 */
function agentDossier(a, dims) {
  const p = a.profile || {};
  const locked = p.manual_locked === true;
  const caps = Array.isArray(a.capabilities) ? a.capabilities.filter(hasText) : [];
  const filled = Array.isArray(dims) ? dims.filter((d) => hasText(d && d.value)).length : 0;
  return `<article class="dossier${a.enabled ? '' : ' is-off'}">
    <div class="ds-head">
      <span class="ds-id mono">${esc(a.agent_id)}</span>
      <span class="ds-name">${esc(a.display_name || '未命名 agent')}</span>
      <span class="chip">${esc(a.kind || '未标 kind')}</span>
      ${a.enabled
      ? '<span class="pill st-merged"><i class="dotmark" aria-hidden="true"></i>启用</span>'
      : '<span class="pill st-draft"><i class="dotmark" aria-hidden="true"></i>停用</span>'}
      ${locked
      ? `<span class="lock" title="人工锁定：这个 profile 被手动定住，互评只记录、不改质量分（manual_locked = true）。">人工锁定</span>`
      : ''}
      <span class="ds-fill" title="九维里有内容的维度数">${esc(String(filled))}/${esc(String(Array.isArray(dims) ? dims.length : 0))} 维</span>
    </div>
    <div class="ds-caps">${caps.length
      ? caps.map((c) => `<span class="chip">${esc(c)}</span>`).join('')
      : none('没有声明能力', 'capabilities 为空')}</div>
    ${filled ? '' : '<p class="ds-empty">这个 profile 还没有人写过画像：九维全空，也没有互评。下面是字段本身，空的地方如实标「未填」。</p>'}
    ${agentDims(dims)}
    ${agentStats(a)}
    ${agentPeerReviews(p, a.agent_id)}
    <div class="ds-foot micro">
      <span>通道 <span class="mono">${esc(a.transport || '未记录')}</span></span>
      <span>注入 <span class="mono">${esc(a.mcp_inject || '未记录')}</span></span>
      <span>并发 <span class="mono">${a.concurrency == null ? '未记录' : esc(String(a.concurrency))}</span></span>
      <span>画像更新 ${hasText(p.updated_at) ? `<span title="${attr(abs(p.updated_at))}">${esc(rel(p.updated_at))}</span>` : none('未记录', 'profile.updated_at 为空')}</span>
      <span>质量分 <span class="mono">${p.quality_score == null ? '未记录' : esc(String(p.quality_score))}</span></span>
      <span>成本档 <span class="mono">${p.cost_tier == null ? '未记录' : esc(String(p.cost_tier))}</span></span>
      <span>可靠度 <span class="mono">${p.reliability == null ? '未记录' : esc(String(p.reliability))}</span></span>
    </div>
    ${hasText(a.notes) ? `<p class="ds-note"><span class="micro">备注</span>${esc(a.notes)}</p>` : ''}
  </article>`;
}

function renderAgents() {
  if (!store.overview) {
    const err = store.errors.get('overview');
    return err ? errorBlock('overview', err, 'Agent 注册表') : loadingBlock(5);
  }
  const agents = store.overview.agents || [];
  const q = ui.q.trim().toLowerCase();
  const list = agents.filter((a) => !q || agentHay(a).includes(q));
  const enabled = agents.filter((a) => a.enabled).length;
  const locked = agents.filter((a) => a.profile && a.profile.manual_locked).length;
  // 「有画像」不数 quality_score 这种自动默认值，只数真被同事评过的（peer_reviews 非空）——
  // 否则 8 个 recipe 全算「有画像」，这个数字就没信息量了。
  const withPeer = agents.filter((a) => ((a.profile && a.profile.peer_reviews) || []).length).length;

  const head = `<div class="view-head">
    <div class="view-title"><h1>Agent 注册表</h1>
      <span class="count">${agents.length} 个 · 启用 ${enabled} 个 · 有互评 ${withPeer} 个${locked ? ` · 人工锁定 ${locked} 个` : ''} · 显示 ${list.length}</span></div>
    <div class="view-tools"><span class="micro">能力决定角色 · 通道决定注入方式</span></div>
  </div>`;

  if (!agents.length) return head + emptyState('没有注册的 agent', '用 mesh agent add 把 CLI agent 注册进平台，它才能被拉起干活。');
  if (!list.length) return head + emptyState('没有匹配的 agent', '清掉关键词再试 —— 搜索会扫 id / 名称 / 能力 / 画像文字 / 互评评论。');

  const rows = list.map((a) => `<tr class="${a.enabled ? '' : 'row-disabled'}">
    <td class="c-id">${esc(a.agent_id)}</td>
    <td class="c-title">${esc(a.display_name || '未命名')}</td>
    <td class="c-mono">${esc(a.kind || '—')}</td>
    <td>${a.enabled
      ? '<span class="pill st-merged"><i class="dotmark" aria-hidden="true"></i>启用</span>'
      : '<span class="pill st-draft"><i class="dotmark" aria-hidden="true"></i>停用</span>'}</td>
    <td><div class="cap-list">${(a.capabilities || []).length ? (a.capabilities || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('') : none('无能力声明', 'capabilities 为空')}</div></td>
    <td class="c-num">${esc(a.concurrency == null ? '—' : String(a.concurrency))}</td>
    <td class="c-mono">${esc(a.transport || '—')}</td>
    <td class="c-mono">${esc(a.mcp_inject || '—')}</td>
    <td class="notes" title="${attr(a.notes || '')}">${hasText(a.notes) ? esc(a.notes) : none('无备注', 'notes 为空')}</td>
  </tr>`).join('');

  return head + `<div class="tbl-wrap tbl-wrap-agents"><table class="tbl tbl-agents">
    <caption class="sr-only">Agent 注册表</caption>
    <thead><tr>
      <th scope="col">ID</th><th scope="col">名称</th><th scope="col">kind</th><th scope="col">状态</th>
      <th scope="col">capabilities</th><th scope="col">并发</th><th scope="col">通道</th><th scope="col">注入</th><th scope="col">备注</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <section class="msec" id="a-dossier" aria-labelledby="a-dossier-h">
    <div class="sec-head">
      <h2 class="sec-title" id="a-dossier-h"><span class="n">02</span>画像与战绩</h2>
      <span class="sec-note">九维能力画像 · 人工锁定 · 互评 · 自动统计（来自 profile / dimensions / success_rate）</span>
    </div>
    <div class="dossiers">${list.map((a) => agentDossier(a, a.dimensions)).join('')}</div>
  </section>`;
}

/* --- 视图：任务（mission）------------------------------------------------- */
/* 两级模型：mission（用户下发的活，有 lead / 验收 / 报告）⊃ 任务卡（卡上有审查与证据）。
   这两页只回答一个问题：这件事凭什么算做完了。 */

/** 时长：和 CLI 的 humanDuration 同一个口径（1m 06s），不另造一套。 */
function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const total = Math.round(n / 1000);
  if (total < 1) return `${Math.round(n)}ms`;
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${pad2(total % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad2(m % 60)}m`;
}
function hms(iso) {
  const t = ts(iso);
  if (!t) return '—';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function dayKey(iso) {
  const t = ts(iso);
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dayLabel(iso) {
  const t = ts(iso);
  if (!t) return '时间未知';
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 周${'日一二三四五六'[d.getDay()]}`;
}
/** 建单 → 报告（或最后一次状态变化）。detail 里没有 duration_ms，只能自己算。 */
function missionMs(m) {
  const a = ts(m && m.created_at);
  const b = ts(m && (m.report_at || m.updated_at));
  return a && b ? Math.max(0, b - a) : 0;
}
function missionProgress(p) {
  const x = p || {};
  const total = Number(x.total) || 0;
  const merged = Number(x.merged) || 0;
  const cancelled = Number(x.cancelled) || 0;
  return { total, merged, cancelled, open: Math.max(0, total - merged - cancelled) };
}
/** 进度：一张卡一格（合并实心 / 取消斜纹 / 空槽），沿用轨道那套分段语言。 */
function progressBar(p, label = true) {
  if (!p.total) return `<span class="dim2">还没有卡</span>`;
  const cells = [];
  for (let i = 0; i < p.merged; i++) cells.push('<i class="done"></i>');
  for (let i = 0; i < p.cancelled; i++) cells.push('<i class="cancel"></i>');
  for (let i = 0; i < p.open; i++) cells.push('<i></i>');
  return `<span class="mbar" aria-hidden="true">${cells.join('')}</span>${
    label
      ? `<span>${esc(`${p.merged}/${p.total}`)} 张卡合并${p.cancelled ? ` · ${esc(String(p.cancelled))} 取消` : ''}</span>`
      : ''}`;
}

/**
 * 审查条款：接口实际给的是 `{criterion, pass, evidence}`（见 hub/core/types.ts），
 * 而接口文档写的是 `{text, ok, evidence}`。两种都认，别让字段名差异吃掉证据。
 */
function critOf(c) {
  if (c == null) return { text: '', ok: null, evidence: '' };
  if (typeof c === 'string') return { text: c, ok: null, evidence: '' };
  const rawOk = c.ok !== undefined ? c.ok : c.pass;
  return {
    text: String(c.text ?? c.criterion ?? ''),
    ok: rawOk === true ? true : rawOk === false ? false : null,
    evidence: String(c.evidence ?? ''),
  };
}
function passWord(ok) { return ok === true ? 'PASS' : ok === false ? 'FAIL' : '未裁决'; }

/** mission 下所有会话的索引：把时间线里的 S-000004 翻成「谁」。 */
function sessionIndex(d) {
  const m = new Map();
  for (const t of (d && d.tasks) || []) {
    for (const s of t.sessions || []) {
      if (s && s.session_id) m.set(s.session_id, { agent_id: s.agent_id, role: s.role });
    }
  }
  const mission = d && d.mission;
  if (mission && mission.lead_session && !m.has(mission.lead_session)) {
    m.set(mission.lead_session, { agent_id: mission.lead_agent, role: 'lead' });
  }
  return m;
}
/**
 * actor 常常只是个 session id。能翻成 agent 就翻（这是数据里本来就有的事实），
 * 翻不出来就老实显示原值 —— 不猜「大概是谁」。
 */
function actorHtml(actor, idx) {
  const s = String(actor == null ? '' : actor).trim();
  if (!s) return '<span class="dim2 mono">—</span>';
  if (s.startsWith('hub.')) return `<span class="mono" title="${attr(s)}">平台 · ${esc(s.slice(4))}</span>`;
  if (s.startsWith('mesh-hub')) return '<span class="mono" title="mesh-hub">平台 · hub</span>';
  if (/^S-\d+/.test(s)) {
    const hit = idx.get(s);
    if (!hit) return `<span class="mono" title="${attr(s)}">${esc(s)}</span>`;
    return `<span class="mono" title="${attr(`${s}${hit.role ? ` · ${hit.role}` : ''}`)}">${esc(hit.agent_id || s)}</span>`;
  }
  return `<span class="mono">${esc(s)}</span>`;
}

function renderMissions() {
  return ui.mission ? renderMissionDetail() : renderMissionList();
}

function missionHistoryFoot() {
  const data = store.missions;
  if (!data || !data.history) return '';
  return `<p class="mfoot micro">协作史索引 <span class="mono">${esc(data.history)}</span> · ${
    data.history_exists ? '已生成（一件 mission 一行，按完成顺序）' : '还没生成（第一件 mission 完成后写入）'
  }</p>`;
}

/* --- 视图：任务列表 ------------------------------------------------------- */
function renderMissionList() {
  const data = store.missions;
  if (!data) {
    const err = store.errors.get('missions');
    return err ? errorBlock('missions', err, '任务单列表') : loadingBlock(4);
  }
  const all = data.list;
  const q = ui.q.trim().toLowerCase();
  const list = all.filter((m) => !q || [m.mission_id, m.title, m.lead_agent, m.status].join(' ').toLowerCase().includes(q));

  const head = `<div class="view-head">
    <div class="view-title"><h1>任务单</h1><span class="count">${list.length} / ${all.length} 件事</span></div>
    <div class="view-tools">
      <span class="micro">新的在上面 · 一次 mission = 一组任务卡 + 一份报告</span>
      <button class="btn btn-ink" type="button" id="btn-new-mission" data-act="new-mission" title="发布一件新任务（等同 mesh mission）">发布任务</button>
    </div>
  </div>`;

  if (!all.length) {
    return `${head}${emptyState(
      '还没有 mission',
      '平台收到一件活之后（点上面的「发布任务」，或 mesh mission，或 lead 会话里调用 create_mission），这里会出现一条记录：拆了几张卡、谁审的、报告在哪。',
      '<div class="empty-actions"><button class="btn btn-ink" type="button" data-act="new-mission">发布第一件任务</button></div>',
    )}${missionHistoryFoot()}`;
  }
  if (!list.length) {
    return `${head}${emptyState(
      '没有匹配的 mission',
      `关键词「${ui.q.trim()}」把 ${all.length} 件事全过滤掉了。`,
      '<div class="empty-actions"><button class="btn" type="button" data-act="filter-q">清除关键词</button></div>',
    )}`;
  }

  const rows = list.map((m) => {
    const p = missionProgress(m.progress);
    const ms = Number.isFinite(Number(m.duration_ms)) ? Number(m.duration_ms) : missionMs(m);
    return `<li>
  <a class="mrow st-${esc(m.status)}" href="#/missions/${encodeURIComponent(m.mission_id)}" title="打开 ${attr(m.mission_id)} 的完整证据">
    <span class="mrow-id">${esc(m.mission_id)}</span>
    <span class="mrow-pill">${statusPill(m.status)}</span>
    <span class="mrow-main">
      <span class="mrow-title">${esc(m.title)}</span>
      <span class="mrow-sub">
        <span><span class="k">lead</span> <span class="who">${esc(m.lead_agent || '—')}</span></span>
        <span><span class="k">轮次</span> ${esc(String(m.rounds ?? 0))}</span>
        <span title="最后状态变化：${attr(abs(m.updated_at))}"><span class="k">更新</span> ${esc(rel(m.updated_at))}</span>
      </span>
    </span>
    <span class="mrow-facts">
      <span class="mrow-prog">${progressBar(p)}</span>
      <span class="mrow-dur" title="建单 → 收尾">${esc(dur(ms))}</span>
    </span>
    <svg class="ico mrow-go" aria-hidden="true"><use href="#i-chevron" /></svg>
  </a>
</li>`;
  }).join('');

  return `${head}<div class="mledger"><ul class="mlist" role="list">${rows}</ul></div>${missionHistoryFoot()}`;
}

/* --- 视图：任务详情 ------------------------------------------------------- */
function missionTimelineBlock(d, idx) {
  const list = Array.isArray(d.timeline) ? d.timeline : [];
  const head = `<div class="sec-head"><h2 class="sec-title"><span class="n">01</span>时间线</h2>
    <span class="sec-note">${list.length} 条 · 审计账本 + 消息账本</span></div>`;
  if (!list.length) {
    return `<section class="msec" id="m-time" tabindex="-1">${head}${emptyState(
      '没有记录到事件',
      '这个 mission 的 timeline 是空的：审计账本被清理过，或者它还没跑起来过。空不代表没事发生，只代表没有留痕。',
    )}</section>`;
  }
  let day = '';
  const items = list.map((e) => {
    const dk = dayKey(e.at);
    const sep = dk && dk !== day ? `<div class="tl-day">${esc(dayLabel(e.at))}</div>` : '';
    day = dk || day;
    const kind = String(e.kind || '');
    // 中文标签由后端给（`timeline[].label`，和 timeline.md 用同一张表），前端不再自己维护
    // 一份翻译 —— 两份表迟早会飘。旧数据/未知 kind 没有 label 时老实显示 kind 本身。
    const chip = e.label ? String(e.label) : kind;
    // 后端对某些事件没写描述（describe() 的 default 分支），text 就是事件名本身。
    // 这时候 chip 已经说清楚了，不用再念一遍英文。
    const note = e.text && e.text !== kind ? `<div class="tl-note">${esc(e.text)}</div>` : '';
    const link = e.task_id
      ? `<div class="tl-by"><a class="linklike mono" href="#/board?task=${encodeURIComponent(e.task_id)}" title="在看板上打开 ${attr(e.task_id)}">${esc(e.task_id)}</a></div>`
      : '';
    return `${sep}<div class="tl-item">
      <div class="tl-time" title="${attr(abs(e.at))}">${esc(hms(e.at))}</div>
      <div class="tl-main">
        <div class="tl-move"><span class="chip" title="${attr(kind)}">${esc(chip)}</span><span class="tl-who">${actorHtml(e.actor, idx)}</span></div>
        ${note}
        ${link}
      </div>
    </div>`;
  }).join('');
  return `<section class="msec" id="m-time" tabindex="-1">${head}<div class="timeline">${items}</div></section>`;
}

function missionAcceptance(accept) {
  if (!accept.length) return '';
  return `<div class="maccept">
    <span class="micro">验收（开单时写的 · ${esc(String(accept.length))} 条）</span>
    <ol>${accept.map((a, i) => `<li><span class="n">${pad2(i + 1)}</span><span>${esc(a)}</span></li>`).join('')}</ol>
  </div>`;
}

function missionCardHtml(t, onlyFail) {
  const reviews = Array.isArray(t.reviews_full) ? t.reviews_full : [];
  const write = Array.isArray(t.scope && t.scope.write) ? t.scope.write : [];
  const read = Array.isArray(t.scope && t.scope.read) ? t.scope.read : [];
  const merge = t.merge;
  const sub = t.submission && typeof t.submission === 'object' ? t.submission : null;
  const rejectionCount = Number(t.rejection_count) || 0;
  const rejectedBy = Array.isArray(t.rejected_by) ? t.rejected_by.filter(hasText) : [];
  const reviewers = Array.from(new Set(reviews.map((r) => r.reviewer_agent).filter(Boolean)));
  const subFiles = sub && Array.isArray(sub.files) ? sub.files : [];

  // 谁实现、谁审、打回几次：每一条都单独占一格，缺了就写「无」，不留空格子。
  const facts = [
    `<span><span class="k">role</span> <span class="v">${esc(t.role || '未标角色')}</span></span>`,
    `<span><span class="k">实现者</span> ${hasText(t.implementer_agent)
      ? `<span class="v mono">${esc(t.implementer_agent)}</span>`
      : none('未记录', 'implementer_agent 为空：这张卡还没人接手实现')}</span>`,
    `<span><span class="k">认领</span> ${hasText(t.claimed_by)
      ? `<span class="v mono">${esc(t.claimed_by)}</span>`
      : none('无', 'claimed_by 为空')}</span>`,
    `<span><span class="k">审查者</span> ${reviewers.length
      ? `<span class="v mono">${esc(reviewers.join('、'))}</span>`
      : none('还没人审', 'reviews_full 为空')}</span>`,
    `<span><span class="k">打回</span> ${rejectionCount
      ? `<span class="v tag-broken">${esc(String(rejectionCount))} 次</span>${rejectedBy.length ? ` <span class="dim2 mono">${esc(rejectedBy.join('、'))}</span>` : ''}`
      : none('无', 'rejection_count = 0：这张卡一次都没被打回')}</span>`,
    `<span><span class="k">合并</span> ${merge
      ? `<span class="v mono">${esc(shortSha(merge.merge_commit))}</span> <span class="dim2">${esc(merge.mode || '—')} · ${esc(String((merge.files || []).length))} 文件</span>`
      : none('未合并', 'merge 为空')}</span>`,
  ];

  // 提交：commit / 分支 / 时间 + 提交说明全文（clamp 后可展开）+ 文件清单。
  const subBlock = sub
    ? `<div class="msub">
        <div class="msub-head">
          <span class="micro">提交 ${esc(sub.session_id || '')}</span>
          <span class="mono">${esc(shortSha(sub.commit, 9) || '无 commit')}</span>
          <span class="dim2 mono">on ${esc(sub.branch || t.branch || '—')}</span>
          ${hasText(sub.submitted_at) ? `<span class="dim2" title="${attr(abs(sub.submitted_at))}">${esc(mmdd(sub.submitted_at))}</span>` : none('时间未记录', 'submission.submitted_at 为空')}
          <span class="dim2">${subFiles.length ? `${esc(String(subFiles.length))} 个文件` : '未列文件'}</span>
        </div>
        ${String(sub.summary || '').trim()
          ? longText(sub.summary, 'note-block', 300)
          : `<p class="note-block dim2">提交没有写说明（submission.summary 为空）。</p>`}
        ${subFiles.length
          ? `<ul class="filelist filelist-inline">${subFiles.map((f) => `<li><span class="mark" aria-hidden="true">M</span><span>${esc(f)}</span></li>`).join('')}</ul>`
          : ''}
      </div>`
    : '';

  const scopeBlock = `<div class="mscope">
    <div class="scope-row"><span class="micro">写 scope</span><span class="scope-vals">${listOrNone(write, codeChips, '无（不授权写任何文件）', 'scope.write 为空')}</span></div>
    <div class="scope-row"><span class="micro">读 scope</span><span class="scope-vals">${listOrNone(read, codeChips, '无（未声明额外只读文件）', 'scope.read 为空')}</span></div>
  </div>`;

  // 会话：mission 接口的 tasks[].sessions 比 task 接口多了 created_at / exit。
  // 这份证据原来只有 API 里有、界面上看不见，这里摊开：谁跑过这张卡、何时起、怎么退的。
  const sessions = Array.isArray(t.sessions) ? t.sessions : [];
  const sessBlock = sessions.length ? `<div class="msess">
    <span class="micro">会话</span>
    ${sessions.map((s) => {
    const exit = s && s.exit && typeof s.exit === 'object' ? s.exit : null;
    const code = exit && exit.code != null ? String(exit.code) : null;
    const title = [
      `session ${s.session_id || '?'} · agent ${s.agent_id || '?'} · ${s.role || '?'} · ${s.status || '?'}`,
      hasText(s.created_at) ? `建于 ${abs(s.created_at)}` : '建会话时间未给出',
      exit ? `退出 ${code == null ? 'code 未记录' : `code ${code}`}${hasText(exit.at) ? ` @ ${abs(exit.at)}` : ''}${hasText(exit.note) ? ` · ${exit.note}` : ''}` : '这条会话没有退出记录',
    ].join(' · ');
    return `<span class="msess-item" title="${attr(title)}">
      <span class="mono">${esc(s.session_id || '未编号会话')}</span>
      <span class="dim2">${esc(s.agent_id || '未标 agent')}</span>
      ${hasText(s.role) ? `<span class="dim2">${esc(s.role)}</span>` : ''}
      <span class="dim2 mono">${esc(s.status || '—')}</span>
      ${hasText(s.created_at) ? `<span class="dim">建于 ${esc(mmdd(s.created_at))}</span>` : ''}
      ${exit ? `<span class="dim">退出 ${code == null ? none('code 未记录', 'exit.code 为 null：进程不是正常退出') : esc(`code ${code}`)}</span>` : ''}
    </span>`;
  }).join('')}
  </div>` : '';

  const revHtml = reviews.map((r) => {
    const crits = (r.criteria || []).map(critOf);
    const shown = onlyFail ? crits.filter((c) => c.ok === false) : crits;
    if (onlyFail && !shown.length) return '';
    const ok = String(r.verdict || '') === 'approved';
    const passN = crits.filter((c) => c.ok === true).length;
    const failN = crits.filter((c) => c.ok === false).length;
    const chain = shown.length
      ? `<div class="chain">${shown.map((c) => `<div class="chain-item" data-pass="${c.ok === true ? 'true' : c.ok === false ? 'false' : 'null'}">
          <div class="chain-mark"><span class="glyph" aria-hidden="true">${c.ok === true ? '✓' : c.ok === false ? '✕' : '?'}</span><span class="wire"></span></div>
          <div class="chain-body">
            <div class="chain-crit">${esc(c.text || '（条款文字为空）')}</div>
            <div class="chain-verdict"><span class="verdict">${esc(passWord(c.ok))}</span><span class="mono">${esc(r.review_id || '—')}</span></div>
            ${evidenceBlock(c.evidence)}
          </div>
        </div>`).join('')}</div>`
      : '<p class="dim2" style="font-size:11.5px">这次审查没有留下逐条 criteria（criteria 为空），只有下面的判词。</p>';
    return `<div class="mrev">
      <div class="mrev-head">
        <span>${esc(r.review_id || '—')}</span>
        <span class="${ok ? 'ok' : 'no'}">${esc(r.verdict || '无结论')}</span>
        <span>审查者 <span class="mono">${esc(r.reviewer_agent || '—')}</span></span>
        ${hasText(r.reviewer_session) ? `<span class="dim2 mono">${esc(r.reviewer_session)}</span>` : ''}
        <span>审的是 <span class="mono">${esc(r.implementer_agent || t.implementer_agent || '—')}</span> 的提交</span>
        ${crits.length ? `<span class="dim2">${esc(String(crits.length))} 条 criteria · ${esc(String(passN))} PASS / ${esc(String(failN))} FAIL</span>` : ''}
        ${r.independent ? '<span class="dim2">独立审查</span>' : '<span class="dim2">非独立</span>'}
        <span class="dim2" title="${attr(abs(r.at))}">${esc(mmdd(r.at))}</span>
        ${hasText(r.submission_commit) ? `<span class="dim2 mono">commit ${esc(shortSha(r.submission_commit))}</span>` : ''}
      </div>
      ${chain}
      ${r.notes ? `<div class="mrev-notes"><span class="micro">判词</span>${longText(r.notes, 'note-block')}</div>` : ''}
    </div>`;
  }).join('');

  return `<article class="mcard st-${esc(t.status)}">
    <div class="mcard-head">
      <a class="linklike mono" href="#/board?task=${encodeURIComponent(t.task_id)}" title="在看板上打开 ${attr(t.task_id)}" style="font-size:11px">${esc(t.task_id)}</a>
      <h3 class="mcard-title">${esc(t.title)}</h3>
      ${statusPill(t.status)}
    </div>
    <div class="mcard-meta">${facts.join('')}</div>
    ${scopeBlock}
    ${subBlock}
    ${sessBlock}
    ${missionAcceptance(t.acceptance || [])}
    ${revHtml || '<div class="mrev"><p class="dim">这张卡还没有审查记录（reviews_full 为空）。</p></div>'}
  </article>`;
}

function missionCardsBlock(d) {
  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  const q = ui.q.trim().toLowerCase();
  let critTotal = 0;
  let critFail = 0;
  const rows = tasks.map((t) => {
    let fails = 0;
    for (const r of t.reviews_full || []) {
      for (const c of r.criteria || []) {
        critTotal++;
        if (critOf(c).ok === false) fails++;
      }
    }
    critFail += fails;
    return { t, fails };
  });
  const shown = rows.filter(({ t, fails }) => {
    if (ui.mfail && !fails) return false;
    if (!q) return true;
    const hay = [
      t.task_id, t.title, t.role, t.implementer_agent,
      (t.reviews_full || []).map((r) => r.reviewer_agent || '').join(' '),
      (t.acceptance || []).join(' '),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const head = `<div class="sec-head">
    <h2 class="sec-title"><span class="n">02</span>卡片与证据</h2>
    <div class="sec-tools">
      <span class="sec-note">${shown.length} / ${rows.length} 张卡 · ${critTotal} 条条款</span>
      <div class="seg" role="group" aria-label="按条款结果筛选">
        <button class="seg-btn" type="button" data-act="mfail" data-on="false" aria-pressed="${ui.mfail ? 'false' : 'true'}">全部 <span class="num">${critTotal}</span></button>
        <button class="seg-btn" type="button" data-act="mfail" data-on="true" aria-pressed="${ui.mfail ? 'true' : 'false'}">只看未通过 <span class="num">${critFail}</span></button>
      </div>
    </div>
  </div>`;

  if (!tasks.length) {
    return `<section class="msec" id="m-cards" tabindex="-1">${head}${emptyState(
      '这个 mission 还没有卡',
      'lead 用 plan_mission 把活拆成卡之后，这里会按卡列出「要求 → 审查 → 逐条证据」。',
    )}</section>`;
  }
  if (!shown.length) {
    const back = ui.q.trim()
      ? '<div class="empty-actions"><button class="btn" type="button" data-act="filter-q">清除关键词</button></div>'
      : '<div class="empty-actions"><button class="btn" type="button" data-act="mfail" data-on="false">看全部条款</button></div>';
    return `<section class="msec" id="m-cards" tabindex="-1">${head}${ui.mfail && !critFail
      ? emptyState('没有未通过的条款', `${critTotal} 条条款全部 PASS —— 没有留下需要复查的缺口。`, back)
      : emptyState('没有匹配的卡', '关键词把这张 mission 下的卡全过滤掉了。', back)}</section>`;
  }
  return `<section class="msec" id="m-cards" tabindex="-1">${head}<div class="mcards">${
    shown.map(({ t }) => missionCardHtml(t, ui.mfail)).join('')
  }</div></section>`;
}

function missionReportBlock(d, m) {
  const report = String(d.report || '').trim();
  const path = d.report_path || '';
  const chars = report.length;
  const lines = lineCount(report);
  const files = Array.isArray(d.files) ? d.files : [];
  const onDisk = files.find((f) => f && f.name === 'report.md');
  // 报告入口要能回答两件事：在哪 / 写了多少。路径与字数都放在标题行上，
  // 不用先滚到底才知道这份报告是空的还是三万字。
  const loc = `<div class="report-loc">
    <span class="micro">报告文件</span>
    ${hasText(path) ? `<span class="mono rl-path" title="${attr(path)}">${esc(path)}</span>` : none('未记录落盘路径', 'report_path 为空')}
    <span class="rl-stat">${esc(String(chars))} 字符 · ${esc(String(lines))} 行</span>
    ${onDisk ? `<span class="mfile" data-exists="${onDisk.exists ? 'true' : 'false'}" title="${attr(onDisk.path)}">${onDisk.exists ? '在盘' : '文件不存在'}</span>` : ''}
    ${hasText(m && m.report_at) ? `<span class="rl-stat" title="${attr(abs(m.report_at))}">写于 ${esc(mmdd(m.report_at))}</span>` : none('写入时间未记录', 'mission.report_at 为空')}
  </div>`;
  if (!report) {
    return `<section class="msec" id="m-report" tabindex="-1">
      <div class="sec-head"><h2 class="sec-title"><span class="n">03</span>交付报告</h2><span class="sec-note">0 字符</span></div>
      ${loc}
      ${emptyState('报告还没写', hasText(path)
        ? `报告文件应该在 ${path}，但目前没有内容 —— lead 要用 write_report 写下它。`
        : '这次 mission 还没有报告：lead 的 write_report 还没跑，或者报告文件被清理了。')}
    </section>`;
  }
  return `<section class="msec" id="m-report" tabindex="-1">
    <div class="sec-head"><h2 class="sec-title"><span class="n">03</span>交付报告</h2>
      <span class="sec-note">${esc(String(chars))} 字符 · ${esc(String(lines))} 行${hasText(m && m.report_at) ? ` · 写于 ${esc(mmdd(m.report_at))}` : ''}</span></div>
    ${loc}
    <div class="mreport md">${mdRender(report)}</div>
  </section>`;
}

function renderMissionDetail() {
  const id = ui.mission;
  const d = store.missionDetail.get(id);
  const err = store.errors.get(`mission:${id}`);
  const crumb = `<div class="mcrumb">
    <a class="mback" href="#/missions"><svg class="ico" aria-hidden="true"><use href="#i-chevron" /></svg>全部任务单</a>
    <span class="micro mono">${esc(id)}</span>
  </div>`;

  if (!d) {
    return `${crumb}${err ? errorBlock(`mission:${id}`, err, `任务单 ${id}`) : loadingBlock(6)}`;
  }

  const m = d.mission || {};
  const idx = sessionIndex(d);
  const p = missionProgress(d.progress);
  const accept = m.acceptance || [];
  const files = d.files || [];
  const mates = Array.isArray(m.teammates) ? m.teammates.filter(hasText) : [];
  const rejectedTasks = Array.isArray(m.rejected_tasks) ? m.rejected_tasks.filter(hasText) : [];
  const reportText = String(d.report || '').trim();
  const reportChars = reportText.length;
  const reportLines = lineCount(reportText);
  const cardCount = (d.tasks || []).length;
  const tlCount = (d.timeline || []).length;
  let critCount = 0;
  for (const t of d.tasks || []) for (const r of t.reviews_full || []) critCount += (r.criteria || []).length;
  const trail = (m.history || []).length > 1
    ? `<div class="mtrail" aria-label="状态轨迹">${(m.history || []).map((h, i) => `${i ? '<span class="marrow" aria-hidden="true">→</span>' : ''}<span class="mnode st-${esc(h.to)}" title="${attr(`${abs(h.at)} · ${h.by || '—'}${h.note ? ` · ${h.note}` : ''}`)}">${esc(h.to)}<span class="at">${esc(hms(h.at).slice(0, 5))}</span></span>`).join('')}</div>`
    : '';
  const brief = String(m.brief || '').trim();
  // brief 与标题相同时不重复展示：标题本身就是用户原话（这里是常见情况）。
  const briefBlock = brief && brief !== String(m.title || '').trim()
    ? `<div class="mbrief"><span class="lbl">用户原话</span>${esc(brief)}</div>`
    : '';

  const hero = `<section class="mhero st-${esc(m.status)}" aria-labelledby="m-title">
    <div class="mhero-top">
      <span class="mhero-id">${esc(m.mission_id || id)}</span>
      ${statusPill(m.status, 'pill-lg')}
      ${STATUS_ZH[m.status] ? `<span class="micro">${esc(STATUS_ZH[m.status])}</span>` : ''}
      ${m.parent_mission ? `<a class="chip" href="#/missions/${encodeURIComponent(m.parent_mission)}">上级 ${esc(m.parent_mission)}</a>` : ''}
    </div>
    <h1 id="m-title">${esc(m.title || '（无标题）')}</h1>
    <div class="mhero-meta">
      <span><span class="k">lead</span> ${hasText(m.lead_agent)
        ? `<span class="v">${esc(m.lead_agent)}</span>${hasText(m.lead_session)
          ? `<span class="dim2 mono" title="lead 会话：${attr(m.lead_session)}"> ${esc(m.lead_session)}</span>`
          : ` ${none('（未记 lead 会话）', 'mission.lead_session 为空')}`}`
        : none('未指派 lead', 'mission.lead_agent 为空')}</span>
      <span><span class="k">轮次</span> <span class="v">${esc(String(m.rounds ?? 0))}</span></span>
      <span title="建单 → 报告"><span class="k">时长</span> <span class="v">${esc(dur(missionMs(m)))}</span></span>
      <span title="${attr(abs(m.created_at))}"><span class="k">建单</span> <span class="v">${esc(mmdd(m.created_at))}</span></span>
      <span title="${attr(abs(m.report_at || m.updated_at))}"><span class="k">收尾</span> <span class="v">${esc(mmdd(m.report_at || m.updated_at))}</span></span>
      <span title="已合并 / 卡数">${progressBar(p)}</span>
      <span><span class="k">来源</span> ${hasText(m.source) ? `<span class="v">${esc(m.source)}</span>` : none('未记录', 'mission.source 为空')}</span>
      <span><span class="k">打回</span> ${rejectedTasks.length
        ? `<span class="v tag-broken">${esc(String(rejectedTasks.length))} 张卡</span> <span class="dim2 mono">${esc(rejectedTasks.join('、'))}</span>`
        : none('无', 'mission.rejected_tasks 为空：这次 mission 一次都没打回')}</span>
      <span><span class="k">参与</span> ${mates.length
        ? `<span class="v">${esc(mates.join('、'))}</span>`
        : none('未记录参与人', 'mission.teammates 为空')}</span>
    </div>
    ${briefBlock}
    ${missionAcceptance(accept)}
    ${trail}
    <div class="mfiles">
      <span class="micro">落盘</span>
      <span class="mono dim2">${hasText(d.history_dir) ? esc(d.history_dir) : none('未记录目录', 'history_dir 为空')}</span>
      ${files.length
        ? files.map((f) => {
          // 报告那一格直接就是入口：点它跳到正文，字数与行数写在格子里。
          if (f.name === 'report.md') {
            return `<button class="mfile mfile-report" type="button" data-act="jump" data-to="m-report" title="跳到报告正文 · ${attr(f.path)}">
              ${esc(f.name)} · ${esc(String(reportChars))} 字符 / ${esc(String(reportLines))} 行${f.exists ? '' : '（缺）'}
            </button>`;
          }
          return `<span class="mfile" data-exists="${f.exists ? 'true' : 'false'}" title="${attr(f.path)}${f.exists ? '' : ' · 文件不存在'}">${esc(f.name || f.path || '未命名')}${f.exists ? '' : '（缺）'}</span>`;
        }).join('')
        : none('这一层没有落盘文件', 'files 为空')}
      ${files.some((f) => f && f.name === 'report.md') ? '' : `<button class="mfile mfile-report" type="button" data-act="jump" data-to="m-report" title="跳到报告正文 · ${attr(d.report_path || '（无落盘路径）')}">
        report.md · ${esc(String(reportChars))} 字符 / ${esc(String(reportLines))} 行
      </button>`}
    </div>
  </section>`;

  const nav = `<div class="mnav" role="group" aria-label="页内跳转">
    <button class="mnav-btn" type="button" data-act="jump" data-to="m-time"><span class="n">01</span>时间线<span class="cnt">${esc(String(tlCount))} 条</span></button>
    <button class="mnav-btn" type="button" data-act="jump" data-to="m-cards"><span class="n">02</span>卡片与证据<span class="cnt">${esc(String(cardCount))} 卡 · ${esc(String(critCount))} 条款</span></button>
    <button class="mnav-btn" type="button" data-act="jump" data-to="m-report"><span class="n">03</span>交付报告<span class="cnt">${esc(String(reportChars))} 字</span></button>
  </div>`;

  return `${crumb}${hero}${nav}${missionTimelineBlock(d, idx)}${missionCardsBlock(d)}${missionReportBlock(d, m)}`;
}

/* --- 发布任务（POST /api/missions）----------------------------------------
   观察台只读，只有一个例外：把一件活发进平台。这条链和 CLI 的 `mesh mission`
   是同一个动作（平台侧记在一个 mesh-human 会话名下、source=platform），
   所以字段也照着 CLI 的位置参数排：标题 → 描述 → 验收（可多条）→ lead。
   面板用原生 <dialog>：Esc、焦点圈、backdrop 都是浏览器给的，不自己造一套。 */

let nmTimer = 0;
/** 刚发布成功的那单：结果块里的「现在就打开」用它跳转。 */
let nmLastId = '';

function nmEl(id) { return document.getElementById(id); }

/** 能当 lead 的 agent：启用 + 有 lead 能力 + 非 builtin。
 *  builtin（mesh-human / mesh-hub）没有进程可拉起，平台会给它们 lead_session_id=null。 */
function nmLeadCandidates() {
  const agents = (store.overview && store.overview.agents) || [];
  return agents.filter((a) => a.enabled && a.kind !== 'builtin' && (a.capabilities || []).includes('lead'));
}

function nmAddCritRow(value = '') {
  const host = nmEl('nm-crit-rows');
  if (!host) return;
  const row = document.createElement('div');
  row.className = 'crit-row';
  row.innerHTML = '<span class="crit-n" aria-hidden="true"></span>' +
    '<input class="fld-input crit-input" type="text" autocomplete="off" spellcheck="false" />' +
    '<button class="icon-btn crit-del" type="button" data-act="nm-del-crit" aria-label="删除这条验收条款">' +
    '<svg class="ico" aria-hidden="true"><use href="#i-x" /></svg></button>';
  row.querySelector('input').value = value;
  host.appendChild(row);
  nmRenumberCrit();
  return row;
}

/** 行号与 aria-label 都跟着顺序走，删掉中间一条也不会错位。 */
function nmRenumberCrit() {
  const rows = Array.from((nmEl('nm-crit-rows') || { children: [] }).children);
  rows.forEach((row, i) => {
    const n = row.querySelector('.crit-n');
    if (n) n.textContent = pad2(i + 1);
    const input = row.querySelector('input');
    if (input) input.setAttribute('aria-label', `验收条款 ${i + 1}`);
    const del = row.querySelector('.crit-del');
    if (del) del.setAttribute('aria-label', `删除第 ${i + 1} 条验收条款`);
  });
  const count = nmEl('nm-crit-count');
  if (count) count.textContent = rows.length ? `${rows.length} 条 · 空行提交时忽略` : '还没有条款（可以不加）';
}

function nmFillLeads() {
  const sel = nmEl('nm-lead');
  if (!sel) return;
  const cands = nmLeadCandidates();
  sel.innerHTML = '<option value="">交给平台挑（不指定 lead）</option>' +
    cands.map((a) => `<option value="${esc(a.agent_id)}">${esc(a.agent_id)} · ${esc(a.display_name || '未命名')}</option>`).join('') +
    (cands.length ? '' : '<option value="" disabled>（当前没有可指定的 lead：都停用 / 无 lead 能力 / 是 builtin）</option>');
  sel.value = '';
  if (!store.overview) {
    // 还有一次机会：overview 没加载就先开面板，拿到数据再填一次下拉。
    loaders.overview().then(() => { if (nmEl('new-mission').open) nmFillLeads(); }).catch(() => {});
  }
}

/** 面板里的提示行：空字符串就收起（:empty 在 CSS 里 display:none）。 */
function nmSetMsg(strong, hint = '') {
  const box = nmEl('nm-msg');
  if (!box) return;
  box.innerHTML = hasText(strong)
    ? `<span class="msg-strong">${esc(strong)}</span>${hasText(hint) ? `<span class="msg-hint">${esc(hint)}</span>` : ''}`
    : '';
}

function nmSetBusy(on) {
  const btn = nmEl('nm-submit');
  if (!btn) return;
  btn.disabled = !!on;
  btn.textContent = on ? '发布中…' : '发布任务';
}

const NM_EMPTY = { hidden: true, innerHTML: '' };

function openNewMission() {
  const dlg = nmEl('new-mission');
  if (!dlg) return;
  clearTimeout(nmTimer);
  const form = nmEl('nm-form');
  const result = nmEl('nm-result');
  if (form) form.hidden = false;
  if (result) Object.assign(result, NM_EMPTY);
  nmSetMsg('');
  nmSetBusy(false);
  const title = nmEl('nm-title');
  if (title) { title.value = ''; title.removeAttribute('aria-invalid'); }
  const brief = nmEl('nm-brief');
  if (brief) brief.value = '';
  const rows = nmEl('nm-crit-rows');
  if (rows) rows.innerHTML = '';
  nmAddCritRow();
  nmFillLeads();
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  if (title) { title.focus(); title.select(); }
}

function closeNewMission() {
  const dlg = nmEl('new-mission');
  if (!dlg) return;
  clearTimeout(nmTimer);
  if (dlg.open && typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

/** 成功之后：把三个返回值摆出来，1.6 秒后自动跳到这单（也可以点「现在就打开」）。 */
function nmShowResult(p) {
  const result = nmEl('nm-result');
  const form = nmEl('nm-form');
  if (!result) return;
  const session = p.lead_session_id == null
    ? none('无（builtin 不落会话）', 'lead 是 builtin：没有进程可拉起，所以 lead_session_id 为 null')
    : `<span class="mono">${esc(p.lead_session_id)}</span>`;
  const turn = String(p.lead_turn || '');
  const turnHtml = !turn
    ? none('未返回', 'lead_turn 为空')
    : turn === 'spawned'
      ? '<span class="mono">spawned</span> <span class="dim2">lead 回合已拉起</span>'
      : turn === 'not_applicable'
        ? '<span class="mono">not_applicable</span> <span class="dim2">builtin lead 不需要拉进程</span>'
        : turn.startsWith('deferred')
          ? `<span class="mono">deferred</span> <span class="dim2">未同步拉起，交给 daemon 再试${turn.length > 9 ? ` · ${esc(turn.slice(9).trim())}` : ''}</span>`
          : `<span class="mono">${esc(turn)}</span>`;
  result.innerHTML = `
    <div class="nm-ok-head">
      <span class="pill st-merged"><i class="dotmark" aria-hidden="true"></i>已发布</span>
      <span class="mono nm-ok-id">${esc(p.mission_id)}</span>
      <span class="micro">${esc(p.source || 'platform')}${p.created_by ? ` · 署名 ${esc(p.created_by)}` : ''}</span>
    </div>
    <dl class="kv nm-ok-kv">
      <dt>mission_id</dt><dd class="mono">${esc(p.mission_id)}</dd>
      <dt>lead_agent</dt><dd>${hasText(p.lead_agent) ? `<span class="mono">${esc(p.lead_agent)}</span>` : none('未返回', 'lead_agent 为空')}</dd>
      <dt>lead_session</dt><dd>${session}</dd>
      <dt>lead_turn</dt><dd>${turnHtml}</dd>
      <dt>status</dt><dd>${statusPill(p.status)}</dd>
    </dl>
    <div class="sheet-foot">
      <span class="micro">正在打开 <span class="mono">${esc(p.mission_id)}</span>…</span>
      <span class="sheet-btns"><button class="btn btn-ink" type="button" data-act="nm-jump">现在就打开</button></span>
    </div>`;
  nmLastId = p.mission_id;
  if (form) form.hidden = true;
  result.hidden = false;
  if (result.focus) result.focus({ preventScroll: true });
  // 列表 / 会话 / 总览都变了：全部作废，回到列表时重新拉。
  store.missions = null;
  store.sessions = null;
  store.overview = null;
  store.missionDetail.delete(p.mission_id);
  ['missions', 'sessions', 'overview'].forEach((k) => store.errors.delete(k));
  clearTimeout(nmTimer);
  nmTimer = setTimeout(() => nmJump(p.mission_id), 1600);
}

function nmJump(id) {
  clearTimeout(nmTimer);
  closeNewMission();
  go('missions', { mission: id });
}

/** 把后端 400/500 的响应翻成面板里的一句话，不用 alert。 */
function nmFail(status, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const code = hasText(p.code) ? p.code : '';
  if (status === 400) {
    const bits = [];
    if (hasText(p.hint)) bits.push(p.hint);
    if (hasText(p.agent_id)) bits.push(`agent ${p.agent_id}${Array.isArray(p.capabilities) ? `：能力 ${p.capabilities.join(' / ')}` : ''}`);
    if (code) bits.push(`错误码 ${code}`);
    nmSetMsg(p.message || '平台拒绝了这次请求', bits.join(' · '));
    const title = nmEl('nm-title');
    if (p.field === 'title' && title) {
      title.setAttribute('aria-invalid', 'true');
      title.focus();
      title.select();
    }
    return;
  }
  if (status === 405 || status === 404) {
    nmSetMsg('这个 serve 实例不接受发布', `HTTP ${status}：它可能是发布路由之前的旧版本（只读观察台）。重启 mesh serve 后就能用。`);
    return;
  }
  nmSetMsg('发布失败', `HTTP ${status}${hasText(p.message) ? ` · ${p.message}` : ''}${code ? ` · ${code}` : ''}。服务端内部错误，平台里可能什么都没建；重试前先确认一下。`);
}

async function submitNewMission(ev) {
  if (ev) ev.preventDefault();
  const form = nmEl('nm-form');
  if (!form || form.hidden) return;
  const btn = nmEl('nm-submit');
  if (btn && btn.disabled) return;

  const title = nmEl('nm-title');
  const body = { title: title ? title.value.trim() : '' };
  const brief = nmEl('nm-brief');
  const briefVal = brief ? brief.value.trim() : '';
  if (briefVal) body.brief = briefVal;
  const acceptance = Array.from((nmEl('nm-crit-rows') || { children: [] }).children)
    .map((row) => (row.querySelector('input') || {}).value || '')
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (acceptance.length) body.acceptance = acceptance;
  const lead = nmEl('nm-lead');
  if (lead && lead.value) body.lead_agent = lead.value;

  nmSetMsg('');
  if (title) title.removeAttribute('aria-invalid');
  nmSetBusy(true);
  try {
    const res = await fetch('/api/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (!res.ok) { nmFail(res.status, payload); nmSetBusy(false); return; }
    // 只有真拿到 mission_id 才算发布成功：旧版 serve 会把 POST 落到 GET 上，
    // 回来一份任务单列表（HTTP 200）—— 那时候假装成功并跳转会跳到空页面。
    if (!payload || !hasText(payload.mission_id)) {
      nmSetMsg('服务端没有返回 mission_id', `HTTP ${res.status}：这个 serve 实例可能还没有 POST /api/missions 路由（旧进程）。任务是否已创建未知，先刷新任务单看看。`);
      nmSetBusy(false);
      store.missions = null;
      store.errors.delete('missions');
      return;
    }
    nmShowResult(payload);
  } catch (e) {
    nmSetMsg('连不上后端', `${e.message} · 确认 mesh serve 还在跑，以及页面与 API 同源。`);
    nmSetBusy(false);
  }
}

/** 面板的一次性绑定：提交、Ctrl/⌘+Enter、关闭后把焦点还给入口按钮。 */
function nmBind() {
  const dlg = nmEl('new-mission');
  const form = nmEl('nm-form');
  if (!dlg || !form) return;
  form.addEventListener('submit', submitNewMission);
  dlg.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else submitNewMission(null);
    }
  });
  dlg.addEventListener('close', () => {
    clearTimeout(nmTimer);
    nmSetBusy(false);
    const trigger = nmEl('btn-new-mission');
    if (trigger && trigger.focus) trigger.focus({ preventScroll: true });
  });
  // 输入就把上一次的报错收掉，别让红框一直挂着
  form.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'nm-title') ev.target.removeAttribute('aria-invalid');
    if (nmEl('nm-msg') && nmEl('nm-msg').innerHTML) nmSetMsg('');
  });
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
  if (qEl) qEl.placeholder = view === 'missions' && ui.mission ? '搜索卡 id / 标题 / 角色…' : (SEARCH_PH[view] || '搜索…');
  const detail = view === 'missions' && ui.mission ? store.missionDetail.get(ui.mission) : null;
  document.title = detail && detail.mission && detail.mission.title
    ? `${detail.mission.title} · ${ui.mission} · AgentMesh 观察台`
    : `${VIEW_TITLE[view]} · AgentMesh 观察台`;

  renderStrip();

  const host = $('#view');
  if (!host) return;
  const html = view === 'overview' ? renderOverview()
    : view === 'missions' ? renderMissions()
      : view === 'board' ? renderBoard()
        : view === 'sessions' ? renderSessions()
          : view === 'audit' ? renderAudit()
            : view === 'messages' ? renderMessages()
              : renderAgents();

  const scroller = $('#view-scroll');
  // innerHTML 会先把 #view 清空再重建，浏览器在清空的瞬间会把 #view-scroll 的
  // scrollTop 夹回 0；重建后不会自己回来。所以重绘前记下位置，原地重绘时复原
  // —— 否则点一次「日志」展开就把人送回页面顶部。
  const viewScroll = scroller ? scroller.scrollTop : 0;
  host.innerHTML = html;
  if (view !== lastView || reset) scroller.scrollTop = 0;
  else if (scroller) scroller.scrollTop = viewScroll;

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
  if (view === 'missions' && ui.mission && !store.missionDetail.has(ui.mission) && !store.errors.has(`mission:${ui.mission}`)) {
    loadMission(ui.mission).then(() => { if (ui.view === 'missions' && ui.mission) render({ reset: false }); }).catch(() => { if (ui.view === 'missions') render({ reset: false }); });
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
  if (view === 'missions') { if (missing('missions')) need.push('missions'); }
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
    } else if (act === 'mfail') {
      update({ mfail: el.dataset.on === 'true' }, { reset: false });
    } else if (act === 'jump') {
      const target = el.dataset.to ? document.getElementById(el.dataset.to) : null;
      if (!target) return;
      const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      // 键盘用户需要一个落点：把焦点交给分区本身（tabindex="-1"），但不让它再滚一次。
      if (target.focus) target.focus({ preventScroll: true });
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
      else if (key.startsWith('mission:')) store.missionDetail.delete(key.slice(8));
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
      // 展开日志会让面板内容变高/变矮（上一条日志收起），只还原 scrollTop 不够：
      // 内容一变，同一段文字就在视口里挪了位置。所以以「被点的那一行」为锚，
      // 重绘后把它挪回原来的视口位置 —— 用户眼睛不动，页面就不算跳。
      const sid = el.dataset.s;
      const row = el.closest('.sess-row');
      const beforeTop = row ? row.getBoundingClientRect().top : null;
      ui.logFor = ui.logFor === sid ? '' : sid;
      render({ reset: false });
      const nb = $('#panel-body');
      if (nb && beforeTop != null) {
        const anchor = nb.querySelector(`[data-row-s="${sid}"]`);
        if (anchor) {
          const delta = anchor.getBoundingClientRect().top - beforeTop;
          if (Math.abs(delta) > 1) nb.scrollTop += delta;
        }
      }
      if (ui.logFor) loadLog(ui.logFor).then(() => render({ reset: false })).catch(() => {});
    } else if (act === 'new-mission') {
      openNewMission();
    } else if (act === 'nm-close') {
      closeNewMission();
    } else if (act === 'nm-add-crit') {
      const row = nmAddCritRow();
      if (row) { const i = row.querySelector('input'); if (i) i.focus(); }
    } else if (act === 'nm-del-crit') {
      const row = el.closest('.crit-row');
      const host = nmEl('nm-crit-rows');
      const focusAt = host ? Array.from(host.children).indexOf(row) : -1;
      if (row && host) row.remove();
      nmRenumberCrit();
      // 删完把焦点交给邻近那一行的输入框，键盘用户不会掉到 body 上
      if (host && focusAt >= 0) {
        const next = host.children[Math.min(focusAt, host.children.length - 1)];
        const input = next ? next.querySelector('input') : null;
        if (input) input.focus();
        else { const add = document.querySelector('[data-act="nm-add-crit"]'); if (add) add.focus(); }
      }
    } else if (act === 'nm-jump') {
      if (nmLastId) nmJump(nmLastId);
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
      refresh(['overview', 'tasks', 'sessions', 'audit', 'messages', 'missions']);
      store.tasksById.clear();
      store.logs.clear();
      store.docs.delete('digest');
      store.missionDetail.clear();
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
      if (document.querySelector('dialog[open]')) return; // 交给 dialog 自己关（Esc / cancel）
      if (ui.task) { ev.preventDefault(); update({ task: '' }, { reset: false }); return; }
      if (ui.status || ui.role || ui.q) {
        update({ status: '', role: '', q: '' }, { reset: false });
        return;
      }
      if (typing && t.blur) t.blur();
      return;
    }
    // 对话框开着的时候，其余快捷键（/ ? g …）一律不接管：模态就该是模态。
    if (document.querySelector('dialog[open]')) return;
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
      const map = { b: 'board', s: 'sessions', a: 'audit', m: 'messages', o: 'overview', g: 'agents', r: 'missions' };
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
  nmBind();
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

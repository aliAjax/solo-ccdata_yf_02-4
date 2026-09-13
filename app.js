'use strict';
/* 评审白板：角色 / 阶段门禁 / 意见 / 审计 / 冲突裁决 / 多标签同步 / 刷新恢复 */

const LS_REVIEW = 'rb.review.';            // localStorage key 前缀
const LS_LIST = 'rb.reviews';
const SS_ME = 'rb.me.';                    // sessionStorage：本标签身份
const CH = 'rb.channel.';
const STAGES = [
  { key: 'collect', name: '收集' },
  { key: 'discuss', name: '讨论' },
  { key: 'decide',  name: '决议' },
  { key: 'archive', name: '归档' },
];
const STATUS = { open: '待处理', reviewing: '核验中', approved: '通过', rejected: '驳回' };
const PRIORITY = { high: '高', medium: '中', low: '低' };
const ROLE = { host: '主持人', editor: '编辑者', observer: '观察者' };
const COLORS = ['#276ef1', '#ed6a5a', '#44a57b', '#8d63c9', '#d99322', '#1f9aa8', '#c94f8d', '#5c6f85'];
const SESSION = Math.random().toString(36).slice(2, 9);

/* ---------------- 工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = ts => {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
let toastTimer;
function toast(t) { const q = $('#toast'); q.textContent = t; q.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => q.style.display = 'none', 2000); }
const nameOf = id => state?.members?.[id]?.name || '已离开成员';

/* ---------------- 持久化 ---------------- */
function saveReview(s) { localStorage.setItem(LS_REVIEW + s.id, JSON.stringify(s)); touchList(s); }
function loadReview(id) { try { return JSON.parse(localStorage.getItem(LS_REVIEW + id)); } catch { return null; } }
function touchList(s) {
  const list = JSON.parse(localStorage.getItem(LS_LIST) || '{}');
  list[s.id] = { id: s.id, title: s.title, updatedAt: Date.now() };
  localStorage.setItem(LS_LIST, JSON.stringify(list));
}
function getList() { return Object.values(JSON.parse(localStorage.getItem(LS_LIST) || '{}')).sort((a, b) => b.updatedAt - a.updatedAt); }

/* ---------------- 全局状态 ---------------- */
let state = null;
let meId = null;
let bus = null;
let busSupported = false;
let tool = 'note', color = 'yellow', selectedId = null, statusFilter = 'all';
let undoStack = [];
let sessions = new Set([SESSION]);
let currentConflictId = null;
let editingCommentId = null;
let pendingEvidence = null;
let suppressNextBoardClick = false;

const me = () => state.members[meId];
const myRole = () => me()?.role || 'observer';
const canEditBoard = () => (myRole() === 'host' || myRole() === 'editor') && state.stage !== 'archive';
const canComment = () => (myRole() === 'host' || myRole() === 'editor') && state.stage !== 'archive';
const isHost = () => myRole() === 'host';
const memberColor = id => COLORS[(id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

/* ---------------- 状态合并 ---------------- */
function mergeState(remote) {
  if (!remote) return;
  if (!state) { state = remote; return; }
  state.title = remote.title ?? state.title;
  state.stage = remote.stage ?? state.stage;   // 阶段以远端为准（推进/回退都传播）
  for (const [id, m] of Object.entries(remote.members || {})) {
    if (m.removed) { delete state.members[id]; continue; }
    state.members[id] = { ...state.members[id], ...m };
  }
  for (const id of remote.objectRestores || []) state.objectTombstones = state.objectTombstones.filter(x => x !== id);
  for (const [id, o] of Object.entries(remote.objects || {})) {
    if (state.objectTombstones.includes(id)) continue;  // 已删除元素不被过期消息复活
    state.objects[id] = { ...state.objects[id], ...o };
  }
  for (const id of remote.objectTombstones || []) {
    delete state.objects[id];
    if (!state.objectTombstones.includes(id)) state.objectTombstones.push(id);
  }
  for (const [id, c] of Object.entries(remote.comments || {})) {
    if (state.commentTombstones.includes(id)) continue;
    state.comments[id] = { ...state.comments[id], ...c };
  }
  for (const id of remote.commentTombstones || []) {
    delete state.comments[id];
    if (!state.commentTombstones.includes(id)) state.commentTombstones.push(id);
  }
  for (const c of remote.conflicts || []) {
    if (state.conflictTombstones.includes(c.id)) continue;  // 已裁决冲突不被过期八卦复活
    const i = state.conflicts.findIndex(x => x.id === c.id);
    if (i >= 0) state.conflicts[i] = { ...state.conflicts[i], ...c };
    else state.conflicts.push(c);
  }
  for (const id of remote.conflictTombstones || []) {
    state.conflicts = state.conflicts.filter(c => c.id !== id);
    if (!state.conflictTombstones.includes(id)) state.conflictTombstones.push(id);
  }
  const auditIds = new Set(state.audit.map(a => a.id));
  for (const a of remote.audit || []) if (!auditIds.has(a.id)) { state.audit.push(a); auditIds.add(a.id); }
  state.audit.sort((a, b) => b.ts - a.ts);
  if (state.audit.length > 500) state.audit = state.audit.slice(0, 500);
}

/* ---------------- 消息总线 ---------------- */
function post(msg) { msg.session = SESSION; msg.ts = msg.ts || Date.now(); bus?.postMessage(msg); }

function connectBus() {
  busSupported = 'BroadcastChannel' in window;
  if (!busSupported) {
    // 兜底：storage 事件做全量同步（无冲突检测，仅保证最终一致）
    window.addEventListener('storage', ev => {
      if (ev.key !== LS_REVIEW + state.id || !ev.newValue) return;
      const remote = JSON.parse(ev.newValue);
      if (remote._session === SESSION) return;
      mergeState(remote); saveReview(state); render();
    });
  } else {
    bus = new BroadcastChannel(CH + state.id);
    bus.onmessage = ev => {
      const m = ev.data;
      if (m.session === SESSION) return;
      sessions.add(m.session);
      if (m.kind === 'heartbeat' || m.kind === 'hello' || m.kind === 'hi') {
        if (m.snapshot) { mergeState(m.snapshot); saveReview(state); renderPeople(); }
        if (m.kind === 'hello') post({ kind: 'hi', snapshot: presenceSnapshot() });
        updateSync(); return;
      }
      if (m.kind === 'bye') { sessions.delete(m.session); updateSync(); return; }
      if (m.kind === 'patch') handlePatch(m);
    };
    window.addEventListener('beforeunload', () => post({ kind: 'bye' }));
    setInterval(() => post({ kind: 'heartbeat', snapshot: presenceSnapshot() }), 5000);
  }
  setInterval(() => { if (state && me()) { state.members[meId].lastSeen = Date.now(); saveReview(state); renderPeople(); } }, 8000);
}

/* 补丁快照构造：只携带必要字段，审计带最近 3 条用于跨标签传播 */
function baseSnapshot() {
  const s = structuredClone(state);
  s.objects = {}; s.objectTombstones = []; s.objectRestores = [];
  s.comments = {}; s.commentTombstones = [];
  s.conflicts = []; s.conflictTombstones = [];
  s.members = me() ? { [meId]: me() } : {};
  s.audit = state.audit.slice(0, 3);
  delete s.stage;   // 阶段只随专门的阶段补丁传播，避免旧快照把阶段回退
  return s;
}
function presenceSnapshot() {
  const s = baseSnapshot(); s.audit = []; return s;
}

function handlePatch(m) {
  if (m.patchType === 'object-update' && m.verTag && m.baseTag !== m.verTag) {
    const cur = state.objects[m.objectId];
    const divergent = cur && cur.verTag !== m.verTag && cur.verTag !== m.baseTag;
    if (divergent) {
      // 两人基于同一旧版本分别改动 → 两个版本都保留
      const local = structuredClone(cur);
      const remote = structuredClone(m.proposed);
      const cfId = 'cf-' + m.objectId + '-' + [local.verTag, remote.verTag].sort().join('-');
      mergeState(m.snapshot);
      if (!state.conflicts.some(c => c.id === cfId) && !state.conflictTombstones.includes(cfId)) {
        const va = { ...local, _who: local.updatedBy, _whoName: nameOf(local.updatedBy) };
        const vb = { ...remote, _who: m.by, _whoName: m.byName };
        const pair = (remote.updatedTs || 0) < (local.updatedTs || 0) ? [vb, va] : [va, vb];
        state.conflicts.push({
          id: cfId, objectId: m.objectId,
          versionA: pair[0], versionB: pair[1],
          createdBy: m.by, createdByName: m.byName, ts: m.ts, resolved: false,
        });
        // 画板上确定性地保留先写入版本，后写入版本进裁决弹窗
        const winner = stripAnnotations(pair[0]);
        state.objects[m.objectId] = winner;
        // 把检测到的冲突广播给其他标签
        const cfSnap = baseSnapshot();
        cfSnap.objects = {}; cfSnap.conflicts = [state.conflicts.find(c => c.id === cfId)];
        post({ kind: 'patch', patchType: 'conflict-detected', by: meId, byName: me()?.name, snapshot: cfSnap });
      }
      saveReview(state); render(); afterRemote();
      return;
    }
  }
  mergeState(m.snapshot);
  saveReview(state); render(); afterRemote();
}
function stripAnnotations(o) { const x = { ...o }; delete x._who; delete x._whoName; return x; }
function afterRemote() {
  if (currentConflictId && !state.conflicts.some(c => c.id === currentConflictId && !c.resolved)) {
    $('#conflictModal').hidden = true; currentConflictId = null;
  }
  updateSync();
}

/* ---------------- 本地提交 ---------------- */
function commit(mutator, auditText, critical = false) {
  mutator(state);
  if (auditText) state.audit.unshift({ id: uid('au'), ts: Date.now(), by: meId, byName: me()?.name || '?', critical, text: auditText });
  state.audit.sort((a, b) => b.ts - a.ts);
  state._session = SESSION;
  saveReview(state);
  render();
}

function pushObjectPatch(obj, baseTag, { tombstone = false, restore = false } = {}) {
  const snap = baseSnapshot();
  if (tombstone) snap.objectTombstones = [obj.id];
  else { snap.objects = { [obj.id]: obj }; if (restore) { snap.objectRestores = [obj.id]; snap.objectTombstones = state.objectTombstones.filter(x => x !== obj.id); } }
  snap.conflicts = structuredClone(state.conflicts.map(c => ({ ...c, versionA: stripAnnotations(c.versionA), versionB: stripAnnotations(c.versionB) })));
  post({ kind: 'patch', patchType: tombstone ? 'object-delete' : 'object-update', objectId: obj.id, baseTag, verTag: obj?.verTag, proposed: obj || null, by: meId, byName: me()?.name, snapshot: snap });
}
function pushStatePatch({ commentId, commentTombstone, conflictId, conflictTombstone, objectId, obj, objectTombstone, members, withStage = false, patchType = 'state' } = {}) {
  const snap = baseSnapshot();
  if (withStage) snap.stage = state.stage;
  if (commentId !== undefined) { snap.comments = commentTombstone ? {} : { [commentId]: state.comments[commentId] }; snap.commentTombstones = commentTombstone ? [commentId] : []; }
  if (conflictId !== undefined) { snap.conflicts = conflictTombstone ? [] : state.conflicts.filter(c => c.id === conflictId); snap.conflictTombstones = conflictTombstone ? [conflictId] : []; }
  if (objectId !== undefined && obj) snap.objects = { [objectId]: obj };
  if (objectTombstone) snap.objectTombstones = [objectTombstone];
  if (members) snap.members = members;
  post({ kind: 'patch', patchType, by: meId, byName: me()?.name, snapshot: snap });
}

/* ---------------- 阶段门禁 ---------------- */
function gateForNext() {
  const comments = Object.values(state.comments);
  if (state.stage === 'collect') {
    if (!comments.length) return { ok: false, reason: '收集阶段至少需要 1 条意见才能进入讨论' };
  } else if (state.stage === 'discuss') {
    if (comments.some(c => c.status === 'open')) return { ok: false, reason: '仍有「待处理」意见，需变为核验中/通过/驳回后才能进入决议' };
  } else if (state.stage === 'decide') {
    if (comments.some(c => c.status === 'open' || c.status === 'reviewing'))
      return { ok: false, reason: '所有意见必须给出「通过」或「驳回」结论后才能归档' };
  }
  return { ok: true };
}
function advance() {
  if (!isHost()) return toast('仅主持人可以推进阶段');
  const i = STAGES.findIndex(s => s.key === state.stage);
  if (i >= STAGES.length - 1) return;
  const gate = gateForNext();
  if (!gate.ok) {
    commit(() => {}, `尝试推进到「${STAGES[i + 1].name}」被门禁阻止：${gate.reason}`);
    pushStatePatch();
    return toast('🚫 ' + gate.reason);
  }
  const next = STAGES[i + 1].key;
  commit(s => { s.stage = next; }, `阶段推进：${STAGES[i].name} → ${STAGES[i + 1].name}`, true);
  pushStatePatch({ withStage: true });
  toast('已进入「' + STAGES[i + 1].name + '」阶段');
}
function backStage() {
  if (!isHost()) return toast('仅主持人可以退回阶段');
  const i = STAGES.findIndex(s => s.key === state.stage);
  if (i <= 0) return;
  commit(s => { s.stage = STAGES[i - 1].key; }, `阶段回退：${STAGES[i].name} → ${STAGES[i - 1].name}`, true);
  pushStatePatch({ withStage: true });
}

/* ---------------- 评审生命周期 ---------------- */
function createReview(title, name, role) {
  const id = 'REV-' + Date.now().toString(36).toUpperCase().slice(-4) + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const memberId = uid('mb');
  state = {
    id, title, stage: 'collect',
    members: { [memberId]: { id: memberId, name, role, joinedAt: Date.now(), lastSeen: Date.now() } },
    objects: {}, objectTombstones: [],
    comments: {}, commentTombstones: [],
    conflicts: [], conflictTombstones: [],
    audit: [{ id: uid('au'), ts: Date.now(), by: memberId, byName: name, critical: true, text: `创建评审「${title}」，阶段：收集` }],
    createdAt: Date.now(),
  };
  state._session = SESSION;
  meId = memberId;
  saveReview(state);
  sessionStorage.setItem(SS_ME + id, memberId);
  location.hash = '#room=' + id;
  bootRoom(id);
}

function joinReview(id, name, role) {
  const existing = loadReview(id);
  if (!existing) { toast('未找到该评审，请检查房间号'); return false; }
  const memberId = uid('mb');
  meId = memberId;
  state = existing;
  commit(s => { s.members[memberId] = { id: memberId, name, role, joinedAt: Date.now(), lastSeen: Date.now() }; },
    `${name} 以${ROLE[role]}身份加入评审`, true);
  sessionStorage.setItem(SS_ME + id, memberId);
  connectBus();
  post({ kind: 'hello', snapshot: presenceSnapshot() });
  location.hash = '#room=' + id;
  showApp();
  return true;
}

/* ---------------- 渲染 ---------------- */
function render() {
  if (!state) return;
  renderStage(); renderBoard(); renderComments(); renderAudit(); renderPeople(); renderPermNote();
  $('#rv-title').textContent = state.title;
  $('#roomId').textContent = state.id;
  $('#cmtCount').textContent = Object.keys(state.comments).length;
  $('#auditCount').textContent = state.audit.length;
  $('#memberCount').textContent = Object.keys(state.members).length;
  const badge = $('#me-badge');
  badge.textContent = `${me()?.name || '?'} · ${ROLE[myRole()]}`;
  badge.style.background = { host: '#e7f0ff', editor: '#e8f6ef', observer: '#f1f2f4' }[myRole()];
  badge.style.color = { host: '#276ef1', editor: '#2f9e6e', observer: '#6d7b88' }[myRole()];
  const cf = state.conflicts.filter(c => !c.resolved).length;
  $('#conflictFlag').hidden = cf === 0;
  $('#conflictFlag').textContent = `⚠ ${cf} 个元素冲突待裁决`;
  $$('.tool[data-type],.color button').forEach(b => b.disabled = !canEditBoard());
  $('#undo').disabled = !canEditBoard() || !undoStack.length;
}

function renderStage() {
  const wrap = $('#stages'); wrap.innerHTML = '';
  const i = STAGES.findIndex(s => s.key === state.stage);
  STAGES.forEach((s, idx) => {
    const d = el('div', 'stage ' + (idx === i ? 'active' : idx < i ? 'done' : ''));
    d.append(el('span', 'n', String(idx + 1)), document.createTextNode(s.name));
    wrap.append(d);
  });
  const last = i === STAGES.length - 1;
  $('#btn-advance').hidden = last || !isHost();
  $('#btn-advance').textContent = '进入「' + (STAGES[i + 1]?.name || '') + '」';
  $('#btn-back').hidden = i === 0 || !isHost();
  const hint = $('#stageHint');
  if (last) { hint.textContent = '评审已归档（只读）'; hint.className = 'stage-hint'; }
  else if (!isHost()) { hint.textContent = `当前：${STAGES[i].name}阶段，等待主持人推进`; hint.className = 'stage-hint'; }
  else { const g = gateForNext(); hint.textContent = g.ok ? '门禁条件已满足，可以推进' : '🚫 ' + g.reason; hint.className = 'stage-hint ' + (g.ok ? '' : 'blocked'); }
}

function renderPermNote() {
  const map = {
    host: '<b>主持人</b>：编辑画板、提交意见、管理成员身份、裁决冲突、推进/退回阶段。<br><span class="kbd">Delete</span> 删除选中元素',
    editor: '<b>编辑者</b>：绘制拖动元素、提交意见与证据、更新意见状态。阶段推进与冲突裁决由主持人完成。<br><span class="kbd">Delete</span> 删除选中元素',
    observer: '<b>观察者</b>：只读模式，可浏览画板、意见与审计记录并导出 PNG。',
  };
  $('#permNote').innerHTML = map[myRole()] + (state.stage === 'archive' ? '<br><b>归档阶段：</b>空间锁定，所有身份均为只读。' : '');
}

function renderPeople() {
  if (!state) return;
  const wrap = $('#people'); wrap.innerHTML = '';
  const now = Date.now();
  Object.values(state.members).forEach(m => {
    const a = el('div', 'avatar' + (m.id === meId ? ' me' : '') + (now - (m.lastSeen || 0) > 15000 ? ' off' : ''), (m.name || '?').slice(0, 1));
    a.style.background = memberColor(m.id);
    a.title = `${m.name} · ${ROLE[m.role]}`;
    wrap.append(a);
  });
  const online = Object.values(state.members).filter(m => now - (m.lastSeen || 0) <= 15000).length;
  $('#peopleLabel').textContent = `${Object.keys(state.members).length} 位成员 · ${online} 在线`;
}

/* ---------- 白板 ---------- */
function shapeClass(o) {
  if (o.type === 'note') return 'note ' + (o.cat || 'yellow');
  if (o.type === 'text') return 'label';
  if (o.type === 'circle') return 'shape circle';
  if (o.type === 'line') return 'line';
  return 'shape';
}
function objSummary(o) {
  if (o.type === 'note' || o.type === 'text') return o.text || '(空)';
  if (o.type === 'line') return `连线：${o.w}px，旋转 ${o.angle ?? 18}°，位于 (${Math.round(o.x)}, ${Math.round(o.y)})`;
  return `${{ rect: '矩形', circle: '圆形' }[o.type] || '图形'}，位于 (${Math.round(o.x)}, ${Math.round(o.y)})`;
}

function renderBoard() {
  const board = $('#board');
  board.classList.toggle('locked', !canEditBoard());
  const ids = new Set();
  for (const o of Object.values(state.objects)) {
    ids.add(o.id);
    let node = board.querySelector('[data-oid="' + o.id + '"]');
    if (!node) { node = document.createElement('div'); node.dataset.oid = o.id; board.append(node); }
    node.className = 'object ' + shapeClass(o) + (o.id === selectedId ? ' selected' : '');
    node.style.left = o.x + 'px'; node.style.top = o.y + 'px';
    if (o.type === 'line') { node.style.width = (o.w || 140) + 'px'; node.style.transform = `rotate(${o.angle ?? 18}deg)`; node.textContent = ''; }
    else if (o.type === 'note' || o.type === 'text') { node.textContent = o.text || ''; node.style.transform = ''; node.style.width = ''; }
    else { node.textContent = ''; node.style.transform = ''; node.style.width = ''; }
    const conflicted = state.conflicts.some(c => !c.resolved && c.objectId === o.id);
    node.classList.toggle('conflicted', conflicted);
    node.querySelectorAll('.obj-badge').forEach(b => b.remove());
    if (conflicted) {
      const b = el('span', 'obj-badge obj-conflict', '!');
      b.title = '存在冲突版本，待主持人裁决';
      b.onclick = e => { e.stopPropagation(); const cf = state.conflicts.find(c => !c.resolved && c.objectId === o.id); if (cf) openConflict(cf); };
      node.append(b);
    }
    const links = Object.values(state.comments).filter(c => c.objectId === o.id).length;
    if (links) {
      const b = el('span', 'obj-badge obj-link', String(links));
      b.title = '关联意见数';
      b.onclick = e => { e.stopPropagation(); selectedId = o.id; switchTab('comments'); renderBoard(); };
      node.append(b);
    }
    if (o.id === selectedId && canEditBoard() && !conflicted) {
      const del = el('span', 'obj-badge obj-conflict', '×');
      del.style.background = '#6d7b88'; del.title = '删除该元素';
      del.onclick = e => { e.stopPropagation(); deleteObject(o.id); };
      node.append(del);
    }
  }
  board.querySelectorAll('[data-oid]').forEach(n => { if (!ids.has(n.dataset.oid)) n.remove(); });
}

function makeObject(type, x, y) {
  return {
    id: uid('ob'), type, x: Math.round(x), y: Math.round(y),
    cat: type === 'note' ? color : '', w: type === 'line' ? 140 : null, angle: type === 'line' ? 18 : null,
    text: type === 'note' ? '新便签（双击编辑）' : type === 'text' ? '双击编辑文本' : '',
    version: 1, verTag: uid('v'), updatedBy: meId, updatedTs: Date.now(),
  };
}
function placeObject(x, y) {
  if (!canEditBoard()) return;
  const o = makeObject(tool, x, y);
  undoStack.push({ kind: 'add', id: o.id });
  commit(s => { s.objects[o.id] = o; });
  pushObjectPatch(o, null);
  selectedId = o.id;
}
function updateObjectText(id, text) {
  const cur = state.objects[id];
  if (!cur || blockedByConflict(id)) return;
  const baseTag = cur.verTag;
  const updated = { ...cur, text, version: cur.version + 1, verTag: uid('v'), updatedBy: meId, updatedTs: Date.now() };
  undoStack.push({ kind: 'update', id, before: structuredClone(cur) });
  commit(s => { s.objects[id] = updated; });
  pushObjectPatch(updated, baseTag);
}
function deleteObject(id) {
  const cur = state.objects[id];
  if (!cur || blockedByConflict(id)) return;
  undoStack.push({ kind: 'delete', obj: structuredClone(cur) });
  commit(s => { delete s.objects[id]; if (!s.objectTombstones.includes(id)) s.objectTombstones.push(id); });
  pushObjectPatch({ id }, cur.verTag, { tombstone: true });
  if (selectedId === id) selectedId = null;
}
function blockedByConflict(id) {
  if (state.conflicts.some(c => !c.resolved && c.objectId === id)) {
    toast(isHost() ? '该元素存在冲突，请先裁决后再修改' : '该元素存在冲突，等待主持人裁决');
    return true;
  }
  return false;
}
function undo() {
  if (!canEditBoard() || !undoStack.length) return;
  const act = undoStack.pop();
  if (act.kind === 'add') {
    const cur = state.objects[act.id]; if (!cur) return;
    commit(s => { delete s.objects[act.id]; if (!s.objectTombstones.includes(act.id)) s.objectTombstones.push(act.id); });
    pushObjectPatch({ id: act.id }, cur.verTag, { tombstone: true });
  } else if (act.kind === 'delete') {
    const o = { ...act.before, verTag: uid('v'), version: act.before.version + 1, updatedBy: meId, updatedTs: Date.now() };
    commit(s => { s.objects[o.id] = o; s.objectTombstones = s.objectTombstones.filter(x => x !== o.id); });
    pushObjectPatch(o, null, { restore: true });
  } else if (act.kind === 'update') {
    const cur = state.objects[act.id];
    const o = { ...act.before, verTag: uid('v'), version: (cur?.version || act.before.version) + 1, updatedBy: meId, updatedTs: Date.now() };
    commit(s => { if (s.objects[o.id]) s.objects[o.id] = o; });
    if (cur) pushObjectPatch(o, cur.verTag);
  }
  toast('已撤销');
}

/* ---------- 意见 ---------- */
function renderComments() {
  const list = $('#commentList'); list.innerHTML = '';
  const items = Object.values(state.comments)
    .filter(c => statusFilter === 'all' || c.status === statusFilter)
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]) || b.ts - a.ts);
  if (!items.length) {
    list.append(el('div', 'empty', state.stage === 'collect' ? '还没有意见。<br>编辑者可在「收集」阶段提交第一条意见。' : '当前筛选下没有意见。'));
  }
  for (const c of items) {
    const card = el('div', 'cmt s-' + c.status);
    const top = el('div', 'cmt-top');
    top.append(el('span', 'cmt-prio prio-' + c.priority, '优先级：' + PRIORITY[c.priority]));
    top.append(el('span', 'cmt-who', (state.members[c.by]?.name || '已离开成员') + ' · ' + fmtTime(c.ts)));
    card.append(top);
    card.append(el('div', 'cmt-body', c.content));
    if (c.evidenceName) {
      if (c.evidence?.startsWith('data:image')) {
        const img = el('img', 'cmt-ev'); img.src = c.evidence; img.alt = c.evidenceName;
        img.onclick = () => window.open(c.evidence, '_blank');
        card.append(img);
      }
      card.append(el('div', 'cmt-ev-name', '📎 ' + c.evidenceName));
    }
    const foot = el('div', 'cmt-foot');
    foot.append(el('span', 'cmt-owner', '负责人：' + (state.members[c.ownerId]?.name || '未分配')));
    if (c.objectId && state.objects[c.objectId]) {
      const lk = el('span', 'cmt-link', '定位画板元素');
      lk.onclick = e => {
        e.stopPropagation();
        selectedId = c.objectId; renderBoard();
        $('#board [data-oid="' + c.objectId + '"]')?.scrollIntoView({ block: 'center' });
        toast('已高亮关联元素');
      };
      foot.append(lk);
    }
    const sel = document.createElement('select');
    Object.entries(STATUS).forEach(([k, v]) => { const op = document.createElement('option'); op.value = k; op.textContent = v; if (k === c.status) op.selected = true; sel.append(op); });
    sel.disabled = !canComment();
    sel.onchange = e => { e.stopPropagation(); changeStatus(c, sel.value); };
    foot.append(sel);
    if (canComment() && (isHost() || c.by === meId)) {
      const edit = el('button', 'mini ghost', '编辑');
      edit.onclick = e => { e.stopPropagation(); openCommentModal(c.id); };
      foot.append(edit);
    }
    card.append(foot);
    card.onclick = e => {
      if ((e.target === card || e.target.classList.contains('cmt-body')) && canComment() && (isHost() || c.by === meId)) openCommentModal(c.id);
    };
    list.append(card);
  }
  const addBtn = $('#btn-add-comment');
  addBtn.disabled = !canComment();
  addBtn.textContent = state.stage === 'archive' ? '空间已归档' : '＋ 提交意见与证据';
}

function changeStatus(c, next) {
  const allowed = { open: ['reviewing'], reviewing: ['approved', 'rejected', 'open'], approved: ['reviewing'], rejected: ['reviewing'] };
  if (!allowed[c.status]?.includes(next)) { toast(`不能从「${STATUS[c.status]}」直接变为「${STATUS[next]}」`); renderComments(); return; }
  const from = c.status;
  const updated = { ...c, status: next };
  commit(s => { s.comments[c.id] = updated; }, `意见「${c.content.slice(0, 16)}…」状态：${STATUS[from]} → ${STATUS[next]}`);
  pushStatePatch({ commentId: c.id });
  if (['approved', 'rejected'].includes(next)) toast('已记录决议：' + STATUS[next]);
}

function openCommentModal(id) {
  if (!canComment()) return;
  editingCommentId = id || null;
  pendingEvidence = null;
  const c = id ? state.comments[id] : null;
  if (!id && !['collect', 'discuss'].includes(state.stage)) return toast('仅收集/讨论阶段可以新增意见');
  $('#cm-title').textContent = c ? '编辑意见' : '提交意见';
  $('#cm-content').value = c?.content || '';
  const ownerSel = $('#cm-owner'); ownerSel.innerHTML = '';
  Object.values(state.members).forEach(m => {
    const op = document.createElement('option');
    op.value = m.id; op.textContent = m.name;
    if ((c ? c.ownerId : null) === m.id || (!c && m.id === meId)) op.selected = true;
    ownerSel.append(op);
  });
  $('#cm-priority').value = c?.priority || 'medium';
  $('#cm-status').value = c?.status || 'open';
  $('#cm-status').disabled = !c;
  $('#cm-evname').textContent = c?.evidenceName ? '当前证据：' + c.evidenceName : '';
  $('#cm-file').value = '';
  $('#cm-link').checked = !!c?.objectId && c.objectId === selectedId;
  $('#cm-link').disabled = !selectedId || !state.objects[selectedId];
  $('#cm-linkname').textContent = selectedId && state.objects[selectedId] ? '已选中：' + (state.objects[selectedId].text || state.objects[selectedId].type) : '（先在画板点选元素）';
  $('#cm-delete').hidden = !(c && (isHost() || c.by === meId));
  openModal('#commentModal');
}

function saveComment() {
  const content = $('#cm-content').value.trim();
  if (!content) return toast('请填写意见内容');
  const id = editingCommentId || uid('cm');
  const old = state.comments[id];
  let nextStatus = old ? $('#cm-status').value : 'open';
  if (old && nextStatus !== old.status) {
    const allowed = { open: ['reviewing'], reviewing: ['approved', 'rejected', 'open'], approved: ['reviewing'], rejected: ['reviewing'] };
    if (!allowed[old.status]?.includes(nextStatus)) {
      toast(`不能从「${STATUS[old.status]}」直接变为「${STATUS[nextStatus]}」`);
      return;
    }
  }
  const record = {
    id, content,
    ownerId: $('#cm-owner').value,
    priority: $('#cm-priority').value,
    status: nextStatus,
    by: old?.by || meId, ts: old?.ts || Date.now(), updatedTs: Date.now(),
    objectId: $('#cm-link').checked ? selectedId : (old?.objectId || null),
    evidence: pendingEvidence?.data || old?.evidence || null,
    evidenceName: pendingEvidence?.name || old?.evidenceName || null,
  };
  commit(s => { s.comments[id] = record; },
    `${old ? '更新' : '提交'}意见「${content.slice(0, 16)}…」（负责人：${state.members[record.ownerId]?.name || '?'}，优先级${PRIORITY[record.priority]}）`);
  pushStatePatch({ commentId: id });
  closeModal('#commentModal');
  toast(old ? '意见已更新' : '意见已提交');
}
function deleteComment() {
  const id = editingCommentId; if (!id) return;
  const c = state.comments[id];
  if (!confirm('确认删除该意见？')) return;
  commit(s => { delete s.comments[id]; if (!s.commentTombstones.includes(id)) s.commentTombstones.push(id); },
    `删除意见「${(c.content || '').slice(0, 16)}…」`, true);
  pushStatePatch({ commentId: id, commentTombstone: true });
  closeModal('#commentModal');
}

/* ---------- 审计 ---------- */
function renderAudit() {
  const wrap = $('#auditList'); wrap.innerHTML = '';
  if (!state.audit.length) wrap.append(el('div', 'empty', '暂无关键变更记录。'));
  for (const a of state.audit.slice(0, 150)) {
    const d = el('div', 'audit' + (a.critical ? ' a-critical' : ''));
    d.append(el('span', 'tag', a.critical ? '关键' : '记录'));
    d.append(document.createTextNode(a.text + ' '));
    d.append(el('span', 'at', `— ${a.byName || '?'} · ${fmtTime(a.ts)}`));
    wrap.append(d);
  }
}

/* ---------- 冲突裁决 ---------- */
function openConflict(cf) {
  if (!isHost()) return toast('冲突由主持人裁决');
  currentConflictId = cf.id;
  const A = cf.versionA, B = cf.versionB;
  const hasText = A.type === 'note' || A.type === 'text';
  $('#cf-sub').textContent = `元素 ${cf.objectId.slice(-5)} · ${fmtTime(cf.ts)}`;
  $('#cf-a-head').innerHTML = `<span class="avatar" style="background:${memberColor(A.updatedBy)};width:22px;height:22px;font-size:10px">${esc((A._whoName || nameOf(A.updatedBy)).slice(0, 1))}</span>版本 A（先写入 · ${esc(A._whoName || nameOf(A.updatedBy))}）`;
  $('#cf-b-head').innerHTML = `<span class="avatar" style="background:${memberColor(B.updatedBy)};width:22px;height:22px;font-size:10px">${esc((B._whoName || nameOf(B.updatedBy)).slice(0, 1))}</span>版本 B（后提交 · ${esc(B._whoName || nameOf(B.updatedBy))}）`;
  $('#cf-a').value = objSummary(A);
  $('#cf-b').value = objSummary(B);
  const merge = $('#cf-merge');
  if (hasText) { merge.disabled = false; merge.value = (A.text || '') + '\n\n---\n' + (B.text || ''); }
  else { merge.disabled = true; merge.value = '图形/连线元素仅支持选择其中一个版本。'; }
  openModal('#conflictModal');
}
function resolveConflict(pick) {
  const cf = state.conflicts.find(c => c.id === currentConflictId);
  if (!cf) return;
  const A = cf.versionA, B = cf.versionB;
  let winner;
  if (pick === 'A') winner = stripAnnotations(A);
  else if (pick === 'B') winner = stripAnnotations(B);
  else {
    if (!(A.type === 'note' || A.type === 'text')) return toast('该元素不支持合并，请选择一个版本');
    winner = { ...stripAnnotations(A), text: $('#cf-merge').value };
  }
  const baseTag = state.objects[cf.objectId]?.verTag || cf.versionA.verTag;
  winner.verTag = uid('v');
  winner.version = Math.max(A.version || 1, B.version || 1) + 1;
  winner.updatedBy = meId; winner.updatedTs = Date.now();
  const mode = pick === 'merge' ? '主持人合并两个版本后写入' : `主持人选择版本 ${pick} 写入`;
  commit(s => {
    s.objects[cf.objectId] = winner;
    s.objectTombstones = s.objectTombstones.filter(x => x !== cf.objectId);
    const i = s.conflicts.findIndex(x => x.id === cf.id);
    if (i >= 0) s.conflicts[i] = { ...s.conflicts[i], resolved: true, resolvedTs: Date.now(), mode };
  }, `裁决元素冲突：${mode}（${A._whoName || nameOf(A.updatedBy)} 与 ${B._whoName || nameOf(B.updatedBy)} 的改动）`, true);
  // 广播最终对象 + 冲突终结
  const snap = baseSnapshot();
  snap.objects = { [cf.objectId]: winner };
  snap.conflicts = state.conflicts.filter(c => c.id === cf.id);
  snap.conflictTombstones = [cf.id];
  post({ kind: 'patch', patchType: 'conflict-resolve', objectId: cf.objectId, baseTag, verTag: winner.verTag, proposed: winner, by: meId, byName: me()?.name, snapshot: snap });
  closeModal('#conflictModal');
  const next = state.conflicts.find(c => !c.resolved);
  if (next) setTimeout(() => openConflict(next), 100);
  else toast('冲突已解决，最终版本已写入');
}

/* ---------- 成员管理 ---------- */
function openMembers() {
  const rows = $('#memberRows'); rows.innerHTML = '';
  Object.values(state.members).forEach(m => {
    const row = el('div', 'mrow');
    const av = el('div', 'avatar', (m.name || '?').slice(0, 1)); av.style.background = memberColor(m.id);
    const who = el('div', 'who'); who.append(el('b', null, m.name), el('br'), el('small', null, ROLE[m.role] + ' · ' + fmtTime(m.joinedAt) + ' 加入'));
    row.append(av, who);
    if (isHost()) {
      const sel = document.createElement('select');
      Object.entries(ROLE).forEach(([k, v]) => { const op = document.createElement('option'); op.value = k; op.textContent = v; if (m.role === k) op.selected = true; sel.append(op); });
      sel.onchange = () => changeRole(m, sel.value, sel);
      row.append(sel);
      if (m.id !== meId) {
        const rm = el('button', 'mini danger', '移除');
        rm.onclick = () => removeMember(m);
        row.append(rm);
      }
    }
    rows.append(row);
  });
  openModal('#membersModal');
}
function changeRole(m, role, sel) {
  if (m.role === 'host' && role !== 'host' && Object.values(state.members).filter(x => x.role === 'host').length <= 1) {
    toast('至少保留一位主持人'); sel.value = 'host'; return;
  }
  const old = m.role;
  commit(s => { s.members[m.id].role = role; }, `成员身份变更：${m.name} ${ROLE[old]} → ${ROLE[role]}`, true);
  pushStatePatch({ members: { [m.id]: state.members[m.id] } });
  toast(`${m.name} 的身份已更新为${ROLE[role]}`);
  openMembers();
}
function removeMember(m) {
  if (!confirm(`确认将 ${m.name} 移出评审？`)) return;
  commit(s => { delete s.members[m.id]; }, `移除成员：${m.name}（原${ROLE[m.role]}）`, true);
  const snap = baseSnapshot();
  snap.members = { [m.id]: { id: m.id, removed: true } };
  post({ kind: 'patch', patchType: 'member-remove', by: meId, byName: me()?.name, snapshot: snap });
  openMembers();
}

/* ---------- 导出 PNG ---------- */
function exportPNG() {
  const objs = Object.values(state.objects);
  const W = Math.max(1000, ...objs.map(o => o.x + Math.max(140, o.w || 110))) + 80;
  const H = Math.max(600, ...objs.map(o => o.y + 130)) + 80;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fbfcfd'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e3e9ef';
  for (let x = 0; x < W; x += 22) for (let y = 0; y < H; y += 22) { ctx.beginPath(); ctx.arc(x, y, 1, 0, 7); ctx.fill(); }
  for (const o of objs) {
    ctx.save();
    if (o.type === 'line') {
      ctx.translate(o.x, o.y); ctx.rotate((o.angle ?? 18) * Math.PI / 180);
      ctx.strokeStyle = '#667484'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(o.w || 140, 0); ctx.stroke();
    } else if (o.type === 'rect' || o.type === 'circle') {
      ctx.fillStyle = '#e9f0ff'; ctx.strokeStyle = '#276ef1'; ctx.lineWidth = 3;
      const w = o.type === 'circle' ? 74 : 96, h = o.type === 'circle' ? 74 : 60;
      ctx.beginPath();
      if (o.type === 'circle') ctx.arc(o.x + w / 2, o.y + h / 2, w / 2, 0, 7);
      else roundRectPath(ctx, o.x, o.y, w, h, 12);
      ctx.fill(); ctx.stroke();
    } else {
      const isNote = o.type === 'note';
      ctx.fillStyle = isNote ? (o.cat === 'blue' ? '#dff3ff' : o.cat === 'pink' ? '#ffe0eb' : '#fff3bf') : '#fff';
      ctx.strokeStyle = isNote ? 'transparent' : '#dbe2e8';
      drawWrapped(ctx, o.x, o.y, o.text || '', isNote);
    }
    ctx.restore();
  }
  const passed = Object.values(state.comments).filter(c => c.status === 'approved').length;
  const rejected = Object.values(state.comments).filter(c => c.status === 'rejected').length;
  ctx.fillStyle = '#17212b'; ctx.font = 'bold 18px sans-serif'; ctx.fillText(state.title, 30, 34);
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#6d7b88';
  ctx.fillText(`${state.id} · ${STAGES.find(s => s.key === state.stage).name}阶段 · 意见 ${Object.keys(state.comments).length} 条（通过 ${passed} / 驳回 ${rejected}） · ${new Date().toLocaleString()}`, 30, 54);
  const a = document.createElement('a');
  a.download = `review-${state.id}.png`;
  a.href = cv.toDataURL('image/png');
  a.click();
  toast('PNG 已导出');
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawWrapped(ctx, x, y, text, isNote) {
  ctx.font = '13px sans-serif';
  const wrapped = [];
  for (const ln of String(text).split('\n')) {
    let cur = '';
    for (const ch of ln) { if (ctx.measureText(cur + ch).width > 190 && cur) { wrapped.push(cur); cur = ''; } cur += ch; }
    wrapped.push(cur);
  }
  const mw = Math.max(96, ...wrapped.map(l => ctx.measureText(l).width)) + 26;
  const mh = Math.max(44, wrapped.length * 19 + 24);
  roundRectPath(ctx, x, y, mw, mh, isNote ? 3 : 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#17212b';
  wrapped.forEach((l, i) => ctx.fillText(l, x + 13, y + 22 + i * 19));
}

/* ---------- 弹窗 / Tab ---------- */
function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { const m = $(sel); if (m) m.hidden = true; if (sel === '#conflictModal') currentConflictId = null; }
function switchTab(t) {
  $$('.rtab').forEach(b => b.classList.toggle('active', b.dataset.rtab === t));
  $('#tab-comments').hidden = t !== 'comments'; $('#tab-audit').hidden = t !== 'audit';
}
function updateSync() {
  const s = $('#sync');
  s.textContent = sessions.size > 1 ? `● ${sessions.size} 个标签已连接` : '● 已同步（本地持久化）';
  s.className = 'sync-ok';
}

/* ---------------- 启动 ---------------- */
function showLanding() {
  $('#landing').hidden = false; $('#app').hidden = true;
  const listEl = $('#myReviews'); listEl.innerHTML = '';
  const list = getList();
  if (list.length) {
    listEl.append(el('h4', null, '本机评审记录（点击重新进入）'));
    for (const r of list) {
      const row = el('div', 'review-row');
      const info = el('div');
      info.append(el('b', null, r.title));
      const meta = el('div', 'meta', r.id + ' · ' + fmtTime(r.updatedAt));
      info.append(meta);
      row.append(info);
      row.append(el('span', 'go', '进入 →'));
      row.onclick = () => {
        const mid = sessionStorage.getItem(SS_ME + r.id);
        if (mid) { location.hash = '#room=' + r.id; bootRoom(r.id); }
        else {
          $('#jn-room').value = r.id;
          $$('.ltab').forEach(b => b.classList.toggle('active', b.dataset.ltab === 'join'));
          $('#createForm').hidden = true; $('#joinForm').hidden = false;
          toast('请选择身份后加入该评审');
        }
      };
      listEl.append(row);
    }
  }
}
function showApp() { $('#landing').hidden = true; $('#app').hidden = false; render(); }

function bootRoom(id) {
  state = loadReview(id);
  if (!state) { location.hash = ''; showLanding(); return; }
  meId = sessionStorage.getItem(SS_ME + id);
  if (!meId || !state.members[meId]) {
    showLanding();
    $('#jn-room').value = id;
    $$('.ltab').forEach(b => b.classList.toggle('active', b.dataset.ltab === 'join'));
    $('#createForm').hidden = true; $('#joinForm').hidden = false;
    return;
  }
  connectBus();
  post({ kind: 'hello', snapshot: presenceSnapshot() });
  commit(s => { s.members[meId].lastSeen = Date.now(); });
  showApp();
}
function boot() {
  const m = location.hash.match(/room=([A-Za-z0-9-]+)/);
  if (m) bootRoom(m[1]); else showLanding();
}

/* ---------------- 事件绑定 ---------------- */
$$('.ltab').forEach(b => b.onclick = () => {
  $$('.ltab').forEach(x => x.classList.toggle('active', x === b));
  $('#createForm').hidden = b.dataset.ltab !== 'create';
  $('#joinForm').hidden = b.dataset.ltab !== 'join';
});
$('#createForm').onsubmit = e => { e.preventDefault(); createReview($('#cr-title').value.trim(), $('#cr-name').value.trim(), $('#cr-role').value); };
$('#joinForm').onsubmit = e => {
  e.preventDefault();
  if (joinReview($('#jn-room').value.trim().toUpperCase(), $('#jn-name').value.trim(), $('#jn-role').value)) toast('已加入评审');
};

$$('.tool').forEach(b => b.onclick = () => {
  tool = b.dataset.type || 'select';
  $$('.tool').forEach(x => x.classList.toggle('active', x === b));
});
$$('.color button').forEach(b => b.onclick = () => { color = b.dataset.c; $$('.color button').forEach(x => x.classList.toggle('active', x === b)); });

const board = $('#board');
board.addEventListener('pointerdown', e => {
  if (e.target.closest('.obj-badge')) return;
  const node = e.target.closest('.object');
  if (!node) { selectedId = null; renderBoard(); return; }
  const o = state.objects[node.dataset.oid]; if (!o) return;
  selectedId = o.id; renderBoard();
  if (!canEditBoard() || blockedByConflict(o.id)) return;
  const start = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y, baseTag: o.verTag, version: o.version, moved: false, node };
  function move(ev) {
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
    o.x = Math.max(0, start.ox + dx); o.y = Math.max(0, start.oy + dy);
    start.node.style.left = o.x + 'px'; start.node.style.top = o.y + 'px';
  }
  function up() {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (start.moved) {
      const updated = { ...o, version: start.version + 1, verTag: uid('v'), updatedBy: meId, updatedTs: Date.now() };
      undoStack.push({ kind: 'update', id: o.id, before: structuredClone({ ...o, version: start.version, verTag: start.baseTag, x: start.ox, y: start.oy }) });
      commit(s => { s.objects[o.id] = updated; });
      pushObjectPatch(updated, start.baseTag);
    }
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
board.addEventListener('click', e => {
  if (suppressNextBoardClick) { suppressNextBoardClick = false; return; }
  if (e.target !== board || tool === 'select' || !canEditBoard()) return;
  const r = board.getBoundingClientRect();
  placeObject(e.clientX - r.left, e.clientY - r.top);
});
board.addEventListener('dblclick', e => {
  const node = e.target.closest('.object'); if (!node) return;
  const o = state.objects[node.dataset.oid];
  if (!canEditBoard() || (o.type !== 'note' && o.type !== 'text') || blockedByConflict(o.id)) return;
  selectedId = o.id;
  $('#ed-text').value = o.text || '';
  openModal('#editModal');
});
$('#ed-save').onclick = () => { const v = $('#ed-text').value; if (selectedId) updateObjectText(selectedId, v); closeModal('#editModal'); };
window.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  const modalOpen = !!document.querySelector('.modal-mask:not([hidden])');
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !typing && !modalOpen && canEditBoard()) deleteObject(selectedId);
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && canEditBoard()) { e.preventDefault(); undo(); }
});

$('#undo').onclick = undo;
$('#export').onclick = exportPNG;
$('#btn-advance').onclick = advance;
$('#btn-back').onclick = backStage;
$('#btn-members').onclick = openMembers;
$('#conflictFlag').onclick = () => { const cf = state.conflicts.find(c => !c.resolved); if (cf) openConflict(cf); };
$('#btn-add-comment').onclick = () => openCommentModal(null);
$('#cm-save').onclick = saveComment;
$('#cm-delete').onclick = deleteComment;
$('#cm-file').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { toast('证据图片需 ≤ 2MB'); e.target.value = ''; return; }
  const rd = new FileReader();
  rd.onload = () => { pendingEvidence = { name: f.name, data: rd.result }; $('#cm-evname').textContent = '已选择：' + f.name; };
  rd.readAsDataURL(f);
};
$('#cf-pick-a').onclick = () => resolveConflict('A');
$('#cf-pick-b').onclick = () => resolveConflict('B');
$('#cf-resolve').onclick = () => resolveConflict('merge');
$$('.rtab').forEach(b => b.onclick = () => switchTab(b.dataset.rtab));
$$('#statusFilter button').forEach(b => b.onclick = () => {
  statusFilter = b.dataset.sf;
  $$('#statusFilter button').forEach(x => x.classList.toggle('active', x === b));
  renderComments();
});
$$('[data-close]').forEach(b => b.onclick = () => { const mm = b.closest('.modal-mask'); if (mm) { mm.hidden = true; if (mm.id === 'conflictModal') currentConflictId = null; } });
document.querySelectorAll('.modal-mask').forEach(m => m.addEventListener('click', e => { if (e.target === m) { m.hidden = true; if (m.id === 'conflictModal') currentConflictId = null; } }));
$('#copy').onclick = async () => {
  const url = location.origin + location.pathname + location.hash;
  try { await navigator.clipboard.writeText(url); toast('邀请链接已复制：' + url); }
  catch { prompt('复制邀请链接', url); }
};
$('#exit').onclick = () => { location.hash = ''; showLanding(); };

/* ---------------- 测试钩子（自动化验证用） ---------------- */
window.__rb = {
  get state() { return state; },
  get meId() { return meId; },
  sessions: () => sessions,
  setRole(role) { commit(s => { s.members[meId].role = role; }, `成员身份变更：${me().name} → ${ROLE[role]}`, true); pushStatePatch({ members: { [meId]: state.members[meId] } }); },
  addMember(name, role) {
    const id = uid('mb');
    commit(s => { s.members[id] = { id, name, role, joinedAt: Date.now(), lastSeen: Date.now() }; }, `${name} 以${ROLE[role]}身份加入评审`, true);
    pushStatePatch({ members: { [id]: state.members[id] } });
    return id;
  },
  actAs(id) { meId = id; sessionStorage.setItem(SS_ME + state.id, id); render(); },
  advance, backStage, undo,
  gate: gateForNext,
  place(type, x, y) { tool = type; placeObject(x, y); return selectedId; },
  setText(id, text) { updateObjectText(id, text); },
  snapshotObject: id => structuredClone(state.objects[id]),
  /* 确定性制造冲突：传入“对方编辑前看到的对象快照”与对方的改动 */
  remoteUpdate(id, baseObj, patch, name = '其他编辑者') {
    if (!state.members.remote) {
      commit(s => { s.members.remote = { id: 'remote', name, role: 'editor', joinedAt: Date.now(), lastSeen: Date.now() }; });
    }
    const proposed = { ...structuredClone(baseObj), ...patch, version: baseObj.version + 1, verTag: uid('v'), updatedBy: 'remote', updatedTs: Date.now() + 1 };
    const snap = baseSnapshot();
    snap.members = { remote: state.members.remote };
    snap.objects = { [id]: proposed };
    snap.conflicts = [];
    handlePatch({ session: 'remote-' + uid('s'), ts: Date.now(), kind: 'patch', by: 'remote', byName: name, patchType: 'object-update', objectId: id, baseTag: baseObj.verTag, verTag: proposed.verTag, proposed, snapshot: snap });
  },
  conflicts: () => state.conflicts,
  openConflict(id) { const cf = state.conflicts.find(c => id ? c.id === id : !c.resolved); if (cf) openConflict(cf); },
  setMergeText(t) { $('#cf-merge').value = t; },
  resolve: resolveConflict,
  addComment(content, opts = {}) {
    const id = uid('cm');
    const rec = { id, content, ownerId: opts.ownerId || meId, priority: opts.priority || 'medium', status: opts.status || 'open', by: meId, ts: Date.now(), updatedTs: Date.now(), objectId: opts.objectId || null, evidence: null, evidenceName: null };
    commit(s => { s.comments[id] = rec; }, `提交意见「${content.slice(0, 16)}…」（负责人：${me().name}，优先级${PRIORITY[rec.priority]}）`);
    pushStatePatch({ commentId: id });
    return id;
  },
  setStatus(id, st) { changeStatus(state.comments[id], st); },
  exportPNG,
  STAGES, STATUS,
};

boot();

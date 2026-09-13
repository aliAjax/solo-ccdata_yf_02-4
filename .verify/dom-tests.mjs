/* jsdom 真实执行 index.html + app.js 的端到端验证。
   - 每个 Tab = 独立 JSDOM（独立 sessionStorage），共享一个 localStorage 后端
 *   - Node 原生 BroadcastChannel 跨 JSDOM 实例通信（真实跨标签同步路径）
 *   - reload = 用同一 sessionStorage 重建 JSDOM（模拟刷新）
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = '/workspace';
const html0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('<script src="app.js"></script>', '<script id="appslot"></script>');
const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
/* 用函数式替换注入脚本：避免替换字符串中 $$（app.js 含 const $$）被当成特殊模式 */
const injectApp = h => h.replace('<script id="appslot"></script>', () => `<script>${appjs}</script>`);

const results = [];
function check(name, cond, extra = '') { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 4000, label = '') {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(60); }
  throw new Error('waitFor timeout ' + label + ' ' + (last?.message || ''));
}

/* ---- 共享存储后端 ---- */
const sharedLocal = new Map();
class MemStorage {
  constructor(map) { this.map = map; }
  get length() { return this.map.size; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i) { return [...this.map.keys()][i] ?? null; }
}

const downloads = [];
const pageErrors = [];
let tabSeq = 0;

function makeTab({ width = 1280, sessionMap = new Map(), url = 'http://127.0.0.1:8099/index.html?rbtest=1' } = {}) {
  const html = injectApp(html0);
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url,
    width, height: 900,
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, 'localStorage', { value: new MemStorage(sharedLocal), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: new MemStorage(sessionMap), configurable: true });
      window.structuredClone = globalThis.structuredClone;
      window.BroadcastChannel = globalThis.BroadcastChannel;   // 跨标签真实通信
      window.PointerEvent = class extends window.MouseEvent { constructor(t, i = {}) { super(t, i); this.pointerId = 1; this.pointerType = 'mouse'; } };
      window.confirm = () => true;
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.getAttribute('href') }); };
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
    },
  });
  const w = dom.window, d = w.document;
  function $(s) { return d.querySelector(s); }
  function $$(s) { return [...d.querySelectorAll(s)]; }
  return { dom, w, d, $, $$, sessionMap, name: 'tab' + (++tabSeq) };
}
async function setVal(t, sel, v) { const el = t.$(sel); el.value = v; el.dispatchEvent(new t.w.Event('input', { bubbles: true })); el.dispatchEvent(new t.w.Event('change', { bubbles: true })); }
async function setSelect(t, sel, v) { const el = t.$(sel); el.value = v; el.dispatchEvent(new t.w.Event('change', { bubbles: true })); }
function click(t, sel) { const el = typeof sel === 'string' ? t.$(sel) : sel; el.click(); return el; }

/* ================= 测试开始 ================= */
const A = makeTab();
await sleep(50);
// A：主持人创建评审
await setVal(A, '#cr-title', '首页改版方案评审');
await setVal(A, '#cr-name', '王主持');
click(A, '#createForm button.primary');
await waitFor(() => !A.$('#app').hidden);
const roomId = A.$('#roomId').textContent;
check('主持人创建评审并进入空间', /^REV-/.test(roomId), roomId);
check('初始阶段为「收集」', A.$('.stage.active').textContent.includes('收集'));

// B：编辑者加入
const B = makeTab(); await sleep(30);
click(B, '.ltab[data-ltab="join"]');
await setVal(B, '#jn-room', roomId);
await setVal(B, '#jn-name', '李编辑');
await setSelect(B, '#jn-role', 'editor');
click(B, '#joinForm button.primary');
await waitFor(() => !B.$('#app').hidden);

// C：观察者加入
const C = makeTab(); await sleep(30);
click(C, '.ltab[data-ltab="join"]');
await setVal(C, '#jn-room', roomId);
await setVal(C, '#jn-name', '赵观察');
await setSelect(C, '#jn-role', 'observer');
click(C, '#joinForm button.primary');
await waitFor(() => !C.$('#app').hidden);
await sleep(200);

/* ---------- 1. 身份限制 ---------- */
check('观察者：绘制工具被禁用', C.$('.tool[data-type="note"]').disabled);
check('观察者：提交意见按钮禁用', C.$('#btn-add-comment').disabled);
check('观察者：没有阶段推进按钮', C.$('#btn-advance').hidden);
const n0 = await A.w.eval(`Object.keys(__rb.state.objects).length`);
C.w.eval(`__rb.place('note',120,120)`);
await sleep(150);
const n1 = await A.w.eval(`Object.keys(__rb.state.objects).length`);
check('观察者放置元素被拒绝', n0 === n1, `${n0} vs ${n1}`);
C.w.eval(`__rb.advance()`);
check('观察者推进阶段被拒', C.$('#toast').textContent.includes('仅主持人'));
check('观察者仍可导出 PNG', !C.$('#export').disabled);

/* ---------- 2. 编辑者真实点击画板放置 + 多标签同步 ---------- */
// jsdom 无布局：getBoundingClientRect 为 0，直接派发带 clientX/Y 的 click
B.$('#board').dispatchEvent(new B.w.MouseEvent('click', { bubbles: true, clientX: 160, clientY: 150 }));
await waitFor(() => A.w.eval(`Object.keys(__rb.state.objects).length`) === n0 + 1);
check('编辑者可放置元素（真实 DOM click 事件）', true);
const objBId = B.w.eval(`Object.keys(__rb.state.objects)[0]`);
check('放置的元素实时同步到主持人标签', A.w.eval(`!!__rb.state.objects[${JSON.stringify(objBId)}]`));
check('成员数同步为 3', A.$('#memberCount').textContent.trim() === '3', A.$('#memberCount').textContent);
check('在线人数显示（主持人标签）', A.$('#peopleLabel').textContent.includes('在线'));

/* ---------- 3. 意见 + 证据（真实表单流程） ---------- */
click(B, '#btn-add-comment');
await waitFor(() => !B.$('#commentModal').hidden);
await setVal(B, '#cm-content', '首屏导航层级过深，建议合并为一级入口');
await setSelect(B, '#cm-priority', 'high');
// 证据图片：构造 File 挂到 input.files，触发 change（走真实 FileReader）
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = new B.w.File([png1x1], 'evidence.png', { type: 'image/png' });
Object.defineProperty(B.$('#cm-file'), 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
B.$('#cm-file').dispatchEvent(new B.w.Event('change', { bubbles: true }));
await waitFor(() => B.$('#cm-evname').textContent.includes('evidence.png'));
click(B, '#cm-save');
await waitFor(() => A.d.querySelectorAll('.cmt').length === 1);
const cmtTxt = A.$('.cmt').textContent;
check('意见同步并显示优先级/负责人', cmtTxt.includes('优先级：高') && cmtTxt.includes('负责人：李编辑'), cmtTxt.replace(/\s+/g, ' ').slice(0, 80));
const cmtId = B.w.eval(`Object.keys(__rb.state.comments)[0]`);
check('证据图片转存本地并随意见同步', A.w.eval(`(function(){var c=__rb.state.comments[${JSON.stringify(cmtId)}];return c.evidenceName==='evidence.png'&&c.evidence.startsWith('data:image');})()`));

// 非法跳状态
B.w.eval(`__rb.setStatus(${JSON.stringify(cmtId)},'approved')`);
check('状态门禁：待处理不能直接到通过', B.$('#toast').textContent.includes('不能从'));
check('被拦后状态仍为待处理', B.w.eval(`__rb.state.comments[${JSON.stringify(cmtId)}].status`) === 'open');

/* ---------- 4. 阶段门禁 ---------- */
click(A, '#btn-advance');
check('收集→讨论：有意见时放行', A.$('.stage.active').textContent.includes('讨论'));
await waitFor(() => B.w.eval(`__rb.state.stage`) === 'discuss');
check('阶段推进实时同步到编辑者标签', true);
check('编辑者看不到推进按钮', B.$('#btn-advance').hidden);

click(A, '#btn-advance');
check('门禁：仍有待处理意见，不能进入决议', A.$('#stageHint').textContent.includes('待处理'));
check('阶段仍停留在讨论', A.$('.stage.active').textContent.includes('讨论'));

B.w.eval(`__rb.setStatus(${JSON.stringify(cmtId)},'reviewing')`);
await sleep(150);
click(A, '#btn-advance');
check('意见核验中可进入决议', A.$('.stage.active').textContent.includes('决议'));

click(A, '#btn-advance');
check('门禁：核验中未给结论不能归档', A.$('#stageHint').textContent.includes('驳回'));

B.w.eval(`__rb.setStatus(${JSON.stringify(cmtId)},'approved')`);
await waitFor(() => A.w.eval(`__rb.state.comments[${JSON.stringify(cmtId)}].status`) === 'approved');
check('核验中 → 通过 合法流转', true);
click(A, '#btn-advance');
check('全部有结论后可归档', A.$('.stage.active').textContent.includes('归档'));
await waitFor(() => B.w.eval(`__rb.state.stage`) === 'archive');

// 归档只读
const na = B.w.eval(`Object.keys(__rb.state.objects).length`);
B.$('#board').dispatchEvent(new B.w.MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }));
await sleep(150);
check('归档后画板锁定，编辑者无法新增', B.w.eval(`Object.keys(__rb.state.objects).length`) === na);
check('归档后提交意见禁用', B.$('#btn-add-comment').disabled);
check('归档后观察者导出仍可用', !C.$('#export').disabled);

click(A, '#btn-back');
await sleep(150);
check('主持人可回退阶段（归档→决议）', A.$('.stage.active').textContent.includes('决议'));
await waitFor(() => C.w.eval(`__rb.state.stage`) === 'decide');
check('阶段回退同步到观察者标签', true);

/* ---------- 5. 审计 ---------- */
click(A, '.rtab[data-rtab="audit"]');
const auditTxt = A.$('#auditList').textContent;
check('审计含创建/推进/归档关键记录', auditTxt.includes('创建评审') && auditTxt.includes('阶段推进') && auditTxt.includes('归档'));
check('审计含意见状态流转', auditTxt.includes('核验中 → 通过'));
check('审计含成员加入记录', auditTxt.includes('以观察者身份加入') || auditTxt.includes('以编辑者身份加入'));

/* ---------- 5b. 越权攻击（调试接口 + 伪造总线消息） ---------- */
// 普通访问不挂载 __rb
{
  const plain = makeTab({ url: 'http://127.0.0.1:8099/index.html' });
  check('普通访问不暴露调试接口 __rb', plain.w.eval(`typeof window.__rb`) === 'undefined');
}
const attackCmt = A.w.eval(`__rb.addComment('安全测试意见',{priority:'medium'})`);
await waitFor(() => C.w.eval(`Object.keys(__rb.state.comments).length`) === 2);
const cObserverId = C.w.eval(`__rb.meId`);
C.w.eval(`__rb.setStatus(${JSON.stringify(attackCmt)},'approved')`);
check('观察者 setStatus 被拒', C.$('#toast').textContent.includes('观察者'));
check('意见状态不变', A.w.eval(`__rb.state.comments[${JSON.stringify(attackCmt)}].status`) === 'open');
check('观察者 addComment 被拒（null）', C.w.eval(`__rb.addComment('偷提')`) === null);
C.w.eval(`__rb.setRole('host')`);
check('观察者 setRole 提权被拒', C.$('#toast').textContent.includes('仅主持人'));
check('身份仍为观察者', A.w.eval(`__rb.state.members[${JSON.stringify(cObserverId)}].role`) === 'observer');
check('观察者 addMember 被拒（null）', C.w.eval(`__rb.addMember('内鬼','host')`) === null);
C.w.eval(`__rb.openConflict()`);
check('观察者裁决冲突被拒', C.$('#toast').textContent.includes('仅主持人'));
// 伪造底层补丁
const aHostId2 = A.w.eval(`__rb.meId`);
C.w.eval(`(function(p){
  const ch = new BroadcastChannel('rb.channel.'+__rb.state.id);
  ch.postMessage({kind:'patch',session:'evil1',ts:Date.now(),by:__rb.meId,byName:'赵观察',patchType:'member-role',snapshot:{members:{[__rb.meId]:{...__rb.state.members[__rb.meId],role:'host'}}}});
  ch.postMessage({kind:'patch',session:'evil2',ts:Date.now(),by:__rb.meId,byName:'赵观察',patchType:'member-remove',snapshot:{members:{[p.hid]:{id:p.hid,removed:true}}}});
  ch.postMessage({kind:'patch',session:'evil3',ts:Date.now(),by:__rb.meId,byName:'赵观察',patchType:'object-update',objectId:'evil',baseTag:'b',verTag:'v',proposed:{id:'evil'},snapshot:{objects:{evil:{id:'evil',type:'note',x:1,y:1,text:'伪造',verTag:'v'}}}});
  ch.postMessage({kind:'patch',session:'evil4',ts:Date.now(),by:__rb.meId,byName:'赵观察',patchType:'state',snapshot:{commentTombstones:[p.cid]}});
  ch.postMessage({kind:'patch',session:'stranger',ts:Date.now(),by:'mb-ghost',byName:'陌生人',patchType:'state',snapshot:{comments:{[p.cid]:{id:p.cid,status:'approved'}}}});
})(${JSON.stringify({ cid: attackCmt, hid: aHostId2 })})`);
await sleep(300);
check('伪造提权补丁被丢弃', A.w.eval(`__rb.state.members[${JSON.stringify(cObserverId)}].role`) === 'observer');
check('伪造移除主持人补丁被丢弃', A.w.eval(`!!__rb.state.members[${JSON.stringify(aHostId2)}]`) === true);
check('伪造对象补丁被丢弃', A.w.eval(`!__rb.state.objects.evil`) === true);
check('伪造删除意见补丁被丢弃', A.w.eval(`!!__rb.state.comments[${JSON.stringify(attackCmt)}]`) === true);
check('未知发送者补丁被丢弃', A.w.eval(`__rb.state.comments[${JSON.stringify(attackCmt)}].status`) === 'open');
// 编辑者权限边界：不能管理成员（改他人角色）、不能裁决
{
  const editorId = B.w.eval(`__rb.meId`);
  B.w.eval(`__rb.setRole('host')`);
  check('编辑者不能自行提权', B.$('#toast').textContent.includes('仅主持人') && A.w.eval(`__rb.state.members[${JSON.stringify(editorId)}].role`) === 'editor');
}

/* ---------- 6. 冲突裁决 ---------- */
A.w.eval(`while(__rb.state.stage!=='collect')__rb.backStage();`);
await sleep(200);

const oid2 = A.w.eval(`__rb.place('note',420,120)`);
const base2 = A.w.eval(`__rb.snapshotObject(${JSON.stringify(oid2)})`);
A.w.eval(`__rb.setText(${JSON.stringify(oid2)},'主持人：标题改成 A')`);
A.w.eval(`__rb.remoteUpdate(${JSON.stringify(oid2)}, ${JSON.stringify(base2)}, {text:'编辑者：标题改成 B'}, '李编辑')`);
await sleep(250);
const cfRaw = A.w.eval(`JSON.stringify(__rb.conflicts().filter(c=>!c.resolved))`);
check('并发改同一元素：检测到冲突并保留两个版本', cfRaw.includes('主持人：标题改成 A') && cfRaw.includes('编辑者：标题改成 B'), cfRaw.slice(0, 100));
check('画板元素出现冲突态样式', A.$(`[data-oid="${oid2}"]`).classList.contains('conflicted'));
check('顶部出现待裁决冲突提示', !A.$('#conflictFlag').hidden);

// 冲突期间双方不能写入该元素
B.w.eval(`__rb.setText(${JSON.stringify(oid2)},'试图强改')`);
check('冲突期间编辑者不能写入', B.w.eval(`__rb.state.objects[${JSON.stringify(oid2)}].text`) !== '试图强改');
// 编辑者不能裁决
B.w.eval(`__rb.openConflict()`);
check('冲突只能由主持人裁决（编辑者被拒）', B.$('#toast').textContent.includes('主持人'));

// 主持人合并
click(A, '#conflictFlag');
await waitFor(() => !A.$('#conflictModal').hidden);
check('裁决弹窗展示两个版本', A.$('#cf-a').value.includes('主持人：标题改成 A') && A.$('#cf-b').value.includes('编辑者：标题改成 B'));
A.$('#cf-merge').value = '合并结论：采用 A 的结构 + B 的措辞';
A.$('#cf-merge').dispatchEvent(new A.w.Event('input', { bubbles: true }));
click(A, '#cf-resolve');
await sleep(250);
check('主持人合并后写入最终版本', A.w.eval(`__rb.state.objects[${JSON.stringify(oid2)}].text`) === '合并结论：采用 A 的结构 + B 的措辞');
check('冲突消解、提示消失', A.w.eval(`__rb.conflicts().filter(c=>!c.resolved).length`) === 0 && A.$('#conflictFlag').hidden);
check('裁决写入关键审计', A.w.eval(`__rb.state.audit.some(x=>x.text.includes('裁决元素冲突')&&x.critical)`));
await waitFor(() => B.w.eval(`__rb.state.objects[${JSON.stringify(oid2)}]?.text`) === '合并结论：采用 A 的结构 + B 的措辞');
check('合并结果同步到编辑者标签', true);

// 第二次冲突：选择版本 B
const oid3 = A.w.eval(`__rb.place('note',520,300)`);
const base3 = A.w.eval(`__rb.snapshotObject(${JSON.stringify(oid3)})`);
A.w.eval(`__rb.setText(${JSON.stringify(oid3)},'主持人版本C')`);
A.w.eval(`__rb.remoteUpdate(${JSON.stringify(oid3)}, ${JSON.stringify(base3)}, {text:'编辑者版本D'}, '李编辑')`);
await sleep(200);
click(A, '#conflictFlag');
click(A, '#cf-pick-b');
await sleep(200);
check('支持直接选择某一版本写入（选 B）', A.w.eval(`__rb.state.objects[${JSON.stringify(oid3)}].text`) === '编辑者版本D');

/* ---------- 7. 旧能力：撤销/删除/拖动/双击编辑 ---------- */
const nb = A.w.eval(`Object.keys(__rb.state.objects).length`);
A.w.eval(`__rb.place('rect',60,480)`);
A.w.eval(`__rb.undo()`);
await sleep(200);
check('撤销可用（撤销刚放置的元素）', A.w.eval(`Object.keys(__rb.state.objects).length`) === nb);

const delId = A.w.eval(`__rb.place('circle',100,400)`);
// 选中 + Delete（真实事件链：pointerdown → keydown）
const delNode = A.$(`[data-oid="${delId}"]`);
delNode.dispatchEvent(new A.w.PointerEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 410 }));
A.d.dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
await sleep(150);
check('Delete 删除元素可用', A.w.eval(`!__rb.state.objects[${JSON.stringify(delId)}]`));

// 拖动：pointerdown → window pointermove ×n → pointerup（真实事件链）
const dragId = A.w.eval(`__rb.place('circle',300,400)`);
const dn = A.$(`[data-oid="${dragId}"]`);
dn.dispatchEvent(new A.w.PointerEvent('pointerdown', { bubbles: true, clientX: 310, clientY: 410 }));
for (let i = 1; i <= 6; i++) A.w.dispatchEvent(new A.w.PointerEvent('pointermove', { clientX: 310 + i * 15, clientY: 410 + i * 12, bubbles: true }));
A.w.dispatchEvent(new A.w.PointerEvent('pointerup', { bubbles: true }));
await sleep(200);
const pos = A.w.eval(`JSON.stringify({x:__rb.state.objects[${JSON.stringify(dragId)}].x,y:__rb.state.objects[${JSON.stringify(dragId)}].y})`);
const p = JSON.parse(pos);
check('拖动元素位置更新并广播', p.x > 350 && p.y > 440, pos);

// 双击编辑（真实 dblclick → 弹窗 → 保存）
const txtId = A.w.eval(`__rb.place('text',200,520)`);
A.$(`[data-oid="${txtId}"]`).dispatchEvent(new A.w.MouseEvent('dblclick', { bubbles: true }));
await waitFor(() => !A.$('#editModal').hidden);
A.$('#ed-text').value = '通过双击修改的文本';
click(A, '#ed-save');
await sleep(200);
check('双击编辑文本可用并写入', A.w.eval(`__rb.state.objects[${JSON.stringify(txtId)}].text`) === '通过双击修改的文本');

/* ---------- 8. 刷新恢复 ---------- */
const A2 = makeTab({ sessionMap: A.sessionMap });   // 同标签 sessionStorage 保留
A2.w.location.hash = '#room=' + roomId;
A2.w.eval(`boot && boot()`);
await waitFor(() => !A2.$('#app').hidden);
const restored = A2.w.eval(`JSON.stringify({stage:__rb.state.stage,obj:Object.keys(__rb.state.objects).length,cmt:Object.keys(__rb.state.comments).length,merged:__rb.state.objects[${JSON.stringify(oid2)}]?.text,role:document.querySelector('#me-badge').textContent})`);
const r = JSON.parse(restored);
check('刷新后恢复阶段/画板/意见/合并结果/身份', r.stage === 'collect' && r.obj >= 3 && r.cmt === 2 && r.merged === '合并结论：采用 A 的结构 + B 的措辞' && r.role.includes('王主持'), restored);

// 退出 → 从入口记录重开
click(A2, '#exit');
await waitFor(() => !A2.$('#landing').hidden);
check('入口页列出本机评审记录', A2.d.querySelectorAll('.review-row').length >= 1);
const row = [...A2.d.querySelectorAll('.review-row')].find(x => x.textContent.includes('首页改版方案评审'));
row.click();
await waitFor(() => !A2.$('#app').hidden);
check('从记录重开后身份与数据恢复', A2.$('#me-badge').textContent.includes('王主持') && A2.$('#roomId').textContent === roomId);

/* ---------- 9. 导出真实 PNG（canvas 渲染 + 下载） ---------- */
click(A2, '#export');
await sleep(300);
const dl = downloads.find(x => x.name.includes(roomId));
let pngOk = false, pngSize = 0;
if (dl) {
  const b64 = dl.href.split(',')[1];
  const buf = Buffer.from(b64, 'base64');
  pngOk = buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 1000; pngSize = buf.length;
  fs.writeFileSync('/tmp/exported.png', buf);
}
check('导出真实 PNG 文件且非空', pngOk, `${pngSize} bytes`);

/* ---------- 10. 主持人 UI 修改成员身份并同步 ---------- */
click(A2, '#btn-members');
await waitFor(() => !A2.$('#membersModal').hidden);
const rows = A2.d.querySelectorAll('#memberRows .mrow');
const second = rows[1];
check('成员列表第二行是李编辑', second.textContent.includes('李编辑'));
second.querySelector('select').value = 'observer';
second.querySelector('select').dispatchEvent(new A2.w.Event('change', { bubbles: true }));
await sleep(250);
check('主持人将编辑者降级为观察者（UI）', B.w.eval(`__rb.state.members[__rb.meId].role`) === 'observer');
check('被降级标签工具实时禁用', B.$('.tool[data-type="note"]').disabled);

/* ---------- 11. 窄屏：静态响应式规则 + 390px 下核心流程可执行 ---------- */
const mq720 = css.includes('@media(max-width:720px)');
const cssCovers = mq720 && css.includes('grid-template-columns:1fr') && css.includes('.board{height:54vh');
const P = makeTab({ width: 390, sessionMap: new Map() });
P.w.innerWidth = 390;
await sleep(30);
await setVal(P, '#cr-title', '窄屏冒烟评审');
await setVal(P, '#cr-name', '周主持');
click(P, '#createForm button.primary');
await waitFor(() => !P.$('#app').hidden);
P.$('#board').dispatchEvent(new P.w.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 80 }));
await sleep(150);
const pObj = P.w.eval(`Object.keys(__rb.state.objects).length===1`);
click(P, '#btn-add-comment');
P.$('#cm-content').value = '窄屏下提交一条意见';
click(P, '#cm-save');
await sleep(150);
P.$('#btn-advance').scrollIntoView();
click(P, '#btn-advance');
const pStage = P.$('.stage.active').textContent.includes('讨论');
check('窄屏：响应式 CSS 存在且核心流程（创建/绘制/意见/推进）可完成', cssCovers && pObj && P.d.querySelectorAll('.cmt').length === 1 && pStage, `css=${cssCovers} obj=${pObj} stage=${pStage}`);

/* ---------- 控制台错误 ---------- */
const realErrors = pageErrors.filter(e => !/Could not parse CSS|Not implemented: navigation/.test(e));
check('运行期间无未捕获脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(' - ' + f.name + ' ' + f.extra)); process.exit(1); }
process.exit(0);

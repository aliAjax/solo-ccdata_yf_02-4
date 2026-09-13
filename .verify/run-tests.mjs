import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:8099/index.html?rbtest=1';
const BASE_PLAIN = 'http://127.0.0.1:8099/index.html';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 4000, label } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(100);
  }
  throw new Error('waitFor timeout: ' + (label || '') + ' ' + (lastErr?.message || ''));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

/* ---------- Tab A：主持人创建评审 ---------- */
const a = await context.newPage();
const errors = [];
a.on('pageerror', e => errors.push('A: ' + e.message));
await a.goto(BASE);
await a.fill('#cr-title', '首页改版方案评审');
await a.fill('#cr-name', '王主持');
await a.click('#createForm button.primary');
await a.waitForSelector('#app:not([hidden])');
const roomId = await a.textContent('#roomId');
check('主持人创建评审并进入空间', /^REV-/.test(roomId), roomId);
check('初始阶段为「收集」', (await a.textContent('.stage.active')).includes('收集'));

/* ---------- Tab B：编辑者加入 ---------- */
const b = await context.newPage();
b.on('pageerror', e => errors.push('B: ' + e.message));
await b.goto(BASE);
await b.click('.ltab[data-ltab="join"]');
await b.fill('#jn-room', roomId);
await b.fill('#jn-name', '李编辑');
await b.selectOption('#jn-role', 'editor');
await b.click('#joinForm button.primary');
await b.waitForSelector('#app:not([hidden])');

/* ---------- Tab C：观察者加入 ---------- */
const c = await context.newPage();
c.on('pageerror', e => errors.push('C: ' + e.message));
await c.goto(BASE);
await c.click('.ltab[data-ltab="join"]');
await c.fill('#jn-room', roomId);
await c.fill('#jn-name', '赵观察');
await c.selectOption('#jn-role', 'observer');
await c.click('#joinForm button.primary');
await c.waitForSelector('#app:not([hidden])');
await sleep(500);

/* ---------- 1. 身份限制 ---------- */
// 观察者：工具禁用、提交按钮禁用、无阶段推进按钮、不能放元素
check('观察者：绘制工具被禁用', await c.$eval('.tool[data-type="note"]', el => el.disabled));
check('观察者：提交意见按钮禁用', await c.$eval('#btn-add-comment', el => el.disabled));
check('观察者：没有阶段推进按钮', await c.$eval('#btn-advance', el => el.hidden));
const objsBefore = await a.evaluate(() => Object.keys(__rb.state.objects).length);
await c.evaluate(() => __rb.place('note', 120, 120));
await sleep(200);
const objsAfterObs = await a.evaluate(() => Object.keys(__rb.state.objects).length);
check('观察者放置元素被拒绝（对象数不变）', objsBefore === objsAfterObs, `${objsBefore} vs ${objsAfterObs}`);
// 观察者尝试推进（直接调内部函数也应被拦）
const toastObs = await (async () => {
  await c.evaluate(() => __rb.advance());
  return c.textContent('#toast');
})();
check('观察者推进阶段被拒', toastObs.includes('仅主持人'));
// 观察者仍可导出
const obsCanExport = await c.$eval('#export', el => !el.disabled);
check('观察者可以导出 PNG', obsCanExport);


// 编辑者：可以放元素（通过真实点击画板）
const bb = await b.locator('#board').boundingBox();
await b.mouse.click(bb.x + 160, bb.y + 150);
await sleep(400);
await waitFor(async () => (await a.evaluate(() => Object.keys(__rb.state.objects).length)) === objsBefore + 1, { label: 'sync new object' });
check('编辑者可在画板放置元素', true);

/* ---------- 2. 多标签同步：元素 / 成员 / 在线指示 ---------- */
check('编辑者放置的元素实时同步到主持人标签', (await a.evaluate(() => Object.keys(__rb.state.objects).length)) === objsBefore + 1);
const connTxt = await a.textContent('#sync');
check('主持人标签显示多标签连接', connTxt.includes('2') || connTxt.includes('3'), connTxt);
const memberCountA = await a.textContent('#memberCount');
check('成员数同步为 3', memberCountA.trim() === '3', memberCountA);

/* ---------- 3. 意见：负责人/优先级/状态流转（编辑者 UI 提交，含证据图片） ---------- */
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync('/tmp/evidence.png', png1x1);
await b.click('#btn-add-comment');
await b.fill('#cm-content', '首屏导航层级过深，建议合并为一级入口');
await b.selectOption('#cm-priority', 'high');
await b.setInputFiles('#cm-file', '/tmp/evidence.png');
await waitFor(() => b.locator('#cm-evname').allTextContents().then(t => t.join().includes('evidence.png')));
await b.click('#cm-save');
await waitFor(async () => (await a.locator('.cmt').count()) === 1, { timeout: 8000 });
const cmtTxt = await a.locator('.cmt').first().innerText();
check('意见同步并显示优先级/负责人', cmtTxt.includes('优先级：高') && cmtTxt.includes('负责人：李编辑'), cmtTxt.replace(/\n/g, ' | '));
check('证据图片随意见保存', await a.evaluate(() => { const c = Object.values(__rb.state.comments)[0]; return c.evidenceName === 'evidence.png' && c.evidence?.startsWith('data:image'); }));
const cmtId = await b.evaluate(() => Object.keys(__rb.state.comments)[0]);

// 非法跳状态：待处理 → 通过，应被拦
await b.evaluate(id => __rb.setStatus(id, 'approved'), cmtId);
check('状态门禁：待处理不能直接到通过', (await b.textContent('#toast')).includes('不能从'));
const stillOpen = await b.evaluate(id => __rb.state.comments[id].status, cmtId);
check('被拦后状态仍为待处理', stillOpen === 'open');

/* ---------- 4. 阶段门禁 ---------- */
// 收集→讨论（已有 1 条意见）应放行
await a.click('#btn-advance');
check('收集→讨论：有意见时可推进', (await a.textContent('.stage.active')).includes('讨论'));
await waitFor(() => b.evaluate(() => __rb.state.stage === 'discuss'));
check('阶段推进实时同步到编辑者标签', true);

// 讨论阶段编辑者不能跳推进（按钮隐藏）
check('编辑者看不到推进按钮', await b.$eval('#btn-advance', el => el.hidden));

// 待处理意见阻止讨论→决议
const blocked1 = await (async () => { await a.click('#btn-advance'); return a.textContent('#stageHint'); })();
check('门禁：存在待处理意见时不能进入决议', blocked1.includes('待处理'));
check('阶段仍停留在讨论', (await a.textContent('.stage.active')).includes('讨论'));

// 合法流转：open → reviewing
await b.evaluate(id => __rb.setStatus(id, 'reviewing'), cmtId);
await sleep(300);
// 讨论→决议：reviewing 允许（讨论门禁只拦 open）
await a.click('#btn-advance');
check('意见核验中时可进入决议', (await a.textContent('.stage.active')).includes('决议'));

// 决议→归档：核验中未给结论，阻止
const blocked2 = await (async () => { await a.click('#btn-advance'); return a.textContent('#stageHint'); })();
check('门禁：核验中未给结论不能归档', blocked2.includes('通过') && blocked2.includes('驳回'));

// 非法：reviewing → open 允许退回；approved 必须先经 reviewing
await b.evaluate(id => __rb.setStatus(id, 'approved'), cmtId);
await sleep(300);
const approved = await a.evaluate(id => __rb.state.comments[id].status, cmtId);
check('核验中 → 通过 合法流转', approved === 'approved');
await a.click('#btn-advance');
check('全部有结论后可归档', (await a.textContent('.stage.active')).includes('归档'));

// 归档后只读：编辑者不能再放元素、不能提交意见
const objsArc = await b.evaluate(() => Object.keys(__rb.state.objects).length);
await b.mouse.click(bb.x + 300, bb.y + 300);
await sleep(300);
const objsArc2 = await b.evaluate(() => Object.keys(__rb.state.objects).length);
check('归档后画板锁定，编辑者无法新增', objsArc === objsArc2);
check('归档后提交意见禁用', await b.$eval('#btn-add-comment', el => el.disabled));

// 主持人回退阶段
await a.click('#btn-back');
await sleep(200);
check('主持人可回退阶段（归档→决议）', (await a.textContent('.stage.active')).includes('决议'));
await waitFor(() => c.evaluate(() => __rb.state.stage === 'decide'));
check('阶段回退同步到观察者标签', true);

/* ---------- 5. 审计记录 ---------- */
await a.click('.rtab[data-rtab="audit"]');
const auditTxt = await a.textContent('#auditList');
check('审计含创建/推进/归档/身份等关键记录', auditTxt.includes('创建评审') && auditTxt.includes('阶段推进') && auditTxt.includes('归档'));
check('审计含意见状态变更记录', auditTxt.includes('状态：核验中 → 通过'));

/* ---------- 5b. 越权攻击：调试接口 / 伪造消息都不能提权或改数据 ---------- */
// 普通访问（无 ?rbtest=1）根本不存在调试接口
const plain = await context.newPage();
await plain.goto(BASE_PLAIN);
check('普通访问不暴露调试接口 __rb', await plain.evaluate(() => typeof window.__rb === 'undefined'));
await plain.close();

// 观察者通过调试接口尝试：改意见状态（先由主持人再造一条意见）
const commentsBeforeAttack = await c.evaluate(() => Object.keys(__rb.state.comments).length);
const attackCmt = await a.evaluate(() => __rb.addComment('安全测试意见', { priority: 'medium' }));
await waitFor(async () => (await c.evaluate(() => Object.keys(__rb.state.comments).length)) === commentsBeforeAttack + 1, { timeout: 4000 });
const cRoleBefore = await c.evaluate(() => __rb.state.members[__rb.meId].role);
await c.evaluate(id => __rb.setStatus(id, 'approved'), attackCmt);
check('观察者调用 setStatus 改意见状态被拒', (await c.textContent('#toast')).includes('观察者'));
check('意见状态保持待处理', await a.evaluate(id => __rb.state.comments[id].status, attackCmt) === 'open');

// 观察者尝试提交意见（调试接口）
const beforeCmtN = await a.evaluate(() => Object.keys(__rb.state.comments).length);
const observerCmt = await c.evaluate(() => __rb.addComment('观察者偷提意见'));
check('观察者 addComment 返回 null（被拒）', observerCmt === null);
await sleep(200);
check('观察者没有产生新意见', await a.evaluate(() => Object.keys(__rb.state.comments).length) === beforeCmtN);

// 观察者尝试把自己提升为主持人
await c.evaluate(() => __rb.setRole('host'));
check('观察者 setRole 提权被拒', (await c.textContent('#toast')).includes('仅主持人'));
const observerId = await c.evaluate(() => __rb.meId);
check('观察者身份仍为观察者', await a.evaluate(id => __rb.state.members[id].role, observerId) === 'observer');

// 观察者尝试添加成员 / 裁决冲突 / 推进阶段（调试接口）
const memBefore = await a.evaluate(() => Object.keys(__rb.state.members).length);
check('观察者 addMember 被拒（返回 null）', await c.evaluate(() => __rb.addMember('内鬼', 'host')) === null);
await sleep(150);
check('未新增成员', await a.evaluate(() => Object.keys(__rb.state.members).length) === memBefore);
await c.evaluate(() => __rb.resolve && __rb.resolve('A'));
check('观察者直接 resolve 冲突被拒', (await c.textContent('#toast')).includes('仅主持人'));

// 观察者伪造底层补丁：自封主持人的 member-role / member-remove / 改对象 / 删意见
await c.evaluate(({ cid, hid }) => {
  const ch = new BroadcastChannel('rb.channel.' + __rb.state.id);
  // 自封主持人
  ch.postMessage({ kind: 'patch', session: 'evil1', ts: Date.now(), by: __rb.meId, byName: '赵观察', patchType: 'member-role', snapshot: { members: { [__rb.meId]: { ...__rb.state.members[__rb.meId], role: 'host' } } } });
  // 踢掉主持人
  ch.postMessage({ kind: 'patch', session: 'evil2', ts: Date.now(), by: __rb.meId, byName: '赵观察', patchType: 'member-remove', snapshot: { members: { [hid]: { id: hid, removed: true } } } });
  // 改画板对象（若有）
  ch.postMessage({ kind: 'patch', session: 'evil3', ts: Date.now(), by: __rb.meId, byName: '赵观察', patchType: 'object-update', objectId: 'x', baseTag: 'b', verTag: 'v', proposed: { id: 'x' }, snapshot: { objects: { evil: { id: 'evil', type: 'note', x: 1, y: 1, text: '观察者伪造', verTag: 'v' } } } });
  // 删除意见
  ch.postMessage({ kind: 'patch', session: 'evil4', ts: Date.now(), by: __rb.meId, byName: '赵观察', patchType: 'state', snapshot: { commentTombstones: [cid] } });
}, { cid: attackCmt, hid: await a.evaluate(() => __rb.meId) });
await sleep(400);
check('伪造 member-role 被丢弃（观察者未提权）', await a.evaluate(() => Object.values(__rb.state.members).find(m => m.name === '赵观察').role) === 'observer');
check('伪造 member-remove 被丢弃（主持人仍在）', await a.evaluate(id => !!__rb.state.members[id], await a.evaluate(() => __rb.meId)));
check('伪造对象补丁被丢弃（无 evil 对象）', await a.evaluate(() => !__rb.state.objects.evil));
check('伪造意见删除被丢弃（意见仍在）', await a.evaluate(id => !!__rb.state.comments[id], attackCmt));

// 未知发送者的补丁同样被丢弃
await a.evaluate(cid => {
  const ch = new BroadcastChannel('rb.channel.' + __rb.state.id);
  ch.postMessage({ kind: 'patch', session: 'stranger', ts: Date.now(), by: 'mb-nonexistent', byName: '陌生人', patchType: 'state', snapshot: { comments: { [cid]: { id: cid, status: 'approved' } } } });
}, attackCmt);
await sleep(300);
check('未知发送者补丁被丢弃', await a.evaluate(id => __rb.state.comments[id].status, attackCmt) === 'open');
check('观察者本人身份在 C 标签也未变', cRoleBefore === 'observer');

/* ---------- 5c. 编辑者权限边界：不能裁决/管理成员/推进阶段/删除他人意见 ---------- */
await b.evaluate(() => __rb.advance());
check('编辑者直接调用推进被拒', (await b.textContent('#toast')).includes('仅主持人'));
check('阶段未被编辑者改变', await a.evaluate(() => __rb.state.stage) === 'decide');
await b.evaluate(() => __rb.resolve('A'));
check('编辑者直接裁决被拒', (await b.textContent('#toast')).includes('仅主持人'));
check('编辑者 addMember 被拒（返回 null）', await b.evaluate(() => __rb.addMember('内鬼编辑', 'host')) === null);
const commentsBeforeDel = await a.evaluate(() => Object.keys(__rb.state.comments).length);
// 编辑者伪造删除主持人意见的 commentTombstone 补丁，应被入站授权丢弃
await b.evaluate(cid => {
  const ch = new BroadcastChannel('rb.channel.' + __rb.state.id);
  ch.postMessage({ kind: 'patch', session: 'ed-evil', ts: Date.now(), by: __rb.meId, byName: '李编辑', patchType: 'state', snapshot: { commentTombstones: [cid] } });
}, attackCmt);
await sleep(300);
check('编辑者伪造删除他人意见被丢弃', await a.evaluate(id => !!__rb.state.comments[id], attackCmt) === true);
check('意见总数未变', await a.evaluate(() => Object.keys(__rb.state.comments).length) === commentsBeforeDel);

/* ---------- 6. 冲突裁决 ---------- */
// 回到收集阶段以便继续编辑（主持人回退到收集）
await a.evaluate(() => { while (__rb.state.stage !== 'collect') __rb.backStage(); });
await sleep(300);

// 主持人放一个便签；主持人与“另一位编辑者”都基于放置后的首版分别改动（确定性并发）
const oid2 = await a.evaluate(() => __rb.place('note', 420, 120));
const base2 = await a.evaluate(id => __rb.snapshotObject(id), oid2);   // 共同祖先（首版）
await a.evaluate(id => __rb.setText(id, '主持人：标题改成 A'), oid2);  // 本地分叉
await a.evaluate(([id, base]) => __rb.remoteUpdate(id, base, { text: '编辑者：标题改成 B' }, '李编辑'), [oid2, base2]);
await sleep(300);

let cf = await a.evaluate(() => __rb.conflicts().filter(c => !c.resolved));
check('并发改同一元素：检测到冲突并保留两个版本', cf.length >= 1 &&
  JSON.stringify(cf).includes('主持人：标题改成 A') && JSON.stringify(cf).includes('编辑者：标题改成 B'),
  `未决冲突 ${cf.length} 个`);
check('画板上该元素被标记冲突态', await a.$eval(`[data-oid="${oid2}"]`, el => el.classList.contains('conflicted')));
check('顶部出现待裁决冲突提示', await a.$eval('#conflictFlag', el => !el.hidden));

// 冲突期间编辑者不能改动该元素（直接在 B 标签尝试）
const blockedEdit = await b.evaluate(id => { __rb.setText(id, '试图强改'); return __rb.state.objects[id].text; }, oid2);
check('冲突期间双方均不能写入该元素', blockedEdit !== '试图强改');
// 编辑者不能打开裁决弹窗
await b.evaluate(() => __rb.openConflict());
const toastB = await b.textContent('#toast');
check('冲突只能由主持人裁决（编辑者被拒）', toastB.includes('主持人'));

// 主持人打开裁决弹窗，核对两版本内容后合并
await a.click('#conflictFlag');
await waitFor(() => a.$eval('#conflictModal', m => !m.hidden));
const vaTxt = await a.inputValue('#cf-a');
const vbTxt = await a.inputValue('#cf-b');
check('裁决弹窗展示两个冲突版本', vaTxt.includes('主持人：标题改成 A') && vbTxt.includes('编辑者：标题改成 B'), `A:[${vaTxt}] B:[${vbTxt}]`);
await a.fill('#cf-merge', '合并结论：采用 A 的结构 + B 的措辞');
await a.click('#cf-resolve');
await sleep(300);
const finalTxt = await a.evaluate(id => __rb.state.objects[id].text, oid2);
check('主持人合并后写入最终版本', finalTxt === '合并结论：采用 A 的结构 + B 的措辞', finalTxt);
cf = await a.evaluate(() => __rb.conflicts().filter(c => !c.resolved).length);
check('冲突已消解（无未决冲突、提示消失）', cf === 0 && await a.$eval('#conflictFlag', el => el.hidden));
const auditCF = await a.evaluate(() => __rb.state.audit.some(x => x.text.includes('裁决元素冲突') && x.critical));
check('裁决动作写入关键审计', auditCF);
// 合并结果同步到其他标签
await waitFor(() => b.evaluate(([id, t]) => __rb.state.objects[id]?.text === t, [oid2, '合并结论：采用 A 的结构 + B 的措辞']));
check('合并结果同步到编辑者标签', true);

// 再制造一次冲突，验证“选择版本 B”路径
const oid3 = await a.evaluate(() => __rb.place('note', 520, 300));
const base3 = await a.evaluate(id => __rb.snapshotObject(id), oid3);
await a.evaluate(id => __rb.setText(id, '主持人版本C'), oid3);
await a.evaluate(([id, base]) => __rb.remoteUpdate(id, base, { text: '编辑者版本D' }, '李编辑'), [oid3, base3]);
await sleep(200);
await a.click('#conflictFlag');
await a.click('#cf-pick-b');
await sleep(200);
const final3 = await a.evaluate(id => __rb.state.objects[id].text, oid3);
check('支持直接选择某一版本写入（选 B）', final3 === '编辑者版本D', final3);

/* ---------- 7. 撤销 / 删除（旧能力回归） ---------- */
const beforeUndo = await a.evaluate(() => Object.keys(__rb.state.objects).length);
await a.evaluate(() => __rb.place('rect', 60, 480));   // 压入一条 add
const afterAdd = await a.evaluate(() => Object.keys(__rb.state.objects).length);
await a.evaluate(() => __rb.undo());
await sleep(200);
const afterUndo = await a.evaluate(() => Object.keys(__rb.state.objects).length);
check('撤销可用（撤销刚放置的元素）', afterAdd === beforeUndo + 1 && afterUndo === beforeUndo, `${beforeUndo}→${afterAdd}→${afterUndo}`);
// 删除：选中后按 Delete
const delId = await a.evaluate(() => __rb.place('rect', 100, 400));
await a.evaluate(id => { const n = document.querySelector(`[data-oid="${id}"]`); n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }, delId);
await a.keyboard.press('Delete');
await sleep(200);
check('Delete 删除元素可用', await a.evaluate(id => !__rb.state.objects[id], delId));
// 拖动画板元素（pointer 事件模拟）
const dragId = await a.evaluate(() => __rb.place('circle', 300, 400));
const dnode = await a.locator(`[data-oid="${dragId}"]`).boundingBox();
await a.mouse.move(dnode.x + 10, dnode.y + 10);
await a.mouse.down();
await a.mouse.move(dnode.x + 90, dnode.y + 70, { steps: 6 });
await a.mouse.up();
await sleep(300);
const pos = await a.evaluate(id => ({ x: __rb.state.objects[id].x, y: __rb.state.objects[id].y }), dragId);
check('拖动元素位置已更新并广播', pos.x > 350 && pos.y > 440, JSON.stringify(pos));

/* ---------- 8. 刷新恢复 / 重开 ---------- */
await a.reload();
await a.waitForSelector('#app:not([hidden])');
const restored = await a.evaluate(([id, t]) => ({
  stage: __rb.state.stage,
  objCount: Object.keys(__rb.state.objects).length,
  cmtCount: Object.keys(__rb.state.comments).length,
  merged: __rb.state.objects[id]?.text === t,
  role: document.querySelector('#me-badge').textContent,
}), [oid2, '合并结论：采用 A 的结构 + B 的措辞']);
check('刷新后恢复评审/阶段/画板/意见/身份', restored.stage === 'collect' && restored.objCount >= 3 && restored.cmtCount === 2 && restored.merged && restored.role.includes('主持人'), JSON.stringify(restored));

// 退出到入口页，从本机记录重开
await a.click('#exit');
await a.waitForSelector('#landing:not([hidden])');
check('入口页列出本机评审记录', (await a.locator('.review-row').count()) >= 1);
await a.locator('.review-row', { hasText: '首页改版方案评审' }).click();
await a.waitForSelector('#app:not([hidden])');
check('从记录重开后身份与数据恢复', (await a.textContent('#me-badge')).includes('王主持') && (await a.textContent('#roomId')) === roomId);

/* ---------- 9. 导出 PNG（真实下载） ---------- */
const [download] = await Promise.all([
  a.waitForEvent('download'),
  a.click('#export'),
]);
const path = await download.path();
const buf = fs.readFileSync(path);
const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 1000;
check('导出真实 PNG 文件且非空', isPng, `${buf.length} bytes`);

/* ---------- 10. 主持人管理成员身份（UI）并同步 ---------- */
await a.click('#btn-members');
await waitFor(() => a.$eval('#membersModal', m => !m.hidden));
// 第二行是李编辑（创建顺序：王、李、赵），改为观察者
const rowCount = await a.locator('#memberRows .mrow').count();
const editorName = await a.locator('#memberRows .mrow').nth(1).locator('b').textContent();
await a.locator('#memberRows .mrow').nth(1).locator('select').selectOption('observer');
await sleep(400);
check('主持人将编辑者改为观察者（UI）', editorName.includes('李') &&
  await b.evaluate(() => __rb.state.members[__rb.meId].role === 'observer'));
check('被降级标签的工具实时禁用', await b.$eval('.tool[data-type="note"]', el => el.disabled));
await a.locator('#membersModal [data-close]').click();

/* ---------- 11. 窄屏核心流程 ---------- */
const p = await context.newPage();
await p.setViewportSize({ width: 390, height: 844 });
await p.goto(BASE);
await p.fill('#cr-title', '窄屏冒烟评审');
await p.fill('#cr-name', '周主持');
await p.click('#createForm button.primary');
await p.waitForSelector('#app:not([hidden])');
// 窄屏放置元素
const pbox = await p.locator('#board').boundingBox();
await p.mouse.click(pbox.x + 60, pbox.y + 80);
await sleep(300);
const narrowObj = await p.evaluate(() => Object.keys(__rb.state.objects).length === 1);
// 窄屏提交意见
await p.click('#btn-add-comment');
await p.fill('#cm-content', '窄屏下提交一条意见');
await p.click('#cm-save');
await sleep(200);
const narrowCmt = await p.locator('.cmt').count();
// 门禁提示与推进按钮可见可点（被门禁拦截）
await p.locator('#btn-advance').scrollIntoViewIfNeeded();
const advVisible = await p.locator('#btn-advance').isVisible();
await p.locator('#btn-advance').click();
const narrowBlocked = (await p.textContent('#toast')).includes('至少需要 1 条意见') === false; // 已有意见 → 应成功推进
const narrowStage = (await p.textContent('.stage.active')).includes('讨论');
const overflow = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
check('窄屏：创建/绘制/意见/阶段推进核心流程可用', narrowObj && narrowCmt === 1 && advVisible && narrowStage && overflow,
  `obj=${narrowObj} cmt=${narrowCmt} stage=${narrowStage} noHOverflow=${overflow} blocked=${narrowBlocked}`);

/* ---------- 控制台错误 ---------- */
check('运行期间无未捕获页面错误', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(' - ' + f.name + ' ' + f.extra)); process.exit(1); }

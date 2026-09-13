import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:8099/index.html?rbtest=1');
await p.fill('#cr-title', '首页改版方案评审');
await p.fill('#cr-name', '王主持');
await p.click('#createForm button.primary');
// 放几个元素
await p.evaluate(()=>{__rb.place('note',90,80); const id=Object.keys(__rb.state.objects)[0]; __rb.setText(id,'导航合并为一级入口');});
await p.evaluate(()=>{__rb.place('rect',120,300);__rb.place('circle',330,320);__rb.place('line',520,200);});
// 两条意见
await p.evaluate(()=>{__rb.addComment('首屏导航层级过深，需要合并入口',{priority:'high'});__rb.addComment('空状态缺少引导文案',{priority:'medium'});});
await p.evaluate(id=>__rb.setStatus(id,'reviewing'), await p.evaluate(()=>Object.keys(__rb.state.comments)[0]));
await p.click('#btn-advance');
await p.screenshot({ path: '/workspace/.verify/shot-desktop.png' });
// 冲突裁决弹窗：制造冲突
const oid = await p.evaluate(()=>__rb.place('note',470,90));
const base = await p.evaluate(id=>__rb.snapshotObject(id),oid);
await p.evaluate(id=>__rb.setText(id,'主持人版本：保持双列布局'),oid);
await p.evaluate(([id,b])=>__rb.remoteUpdate(id,b,{text:'编辑者版本：改为单列大卡'},'李编辑'),[oid,base]);
await p.click('#conflictFlag');
await p.waitForTimeout(200);
await p.screenshot({ path: '/workspace/.verify/shot-conflict.png' });
// 窄屏
const m = await ctx.newPage();
await m.setViewportSize({width:390,height:844});
await m.goto('http://127.0.0.1:8099/index.html?rbtest=1');
await m.fill('#cr-title','移动端评审'); await m.fill('#cr-name','周主持');
await m.click('#createForm button.primary');
await m.evaluate(()=>__rb.addComment('窄屏意见'));
await m.screenshot({ path: '/workspace/.verify/shot-mobile.png', fullPage:false });
await browser.close();
console.log('shots done');

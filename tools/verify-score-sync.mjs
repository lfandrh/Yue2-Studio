import fs from "node:fs";

/* 主页谱面与乐谱工作台共用 + 「用这份谱面生成」开关的验收脚本（20 项，对 http://127.0.0.1:8083 做 CDP 检查）。
   先起一个独立 headless Chrome（独立 profile，不碰用户已开标签）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9456 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   再运行：node tools/verify-score-sync.mjs      结果与截图落在 tools/evidence/
   只读后端：创建任务的请求被页内 fetch 桩拦下，不会真的排队。 */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:8083";
const PORT = Number(process.env.VERIFY_CDP || 9456);

const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  /* 脏编辑时的 beforeunload「离开站点？」会冻结整页，必须当场放行 */
  if (m.method === "Page.javascriptDialogOpening") {
    ws.send(JSON.stringify({id: ++id, method: "Page.handleJavaScriptDialog", params: {accept: true}, sessionId: m.sessionId}));
  }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}));
});
const {targetInfos} = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const {sessionId} = await send("Target.attachToTarget", {targetId: page.targetId, flatten: true});
const ev = async (expr) => (await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true}, sessionId)).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (expr) => JSON.parse(await ev(expr));
const waitFor = async (expr, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch (exc) { /* 页面可能正在导航 */ }
    await sleep(200);
  }
  return false;
};
const results = [];
setTimeout(() => {
  const done = results.filter((r) => r.pass).length;
  console.log(`\nTIMEOUT 卡住，已完成 ${done}/${results.length}：`, results.map((r) => r.name).join(" | "));
  process.exit(1);
}, 220000).unref();
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};
const go = (view) => ev(`document.querySelector('[data-view="${view}"]').click()`);/* 弹框确认（结构检查/提醒级）一律点主按钮放行，只为拿到请求体 */
const acceptDialog = async () => {
  if (await ev(`!!document.querySelector(".modal.open [data-ok]")`)) {
    await ev(`document.querySelector(".modal.open [data-ok]").click()`);
    await sleep(250);
  }
};
const setText = (sel, value) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
  el.value=${JSON.stringify(value)};el.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", {cacheDisabled: true}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);

/* 干净起步：先加载一次拿到 localStorage 句柄，清掉草稿/语言/引导标记，再整页重载，
   保证「开关默认关」是真正的首次状态，而且不会有巡览遮罩挡住点击。 */
const booted = `!!document.getElementById("btnKeys") && !!document.getElementById("studioUseScore")`;
const dismiss = async () => {
  await ev(`(()=>{const t=document.getElementById("tour");
    if(t&&!t.hidden){const s=document.getElementById("tourSkip");if(s)s.click();}
    document.querySelectorAll(".modal.open [data-x]").forEach(b=>b.click());return true})()`);
  await sleep(200);
};
await send("Page.navigate", {url: BASE + "/"}, sessionId);
if (!(await waitFor(`!!document.getElementById("btnKeys")`, 15000)) && !(await waitFor(`!!document.getElementById("btnKeys")`, 8000))) {
  throw new Error("页面没起来：" + (await ev(`location.href`)));
}
await ev(`localStorage.clear();localStorage.setItem("yue2.guide","done");localStorage.setItem("yue2.tour","done")`);
await send("Page.reload", {}, sessionId);
if (!(await waitFor(booted, 15000))) throw new Error("重载后页面没起来：" + (await ev(`location.href`)));
await dismiss();
await sleep(1200);
await go("studio");
await sleep(600);

/* ---------- 1. 面板控件与默认状态 ---------- */
const panel = await json(`JSON.stringify({
  select:!!document.getElementById("studioScoreSource"),
  box:!!document.getElementById("studioScore"),
  chip:!!document.getElementById("studioUseScore"),
  reload:!!document.getElementById("btnLoadSelectedScore"),
  save:!!document.getElementById("btnSaveStudioDraft"),
  note:!!document.getElementById("studioScoreNote"),
  pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  chipDisabled:document.getElementById("studioUseScore").disabled,
  noteHidden:document.getElementById("studioScoreNote").hidden})`);
check("主页谱面面板控件齐全",
  [panel.select, panel.box, panel.chip, panel.reload, panel.save, panel.note].every(Boolean), panel);
check("开关默认关且已启用", panel.pressed === "false" && panel.chipDisabled === false && panel.noteHidden === true, panel);

const emptyOption = await json(`JSON.stringify([...document.getElementById("studioScoreSource").options].map(o=>o.value))`);
check("下拉没有「不使用谱面」空选项", emptyOption.length > 0 && emptyOption.every((x) => x !== ""), {count: emptyOption.length});

/* ---------- 2. 两页共用同一份谱 ---------- */
await go("score");
await waitFor(`!!document.getElementById("abcEd").value`, 8000);
await sleep(400);
const both = await json(`JSON.stringify({
  home:[...document.getElementById("studioScoreSource").options].map(o=>o.value),
  work:[...document.getElementById("scoreJob").options].map(o=>o.value),
  homeSel:document.getElementById("studioScoreSource").value,
  workSel:document.getElementById("scoreJob").value,
  homeLen:document.getElementById("studioScore").value.length,
  workLen:document.getElementById("abcEd").value.length})`);
check("两页下拉列出同一批任务", JSON.stringify(both.home) === JSON.stringify(both.work), {home: both.home.length, work: both.work.length});
check("两页选中同一个任务", both.homeSel === both.workSel && both.homeSel !== "", both);
check("两页谱面文本一致", both.homeLen > 0 && both.homeLen === both.workLen, both);

/* 工作台换任务 → 主页跟着换 */
const other = both.home.find((x) => x !== both.homeSel);
await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(other)};
  s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
await waitFor(`document.getElementById("studioScoreSource").value === ${JSON.stringify(other)}`, 8000);
await sleep(500);
const followed = await json(`JSON.stringify({workSel:document.getElementById("scoreJob").value,
  homeSel:document.getElementById("studioScoreSource").value,
  same:document.getElementById("studioScore").value===document.getElementById("abcEd").value})`);
check("工作台换任务，主页下拉同步", followed.workSel === other && followed.homeSel === other && followed.same, followed);

/* 主页编辑 → 工作台看到；工作台编辑 → 主页看到（脏编辑不被覆盖） */
await go("studio");
await sleep(500);
const MARK = "\n% 同步探针 A";
const homeBase = await ev(`document.getElementById("studioScore").value`);
await setText("#studioScore", homeBase + MARK);
await sleep(500);
await go("score");
await sleep(700);
const workSaw = await ev(`document.getElementById("abcEd").value.endsWith(${JSON.stringify(MARK)})`);
check("主页改的谱，工作台立即是改后的", workSaw === true);

await go("studio");
await sleep(600);
const homeKept = await ev(`document.getElementById("studioScore").value.endsWith(${JSON.stringify(MARK)})`);
check("来回切页不冲掉未保存的编辑", homeKept === true);

/* ---------- 3. 开关回显与置灰 ---------- */
await ev(`document.getElementById("studioUseScore").click()`);
await sleep(250);
const on = await json(`JSON.stringify({pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  hidden:document.getElementById("studioScoreNote").hidden,
  text:document.getElementById("studioScoreNote").textContent})`);
check("勾上开关：显示回显且带任务编号", on.pressed === "true" && on.hidden === false && on.text.length > 10, on);
await ev(`document.getElementById("studioUseScore").click()`);
await sleep(250);
const off = await json(`JSON.stringify({pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  hidden:document.getElementById("studioScoreNote").hidden})`);
check("取消开关：回显收起", off.pressed === "false" && off.hidden === true, off);

const boxLen = await ev(`document.getElementById("studioScore").value.length`);
await setText("#studioScore", "");
await sleep(400);
const greyed = await json(`JSON.stringify({disabled:document.getElementById("studioUseScore").disabled,
  pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed")})`);
check("谱为空时开关置灰并强制关", greyed.disabled === true && greyed.pressed === "false", greyed);
await setText("#studioScore", homeBase);
await sleep(400);
const back = await ev(`document.getElementById("studioUseScore").disabled`);
check("谱填回来开关解禁", back === false, {disabled: back});

/* ---------- 4. 提交请求体：关=新歌，开=按谱重渲染 ---------- */
await ev(`(()=>{window.__posts=[];const real=window.fetch.bind(window);
  window.fetch=(input,init)=>{const url=typeof input==="string"?input:input.url;
    const method=((init&&init.method)||"GET").toUpperCase();
    if(method==="POST"&&url.split("?")[0]==="/api/jobs"){window.__posts.push(JSON.parse(init.body));
      return Promise.resolve(new Response(JSON.stringify({id:"probe_job",status:"queued"}),{status:201,headers:{"Content-Type":"application/json"}}));}
    return real(input,init);};return true})()`);
await setText("#fStyle", "city pop, 100 BPM, electric piano");
await setText("#fLyrics", "[Verse]\n晚风轻轻吹过窗前\n把今天的路上");
await sleep(300);
await ev(`document.getElementById("btnGen").click()`);
await sleep(700);
await acceptDialog();
await sleep(700);
await go("studio");
await sleep(300);
await ev(`document.getElementById("btnGen").click()`);
await sleep(700);
await acceptDialog();
await sleep(900);
const posts1 = await json(`JSON.stringify(window.__posts)`);
const offPost = posts1[0];
check("不勾开关：请求是新歌（无 source/abc）",
  posts1.length >= 1 && offPost.type === "song" && offPost.source === undefined && offPost.abc === undefined, offPost);

/* 开关联动：勾上后再点，请求应转成 rerender */
await ev(`(()=>{const c=document.getElementById("studioUseScore");
  if(!c.disabled&&c.getAttribute("aria-pressed")!=="true")c.click();return true})()`);
await sleep(300);
const beforeAbc = await ev(`document.getElementById("studioScore").value`);
await ev(`document.getElementById("btnGen").click()`);
await sleep(700);
await acceptDialog();
await sleep(900);
const posts2 = await json(`JSON.stringify(window.__posts)`);
const onPost = posts2[posts2.length - 1];
check("勾上开关：请求转为按谱重渲染（带 source 与 abc）",
  onPost.type === "rerender" && onPost.source === await ev(`document.getElementById("studioScoreSource").value`) && onPost.abc === beforeAbc,
  {type: onPost.type, source: onPost.source, abcLen: (onPost.abc || "").length});
await send("Page.reload", {ignoreBeforeunload: true}, sessionId);
await waitFor(`!!document.getElementById("studioUseScore")`, 10000);
await dismiss();
await sleep(1000);

/* ---------- 5. 工作台「回创作页」：有改动自动勾上 ---------- */
await go("score");
await waitFor(`!!document.getElementById("abcEd").value`, 8000);
await sleep(500);
const cleanAbc = await ev(`document.getElementById("abcEd").value`);
/* 先确认无改动时开关保持原样（主页当前是关） */
await ev(`document.getElementById("btnToStudio").click()`);
await waitFor(`document.getElementById("fLyrics").value.length>0`, 8000);
await sleep(800);
const backClean = await json(`JSON.stringify({pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  style:document.getElementById("fStyle").value.length})`);
check("谱没改：回创作页不替你勾开关", backClean.pressed === "false" && backClean.style > 0, backClean);

/* 制造改动后再点回创作页 */
await go("score");
await sleep(700);
await setText("#abcEd", cleanAbc + "\n% 探针 B");
await sleep(900);
await ev(`document.getElementById("btnToStudio").click()`);
await waitFor(`document.getElementById("studioUseScore").getAttribute("aria-pressed")==="true"`, 8000);
await sleep(400);
const backDirty = await json(`JSON.stringify({pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  noteHidden:document.getElementById("studioScoreNote").hidden,
  homeHasEdit:document.getElementById("studioScore").value.includes("% 探针 B")})`);
check("谱有改动：回创作页自动勾上开关并把改动带回", backDirty.pressed === "true" && backDirty.noteHidden === false && backDirty.homeHasEdit === true, backDirty);

/* ---------- 6. 生成中出谱即显示（页内假 API，只喂一个 running 任务） ---------- */
await ev(`(()=>{window.__mock={jobs:[],score:""};
  const real=window.fetch.bind(window);
  window.fetch=(input,init)=>{const url=typeof input==="string"?input:input.url;
    const method=((init&&init.method)||"GET").toUpperCase();
    if(method!=="GET"){return real(input,init);}
    if(window.__mock.active&&url.split("?")[0]==="/api/jobs")
      return Promise.resolve(new Response(JSON.stringify({jobs:window.__mock.jobs,notices:[]}),{status:200,headers:{"Content-Type":"application/json"}}));
    if(window.__mock.score&&/\\/score$/.test(url))
      return Promise.resolve(new Response(JSON.stringify({abc:window.__mock.score}),{status:200,headers:{"Content-Type":"application/json"}}));
    return real(input,init);};
  return fetch("/api/jobs").then(r=>r.json()).then(d=>{
    const base=d.jobs.find(j=>j.artifacts&&j.artifacts["score.abc"]&&j.requested);
    return fetch("/api/jobs/"+base.id+"/score").then(r=>r.json()).then(s=>{
      window.__mockAbc=s.abc;
      window.__mockRow=Object.assign({},base,{id:"song_mock_running_probe",status:"running",stage:"语义生成",stage_raw:"semantic",
        artifacts:{},result:{},title:"探针 · 生成中",parent_id:null,duration:null,seconds:null});
      return true;});});})()`);
await sleep(400);
const ready = await ev(`!!window.__mockRow`);
check("探针任务行准备就绪", ready === true);

/* 6a 完全没有谱：面板空态、开关置灰 */
await ev(`window.__mock.jobs=[Object.assign({},window.__mockRow)];window.__mock.active=true`);
await go("library");
await sleep(300);
await ev(`document.getElementById("btnReload").click()`);
await sleep(700);
await go("studio");
await sleep(700);
const emptyState = await json(`JSON.stringify({
  selectDisabled:document.getElementById("studioScoreSource").disabled,
  boxDisabled:document.getElementById("studioScore").disabled,
  chipDisabled:document.getElementById("studioUseScore").disabled,
  boxValue:document.getElementById("studioScore").value.length,
  placeholder:document.getElementById("studioScore").placeholder})`);
check("运行中还没出谱：面板空态且开关置灰",
  emptyState.selectDisabled === true && emptyState.boxDisabled === true && emptyState.chipDisabled === true && emptyState.boxValue === 0, emptyState);

/* 6b 模型刚写完谱（任务仍是 running）：两页同时出现谱面 */
await ev(`(()=>{window.__mock.score=window.__mockAbc;
  window.__mock.jobs=[Object.assign({},window.__mockRow,{artifacts:{"score.abc":window.__mockAbc.length}})];return true})()`);
await go("library");
await sleep(300);
await ev(`document.getElementById("btnReload").click()`);
await sleep(900);
await go("studio");
await waitFor(`document.getElementById("studioScore").value.length>10`, 9000);
await sleep(500);
const appeared = await json(`JSON.stringify({
  boxLen:document.getElementById("studioScore").value.length,
  chipDisabled:document.getElementById("studioUseScore").disabled,
  pressed:document.getElementById("studioUseScore").getAttribute("aria-pressed"),
  queueRunning:document.getElementById("queue").textContent.includes("生成中"),
  statusText:document.getElementById("queue").textContent.replace(/\\s+/g," ").slice(0,60)})`);
check("出谱即显示：任务还在跑，主页已拿到谱", appeared.boxLen > 10 && appeared.chipDisabled === false && appeared.pressed === "false", appeared);
check("生成中的任务仍显示为运行中", appeared.queueRunning === true, {queue: appeared.statusText});

await go("score");
await waitFor(`document.getElementById("abcEd").value.length>10`, 9000);
await sleep(500);
const workAppeared = await json(`JSON.stringify({len:document.getElementById("abcEd").value.length,
  sel:document.getElementById("scoreJob").value,
  match:document.getElementById("abcEd").value===window.__mockAbc})`);
check("出谱即显示：工作台同一时刻也有这份谱", workAppeared.len > 10 && workAppeared.sel === "song_mock_running_probe" && workAppeared.match === true, workAppeared);

/* ---------- 7. 刷新后草稿不回带已消失的任务 ---------- */
await send("Page.reload", {ignoreBeforeunload: true}, sessionId);
await waitFor(`!!document.getElementById("studioUseScore")`, 10000);
await dismiss();
await sleep(1200);
await go("studio");
await sleep(600);
const afterReload = await json(`JSON.stringify({sel:document.getElementById("studioScoreSource").value,
  mockGone:document.getElementById("studioScoreSource").value!=="song_mock_running_probe"})`);
check("探针任务消失后自动跟到最新谱（刷新不卡住）", afterReload.mockGone === true && afterReload.sel !== "", afterReload);

/* ---------- 8. 双语：新面板文案在 EN 下不夹中文 ---------- */
await ev(`document.querySelector('button[data-lang="en"]').click()`);
await sleep(700);
const en = await json(`(()=>{
  const card=document.getElementById("studioScoreSource").closest(".card");
  const bits=[...card.querySelectorAll("h2,p.hint,div.hint,label,button")].map(e=>e.textContent.replace(/\\s+/g," ").trim());
  const chip=document.getElementById("studioUseScore");
  document.getElementById("studioUseScore").click();
  const note=document.getElementById("studioScoreNote").textContent;
  document.getElementById("studioUseScore").click();
  return JSON.stringify({chip:chip.textContent.trim(),title:chip.title,
    placeholder:document.getElementById("studioScore").placeholder,
    bits:bits.join(" | "),note:note});})()`);
const cjk = /[\u4e00-\u9fff]/;
check("EN：开关文案与悬停说明已翻译", en.chip === "Use This Score" && cjk.test(en.title) === false, {chip: en.chip, title: en.title.slice(0, 50)});
check("EN：面板标题/说明/占位符无残留中文",
  cjk.test(en.bits) === false && cjk.test(en.placeholder) === false && cjk.test(en.note) === false,
  {bits: en.bits.slice(0, 120), placeholder: en.placeholder.slice(0, 40), note: en.note.slice(0, 60)});
await ev(`document.querySelector('button[data-lang="zh"]').click()`);
await sleep(600);

/* ---------- 9. 分辨率：新增开关行不产生横向溢出 ---------- */
await go("studio");
await sleep(500);
const probe = `(async()=>{try{
  const chipEl=document.getElementById("studioUseScore");
  const card=chipEl.closest(".card");
  const r=chipEl.getBoundingClientRect();
  const c=card.getBoundingClientRect();
  return JSON.stringify({ok:true,
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    studioVisible:!document.getElementById("v-studio").hidden,
    chip:{right:Math.round(r.right),cardRight:Math.round(c.right),fits:r.right<=c.right+1}});
}catch(e){return JSON.stringify({ok:false,error:String(e)})}})()`;
const widths = [];
for (const [w, h] of [[1920, 1080], [2560, 1440], [3840, 2160]]) {
  await send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: 1, mobile: false}, sessionId);
  await sleep(600);
  widths.push({w, h, ...await json(probe)});
}
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
for (const item of widths) {
  check(`${item.w}x${item.h}：无横向溢出且开关不越卡片边线`,
    item.ok === true && item.overflow <= 1 && item.chip.fits === true, item);
}
/* ---------- 汇总（先落盘，截图只是附证，卡住也不能影响结果） ---------- */
const passed = results.filter((r) => r.pass).length;
const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail === undefined ? "" : " " + JSON.stringify(r.detail)}`);
lines.push("", `${passed}/${results.length} 通过`);
fs.writeFileSync(`${OUT}/score-sync-report.txt`, lines.join("\n"));
console.log(`\n${passed}/${results.length} 通过`);
for (const r of results.filter((x) => !x.pass)) console.log("需处理：", r.name, JSON.stringify(r.detail));
ws.close();
process.exit(passed === results.length ? 0 : 1);

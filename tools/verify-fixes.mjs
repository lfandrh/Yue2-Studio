import fs from "node:fs";

/* 修复验收脚本（对 http://127.0.0.1:9090 做 CDP 检查，21 项）。
   先起一个独立 headless Chrome（独立 profile，不碰用户已开标签）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9455 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   再运行：node tools/verify-fixes.mjs        截图与结果落在 tools/evidence/ */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:9090";
const PORT = Number(process.env.VERIFY_CDP || 9455);

const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({id: i, method, params, ...(sessionId ? {sessionId} : {})}));
});
const {targetInfos} = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const {sessionId} = await send("Target.attachToTarget", {targetId: page.targetId, flatten: true});
const ev = async (expr) => (await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true}, sessionId)).result.value;
const setLang = (lang) => ev(`import("/static/js/i18n.js").then(m => m.applyLang(${JSON.stringify(lang)}))`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const {data} = await send("Page.captureScreenshot", {format: "png"}, sessionId);
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
};
const json = async (expr) => JSON.parse(await ev(expr));
const waitFor = async (expr, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch (exc) { /* context may be mid-navigation */ }
    await sleep(200);
  }
  return false;
};
const ready = () => waitFor(`document.readyState === "complete" && !!document.getElementById("btnKeys")`);
const results = [];
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", {cacheDisabled: true}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await send("Page.navigate", {url: BASE + "/"});
if (!(await ready())) {
  await send("Page.navigate", {url: BASE + "/"});
  if (!(await ready())) throw new Error("page did not load: " + (await ev(`location.href`)));
}
await sleep(1200);

/* ---------- 1. 关闭的弹窗不可聚焦（BUG-009） ---------- */
let modals = await json(`JSON.stringify([...document.querySelectorAll(".modal")].map(m=>({id:m.id,open:m.classList.contains("open"),inert:m.inert,hidden:getComputedStyle(m).display})))`);
check("closed modals inert", modals.every((m) => m.inert === true), modals);
let focusBlocked = await ev(`(()=>{document.getElementById("keysX").focus();return document.activeElement.id})()`);
check("focus cannot enter closed modal", focusBlocked !== "keysX", {activeElement: focusBlocked});

await ev(`(()=>{const b=document.getElementById("btnKeys");b.focus();b.click();return true})()`);
await sleep(350);
let openState = await json(`JSON.stringify({inert:document.getElementById("keysModal").inert,focus:document.activeElement.closest("#keysModal")?.id||""})`);
check("keys modal open + focus inside", openState.inert === false && openState.focus === "keysModal", openState);
await ev(`document.getElementById("keysX").click()`);
await sleep(350);
let closedState = await json(`JSON.stringify({inert:document.getElementById("keysModal").inert,focus:document.activeElement.id})`);
check("keys modal closed inert + focus restored", closedState.inert === true && closedState.focus === "btnKeys", closedState);

/* ---------- 2. 巡览：中途缩窗 + 切语言（BUG-011 / BUG-012） ---------- */
let tourOpen = await waitFor(`!document.getElementById("tour").hidden`, 4000);
if (!tourOpen) {
  await ev(`document.querySelector('[data-view="guide"]').click()`);
  await sleep(400);
  await ev(`document.getElementById("btnReplayTour").click()`);
  await sleep(600);
}
await ev(`document.getElementById("tourNext").click()`);
await sleep(350);
await ev(`document.getElementById("tourNext").click()`);
await sleep(450);
let beforeResize = await json(`(()=>{const r=document.getElementById("tourCard").getBoundingClientRect();return JSON.stringify({step:document.getElementById("tourStep").textContent,top:Math.round(r.top),bottom:Math.round(r.bottom),vw:innerWidth,vh:innerHeight})})()`);
await send("Emulation.setDeviceMetricsOverride", {width: 320, height: 640, deviceScaleFactor: 2, mobile: true}, sessionId);
await sleep(700);
let afterResize = await json(`(()=>{const c=document.getElementById("tourCard");const r=c.getBoundingClientRect();const n=document.getElementById("tourNext");const nr=n.getBoundingClientRect();const cx=Math.round(nr.left+nr.width/2),cy=Math.round(nr.top+nr.height/2);const hit=document.elementFromPoint(cx,cy);const doc=document.documentElement;return JSON.stringify({innerH:innerHeight,docH:doc.clientHeight,cardTop:Math.round(r.top),cardBottom:Math.round(r.bottom),scrollable:c.scrollHeight>c.clientHeight,nextCenter:[cx,cy],nextVisible:cy<doc.clientHeight,hit:hit&&(hit.closest("#tourNext")?"tourNext":hit.tagName+"."+hit.className)})})()`);
check("tour card re-clamps after resize", afterResize.cardBottom <= afterResize.docH, {before: beforeResize, after: afterResize});
check("tour Next reachable at 320x640", afterResize.hit === "tourNext", afterResize);

await setLang("en");
await sleep(500);
let tourEn = await json(`JSON.stringify({step:document.getElementById("tourStep").textContent,title:document.getElementById("tourTitle").textContent,next:document.getElementById("tourNext").textContent})`);
check("tour step counter translated", /^Step \d+ of \d+$/.test(tourEn.step), tourEn);
await shot("fix-tour-320-en");
await setLang("zh");
await sleep(400);
let tourZh = await json(`JSON.stringify({step:document.getElementById("tourStep").textContent})`);
check("tour step counter back to zh", /^第 \d+ 步 /.test(tourZh.step), tourZh);
await ev(`document.getElementById("tourSkip").click()`);
await sleep(300);
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

/* ---------- 3. 手机底栏不再遮挡按钮（BUG-016） ---------- */
const mobile = [];
for (const [w, h] of [[320, 640], [375, 667], [414, 896]]) {
  await send("Emulation.setDeviceMetricsOverride", {width: w, height: h, deviceScaleFactor: 2, mobile: true}, sessionId);
  await sleep(450);
  await ev(`document.querySelector('[data-view="studio"]').click()`);
  await sleep(350);
  const m = await json(`(()=>{const g=document.getElementById("btnGen");const p=document.getElementById("btnPlan");const gr=g.getBoundingClientRect(),pr=p.getBoundingClientRect();
    const hit=(r)=>{const h=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));return h?!!h.closest("#btnGen,#btnPlan"):false};
    const q=document.getElementById("queue");const cs=getComputedStyle(q);
    const tb=document.querySelector(".topbar").getBoundingClientRect();
    return JSON.stringify({w:innerWidth,h:innerHeight,gen:[Math.round(gr.left),Math.round(gr.top),Math.round(gr.right),Math.round(gr.bottom)],genHit:hit(gr),planHit:hit(pr),queuePadBottom:cs.paddingBottom,scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,topRight:Math.round(tb.right),costRects:[...document.querySelectorAll(".dock .cost, .dock #costBrk")].map(e=>({id:e.id||e.className,disp:getComputedStyle(e).display,top:Math.round(e.getBoundingClientRect().top)}))})})()`);
  m.width = w; m.height = h;
  mobile.push(m);
  check(`mobile ${w}: gen+plan clickable, no overlap`, m.genHit && m.planHit && m.gen[3] <= m.h, m);
  check(`mobile ${w}: no horizontal overflow`, m.scrollW <= m.clientW + 1 && m.topRight <= w, {scrollW: m.scrollW, clientW: m.clientW, topRight: m.topRight});
}
await shot("fix-mobile-320-dock");
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await sleep(400);
await ev(`location.reload()`);
if (!(await ready())) throw new Error("page did not reload");
await sleep(1200);

/* ---------- 4. 连点提交只入队一次（BUG-005 / BUG-007） ---------- */
await ev(`(()=>{window.__posts=0;window.__realFetch=window.fetch;window.fetch=function(input,init={}){const url=String((input&&input.url)||input);const method=(init&&init.method)||"GET";if(url.includes("/api/jobs")&&method==="POST"){window.__posts++;return new Promise(res=>setTimeout(()=>res({ok:true,status:200,text:async()=>JSON.stringify({id:"stub_job",type:"song",status:"queued"}),json:async()=>({id:"stub_job"})}),500))}return window.__realFetch.apply(this,arguments)}})()`);
await ev(`(()=>{const s=document.getElementById("fStyle");s.value="Mandarin, city pop, warm female vocal, 92 BPM";s.dispatchEvent(new Event("input",{bubbles:true}));
  const l=document.getElementById("fLyrics");l.value="[Verse]\\n晚风轻轻吹过窗前\\n[Chorus]\\n啦啦啦啦啦啦啦";l.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
await sleep(400);
let firstClick = await json(`(()=>{const b=document.getElementById("btnGen");b.click();const disabled=b.disabled;b.click();b.click();return JSON.stringify({disabledAfterFirst:disabled})})()`);
await sleep(1600);
let genPosts = await ev(`window.__posts`);
check("double click generate -> 1 request", genPosts === 1, {posts: genPosts, disabledAfterFirst: firstClick.disabledAfterFirst});

await ev(`(()=>{window.__posts=0;return true})()`);
let planClick = await json(`(()=>{const b=document.getElementById("btnPlan");b.click();const disabled=b.disabled;b.click();b.click();return JSON.stringify({disabledAfterFirst:disabled})})()`);
await sleep(1600);
let planPosts = await ev(`window.__posts`);
check("triple click plan -> 1 request", planPosts === 1, {posts: planPosts, disabledAfterFirst: planClick.disabledAfterFirst});
await ev(`window.fetch=window.__realFetch; delete window.__posts; delete window.__realFetch`);

/* ---------- 5. 乐谱草稿自动恢复（BUG-010） ---------- */
await ev(`location.reload()`);
if (!(await ready())) throw new Error("page did not reload");
await sleep(1200);
await ev(`document.querySelector('[data-view="score"]').click()`);
await sleep(1400);
let scoreState = await json(`(()=>{const s=document.getElementById("scoreJob");return JSON.stringify({options:[...s.options].map(o=>o.value),value:s.value,len:document.getElementById("abcEd").value.length})})()`);
const [jobA, jobB] = scoreState.options;
if (!jobB) {
  check("score draft (needs 2 score jobs)", false, scoreState);
} else {
  await ev(`(()=>{const e=document.getElementById("abcEd");e.value=e.value+"\\n% draft-test";e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(jobB)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(1200);
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(jobA)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(1200);
  let restored = await json(`(()=>{const e=document.getElementById("abcEd");return JSON.stringify({tail:e.value.slice(-14),toasts:[...document.querySelectorAll("#toasts .toast")].map(t=>t.innerText.replace(/\\s+/g," "))})})()`);
  check("draft restored after switching back", restored.tail.includes("% draft-test"), restored);
  check("draft restore toast shown", restored.toasts.some((t) => t.includes("已恢复上次未保存的修改")), restored.toasts);
  await shot("fix-score-draft");

  // 改回原样后草稿清除：切走再回来不应再提示
  await ev(`(()=>{const e=document.getElementById("abcEd");e.value=e.value.replace("\\n% draft-test","");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await ev(`document.querySelectorAll("#toasts .toast").forEach(t=>t.remove())`);
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(jobB)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(1000);
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(jobA)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(1000);
  let stale = await json(`JSON.stringify({tail:document.getElementById("abcEd").value.slice(-14),toasts:[...document.querySelectorAll("#toasts .toast")].map(t=>t.innerText)})`);
  check("draft dropped after reverting", !stale.tail.includes("% draft-test") && !stale.toasts.some((t) => t.includes("已恢复")), stale);
}

/* ---------- 6. 英文错误映射（BUG-015） ---------- */
const demoAbc = (await (await fetch(`${BASE}/api/jobs/song_demo_wanfeng/score`)).json()).abc;
await ev(`document.querySelector('[data-view="score"]').click()`);
await sleep(800);
await ev(`(()=>{const e=document.getElementById("abcEd");e.value=${JSON.stringify(demoAbc)};e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
await sleep(300);
await ev(`(()=>{const e=document.getElementById("abcEd");const lines=e.value.trimEnd().split("\\n");const last=lines.length-1;if(lines[last].endsWith("|"))lines[last]=lines[last].slice(0,-1);e.value=lines.join("\\n");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
await ev(`document.querySelectorAll("#toasts .toast").forEach(t=>t.remove())`);
await ev(`document.getElementById("btnInspect").click()`);
await sleep(1200);
let zhErr = await ev(`[...document.querySelectorAll("#toasts .toast")].map(t=>t.innerText.replace(/\\s+/g," ")).join(" | ")`);
check("barline error localized (zh)", zhErr.includes("谱面格式有误"), zhErr);

await setLang("en");
await sleep(350);
await ev(`document.querySelectorAll("#toasts .toast").forEach(t=>t.remove())`);
await ev(`document.getElementById("btnInspect").click()`);
await sleep(1200);
let enErr = await ev(`[...document.querySelectorAll("#toasts .toast")].map(t=>t.innerText.replace(/\\s+/g," ")).join(" | ")`);
check("barline error localized (en)", /Score format error/i.test(enErr), enErr);
await shot("fix-error-en");
await setLang("zh");
await sleep(350);

/* ---------- 7. 多标签同步标题（BUG-014） ---------- */
await ev(`document.querySelector('[data-view="library"]').click()`);
await sleep(600);
const seen = async () => ev(`document.getElementById("libGrid").innerText.includes("验收临时标题")`);
const patchTitle = async (title) => {
  const r = await fetch(`${BASE}/api/jobs/song_demo_wanfeng`, {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({title})});
  return r.status;
};
await patchTitle("验收临时标题");
await sleep(1400);
const gotNew = await seen();
await shot("fix-tab-sync");
await patchTitle("示例曲 · 晚风");
await sleep(1400);
const gotOld = await ev(`document.getElementById("libGrid").innerText.includes("示例曲 · 晚风")`);
check("other-tab title change arrives via SSE", gotNew === true && gotOld === true, {gotNew, gotOld});

/* ---------- 8. 2026-10-28 混沌修复回归 ---------- */
const preT = (await (await fetch(`${BASE}/api/jobs?limit=500`)).json()).jobs.find((j) => j.title === "验证截断" && j.status === "complete" && j.truncated === true);
if (!preT) {
  await fetch(`${BASE}/api/jobs`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
    type: "plan", style: "mandarin, city pop, soft female vocal, 92 BPM",
    lyrics: "[Verse]\n晚风轻轻吹过窗前\n[Chorus]\n啦啦啦啦啦啦啦",
    cot: "melody", seed: 831001, title: "验证截断", abc_sampling: {max_tokens: 200}}) });
}
const tPlanReady = await waitFor(`fetch("${BASE}/api/jobs?limit=500").then(r=>r.json()).then(d=>d.jobs.some(j=>j.title==="验证截断"&&j.status==="complete"&&j.truncated===true))`, 240000);
check("truncated plan job exists", tPlanReady);
await ev(`location.reload()`);
if (!(await ready())) throw new Error("page did not reload");
await sleep(1200);
await ev(`document.querySelector('[data-view="studio"]').click()`);
await sleep(900);
const regJobs = (await (await fetch(`${BASE}/api/jobs?limit=500`)).json()).jobs;
const regCards = await json(`(()=>{const out={};document.querySelectorAll("#queue .jobc").forEach(c=>{const b=[...c.querySelectorAll(".acts button")].find(x=>x.innerText.includes("渲染成歌"));out[c.dataset.job]={text:c.innerText.replace(/\\s+/g," "),render:b?{disabled:b.disabled,title:b.title}:null};});return JSON.stringify(out)})()`);
const tPlan = regJobs.find((j) => j.title === "验证截断");
const tCard = tPlan && regCards[tPlan.id];
check("truncated plan card disables render", !!tCard && !!tCard.render && tCard.render.disabled === true && /谱面被截断/.test(tCard.text) && /截断 是/.test(tCard.text), tCard);
const nPlan = regJobs.find((j) => j.type === "plan" && j.status === "complete" && !j.truncated);
if (nPlan && regCards[nPlan.id]) {
  check("normal plan keeps render enabled", regCards[nPlan.id].render?.disabled === false, regCards[nPlan.id]);
} else {
  check("normal plan keeps render enabled", false, {visible: Object.keys(regCards), nPlan: nPlan?.id});
}
const cId = Object.keys(regCards).find((id) => /Cancelled during/i.test(regJobs.find((j) => j.id === id)?.error || ""));
if (cId) {
  await ev(`document.querySelector('#queue [data-job="${cId}"] [data-act="detail"]').click()`);
  await sleep(1600);
  const detail = await ev(`document.getElementById("jobBody").innerText.replace(/\\s+/g," ")`);
  check("cancelled detail: 取消原因 + chinese", detail.includes("取消原因") && detail.includes("已取消（在「规划乐谱」阶段停止）") && !detail.includes("Cancelled during"), detail.slice(0, 200));
  await ev(`document.querySelector('#jobModal [data-close]').click()`);
  await sleep(400);
} else {
  check("cancelled detail: 取消原因 + chinese", false, "no cancelled job in queue");
}

await ev(`document.querySelector('[data-view="score"]').click()`);
await sleep(1600);
const regJobs2 = (await (await fetch(`${BASE}/api/jobs?limit=500`)).json()).jobs;
const songScore2 = regJobs2.find((j) => j.id === "song_demo_wanfeng")
  || regJobs2.find((j) => j.type === "song" && j.status === "complete" && j.artifacts?.["score.abc"]);
if (songScore2) {
  const otherOpt = await ev(`[...document.getElementById("scoreJob").options].map(o=>o.value).find(v=>v!=="${songScore2.id}") || ""`);
  if (otherOpt) {
    await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(otherOpt)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
    await sleep(1200);
  }
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(songScore2.id)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(1600);
}
const hasScoreJob = await ev(`document.getElementById("scoreJob").value !== ""`);
if (hasScoreJob) {
  const qline = await ev(`(()=>{const e=document.getElementById("abcEd");const m=e.value.match(/^Q:.*$/m);if(!m)return null;e.value=e.value.replace(/^Q:(.*?)(\\d+)\\s*$/m,(all,a,n)=>all.replace(/\\d+\\s*$/,(String(Number(n)+7))));e.dispatchEvent(new Event("input",{bubbles:true}));return e.value.match(/^Q:.*$/m)[0]})()`);
  await ev(`document.querySelectorAll("#toasts .toast").forEach(t=>t.remove())`);
  await ev(`document.getElementById("btnCompare").click()`);
  await sleep(1600);
  const note = await ev(`document.getElementById("toolNote").innerText.replace(/\\s+/g," ")`);
  const rawOpen = await ev(`!!document.querySelector("#toolNote details")`);
  check("compare tempo diff localized + raw collapsible", /速度（BPM）与原谱不同/.test(note) && rawOpen, {note: note.slice(0, 180), rawOpen, qline});
  await ev(`(()=>{const e=document.getElementById("abcEd");e.value=e.value.replace(/^K:.*$/m,"K:Hmaj");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await ev(`document.querySelectorAll("#toasts .toast").forEach(t=>t.remove())`);
  await ev(`document.getElementById("btnInspect").click()`);
  await sleep(1600);
  const keyToast = await ev(`[...document.querySelectorAll("#toasts .toast")].map(t=>t.innerText.replace(/\\s+/g," ")).join(" | ")`);
  check("unsupported key localized", keyToast.includes("调号不支持"), keyToast);
  await shot("fix-score-diff-zh");
} else {
  check("compare tempo diff localized + raw collapsible", false, "no score job");
}

/* ---------- 8.5 高级参数：精确输入 + 单项复位 ---------- */
await ev(`document.querySelector('[data-view="studio"]').click()`);
await sleep(500);
await ev(`(()=>{const acc=document.getElementById("accAdv");if(!acc.classList.contains("open"))document.querySelector("#accAdv .t").click();return true})()`);
await sleep(300);
const advShape = await json(`(()=>{const rows=[...document.querySelectorAll("#accAdv .ctl")].filter(r=>r.querySelector("[data-range]")||r.querySelector("[data-num]"));
  return JSON.stringify({rows:rows.length,nums:document.querySelectorAll("#accAdv [data-num]").length,
    resets:document.querySelectorAll("#accAdv [data-reset]").length,
    cfg:{num:!!document.getElementById("nCfg"),rst:!!document.getElementById("rstCfg"),max:document.getElementById("sCfg").max},
    ode:{num:!!document.getElementById("nOde"),rst:!!document.getElementById("rstOde")},
    vae:{rst:!!document.getElementById("rstVae"),disabled:document.getElementById("rstVae").disabled}})})()`);
check("advanced rows expose number input + per-item reset",
  advShape.rows === 16 && advShape.nums === 16 && advShape.resets === 14 && advShape.cfg.num && advShape.cfg.rst && advShape.cfg.max === "20"
  && advShape.ode.num && advShape.ode.rst && advShape.vae.rst && advShape.vae.disabled === true, advShape);

const setNum = async (selector, value) => json(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event("change",{bubbles:true}));
  const row=el.closest(".ctl");const range=row.querySelector("[data-range]")||row.querySelector('input[type="range"]');const rst=row.querySelector("[data-reset],.rst");
  return JSON.stringify({num:el.value,range:range.value,rst:rst.disabled,badge:document.getElementById("advBadge").textContent})})()`);
const clickReset = async (selector) => json(`(()=>{document.querySelector(${JSON.stringify(selector)}).click();
  return JSON.stringify({badge:document.getElementById("advBadge").textContent})})()`);

const tempSet = await setNum('#grpAbc [data-key="temperature"] [data-num]', "0.33");
check("temperature input syncs slider + badge",
  Number(tempSet.num) === 0.33 && Number(tempSet.range) === 0.33 && tempSet.rst === false && /已自定义|Customised/.test(tempSet.badge), tempSet);
const tempReset = await clickReset('#grpAbc [data-key="temperature"] [data-reset]');
await sleep(250);
const tempBack = await ev(`(()=>{const row=document.querySelector('#grpAbc [data-key="temperature"]');return JSON.stringify({num:row.querySelector("[data-num]").value,range:row.querySelector("[data-range]").value,rst:row.querySelector("[data-reset]").disabled,badge:document.getElementById("advBadge").textContent})})()`).then(JSON.parse);
check("per-item reset restores temperature default",
  Number(tempBack.num) === 0.7 && Number(tempBack.range) === 0.7 && tempBack.rst === true && /官方默认|Official defaults/.test(tempBack.badge), {tempReset, tempBack});

const cfgSet = await setNum("#nCfg", "4.5");
const cfgBack = await ev(`(()=>{const r=document.getElementById("rstCfg");const state={num:document.getElementById("nCfg").value,range:document.getElementById("sCfg").value,rst:r.disabled};
  r.click();const after={num:document.getElementById("nCfg").value,range:document.getElementById("sCfg").value,rst:r.disabled};return JSON.stringify({state,after})})()`).then(JSON.parse);
check("cfg accepts values above 3, reset follows mode default",
  Number(cfgSet.num) === 4.5 && Number(cfgSet.range) === 4.5 && cfgSet.rst === false
  && Math.abs(Number(cfgBack.after.num) - 1) < 1e-9 && cfgBack.after.rst === true, {cfgSet, cfgBack});

const topKDefault = await ev(`document.querySelector('#grpAbc [data-key="top_k"] [data-num]').value`);
const clampSet = await setNum('#grpAbc [data-key="top_k"] [data-num]', "5000");
await sleep(200);
const clampBack = await ev(`(()=>{const row=document.querySelector('#grpAbc [data-key="top_k"]');row.querySelector("[data-reset]").click();
  return JSON.stringify({num:row.querySelector("[data-num]").value,rst:row.querySelector("[data-reset]").disabled})})()`).then(JSON.parse);
check("out-of-range input clamps to schema max",
  Number(clampSet.num) === 1000 && Number(clampSet.range) === 1000 && clampBack.num === topKDefault && clampBack.rst === true, {topKDefault, clampSet, clampBack});

await shot("fix-advanced-controls");
await send("Emulation.setDeviceMetricsOverride", {width: 320, height: 640, deviceScaleFactor: 2, mobile: true}, sessionId);
await sleep(450);
const advMobile = await json(`(()=>{const q=document.getElementById("accAdv");const r=q.getBoundingClientRect();
  return JSON.stringify({scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,left:Math.round(r.left),right:Math.round(r.right),open:q.classList.contains("open")})})()`);
check("advanced panel fits 320px without overflow",
  advMobile.open && advMobile.scrollW <= advMobile.clientW + 1 && advMobile.right <= 320, advMobile);
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
await sleep(300);

/* ---------- 9. 数据状态回读 ---------- */
if (tPlan) {
  const cleanup = await fetch(`${BASE}/api/jobs/${tPlan.id}`, {method: "DELETE"});
  check("cleanup truncated test job", cleanup.status === 200, cleanup.status);
}
const jobs = await (await fetch(`${BASE}/api/jobs`)).json();
const demo = jobs.jobs.find((j) => j.id === "song_demo_wanfeng");
check("demo job intact (title/favorite/status)", demo && demo.status === "complete" && demo.title === "示例曲 · 晚风" && demo.favorite === false, {status: demo?.status, title: demo?.title, favorite: demo?.favorite});
const model = await (await fetch(`${BASE}/api/model`)).json();
/* 不写死 cuda：本机 3060 Ti 常自动降级，写死就每次跑都出一条假红。
   要验的是「状态与真值一致」——报了 loaded 就得有一台明确设备在跑。 */
check("model reports loaded with a concrete device",
  model.state === "loaded" && (model.device === "cpu" || model.device === "cuda"),
  {state: model.state, device: model.device, reason: model.reason});

fs.writeFileSync(`${OUT}/fix-verify-results.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
ws.close();
process.exit(results.some((r) => !r.pass) ? 1 : 0);

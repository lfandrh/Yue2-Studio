import fs from "node:fs";

/* 音块图验收（对 http://127.0.0.1:9091 做 CDP 检查）。
   独立 headless Chrome，端口 9456，不碰用户已开的浏览器：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9456 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   然后：node tools/verify-roll.mjs        截图落在 tools/evidence/ */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = "http://127.0.0.1:9091";
const PORT = Number(process.env.VERIFY_CDP || 9456);

const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "").split("\n")[0]);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0]);
  }
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
    try { if (await ev(expr)) return true; } catch (exc) { /* mid-navigation */ }
    await sleep(150);
  }
  return false;
};
const results = [];
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
/* 全新 profile 会触发首访引导巡览（会切视图、吞按键），验收里按“已看过”处理 */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try{localStorage.setItem("yue2.v1.tour","seen");localStorage.setItem("yue2.v1.guide","off");localStorage.removeItem("yue2.v1.rollZoom")}catch(e){}`}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await send("Page.navigate", {url: BASE + "/"}, sessionId);
if (!(await waitFor(`document.readyState === "complete" && !!document.getElementById("btnKeys")`))) {
  throw new Error("page did not load");
}
await sleep(1200);

/* 找一个能画成音块图的乐谱任务 */
await ev(`document.querySelector('[data-view="score"]').click()`);
await sleep(900);
const options = await json(`JSON.stringify([...document.querySelectorAll("#scoreJob option")].map(o=>o.value))`);
let picked = null;
for (const value of options) {
  await ev(`(()=>{const s=document.getElementById("scoreJob");s.value=${JSON.stringify(value)};s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await sleep(900);
  if (await ev(`!document.getElementById("rollGrid").hidden`)) { picked = value; break; }
}
check("roll renders for a real score", !!picked, {picked, options: options.length});
if (!picked) {
  await shot("roll-no-plan");
  throw new Error("no plannable score");
}
check("default tab is 音块图", await ev(`document.getElementById("tabRoll").getAttribute("aria-selected") === "true" && document.getElementById("edwrap").hidden`));
const meta = await ev(`document.getElementById("rollMeta").textContent`);
check("roll meta filled", /\d+ 小节/.test(meta || ""), meta);
await shot("roll-overview");

/* 在页面里复算几何，拿到一个音块的屏幕坐标；先保证音块不被底部播放条挡住 */
const measure = async () => json(`(async () => {
  const grid = document.getElementById("rollGrid");
  const canvas = document.getElementById("rollCanvas");
  canvas.scrollIntoView({block: "center"});
  await new Promise((r) => setTimeout(r, 250));
  const top = canvas.getBoundingClientRect().top;
  if (top < 90 || top > innerHeight - 520) {
    window.scrollBy(0, top - 180);
    await new Promise((r) => setTimeout(r, 250));
  }
  const abc = document.getElementById("abcEd").value;
  const plan = await (await fetch("/api/score/plan", {method:"POST",
    headers:{"Content-Type":"application/json"}, body: JSON.stringify({abc})})).json();
  const scroll = document.getElementById("rollScroll");
  /* scrollIntoView 会把画布内容起点对齐到滚动区左缘（=轴宽 44），
     于是首个音符滑到冻结轴底下；音块图默认从 scrollLeft=0 起，这里归零还原真实点击位 */
  scroll.scrollLeft = 0; scroll.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 120));
  const rect = canvas.getBoundingClientRect();
  const total = plan.bars.reduce((s,b)=>s+b.dur,0);
  const rows = Math.max(12, plan.pitch_max - plan.pitch_min + 3);
  /* 直接读画布实际尺寸，不重算公式：缩放/布局改了也不会和 app 漂移 */
  const width = parseFloat(canvas.style.width) || rect.width;
  const height = parseFloat(canvas.style.height) || rect.height;
  const rowH = (height - 18 - 16) / rows;
  const scale = width / total;
  const high = plan.pitch_max + 1;
  const view = Math.max(240, scroll.clientWidth - 44);
  const voice = plan.voices.find(v => v.name === "Vocal" && v.notes.length) || plan.voices.find(v => v.notes.length);
  const note = voice.notes.find(n => !n.tie) || voice.notes[0];
  const x = note.start * scale;
  const y = 34 + (high - note.pitch) * rowH;
  const cx = Math.round(rect.left + x + 2);
  const cy = Math.round(rect.top + y + Math.max(2, rowH / 2));
  const hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({rect: {left: rect.left, top: rect.top}, x, y, cx, cy, rowH,
    hit: hit && (hit.id || hit.tagName), pitch: note.pitch, dur: note.dur, i: note.i,
    voice: voice.name, view, width, notes: voice.notes.length, bars: plan.bars_total});
})()`);
const geom = await measure();
check("click point lands on the canvas", geom.hit === "rollCanvas", geom);
const at = (dx, dy) => ({x: geom.cx + dx, y: geom.cy + dy});
const mouse = (type, point, extra = {}) => send("Input.dispatchMouseEvent", {
  type, x: point.x, y: point.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse", ...extra}, sessionId);
const hover = (point) => send("Input.dispatchMouseEvent", {type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse"}, sessionId);

/* 1. 点选 */
const abc0 = await ev(`document.getElementById("abcEd").value`);
let point = at(0, 0);
await hover(point);
await mouse("mousePressed", point);
await mouse("mouseReleased", point);
await sleep(300);
const sel = await ev(`document.getElementById("rollSel").textContent`);
check("click selects a note", new RegExp(`${geom.voice === "Vocal" ? "人声旋律" : "伴奏"}`).test(sel || ""), sel);
await shot("roll-selected");

/* 2. 向上拖两行 = 升高两个半音 */
await hover(point);
await mouse("mousePressed", point);
await mouse("mouseMoved", {x: point.x, y: point.y - Math.round(geom.rowH * 2)}, {buttons: 1});
await mouse("mouseReleased", {x: point.x, y: point.y - Math.round(geom.rowH * 2)});
await sleep(1600);
const abc1 = await ev(`document.getElementById("abcEd").value`);
const lift = await json(`(async () => {
  const abc = document.getElementById("abcEd").value;
  const plan = await (await fetch("/api/score/plan", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({abc})})).json();
  const voice = plan.voices.find(v => v.name === ${JSON.stringify(geom.voice)});
  return JSON.stringify({pitch: voice.notes[${geom.i}].pitch, bars: plan.bars_total});
})()`);
check("drag up raises pitch by 2", abc1 !== abc0 && lift.pitch === geom.pitch + 2, {from: geom.pitch, to: lift.pitch});
await shot("roll-after-drag");

/* 3. 键盘 ↑ 单个半音 */
await ev(`document.getElementById("rollCanvas").focus()`);
const key = async (key, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", {type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers}, sessionId);
  await send("Input.dispatchKeyEvent", {type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers}, sessionId);
};
await key("ArrowUp", "ArrowUp", 38);
await sleep(1500);
const pitchNow = async () => json(`(async () => {
  const abc = document.getElementById("abcEd").value;
  const plan = await (await fetch("/api/score/plan", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({abc})})).json();
  const voice = plan.voices.find(v => v.name === ${JSON.stringify(geom.voice)});
  return JSON.stringify({pitch: voice.notes[${geom.i}].pitch, notes: plan.notes_total});
})()`);
const afterKey = await pitchNow();
check("ArrowUp nudges one semitone", afterKey.pitch === lift.pitch + 1, {from: lift.pitch, to: afterKey.pitch});

/* 4. Delete 删音 */
const notesBefore = await ev(`document.getElementById("rollMeta").textContent`);
await key("Delete", "Delete", 46);
await sleep(1600);
const notesAfter = await ev(`document.getElementById("rollMeta").textContent`);
const count = (text) => Number((text.match(/· (\d+) 音/) || [])[1] || 0);
check("Delete removes one note", count(notesAfter) === count(notesBefore) - 1, {before: notesBefore, after: notesAfter});

/* 5. Ctrl+Z 撤回 */
await key("z", "KeyZ", 90, 2);
await sleep(1600);
const notesUndo = await ev(`document.getElementById("rollMeta").textContent`);
check("Ctrl+Z restores the note", count(notesUndo) === count(notesBefore), {after: notesUndo});

/* 6. 工具箱：BPM 与移调 */
const bpm0 = await ev(`Number(document.getElementById("rollBpm").value)`);
await ev(`(()=>{const b=document.getElementById("rollBpm");b.value=String(${bpm0} + 6);document.getElementById("btnBpm").click();return true})()`);
await sleep(1600);
const bpm1 = await ev(`Number(document.getElementById("rollBpm").value)`);
check("BPM apply rewrites Q:", bpm1 === bpm0 + 6, {from: bpm0, to: bpm1});

await ev(`document.getElementById("trUp12").click()`);
await sleep(1600);
const transposed = await ev(`document.getElementById("abcEd").value`);
check("transpose +12 changes score", transposed !== abc1, {len: transposed.length});

/* 7. 段落复制 / 删除 */
const bars = (text) => Number((text.match(/^(\d+) 小节/) || [])[1] || 0);
const barsBefore = bars(await ev(`document.getElementById("rollMeta").textContent`));
await ev(`document.getElementById("btnSecDup").click()`);
await sleep(1600);
const barsDup = bars(await ev(`document.getElementById("rollMeta").textContent`));
await ev(`document.getElementById("btnRevert").click()`);
await sleep(500);
await ev(`document.querySelector(".modal [data-ok]")?.click()`);
await sleep(1600);
const barsRevert = bars(await ev(`document.getElementById("rollMeta").textContent`));
check("duplicate section adds bars, revert restores", barsDup > barsBefore && barsRevert === barsBefore, {before: barsBefore, dup: barsDup, revert: barsRevert});

/* 8. 切到文本谱改速度，再切回音块图 */
await ev(`document.getElementById("tabText").click()`);
await sleep(400);
const textTab = await json(`JSON.stringify({ed: !document.getElementById("edwrap").hidden, grid: document.getElementById("rollGrid").hidden})`);
await ev(`document.getElementById("abcEd").focus()`);
const bpmText = await ev(`Number((document.getElementById("abcEd").value.match(/Q:1\\/4=(\\d+)/) || [])[1])`);
await ev(`(()=>{const t=document.getElementById("abcEd");t.value=t.value.replace(/Q:1\\/4=\\d+/, "Q:1/4=${bpmText + 4}");t.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
await sleep(1200);
await ev(`document.getElementById("tabRoll").click()`);
await sleep(1200);
const rollTab = await json(`JSON.stringify({ed: document.getElementById("edwrap").hidden, grid: !document.getElementById("rollGrid").hidden, note: document.getElementById("rollNote").hidden, bpm: Number(document.getElementById("rollBpm").value), meta: document.getElementById("rollMeta").textContent})`);
check("text edit flows into the roll", textTab.ed && textTab.grid && rollTab.ed && rollTab.grid && rollTab.note && rollTab.bpm === bpmText + 4, {textTab, rollTab});
await shot("roll-roundtrip");

/* 9. 段落下拉有内容，英文模式不留中文 */
const sectionText = await ev(`document.querySelector("#rollSection option")?.textContent || ""`);
check("section dropdown filled", /小节/.test(sectionText), sectionText);
await setLang("en");
await sleep(900);
const left = await json(`(()=>{const sec=document.getElementById("v-score");
  const w=document.createTreeWalker(sec,NodeFilter.SHOW_TEXT);const out=[];let n;
  while((n=w.nextNode())){const t=(n.nodeValue||"").trim();
    if(!t||/[\\u4e00-\\u9fff]/.test(t)===false)continue;
    if(n.parentElement.closest("[data-notr]")||n.parentElement.closest("#scoreJob"))continue;out.push(t.slice(0,26));}
  return JSON.stringify(out.slice(0,10))})()`);
check("EN mode leaves no untranslated Chinese", left.length === 0, left);
await shot("roll-en");
await setLang("zh");
await sleep(700);
check("back to Chinese", /[\u4e00-\u9fff]/.test(await ev(`document.getElementById("tabRoll").textContent`)));

/* 10. 全屏（窗口内放大）：收起导航与侧栏，谱面铺满；Esc 退出 */
check("score view is still the active one", await ev(`document.querySelector(".view.active")?.id === "v-score"`));
const plainH = await ev(`document.getElementById("rollGrid").getBoundingClientRect().height`);
await ev(`document.getElementById("btnRollFull").click()`);
await sleep(700);
const focus = await json(`(()=>{const v=document.getElementById("v-score");
  const grid=document.getElementById("rollGrid").getBoundingClientRect();
  const cards=[...document.querySelectorAll("#v-score aside>.card")].filter(c=>c.offsetParent);
  const topbar=document.querySelector(".topbar").getBoundingClientRect();
  const rail=document.querySelector(".rail").getBoundingClientRect();
  const covered=(x,y)=>{const e=document.elementFromPoint(x,y);return !!(e&&e.closest("#v-score"))};
  return JSON.stringify({on:v.classList.contains("rollfocus"), fixed:getComputedStyle(v).position,
    pressed:document.getElementById("btnRollFull").getAttribute("aria-pressed"),
    tx:document.getElementById("btnRollFullTx").textContent,
    h:Math.round(grid.height), covered:covered(20,20)&&covered(topbar.width/2,topbar.height/2)&&covered(rail.width/2,rail.height/2),
    cards:cards.map(c=>c.id), vw:Math.round(v.getBoundingClientRect().width), innerW:innerWidth,
    fits:v.scrollHeight <= v.clientHeight + 1})})()`);
check("full screen covers nav and grows the roll",
  focus.on && focus.fixed === "fixed" && focus.covered && focus.h > plainH + 60 && focus.vw >= focus.innerW - 1,
  {plainH: Math.round(plainH), ...focus});
check("full screen fits the window without scrolling", focus.fits, {scroll: focus.fits});
check("full screen keeps only 快速调整", focus.cards.length === 1 && focus.cards[0] === "cardQuick" && focus.pressed === "true",
  {cards: focus.cards, tx: focus.tx});

const fgeom = await measure();
check("focus click point lands on the canvas", fgeom.hit === "rollCanvas", {hit: fgeom.hit, h: Math.round(focus.h)});
const fp = {x: fgeom.cx, y: fgeom.cy};
await hover(fp);
await mouse("mousePressed", fp);
await mouse("mouseMoved", {x: fp.x, y: fp.y - Math.round(fgeom.rowH)}, {buttons: 1});
await mouse("mouseReleased", {x: fp.x, y: fp.y - Math.round(fgeom.rowH)});
await sleep(1600);
const fpitch = await json(`(async () => {
  const abc = document.getElementById("abcEd").value;
  const plan = await (await fetch("/api/score/plan", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({abc})})).json();
  const voice = plan.voices.find(v => v.name === ${JSON.stringify(fgeom.voice)});
  return JSON.stringify({pitch: voice.notes[${fgeom.i}].pitch});
})()`);
check("drag still works in full screen", fpitch.pitch === fgeom.pitch + 1, {from: fgeom.pitch, to: fpitch.pitch});
await shot("roll-focus");

await ev(`document.getElementById("tabText").click()`);
await sleep(500);
const focusText = await json(`(()=>{const w=document.getElementById("edwrap").getBoundingClientRect();
  const v=document.getElementById("v-score");
  return JSON.stringify({on:v.classList.contains("rollfocus"), hidden:document.getElementById("edwrap").hidden,
    h:Math.round(w.height), fits:v.scrollHeight <= v.clientHeight + 1})})()`);
check("full screen text tab fills the window", focusText.on && !focusText.hidden && focusText.h > 500 && focusText.fits, focusText);
await shot("roll-focus-text");
await ev(`document.getElementById("tabRoll").click()`);
await sleep(700);

await key("Escape", "Escape", 27);
await sleep(700);
const esc = await json(`(()=>{const v=document.getElementById("v-score");
  return JSON.stringify({on:v.classList.contains("rollfocus"), pressed:document.getElementById("btnRollFull").getAttribute("aria-pressed"),
    tx:document.getElementById("btnRollFullTx").textContent,
    h:Math.round(document.getElementById("rollGrid").getBoundingClientRect().height)})})()`);
check("Esc leaves full screen", !esc.on && esc.pressed === "false" && Math.abs(esc.h - plainH) < 40, {plainH: Math.round(plainH), ...esc});
await shot("roll-esc");

/* 全屏中切语言，按钮文字和提示都要跟着翻 */
await ev(`document.getElementById("btnRollFull").click()`);
await sleep(500);
await setLang("en");
await sleep(700);
const enFocus = await json(`JSON.stringify({tx:document.getElementById("btnRollFullTx").textContent,
  title:document.getElementById("btnRollFull").title})`);
check("button follows state after a language switch",
  enFocus.tx === "Exit full screen" && /exit/i.test(enFocus.title), enFocus);
await setLang("zh");
await sleep(700);
const zhFocus = await json(`JSON.stringify({tx:document.getElementById("btnRollFullTx").textContent,
  title:document.getElementById("btnRollFull").title})`);
check("button follows state back in Chinese", zhFocus.tx === "退出全屏" && /Esc/.test(zhFocus.title), zhFocus);
await key("Escape", "Escape", 27);
await sleep(500);

/* 11. 320 宽不溢出 */
await send("Emulation.setDeviceMetricsOverride", {width: 320, height: 640, deviceScaleFactor: 2, mobile: true}, sessionId);
await sleep(900);
const narrow = await json(`(()=>{const d=document.documentElement;const g=document.getElementById("rollGrid").getBoundingClientRect();return JSON.stringify({scrollW:d.scrollWidth,clientW:d.clientWidth,gridRight:Math.round(g.right),gridW:Math.round(g.width),innerW:innerWidth})})()`);
check("320px: no horizontal overflow", narrow.scrollW <= narrow.clientW + 1 && narrow.gridRight <= narrow.innerW, narrow);
await shot("roll-320");

await ev(`document.getElementById("btnRollFull").click()`);
await sleep(700);
const narrowFocus = await json(`(()=>{const v=document.getElementById("v-score");const d=document.documentElement;
  const g=document.getElementById("rollGrid").getBoundingClientRect();
  return JSON.stringify({on:v.classList.contains("rollfocus"), scrollW:d.scrollWidth, clientW:d.clientWidth,
    gridW:Math.round(g.width), gridH:Math.round(g.height), innerW:innerWidth})})()`);
check("320px: full screen still fits", narrowFocus.on && narrowFocus.scrollW <= narrowFocus.clientW + 1 && narrowFocus.gridW > 0, narrowFocus);
await shot("roll-320-focus");
await key("Escape", "Escape", 27);
await sleep(600);
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

/* 12. 中间宽度：工具条会换行，全屏高度得跟着量，不能写死常数 */
await send("Emulation.setDeviceMetricsOverride", {width: 1000, height: 700, deviceScaleFactor: 1, mobile: false}, sessionId);
await sleep(800);
await ev(`document.getElementById("btnRollFull").click()`);
await sleep(700);
const midFocus = await json(`(()=>{const v=document.getElementById("v-score");
  const g=document.getElementById("rollGrid").getBoundingClientRect();
  return JSON.stringify({on:v.classList.contains("rollfocus"), h:Math.round(g.height),
    bottom:Math.round(g.bottom), fits:v.scrollHeight <= v.clientHeight + 1, vh:innerHeight})})()`);
check("1000x700: full screen height follows the wrapped toolbar",
  midFocus.on && midFocus.fits && midFocus.bottom < midFocus.vh, midFocus);
await shot("roll-focus-1000");
await key("Escape", "Escape", 27);
await sleep(600);
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

/* 13. 退出全屏回到原滚动位置（矮窗口才有得滚） */
await send("Emulation.setDeviceMetricsOverride", {width: 1280, height: 460, deviceScaleFactor: 1, mobile: false}, sessionId);
await sleep(900);
await ev(`(()=>{document.getElementById("work").scrollTop=0;return true})()`);
await sleep(200);
const scrollable = await json(`(()=>{const w=document.getElementById("work");
  return JSON.stringify({extra:w.scrollHeight-w.clientHeight})})()`);
check("460px-tall window: score page scrolls", scrollable.extra > 40, scrollable);
await ev(`(()=>{const w=document.getElementById("work");w.scrollTop=w.scrollHeight;return true})()`);
await sleep(300);
const scrolled = await json(`(()=>{const w=document.getElementById("work");
  return JSON.stringify({top:w.scrollTop,gridH:Math.round(document.getElementById("rollGrid").getBoundingClientRect().height)})})()`);
await ev(`document.getElementById("btnRollFull").click()`);
await sleep(700);
const focusTop = await ev(`document.getElementById("work").scrollTop`);
check("entering full screen scrolls to top", focusTop === 0, {focusTop});
await shot("roll-focus-short");
await key("Escape", "Escape", 27);
await sleep(800);
const restored = await json(`(()=>{const w=document.getElementById("work");
  return JSON.stringify({top:w.scrollTop,focus:document.getElementById("v-score").classList.contains("rollfocus"),
    gridH:Math.round(document.getElementById("rollGrid").getBoundingClientRect().height)})})()`);
check("exiting full screen restores the scroll position",
  !restored.focus && scrolled.top > 40 && Math.abs(restored.top - scrolled.top) <= 2, {scrolled, restored});
await key("Escape", "Escape", 27);
await sleep(400);
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

/* 14. 缩放：横向/纵向放大、适应复位、光标锚点、持久化、短音符可点 */
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await sleep(600);
await ev(`document.querySelector('[data-view="score"]').click()`);
await sleep(400);
await ev(`document.getElementById("tabRoll").click()`);
await sleep(900);
const rollState = () => json(`(()=>{const c=document.getElementById("rollCanvas");const s=document.getElementById("rollScroll");const a=document.getElementById("rollAxis");
  return JSON.stringify({w:parseFloat(c.style.width)||0,h:parseFloat(c.style.height)||0,axisH:parseFloat(a.style.height)||0,
    xVal:document.getElementById("zoomXVal").textContent,yVal:document.getElementById("zoomYVal").textContent,
    sl:s.scrollLeft,st:s.scrollTop,vOver:s.scrollHeight-s.clientHeight,hOver:s.scrollWidth-s.clientWidth})})()`);
const z0 = await rollState();
check("roll visible before zoom", z0.w > 0 && z0.h > 0 && z0.xVal === "100%", z0);

for (let k = 0; k < 3; k++) await ev(`document.getElementById("zoomXIn").click()`);
await sleep(300);
const zx = await rollState();
check("horizontal zoom widens canvas + x-scroll", zx.w > z0.w * 1.8 && zx.hOver > 10 && zx.xVal !== "100%", {w0: Math.round(z0.w), w: Math.round(zx.w), xVal: zx.xVal, hOver: Math.round(zx.hOver)});

for (let k = 0; k < 3; k++) await ev(`document.getElementById("zoomYIn").click()`);
await sleep(300);
const zy = await rollState();
check("vertical zoom grows height + y-scroll", zy.h > z0.h * 1.8 && zy.vOver > 10, {h0: Math.round(z0.h), h: Math.round(zy.h), vOver: Math.round(zy.vOver)});
check("axis height tracks content height", Math.abs(zy.axisH - zy.h) < 1, {axisH: Math.round(zy.axisH), h: Math.round(zy.h)});

await ev(`document.getElementById("zoomFit").click()`);
await sleep(300);
const zf = await rollState();
check("fit resets zoom to 100% and original size",
  zf.xVal === "100%" && zf.yVal === "100%" && Math.abs(zf.w - z0.w) < 2 && Math.abs(zf.h - z0.h) < 2 && zf.sl === 0, {zf, w0: z0.w, h0: z0.h});

/* 光标锚点：Ctrl+滚轮在可视区中部放大，光标下的“音乐位置”（单位）应不变 */
const totalU = await ev(`(async()=>{const abc=document.getElementById("abcEd").value;
  const p=await (await fetch("/api/score/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({abc})})).json();
  return p.bars.reduce((a,b)=>a+b.dur,0)})()`);
const probeUnits = (px) => ev(`(()=>{const s=document.getElementById("rollScroll");const c=document.getElementById("rollCanvas");
  const r=s.getBoundingClientRect();const scale=(parseFloat(c.style.width)||1)/${totalU};
  return (s.scrollLeft+(${px}-r.left-44))/scale})()`);
const wheelPt = await json(`(()=>{const r=document.getElementById("rollScroll").getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+44+(r.width-44)/2),y:Math.round(r.top+r.height/2)})})()`);
const uBefore = await probeUnits(wheelPt.x);
await send("Input.dispatchMouseEvent", {type: "mouseWheel", x: wheelPt.x, y: wheelPt.y, deltaX: 0, deltaY: -120, modifiers: 2}, sessionId);
await sleep(350);
const uAfter = await probeUnits(wheelPt.x);
const zw = await rollState();
check("ctrl+wheel zooms in", zw.w > zf.w + 2, {w: Math.round(zw.w), zfw: Math.round(zf.w)});
check("ctrl+wheel keeps the musical position under the cursor",
  Math.abs(uAfter - uBefore) <= Math.max(2, totalU * 0.01), {uBefore: Math.round(uBefore), uAfter: Math.round(uAfter), totalU});

const persisted = await ev(`(()=>{try{return localStorage.getItem("yue2.v1.rollZoom")}catch(e){return null}})()`);
check("zoom persisted to localStorage", !!persisted && /"x":/.test(persisted), persisted);

/* 短音符可点：把 dur 最小的音符滚到视口中央，点它的中心应选中它本人（验证命中容差 + 最近优先） */
await ev(`document.getElementById("zoomFit").click()`);
await sleep(300);
/* 先把谱面在窗口里居中，否则靠下的音符会落到底部歌词浮层(#lyr)后面，点到浮层而不是画布 */
await ev(`document.getElementById("rollGrid").scrollIntoView({block:"center"})`);
await sleep(250);
const shortNote = await json(`(async()=>{const abc=document.getElementById("abcEd").value;
  const p=await (await fetch("/api/score/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({abc})})).json();
  const c=document.getElementById("rollCanvas");const s=document.getElementById("rollScroll");
  const total=p.bars.reduce((a,b)=>a+b.dur,0);const width=parseFloat(c.style.width);const height=parseFloat(c.style.height);
  const rows=Math.max(12,p.pitch_max-p.pitch_min+3);const rowH=(height-34)/rows;const scale=width/total;
  let best=null;for(const v of p.voices){for(const n of v.notes){if(!best||n.dur<best.dur)best={i:n.i,start:n.start,pitch:n.pitch,dur:n.dur,bar:n.bar,voice:v.name};}}
  const nw=Math.max(3,best.dur*scale-0.8);const lx=best.start*scale+nw/2;const ly=34+(p.pitch_max+1-best.pitch)*rowH+rowH/2;
  /* 横向把音符放到"未被冻结轴遮挡"的可视区中央；纵向内容恰好铺满一屏，scrollTop 归零 */
  s.scrollLeft=Math.max(0,Math.round(44+lx-(44+s.clientWidth)/2));
  s.scrollTop=0;
  await new Promise(r=>setTimeout(r,160));
  const rect=c.getBoundingClientRect();
  const clickX=Math.round(rect.left+lx),clickY=Math.round(rect.top+ly);
  const NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const nm=NAMES[((best.pitch%12)+12)%12]+(Math.floor(best.pitch/12)-1);
  const e=document.elementFromPoint(clickX,clickY);
  return JSON.stringify({i:best.i,voice:best.voice,dur:best.dur,bar:best.bar,w:Math.round(nw),name:nm,
    gridTop:Math.round(document.getElementById("rollGrid").getBoundingClientRect().top),
    clickX,clickY,onCanvas:e&&(e.id||e.tagName)})})()`);
await hover({x: shortNote.clickX, y: shortNote.clickY});
await mouse("mousePressed", {x: shortNote.clickX, y: shortNote.clickY});
await mouse("mouseReleased", {x: shortNote.clickX, y: shortNote.clickY});
await sleep(350);
const shortSel = await ev(`document.getElementById("rollSel").textContent`);
check("shortest note is clickable and selects itself",
  shortNote.w <= 6 && shortNote.onCanvas === "rollCanvas" && new RegExp(`第 ${shortNote.bar + 1} 小节`).test(shortSel || "") && (shortSel || "").includes(shortNote.name),
  {shortNote, shortSel});

await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log("\nFAILED:", failed.map((r) => r.name).join(" | "));
  console.log("STATE", await ev(`(()=>({hash:location.hash,
    active:[...document.querySelectorAll(".view.active")].map(s=>s.id),
    vCls:document.getElementById("v-score")?.className,
    vSize:[document.getElementById("v-score")?.offsetWidth, document.getElementById("v-score")?.offsetHeight],
    fullBtn:[document.getElementById("btnRollFull").disabled, document.getElementById("btnRollFullTx").textContent],
    inner:[innerWidth,innerHeight]}))()`));
  if (errors.length) console.log("ERRORS", errors.slice(-5));
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

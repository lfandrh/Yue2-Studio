import fs from "node:fs";

/* 创作页样式验收（对 http://127.0.0.1:8083 做 CDP 检查）。
   先起一个独立 headless Chrome（端口 9458，不碰用户已开标签）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9458 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   再运行：node tools/verify-page-style.mjs        截图落在 tools/evidence/ */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:8083";
const PORT = Number(process.env.VERIFY_CDP || 9458);

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
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};

await send("Page.enable");
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", {cacheDisabled: true}, sessionId);
await send("Emulation.setDeviceMetricsOverride", {width: 1426, height: 900, deviceScaleFactor: 1, mobile: false}, sessionId);
await send("Page.navigate", {url: BASE + "/"}, sessionId);
for (let i = 0; i < 60; i++) {
  if (await ev(`document.readyState === "complete" && !!document.getElementById("btnKeys")`)) break;
  await sleep(200);
}
await sleep(700);

/* 首次引导会压暗整页，先标记已读再刷新，验收和截图都基于干净页面 */
await ev(`localStorage.setItem("yue2.tour", "seen")`);
await send("Page.reload", {}, sessionId);
for (let i = 0; i < 60; i++) {
  if (await ev(`document.readyState === "complete" && !!document.getElementById("btnKeys")`)) break;
  await sleep(200);
}
await sleep(700);

/* 零值计数不应显示高亮徽标 */
const badges = await ev(`(() => ({
  studio: {hidden: document.getElementById("cStudio").hidden, text: document.getElementById("cStudio").textContent,
    display: getComputedStyle(document.getElementById("cStudio")).display},
  lib: {hidden: document.getElementById("cLib").hidden, text: document.getElementById("cLib").textContent,
    display: getComputedStyle(document.getElementById("cLib")).display}
}))()`);
check("零计数徽标隐藏", badges.studio.hidden === true && badges.studio.display === "none" && badges.lib.hidden === false, badges);

/* 单行控件统一 40px：语言下拉与速度输入上下对齐 */
const align = await ev(`(() => {
  const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return {top: +b.top.toFixed(1), h: +b.height.toFixed(1)}; };
  return {lang: r("fLang"), bpm: r("fBpm"), preset: r("fPreset"), presetBtn: r("btnPreset")};
})()`);
check("语言/速度控件等高对齐", align.lang.h === 40 && align.bpm.h === 40 && align.lang.top === align.bpm.top, align);
check("范例下拉与按钮等高对齐", align.preset.h === 32 && align.presetBtn.h === 32 && align.preset.top === align.presetBtn.top, align);

/* 耗时构成：展开状态要同步给读屏 */
const before = await ev(`document.getElementById("costBrk").getAttribute("aria-expanded")`);
await ev(`document.getElementById("costBrk").click()`);
const after = await ev(`document.getElementById("costBrk").getAttribute("aria-expanded")`);
await ev(`document.getElementById("costBrk").click()`);
const after2 = await ev(`document.getElementById("costBrk").getAttribute("aria-expanded")`);
check("耗时构成展开状态同步", before === "false" && after === "true" && after2 === "false", {before, after, after2});

const guide = await ev(`(() => { const el = document.getElementById("btnGuideOff"); return el ? {cls: el.className, h: Math.round(el.getBoundingClientRect().height)} : null; })()`);
check("引导主操作有边界样式", guide && guide.cls === "btn sm" && guide.h === 32, guide);

const wrap = await ev(`(() => ({h1: getComputedStyle(document.querySelector(".vhead h1")).textWrap, p: getComputedStyle(document.querySelector(".vhead p")).textWrap}))()`);
check("标题/正文断行策略", wrap.h1 === "balance" && wrap.p === "pretty", wrap);

check("页面无控制台报错", errors.length === 0, errors.slice(0, 3));

for (const theme of ["light", "dark"]) {
  await ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(250);
  const {data} = await send("Page.captureScreenshot", {format: "png"}, sessionId);
  fs.writeFileSync(`${OUT}/page-style-1426-${theme}.png`, Buffer.from(data, "base64"));
}

ws.close();
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项未通过` : `\n${results.length} 项全部通过`);
process.exit(failed ? 1 : 0);

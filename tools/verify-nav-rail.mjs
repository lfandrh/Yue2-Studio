import fs from "node:fs";

/* 侧栏响应式验收（对 http://127.0.0.1:8083 做 CDP 检查）。
   先起一个独立 headless Chrome（端口 9457，不碰用户已开标签）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9457 --user-data-dir=<临时目录> --window-size=1426,900 --no-first-run about:blank
   再运行：node tools/verify-nav-rail.mjs        截图落在 tools/evidence/ */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, {recursive: true});
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:8083";
const PORT = Number(process.env.VERIFY_CDP || 9457);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, timeout = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch (err) { /* context may be mid-navigation */ }
    await sleep(200);
  }
  return false;
};
const results = [];
const check = (name, pass, detail) => {
  results.push({name, pass, detail});
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};

await send("Page.enable");
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", {cacheDisabled: true}, sessionId);
await send("Page.navigate", {url: BASE + "/"}, sessionId);
if (!(await waitFor(`document.readyState === "complete" && !!document.querySelector(".rail")`))) {
  throw new Error("page did not load: " + (await ev("location.href")));
}
await sleep(600);
// 关掉首次巡览遮罩，截图与量测只针对导航本身
await ev(`(() => { localStorage.setItem("yue2.tour", "seen"); localStorage.setItem("yue2.guide", "off"); return true; })()`);
await send("Page.reload", {}, sessionId);
if (!(await waitFor(`document.readyState === "complete" && document.getElementById("tour").hidden`))) {
  throw new Error("tour overlay still open");
}
await sleep(400);

const measure = () => ev(`(() => {
  const rail = document.querySelector(".rail");
  const rr = rail.getBoundingClientRect();
  return {
    innerWidth,
    rail: {x: Math.round(rr.x), right: Math.round(rr.right), w: Math.round(rr.width),
      scrollOver: rail.scrollWidth - rail.clientWidth},
    navs: [...document.querySelectorAll(".nav")].map((n) => {
      const r = n.getBoundingClientRect();
      return {view: n.dataset.view, x: Math.round(r.x), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height),
        over: n.scrollWidth - n.clientWidth,
        lb: getComputedStyle(n.querySelector(".lb")).display,
        key: getComputedStyle(n.querySelector(".nkey")).display,
        name: n.getAttribute("aria-label") || ""};
    }),
  };
})()`);

for (const width of [1280, 1180, 1000, 900, 821, 820, 672, 400]) {
  await send("Emulation.setDeviceMetricsOverride", {width, height: 800, deviceScaleFactor: 1, mobile: false}, sessionId);
  await sleep(250);
  const m = await measure();
  const bottom = width <= 820;
  const collapsed = !bottom && width <= 1180;
  const issues = [];
  if (m.rail.scrollOver > 0) issues.push(`rail 横向溢出 ${m.rail.scrollOver}px`);
  for (const n of m.navs) {
    const within = bottom
      ? n.x >= m.rail.x - 1 && n.right <= m.rail.right + 1
      : n.x >= m.rail.x && n.right <= m.rail.right;
    if (n.over > 0) issues.push(`${n.view} 内容溢出 ${n.over}px`);
    if (!within) issues.push(`${n.view} 超出侧栏 ${n.x}-${n.right} / ${m.rail.x}-${m.rail.right}`);
    if (!n.name) issues.push(`${n.view} 缺 aria-label`);
    if (width > 1180 && n.lb === "none") issues.push(`${n.view} 完整侧栏丢了文字标签`);
    if (width <= 1180 && n.key !== "none") issues.push(`${n.view} 窄栏仍显示快捷键徽标`);
    if (collapsed && (n.w !== 44 || n.h !== 44)) issues.push(`${n.view} 点击区 ${n.w}x${n.h} 不是 44x44`);
  }
  check(`${width}px`, issues.length === 0, issues.length ? issues : m.navs.map((n) => `${n.w}x${n.h}`).join(","));
  if (width === 1000 || width === 672) {
    const {data} = await send("Page.captureScreenshot", {format: "png"}, sessionId);
    fs.writeFileSync(`${OUT}/nav-rail-${width}.png`, Buffer.from(data, "base64"));
  }
}

// 英文界面：图标栏的 aria-label / title 必须跟着翻译，不能残留中文
await send("Emulation.setDeviceMetricsOverride", {width: 1000, height: 800, deviceScaleFactor: 1, mobile: false}, sessionId);
await ev(`(() => { document.getElementById("btnLang").click(); return true; })()`);
await sleep(500);
const en = await ev(`[...document.querySelectorAll(".nav")].map((n) => ({view: n.dataset.view, aria: n.getAttribute("aria-label"), title: n.getAttribute("title")}))`);
const expectEn = "Create,Score workbench,Library,Tutorial,System";
check("英文导航名称", en.map((n) => n.aria).join(",") === expectEn, en.map((n) => n.aria));
check("英文提示标题", en.every((n) => n.title === n.aria), en.map((n) => n.title));

ws.close();
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} 项未通过` : `\n${results.length} 项全部通过`);
process.exit(failed.length ? 1 : 0);

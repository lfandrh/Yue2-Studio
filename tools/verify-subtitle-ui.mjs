import fs from "node:fs";

/* 字幕导出 UI 验收（对 VERIFY_BASE 做 CDP 检查，默认 8083）。
   先起独立 headless Chrome（端口 VERIFY_CDP，默认 9461）：
     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new \
       --remote-debugging-port=9461 --user-data-dir=<临时目录> --no-first-run \
       --autoplay-policy=no-user-gesture-required about:blank
   再运行：node tools/verify-subtitle-ui.mjs
   覆盖：三个入口（歌词条 / 任务详情 / 曲库卡）、下载 URL 与文件名、菜单关闭与焦点回位、
         A/B 选择不受影响、英文文案、390px 触控尺寸与菜单不出界。 */
const OUT = "tools/evidence";
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:8083";
const PORT = Number(process.env.VERIFY_CDP || 9461);

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
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const ev = async (expr) => (await send("Runtime.evaluate", {
  expression: expr, awaitPromise: true, returnByValue: true,
}, sessionId)).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, timeout = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch (err) { /* 导航中上下文会短暂失效 */ }
    await sleep(200);
  }
  return false;
};
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail)}`);
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
};

await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId);

/* 真曲库里没有「未完成」和派生任务样本：给 /api/jobs 注入两条，验证入口与原因文案。
   created_at 设成最早，排在现有卡片后面，不影响按首卡取元素的老断言。 */
const fakeJob = {
  id: "ui_fixture_running", type: "song", status: "running", stage: "", progress: "",
  device: "cpu", style: "", title: "验收用运行中任务", seed: 1, cot: "full",
  created_at: 1, updated_at: 1, favorite: 0, error: "", duration: null, truncated: false,
  ode_steps: null, vae: "", demo: false, work_name: "", version_no: null,
  version_tag: "", version_label: "", version_note: "", kept: null, hidden: false,
  lyrics_len: 0, lyrics_head: "", artifacts: {},
  requested: {style: "", lyrics: "", cot: "full", seed: 1},
};
const derivedJob = {
  ...fakeJob, id: "ui_fixture_derived", type: "redecode", status: "complete",
  title: "验收用派生任务", parent_id: "song_demo_wanfeng", created_at: 2,
  work_name: "派生任务验收", lyrics_len: 8, lyrics_head: "晚风轻轻吹过窗前",
  artifacts: {"audio.flac": {size: 1}}, requested: {style: "Mandarin", cot: "full", seed: 1},
};
const injected = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const fake = ${JSON.stringify(fakeJob)};
  const derived = ${JSON.stringify(derivedJob)};
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    const res = await orig(url, opts);
    try {
      const parsed = new URL(String(url), location.href);
      if (parsed.pathname === "/api/jobs" && (!opts || !opts.method || opts.method === "GET")) {
        const data = await res.clone().json();
        data.jobs = [...(data.jobs || []), fake, derived];
        return new Response(JSON.stringify(data), {status: res.status,
          headers: {"Content-Type": "application/json"}});
      }
    } catch (err) { /* 非 JSON 响应原样返回 */ }
    return res;
  };
})()` }, sessionId);

const boot = async (lang = "zh") => {
  await send("Page.navigate", { url: BASE + "/#library" }, sessionId);
  await waitFor(`document.readyState === "complete"`);
  await ev(`localStorage.setItem("yue2.v1.tour", "seen"), localStorage.setItem("yue2.v1.guide", "off"),
    localStorage.setItem("yue2.v1.lang", ${JSON.stringify(lang)}), true`);
  await send("Page.reload", {}, sessionId);
  if (!(await waitFor(`!!document.querySelector(".cardSub[data-subcard]")`))) {
    throw new Error("曲库里没有带字幕入口的卡片");
  }
  await sleep(500);
};

/* 只拦字幕请求，其他请求照旧，避免打断轮询 */
const patchFetch = () => ev(`(() => {
  window.__subCalls = [];
  window.__fetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes("/lyrics/subtitle")) {
      window.__subCalls.push(String(url));
      return new Response("fake", {status: 200});
    }
    return window.__fetch(url, opts);
  };
  return true;
})()`);
const restoreFetch = () => ev(`(() => { window.fetch = window.__fetch; delete window.__fetch; return true; })()`);
const failFetch = (detail) => ev(`(() => {
  window.__subCalls = [];
  window.__fetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes("/lyrics/subtitle")) {
      window.__subCalls.push(String(url));
      return new Response(JSON.stringify({detail: ${JSON.stringify(detail)}}),
        {status: 409, headers: {"Content-Type": "application/json"}});
    }
    return window.__fetch(url, opts);
  };
  return true;
})()`);
const lastCall = () => ev(`window.__subCalls[window.__subCalls.length - 1] || ""`);
const toastText = () => ev(`(document.querySelector(".toast:last-of-type") || {}).innerText || ""`);
const waitToast = async (needle) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const text = await ev(`[...document.querySelectorAll(".toast")].map(t => t.innerText).join("\\n")`);
    if (String(text).includes(needle)) return String(text);
    await sleep(150);
  }
  return "";
};

/* ---------- 曲库卡 ---------- */
await boot();
const cards = await ev(`document.querySelectorAll(".cardSub[data-subcard]").length`);
check("曲库卡有字幕入口", cards >= 1, { cards });

const cardState = await ev(`(() => {
  const card = document.querySelector(".cardSub[data-subcard]");
  const ab = document.querySelector("#btnAB").textContent.trim();
  card.open = true;
  const labels = [...card.querySelectorAll("[data-sub]")].map(b => b.textContent.trim());
  const heights = [...card.querySelectorAll("[data-sub]")].map(b => Math.round(b.getBoundingClientRect().height));
  return {ab, labels, heights, summary: card.querySelector("summary").getAttribute("aria-label")};
})()`);
check("曲库卡展开出三种格式", JSON.stringify(cardState.labels) === JSON.stringify(["SRT 字幕", "LRC（行级）", "LRC（逐字）"]),
  cardState.labels);
check("曲库卡入口标注", cardState.summary === "字幕导出", cardState.summary);

await patchFetch();
await ev(`document.querySelector(".cardSub[data-subcard] [data-word='1']").click()`);
const cardToast = await waitToast(".lrc");
const cardUrl = await lastCall();
check("曲库卡逐字请求", /format=lrc/.test(cardUrl) && /enhanced=1/.test(cardUrl), cardUrl);
check("曲库卡文件名带逐字", cardToast.includes("(逐字)") && cardToast.includes(".lrc"), cardToast.trim());
const cardClosed = await ev(`(() => { const c = document.querySelector(".cardSub[data-subcard]");
  return !c.open && document.activeElement === c.querySelector("summary"); })()`);
check("下载后收起并把焦点还给入口", cardClosed);
const abAfter = await ev(`document.querySelector("#btnAB").textContent.trim()`);
check("点字幕不影响 A/B 选择", abAfter === cardState.ab, { before: cardState.ab, after: abAfter });
await restoreFetch();

await failFetch("没有歌词，无法生成字幕");
await ev(`(() => { const c = document.querySelector(".cardSub[data-subcard]");
  c.open = true; return true; })()`);
await sleep(120);
await ev(`document.querySelector(".cardSub[data-subcard] [data-sub='lrc']:not([data-word])").click()`);
const failToast = await waitToast("没有歌词");
await sleep(120);
check("下载失败原因可见", failToast.includes("没有歌词"), failToast.trim());
const failState = await ev(`(() => {
  const c = document.querySelector(".cardSub[data-subcard]");
  const b = c.querySelector("[data-word='1']");
  return {open: c.open, busy: b.disabled, pressed: b.getAttribute("aria-busy")};
})()`);
check("失败后菜单保持展开且按钮恢复", failState.open && !failState.busy && !failState.pressed, failState);
await restoreFetch();
await ev(`document.querySelector(".cardSub[data-subcard] [data-sub='lrc']:not([data-word])").click()`);
await waitFor(`!document.querySelector(".cardSub[data-subcard]").open`);
check("重试成功后菜单才收起", await ev(`!document.querySelector(".cardSub[data-subcard]").open`));
/* 初始请求返回后列表可能补到更早创建的注入任务；需要重渲染时再按 report 处理。 */
check("真实字幕入口仍在首张卡", await ev(`!!document.querySelector(".cardSub[data-subcard]")?.dataset.subcard`));

/* 整表重渲染（切语言）会换掉卡片节点；焦点应回到原来的字幕入口 */
const focusId = await ev(`(() => {
  const c = document.querySelector(".cardSub[data-subcard]");
  c.open = true; c.querySelector("summary").focus();
  return c.dataset.subcard;
})()`);
await sleep(150);
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "l", bubbles: true}))`);
await sleep(700);
const restored = await ev(`(() => {
  const a = document.activeElement;
  return {tag: a?.tagName || "", id: a?.closest?.("[data-subcard]")?.dataset.subcard || "",
    lang: document.documentElement.lang};
})()`);
check("重渲染后字幕入口焦点回来", restored.tag === "SUMMARY" && restored.id === focusId, restored);
await ev(`document.querySelector(".cardSub[data-subcard]").open = false`);
if (await ev(`document.documentElement.lang !== "zh"`)) {
  await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "l", bubbles: true}))`);
  await sleep(700);
}

const fakeCard = await ev(`(() => {
  const card = document.querySelector('[data-subcard="ui_fixture_running"]');
  if (!card) return {found: false};
  card.open = true;
  return {found: true, muted: card.querySelector("summary").classList.contains("muted"),
    buttons: card.querySelectorAll("[data-sub]").length,
    reason: (card.querySelector(".subEmpty") || {}).textContent?.trim() || ""};
})()`);
check("未完成任务仍显示字幕入口", fakeCard.found && fakeCard.muted, fakeCard);
check("未完成任务在卡内给出原因", !fakeCard.buttons && fakeCard.reason.includes("任务未完成"), fakeCard);

await ev(`document.querySelector('[data-lib="ui_fixture_running"] [data-more]').click()`);
await waitFor(`document.querySelector("#jobModal").classList.contains("open")`);
const fakeModal = await ev(`(() => {
  const d = document.querySelector("#jobModal");
  return {buttons: d.querySelectorAll("[data-sub]").length,
    reason: (d.querySelector(".subEmpty") || {}).textContent?.trim() || ""};
})()`);
check("详情弹窗也显示不可导出原因", !fakeModal.buttons && fakeModal.reason.includes("任务未完成"), fakeModal);
await ev(`document.querySelector("#jobModal button[aria-label='关闭']").click()`);

const derivedCard = await ev(`(() => {
  const card = document.querySelector('[data-subcard="ui_fixture_derived"]');
  if (!card) return {found: false};
  card.open = true;
  return {found: true, buttons: [...card.querySelectorAll("[data-sub]")]
    .map(b => b.textContent.trim()), reason: (card.querySelector(".subEmpty") || {}).textContent?.trim() || ""};
})()`);
check("派生任务继承源歌词可导出", derivedCard.found && !derivedCard.reason
  && JSON.stringify(derivedCard.buttons) === JSON.stringify(["SRT 字幕", "LRC（行级）", "LRC（逐字）"]),
  derivedCard);

/* ---------- 任务详情 ---------- */
const opened = await ev(`(() => {
  const card = [...document.querySelectorAll(".tcard")].find(c => c.textContent.includes("示例曲"));
  card.querySelector("[data-more]").click();
  return true;
})()`);
await waitFor(`document.querySelector("#jobModal").classList.contains("open")`);
const modal = await ev(`(() => {
  const d = document.querySelector("#jobModal");
  return {labels: [...d.querySelectorAll("[data-sub]")].map(b => b.textContent.trim()),
    hint: [...d.querySelectorAll(".hint")].map(h => h.innerText).find(t => t.includes("逐字")) || ""};
})()`);
check("任务详情有三种格式", opened && JSON.stringify(modal.labels) === JSON.stringify(["SRT 字幕", "LRC（行级）", "LRC（逐字）"]),
  modal.labels);
check("任务详情有导出说明", modal.hint.includes("逐字"), modal.hint.slice(0, 30));

await patchFetch();
await ev(`document.querySelector("#jobModal [data-sub='lrc']:not([data-word])").click()`);
const modalToast = await waitToast(".lrc");
const modalUrl = await lastCall();
check("任务详情行级请求", /format=lrc/.test(modalUrl) && !/enhanced=1/.test(modalUrl), modalUrl);
check("任务详情下载反馈", modalToast.includes(".lrc"), modalToast.trim());
const modalStays = await ev(`document.querySelector("#jobModal").classList.contains("open")`);
check("详情弹窗下载后不关闭", modalStays);
await restoreFetch();
await shot("subtitle-modal");

/* ---------- 歌词条 ---------- */
await ev(`document.querySelector("#jobModal button[aria-label='关闭']").click()`);
await ev(`(() => {
  const card = [...document.querySelectorAll(".tcard")].find(c => c.textContent.includes("示例曲"));
  card.querySelector("[data-lplay]").click();
  return true;
})()`);
const lyrShown = await waitFor(`(() => { const s = document.querySelector("#lyrSub");
  return !!s && !!s.offsetParent; })()`);
check("播放后歌词条出现字幕入口", lyrShown);

await patchFetch();
await ev(`document.querySelector("#lyrSub summary").click()`);
await sleep(250);
await shot("subtitle-lyrics-menu");
const lyrMenu = await ev(`(() => { const s = document.querySelector("#lyrSub");
  return {open: s.open, labels: [...s.querySelectorAll("[data-sub]")].map(b => b.textContent.trim()),
    panel: Math.round(s.querySelector(".subMenuPanel").getBoundingClientRect().width)}; })()`);
check("歌词条菜单展开", lyrMenu.open && lyrMenu.labels.length === 3, lyrMenu.labels);

await ev(`document.querySelector("#lyrSub [data-sub='srt']").click()`);
const lyrToast = await waitToast(".srt");
const lyrUrl = await lastCall();
check("歌词条 SRT 请求", /format=srt/.test(lyrUrl) && !/enhanced=1/.test(lyrUrl), lyrUrl);
check("歌词条下载反馈", lyrToast.includes(".srt"), lyrToast.trim());
const lyrClosed = await ev(`(() => { const s = document.querySelector("#lyrSub");
  return !s.open && document.activeElement === s.querySelector("summary"); })()`);
check("歌词条下载后收起并回焦", lyrClosed);
await restoreFetch();

await ev(`document.querySelector("#lyrSub summary").click()`);
await sleep(200);
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`);
await sleep(100);
const escaped = await ev(`(() => { const s = document.querySelector("#lyrSub");
  return {open: s.open, focus: document.activeElement === s.querySelector("summary")}; })()`);
check("Escape 收起歌词条菜单并回焦", !escaped.open && escaped.focus, escaped);
await ev(`document.querySelector("#lyrSub summary").click()`);
await sleep(200);
await ev(`document.body.click()`);
await sleep(100);
check("点外部收起歌词条菜单", !(await ev(`document.querySelector("#lyrSub").open`)));

/* ---------- 英文 ---------- */
await boot("en");
const en = await ev(`(() => {
  const card = document.querySelector(".cardSub[data-subcard]");
  card.open = true;
  return {lang: document.documentElement.lang,
    summary: card.querySelector("summary").getAttribute("aria-label"),
    labels: [...card.querySelectorAll("[data-sub]")].map(b => b.textContent.trim())};
})()`);
check("英文卡入口文案", en.summary === "Subtitle export", en.summary);
check("英文格式文案", JSON.stringify(en.labels) === JSON.stringify(["SRT subtitles", "LRC (line)", "LRC (word)"]),
  en.labels);

await failFetch("没有歌词，无法生成字幕");
await ev(`document.querySelector(".cardSub[data-subcard] [data-sub='srt']").click()`);
const enFailToast = await waitToast("no lyrics");
check("英文界面翻译服务端原因", enFailToast.includes("This job has no lyrics"), enFailToast.trim());
await restoreFetch();

await failFetch("歌词对齐失败：音频识别失败");
await ev(`(() => { const c = document.querySelector(".cardSub[data-subcard]");
  if (!c.open) c.querySelector("summary").click(); return true; })()`);
await sleep(200);
await ev(`document.querySelector(".cardSub[data-subcard] [data-sub='srt']").click()`);
const enLyrFail = await waitToast("Lyric alignment failed");
check("英文界面翻译对齐失败前缀", enLyrFail.includes("Lyric alignment failed:")
  && enLyrFail.includes("音频识别失败"), enLyrFail.trim());
await restoreFetch();

const enFake = await ev(`(() => {
  const card = document.querySelector('[data-subcard="ui_fixture_running"]');
  if (!card) return {found: false};
  card.open = true;
  return {found: true, reason: (card.querySelector(".subEmpty") || {}).textContent?.trim() || ""};
})()`);
check("英文界面给出未完成原因", enFake.found && enFake.reason.includes("not finished"), enFake);

/* ---------- 390px 触控 ---------- */
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
await boot("zh");
const mobile = await ev(`(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return {x: Math.round(b.x), right: Math.round(b.right),
    w: Math.round(b.width), h: Math.round(b.height)}; };
  const card = document.querySelector(".cardSub[data-subcard]");
  card.open = true;
  const cardHeights = [...card.querySelectorAll("[data-sub]")].map(b => Math.round(b.getBoundingClientRect().height));
  const play = [...document.querySelectorAll(".tcard")].find(c => c.textContent.includes("示例曲"));
  play.querySelector("[data-lplay]").click();
  return {cardHeights, coarse: matchMedia("(pointer: coarse)").matches,
    overflowX: document.documentElement.scrollWidth > innerWidth};
})()`);
check("390px 卡片按钮可点", mobile.cardHeights.every(h => h >= 44), mobile.cardHeights);
check("390px 页面无横向溢出", !mobile.overflowX, mobile);
await waitFor(`document.querySelector("#lyrSub") && document.querySelector("#lyrSub").offsetParent`);
await ev(`document.querySelector("#lyrSub summary").click()`);
await sleep(300);
const mobileMenu = await ev(`(() => {
  const s = document.querySelector("#lyrSub");
  const r = (el) => { const b = el.getBoundingClientRect(); return {x: Math.round(b.x), right: Math.round(b.right),
    h: Math.round(b.height)}; };
  return {sum: r(s.querySelector("summary")), panel: r(s.querySelector(".subMenuPanel")),
    items: [...s.querySelectorAll("[data-sub]")].map(b => Math.round(b.getBoundingClientRect().height)),
    overflowX: document.documentElement.scrollWidth > innerWidth};
})()`);
check("390px 歌词条按钮可点", mobileMenu.sum.h >= 44, mobileMenu.sum);
check("390px 菜单不出界", mobileMenu.panel.x >= 0 && mobileMenu.panel.right <= 390 && !mobileMenu.overflowX, mobileMenu.panel);
check("390px 菜单项可点", mobileMenu.items.every(h => h >= 44), mobileMenu.items);
await shot("subtitle-mobile");

await ev(`document.querySelector("#lyrSub").open = false`);
await ev(`(() => {
  const card = [...document.querySelectorAll(".tcard")].find(c => c.textContent.includes("示例曲"));
  card.querySelector("[data-more]").click();
  return true;
})()`);
await waitFor(`document.querySelector("#jobModal").classList.contains("open")`);
const modalTouch = await ev(`[...document.querySelectorAll("#jobModal .subActions .btn")]
  .map(b => Math.round(b.getBoundingClientRect().height))`);
check("390px 详情按钮可点", modalTouch.length === 3 && modalTouch.every(h => h >= 44), modalTouch);

if (injected?.identifier) {
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier }, sessionId);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n字幕导出 UI 验收：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((r) => r.name).join("；")}`);
  process.exit(1);
}
ws.close();

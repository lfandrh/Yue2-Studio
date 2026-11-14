/* 会创建真实任务：跑之前要你明确同意（本项目的规矩是不擅自生成音乐）。
   端到端补测：浏览器内 3MB 提交返回 413（不是断连）、真实取消任务的中文提示、测试任务清理。
   需要先有 tools/verify-fixes.mjs 注释里的 headless Chrome（端口 9455）与 8083 服务。
   运行：node tools/verify-cancel-413.mjs   —— 会创建并删除一个 plan 任务。 */
const BASE = "http://127.0.0.1:8083";
const v = await (await fetch("http://127.0.0.1:9455/json/version")).json();
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

const results = [];
const check = (name, pass, detail) => { results.push({name, pass, detail}); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };

/* 浏览器内 3MB 提交：应拿到 413 JSON，而不是网络错误 */
const big = await ev(`(()=>fetch("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"song",style:"pop",lyrics:"x".repeat(3000000)})}).then(async r=>JSON.stringify({status:r.status,body:(await r.text()).slice(0,60)})).catch(e=>JSON.stringify({status:0,error:String(e)})))()`);
const bigParsed = JSON.parse(big);
check("browser 3MB POST -> 413 JSON (no reset)", bigParsed.status === 413 && bigParsed.body.includes("请求体过大"), bigParsed);

/* 真实取消 plan 任务，卡片应显示中文取消提示 */
const created = await (await fetch(`${BASE}/api/jobs`, {
  method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({type: "plan", style: "Mandarin, city pop, warm female vocal, 92 BPM", lyrics: "[Verse]\n晚风轻轻吹过窗前\n[Chorus]\n啦啦啦啦啦啦啦"}),
})).json();
const jobId = created.id;
await sleep(2500);
await fetch(`${BASE}/api/jobs/${jobId}/cancel`, {method: "POST"});
let final = null;
for (let i = 0; i < 120; i++) {
  const list = await (await fetch(`${BASE}/api/jobs`)).json();
  final = list.jobs.find((j) => j.id === jobId);
  if (final && final.status !== "running" && final.status !== "queued") break;
  await sleep(1000);
}
console.log("job final:", final?.status, "| error:", final?.error);
await ev(`document.querySelector('[data-view="studio"]').click()`);
await sleep(1500);
const cardText = await ev(`(()=>{const c=[...document.querySelectorAll("#queue .jobc")].find(el=>el.dataset.job===${JSON.stringify(jobId)});return c?c.innerText.replace(/\\s+/g," ").slice(0,260):"(card not found)"})()`);
check("cancelled card shows localized reason", /已取消（在「.+」阶段停止）/.test(cardText), cardText);
const rawVisible = await ev(`(()=>{const b=[...document.querySelectorAll("#queue .jobc")].find(el=>el.dataset.job===${JSON.stringify(jobId)});if(!b)return "";const d=b.querySelector("[data-act=detail]");d&&d.click();return ""})()`);
await sleep(700);
const detailText = await ev(`document.getElementById("jobBody").innerText.replace(/\\s+/g," ").slice(0,400)`);
check("detail keeps raw English error", /Cancelled during|Cancelled before/.test(detailText), detailText.slice(0, 200));
await ev(`document.querySelector('#jobModal [data-close]').click()`);
await sleep(400);

/* 清理测试任务 */
const del = await fetch(`${BASE}/api/jobs/${jobId}`, {method: "DELETE"});
const delBody = await del.json();
const after = await (await fetch(`${BASE}/api/jobs`)).json();
check("test job deleted", del.status === 200 && !after.jobs.some((j) => j.id === jobId), {del: delBody, remaining: after.jobs.length});
console.log(JSON.stringify(results.filter((r) => !r.pass)));
ws.close();
process.exit(results.some((r) => !r.pass) ? 1 : 0);

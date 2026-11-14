import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/* 一键验收入口：独立脚本按顺序跑，单个失败不阻断其余脚本。
   --standalone 只跑不依赖 9090/headless Chrome/真实模型的前置脚本。
   CDP 脚本需要先按各脚本头注释启动 headless Chrome；需要 9090 的脚本也先起服务。
   用法：node tools/verify-all.mjs [--only verify-subtitle-ui.mjs,verify-naming.mjs] */
const ROOT = path.resolve(import.meta.dirname, "..");
const TOOLS = path.join(ROOT, "tools");
const argValue = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = argValue("only");
const standalone = process.argv.includes("--standalone");
const wanted = only ? only.split(",").map((item) => item.trim()) : null;

const scripts = fs.readdirSync(TOOLS)
  .filter((name) => /^verify-.+\.(mjs|py)$/.test(name))
  .filter((name) => !["verify-all.mjs"].includes(name))
  .filter((name) => !wanted || wanted.includes(name))
  .filter((name) => !standalone || !["verify-fixes.mjs", "verify-cancel-413.mjs", "verify-generation.mjs", "verify-nav-rail.mjs", "verify-page-style.mjs", "verify-roll.mjs", "verify-score-sync.mjs", "verify-subtitle-ui.mjs"].includes(name))
  .sort((left, right) => {
    const rank = (name) => name === "verify-subtitle-export.py" ? 0
      : name === "verify-subtitle-api.py" ? 1
      : name === "verify-naming.mjs" ? 2
      : name === "verify-subtitle-ui.mjs" ? 3
      : name.endsWith(".py") ? 4 : 5;
    return rank(left) - rank(right) || left.localeCompare(right);
  });

if (!scripts.length) {
  console.error(wanted ? `没有匹配的验收脚本：${wanted.join(", ")}` : "tools/ 下没有验收脚本");
  process.exit(2);
}

const results = [];
const start = Date.now();
for (const name of scripts) {
  const file = path.join(TOOLS, name);
  const command = name.endsWith(".py")
    ? [path.join(ROOT, "YuE", ".venv", "Scripts", "python.exe"), path.join(ROOT, "YuE", ".venv", "python.exe")].find(fs.existsSync) || path.join(ROOT, "YuE", ".venv", "Scripts", "python.exe")
    : [process.execPath, file];
  const run = spawn(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  run.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  run.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  const code = await new Promise((resolve) => run.on("close", resolve));
  const passed = /(\d+)\s*\/\s*\1?\s*项通过|(\d+)\s*\/\s*\2?\s* 项通过|(\d+)\s*\/\s*\3?\s*项通过|(\d+)\s*\/\s*\4?\s* 项通过/.test(output);
  const count = [...output.matchAll(/(\d+)\s*\/\s*(\d+)\s*项通过/g)].pop();
  const summary = count ? `${count[1]}/${count[2]} 项通过` : (code === 0 ? "通过" : "失败");
  results.push({ name, code, summary, passed: code === 0 });
  console.log(`VERIFY ${name}: ${summary}`);
}

const failed = results.filter((item) => !item.passed);
const seconds = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n验收汇总：${results.length - failed.length}/${results.length} 个脚本通过，耗时 ${seconds}s`);
if (failed.length) {
  console.error("失败脚本：" + failed.map((item) => item.name).join("、"));
  process.exit(1);
}

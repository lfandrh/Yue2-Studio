# YuE2 本地音乐工作台

港科大开源的歌曲生成模型 **YuE2**（歌词 + 风格 → 可编辑 ABC 乐谱 → 48kHz 立体声完整歌曲）在本机的落地：`YuE/` 是官方代码与权重环境，`app/` 是自建的 FastAPI + 原生 JS Web 界面（替代官方 gradio，端口 **8083**）。

## 快速开始

```bat
start.bat      :: 起服务并自动打开 http://127.0.0.1:8083
stop.bat       :: 结束 8083 上的进程（含常驻的 model_worker 子进程，释放显存）
```

打开页面后：右上角「加载模型」选显卡或 CPU → 创作页写风格与歌词 → 生成。
CPU 单首实测约 8 分 30 秒（42 秒音频 / 509 秒耗时），3060 Ti 8GB 可用 CUDA 但显存吃紧。
第一次用可以点界面里的「界面巡览」和「使用指南」两页，内置示例曲《晚风》可以直接试听和改谱。

## 目录

| 路径 | 是什么 |
|---|---|
| `app/server.py` | FastAPI 后端：任务队列、常驻 worker 管理、SQLite 元数据、产物索引 |
| `app/model_worker.py` | 常驻推理子进程（加载一次模型，按命令跑 plan / song / rerender / redecode） |
| `app/static/` | 前端（原生 ES module，无构建步骤）：`index.html` + `js/{app,store,ui,i18n}.js` + `styles/` |
| `app/static/index.legacy.html` | 旧版单文件界面，`GET /legacy` 可访问，仅作对照 |
| `demo/showcase/` | 内置示例曲的产物（重启时自动导入曲库为 `song_demo_wanfeng`） |
| `runs/` | 运行数据：`jobs/<id>/`（产物，其中 `.meta/run.log` 是这条任务自己的完整输出与栈）、`_trash/`（删除的任务移到这里，超过 30 天在启动时自动清掉）、`yue2.db`、`app.log`（服务日志，5 MB × 3 轮转）、`model_worker.log`（模型进程日志，起进程时超 5 MB 滚成 `.1`）。失败时界面给的「日志编号」可在三个日志里搜到同一条 |
| `YuE/` | 官方仓库副本 + `.venv` + `models/`（权重）+ `wheels/`（可选的 flash_attn 轮子，装上后语义加速走 FA2）+ `skills/yue2-music/` |
| `tools/` | 验收脚本（CDP 驱动独立 headless Chrome，不碰你正在用的浏览器标签） |

## 生成加速实测（RTX 3060 Ti 8GB / torch 2.9.1+cu128）

系统页「生成加速」有两个**默认关闭**的开关。开哪个都会让歌不一样（算法换了，浮点加法顺序变了）。注意「全关」拿到的是 **cuDNN 之前**的老路径（latent `26de3604` 那一族），不是曲库现在这批（`6f9dc4ef`）——那一批是「音频合成加速」开着跑出来的；要复现曲库现有字节就把「音频合成加速」开着、语义加速保持关。

同一份风格+歌词、`seed 831001`、`cot=full`，各跑 1 次：

| 档位 | 语义阶段 tokens/s | 语义耗时（token 数） | 整曲 | 语义结束时显存（torch 已占 / 驱动剩余） |
|---|---|---|---|---|
| 语义加速 **关**（默认） | 27.0 | 176.7 s（4771） | 292.4 s | 5.23 GiB / 1.56 GiB |
| 语义加速 **开**，未装 FA2 → 复制法 | 36.5（**+35%**） | 136.9 s（4990） | 255.7 s | 5.15 GiB / 1.78 GiB |
| 语义加速 **开**，已装 FA2 → FlashAttention-2 | 44.3（**+64%**） | 108.0 s（4781） | **220.9 s**（-24.5%） | 4.98 GiB / **1.96 GiB** |

- 三首都是 42 秒左右的完整歌曲；语义 token 数不同，所以**只有 tokens/s 是严格可比的**。关 vs FA2 两行 token 数差 0.2%，整曲 292.4 → 220.9 秒可以直接当提速看。
- 产物哈希（证明确实换歌，也证明没走缓存）：latent `6f9dc4ef` → 复制法 `d1258f58` → FA2 `f216b560`。
- 单算子探针（4000 token、16 头 / 8 KV 头、bf16，非性能结论依据，只解释机理）：math 12.4 ms / 摊出 ~1.0 GiB 分数表，复制法 3.6 ms，FA2 **2.76 ms / 0.21 GiB**；三者与 fp32 参考的最大偏差同为 `0.00763`，FA2 不比默认更不准。
- 「关」那档的分数矩阵是 16×6600×6600 fp32 ≈ **2.8 GiB**，装上模型后桌上放不下，Windows（WDDM）会把它挪进共享内存 —— 不报错，只是慢。这就是加速开关省掉的东西。
- 三个 run 的「音频合成加速」都是**开**的（第一行是加开关之前跑的曲库基线，当时 cuDNN 恒定启用）。两开关全开之外的那档 —— 全关 —— 没有重跑：它必然顶爆 8GB 卡，没有再测一次的必要；它和第一行只差 NAR 阶段换回便携内核（自测 14.4 ms vs 20.9 ms / 步）。

装 FA2（可选，不装就自动用复制法拿 +35%）：

```bat
YuE\.venv\Scripts\python.exe -m pip install --no-deps YuE\wheels\flash_attn-2.8.2+cu128torch2.8.0cxx11abiFALSE-cp311-cp311-win_amd64.whl
```

轮子文件名写的是 torch 2.8.0 / cxx11abiFALSE，本机是 torch 2.9.1 / abiTRUE，**标签对不上但实测可用**（import + GQA 出图 + 上表整曲都是装完后跑的）。装与不装都不用改代码：`FA2 → 复制法 → 默认` 是依次探测，任何一环不满足（非 CUDA、算力 < 8.0、head_dim > 256、bf16/fp16 之外、import 失败）就自动退回上一档；**装了但运行期报错也会立刻退到复制法并记下原因，不会让整首歌失败**。界面上那行开关旁边写明实际走了哪档、为什么退。CPU 和 MPS 上开不动，只会走默认路径。

复现（跑整曲约 4 分钟，会占满显存，跑之前先卸载界面里的模型）：

```bat
YuE\.venv\Scripts\python.exe -m yue2.cli batch --model YuE\models\YuE2-3B --vae YuE\models\YuE2-Vae --budget 24 --staged --ar-accel --nar-accel --input runs\accel-bench\request.jsonl --output runs\accel-bench
```

去掉 `--ar-accel` / `--nar-accel` 就是「关」那档。上面三个 run 的完整产物留在 `runs/accel-bench/`（`accel_on` = 复制法、`accel_flash` = FA2）和曲库任务 `song_20261029_160314_1124`（基线）里，`result.json` 内含逐阶段耗时与显存账本。

## 复测

```bat
node tools\verify-fixes.mjs        :: 21 项前端验收（需先按脚本头注释起一个 headless Chrome）
node tools\verify-cancel-413.mjs   :: 4 项端到端补测（会创建并删除一个测试任务）
```

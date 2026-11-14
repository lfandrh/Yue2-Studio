# YuE2 本地音乐工作台

港科大开源的歌曲生成模型 **YuE2**（歌词 + 风格 → 可编辑 ABC 乐谱 → 48kHz 立体声完整歌曲）在本机的落地：`YuE/` 是官方代码与权重环境，`app/` 是自建的 FastAPI + 原生 JS Web 界面（替代官方 gradio，端口 **9090**）。

## 快速开始

```bat
start.bat      :: 起服务并自动打开 http://127.0.0.1:9090
stop.bat       :: 结束 9090 上的进程（含常驻的 model_worker 子进程，释放显存）

启动前请确认：`app/server.py` 存在，且虚拟环境位于 `YuE/.venv/Scripts/python.exe`。`start.bat` 会先做这两项检查；完整依赖与模型诊断请使用界面「系统」页的 doctor，`start.bat` 不会预先加载模型。
```

打开页面后：右上角「加载模型」选显卡或 CPU → 创作页写风格与歌词 → 生成。
CPU 单首实测约 8 分 30 秒（42 秒音频 / 509 秒耗时），3060 Ti 8GB 可用 CUDA 但显存吃紧。
第一次用可以点界面里的「界面巡览」和「使用指南」两页，内置示例曲《晚风》可以直接试听和改谱。

## 自动更新（只更新代码）

系统页右侧「软件更新」卡片可检查并安装新版本。**只更新 `app/` 与根脚本、说明文件**；`YuE/models/`（权重）、`YuE/.venv/`（Python 运行时与依赖）、`runs/`（任务产物与 SQLite 索引）、`demo/` 一律不动，官方引擎 `YuE/src` 也不在更新范围内。

- 更新源：`update.json` 的 `update_url` 指向 Gitee 仓库的 `releases/latest.json`（仓库建好后填真实地址，打包时会写入默认值）。
- 发布：`tools/publish-release.ps1` 打 code-only zip、算 sha256、生成 `latest.json`；把 zip 传到 Gitee Release、把清单提交到仓库即可。
- 安装：网页确认 → 服务端预检（有任务在跑则拒绝）→ 备份当前代码到 `runs/_backup/` → 停服 → 解压覆盖（路径白名单 + sha256 校验）→ 重启 → 探活；探活失败自动回滚并重启。
- 版本身份：`version.json`（version / commit / built_at），随包分发并随更新刷新，`/api/health` 与 `/api/system/version` 都会暴露。

已经发出去的整合包不带更新器，需要从内置更新器的版本起才能增量更新。

> 当前为「手动检查 + 一键安装」；`update.json` 的 `auto_check` 是预留开关，尚未启用。

## 只有代码时：从零搭建环境（Windows）

> 本节适用于**只拿到源码**、手上没有 `YuE/.venv` 和 `models/` 的情况。整合包（已含虚拟环境与权重）不需要这些步骤，路径会在打包时统一处理。

### 前提

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 64 位（`start.bat` / `stop.bat` 与 `YuE\.venv\Scripts\python.exe` 按 Windows 写） |
| Python | 3.11 或 3.12（本机实测 3.11.9） |
| 显卡 | NVIDIA，BF16 需算力 ≥ 8.0（RTX 30 系起）。官方建议 24GB 显存；8GB 卡可跑短歌，显存不足会自动降级 CPU（单首约 8.5 分钟） |
| 磁盘 | ≥ 20GB 可用（权重约 7.8GB + 环境约 3GB） |
| 网络 | 装依赖与下权重都要；国内建议全程走镜像 |

### 1. 建虚拟环境

```bat
cd /d <项目根目录>
python -m venv YuE\.venv
set "YUE2PY=YuE\.venv\Scripts\python.exe"
```

### 2. 依赖走镜像站

```bat
%YUE2PY% -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
%YUE2PY% -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

> 下面的命令请在**同一个 cmd 窗口**里按顺序执行（`set "YUE2PY=..."` 只在当前窗口有效）；也可以把 `set` 那行单独留下来反复用。

备选镜像：阿里云 `https://mirrors.aliyun.com/pypi/simple/`、华为云 `https://repo.huaweicloud.com/repository/pip/simple/`、中科大 `https://pypi.mirrors.ustc.edu.cn/simple/`。

### 3. 装 PyTorch（CUDA 12.8 轮子）

```bat
%YUE2PY% -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
```

- 官方 `YuE/pyproject.toml` 钉的是 `torch==2.10.0`；本机整合包实测用的是 `2.9.1+cu128`，两者都能跑。全新安装先用官方钉的版本；若生成阶段出现诡异错误，再换 2.9.1 对比。
- 驱动较旧可换 `cu126`；40/50 系新驱动可用 `cu130`。
- 国内 PyPI 镜像上的 torch 多为 CPU 版或 CUDA 版本不全，**这一步保持 PyTorch 官方源**。

### 4. 装 YuE 本体与 Web 依赖

先装本体（`--no-deps`，避免 pip 去动已装好的 torch），再补齐官方依赖与 Web 侧依赖：

```bat
cd /d YuE
%YUE2PY% -m pip install . --no-deps
cd /d ..
%YUE2PY% -m pip install transformers==4.57.6 huggingface-hub==0.36.2 safetensors==0.7.0 tiktoken==0.12.0 numpy==2.2.6 soundfile==0.13.1 accelerate==1.13.0
%YUE2PY% -m pip install fastapi uvicorn pydantic onnxruntime kaldi-native-fbank
```

- `fastapi / uvicorn / pydantic` 是 Web 服务依赖；`onnxruntime + kaldi-native-fbank` 是歌词字级对齐（Paraformer 时间戳引擎）依赖。
- 可选：`sherpa-onnx faster-whisper` —— 歌词对齐的兜底引擎，不装就只用 Paraformer，对齐不可用时界面会明确提示。
- 可选：FA2 加速轮子，见下文「生成加速实测」。

### 5. 下权重：魔搭 → HF 镜像 → HF

必需两份（共约 7.8GB）：`m-a-p/YuE2-3B`（主模型，6.9GB）、`m-a-p/YuE2-Vae`（解码器，0.5GB）。建议再下歌词对齐模型（232MB，词级时间戳）。三个渠道只是下载来源不同，文件内容一致；**建议一次只走一个渠道下完**，避免来源间版本不一致。

**第一选择 · 魔搭 ModelScope**（国内直连，最稳）

```bat
%YUE2PY% -m pip install modelscope
%YUE2PY% -c "from modelscope import snapshot_download; snapshot_download('m-a-p/YuE2-3B', local_dir=r'YuE/models/YuE2-3B')"
%YUE2PY% -c "from modelscope import snapshot_download; snapshot_download('m-a-p/YuE2-Vae', local_dir=r'YuE/models/YuE2-Vae')"
%YUE2PY% -c "from modelscope import snapshot_download; snapshot_download('manyeyes/paraformer-large-zh-en-timestamp-int8-onnx-offline', local_dir=r'YuE/models/paraformer-zh-en-ts')"
```

上面的 Python API 是官方稳定接口，跨版本不变；也可以装 CLI（`modelscope download`）后下载，参数以 `modelscope download --help` 为准。

**第二选择 · HF 镜像站**

```bat
set "HF_ENDPOINT=https://hf-mirror.com"
%YUE2PY% -m pip install -U "huggingface-hub[cli]"
YuE\.venv\Scripts\hf.exe download m-a-p/YuE2-3B --local-dir YuE/models/YuE2-3B
YuE\.venv\Scripts\hf.exe download m-a-p/YuE2-Vae --local-dir YuE/models/YuE2-Vae
```

**第三选择 · HuggingFace 官方**

```bat
YuE\.venv\Scripts\hf.exe download m-a-p/YuE2-3B --local-dir YuE/models/YuE2-3B
YuE\.venv\Scripts\hf.exe download m-a-p/YuE2-Vae --local-dir YuE/models/YuE2-Vae
```

注意：

- hf-mirror 对 Xet 存储的仓库可能元数据校验失败，大文件改用 `curl -C -` 逐文件拉 `https://hf-mirror.com/<repo>/resolve/main/<file>` 更稳。
- 权重许可：YuE2 权重为 **CC BY-NC 4.0 + 附加条款**（见 `YuE/MODEL_LICENSE`），非商业用途；不要二次分发权重。

### 6. 自检与启动

```bat
set "HF_ENDPOINT=https://hf-mirror.com"
YuE\.venv\Scripts\yue2.exe doctor
start.bat
```

doctor 应报 `dependencies_ready: true`，并识别到显卡（算力 ≥ 8.0）。之后打开 `http://127.0.0.1:9090`，在「系统」页可再跑一次完整 doctor。

### 端口

默认 **9090**。两种指定方式（命令行优先于环境变量）：

```bat
rem 方式一：直接给端口
start.bat 9091

rem 方式二：用环境变量
set "YUE2_PORT=9091"
start.bat
```

stop.bat 用同一个端口（stop.bat 9091）。两个脚本都支持 --no-pause，供自动化调用，否则结尾会停在 pause。

为什么从 8083 换成 9090：Windows 的 Hyper-V / WSL / Docker 会保留一段 TCP 端口（`netsh int ipv4 show excludedportrange protocol=tcp` 可查），8083 常落在保留段里，绑定会报 `Permission denied`。9090 在保留段之外；`start.bat` 启动失败时也会提示换端口。

## 目录

| 路径 | 是什么 |
|---|---|
| `app/server.py` | FastAPI 后端：任务队列、常驻 worker 管理、SQLite 元数据、产物索引 |
| `app/model_worker.py` | 常驻推理子进程（加载一次模型，按命令跑 plan / song / rerender / redecode） |
| `app/static/` | 前端（原生 ES module，无构建步骤）：`index.html` + `js/{app,store,ui,i18n}.js` + `styles/` |
| `app/static/index.legacy.html` | 旧版单文件对照页，只通过 `GET /legacy` 访问；生产导航不链接它，页面顶部有旧版标识 |
| `demo/showcase/` | 内置示例曲的产物（重启时自动导入曲库为 `song_demo_wanfeng`） |
| `runs/` | 运行数据：`jobs/<id>/`（产物，其中 `.meta/run.log` 是这条任务自己的完整输出与栈）、`_trash/`（删除的任务移到这里，超过 30 天在启动时自动清掉）、`yue2.db`、`app.log`（服务日志，5 MB × 3 轮转）、`model_worker.log`（模型进程日志，起进程时超 5 MB 滚成 `.1`）。失败时界面给的「日志编号」可在三个日志里搜到同一条 |
| `YuE/` | 官方仓库副本 + `.venv` + `models/`（权重）+ `wheels/`（可选的 flash_attn 轮子，装上后语义加速走 FA2）+ `skills/yue2-music/`。模型目录由后端解析为 `YuE/models/YuE2-3B` 与 `YuE/models/YuE2-Vae`，缺失时 doctor 会明确报告 |
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

## 部署与健康检查

### 探活端点

`GET /api/health` 是轻量部署探活：只读内存队列与 SQLite 计数，不加载模型、不扫描磁盘、也不跑 doctor 子进程。返回示例：

```json
{"status": "ok", "jobs": 9, "queued": 0, "subscribers": 1, "model_busy": false, "time": 1763123456.7}
```

- HTTP 200 + `status=ok`：可接流量；HTTP 503 + `status=degraded`：索引不可达，负载均衡应摘除实例。
- `queued` 是当前排队任务数，`subscribers` 是在线 SSE 连接数，`model_busy` 表示模型正在生成。
- 需要完整依赖/模型诊断时用系统页的 `GET /api/system/doctor`（会起子进程，不要当高频探活用）。

手动检查：

```bat
curl http://127.0.0.1:9090/api/health
```

### 安全响应头

所有响应默认带以下头（局部响应已有的值不会被覆盖，反代可再追加）：

| 头 | 值 | 作用 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 禁止浏览器猜测内容类型 |
| `X-Frame-Options` | `DENY` | 禁止被任意页面嵌套（防点击劫持） |
| `Referrer-Policy` | `no-referrer` | 出站链接不携带来源地址 |
| `Cross-Origin-Opener-Policy` | `same-origin` | 隔离跨源窗口 |
| `Cross-Origin-Resource-Policy` | `same-origin` | 仅同源可加载本站资源 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | 显式关闭未用设备能力 |

- 暂未启用 CSP：页面含内联脚本/样式，直接上 `default-src 'self'` 会破坏界面；如后续做 nonce/hash 改造再评估。
- HTTPS 反代请自行补 `Strict-Transport-Security`。

### 反向代理注意事项

- SSE（`/api/events`）要求反代禁用缓冲并放宽读超时：服务已下发 `X-Accel-Buffering: no`，Nginx 仍需 `proxy_buffering off;` 与较长的 `proxy_read_timeout`。
- 上传经反代时要放宽 `client_max_body_size`（服务端自身上限 2 MB）。
- 应用只监听 `127.0.0.1` 且不承载公网鉴权，请放在反代之后并自行加访问控制。

### 启动自检

`start.bat` 会先确认 `app/server.py` 与虚拟环境存在、端口未被占用，再拉起服务；停止用 `stop.bat`。运行日志在 `runs/app.log`，删除的任务先进 `runs/_trash/`（超过 30 天启动时自动清理）。

## 复测

```bat
node tools\verify-fixes.mjs        :: 21 项前端验收（需先按脚本头注释起一个 headless Chrome）
node tools\verify-cancel-413.mjs   :: 4 项端到端补测（会创建并删除一个测试任务）
```

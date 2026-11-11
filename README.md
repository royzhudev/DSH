# video-agent

视频创作智能体 MVP：输入一个主题，自动完成 **脚本生成 → 素材匹配 → 语音合成 → 规则化剪辑 → 竖屏成片**。

当前版本聚焦第一版最小闭环，提供 CLI 与本地 HTTP API。抖音号发布、多视频生成模型路由不在本步骤范围内。

## 能力

- **主题 → 脚本**：默认 `auto` 模式。配置了 `SCRIPT_API_KEY` 时调用 OpenAI 兼容的 Chat Completions 接口；没有密钥时使用内置离线模板，保证开箱即可跑通。
- **本地素材库 + 上传**：支持 mp4/mov/webm/mkv 与 jpg/png/webp；自动探测时长、尺寸；按文件名和自定义标签匹配分镜关键词。没有命中时生成渐变背景，不会把无关素材硬塞进片子。
- **可替换 TTS**：默认使用 Edge TTS（免费、无需密钥，中文音色 `zh-CN-XiaoxiaoNeural`）；也可切换 OpenAI 兼容 `/audio/speech` 或静音占位。Edge 返回句级时间戳，用于字幕对齐。
- **规则化自动剪辑**：每个分镜时长由配音时长决定，素材自动铺满 9:16 画幅，字幕烧录，分镜间统一淡入淡出转场，最后拼接为成片。
- **产物完整**：成片 `video.mp4`、字幕 `subtitles.srt`、脚本 `script.json`、执行结果 `result.json`。
- **两种入口**：CLI 适合本地批量生成；HTTP API 适合后续接前端或工作流。

## 快速开始

环境要求：

- Node.js >= 20.11
- pnpm（仓库使用 pnpm 11）
- 系统安装 CJK 字体（推荐 `Noto Sans CJK SC`；Ubuntu：`sudo apt-get install fonts-noto-cjk`）
- ffmpeg/ffprobe 由 `ffmpeg-static` / `ffprobe-static` 自动安装，无需系统预装

```bash
pnpm install
pnpm demo
```

`pnpm demo` 使用离线脚本模板 + Edge TTS 生成一条 720×1280 的演示成片，输出到 `./output/`。首次运行会下载 ffmpeg 二进制。Edge TTS 需要网络；失败时会回退为静音占位并在日志中告警。

生成一条正式视频：

```bash
# 有 SCRIPT_API_KEY 时走大模型；没有则自动使用离线模板
pnpm dev create --topic "城市夜景" --out ./output

# 强制离线脚本 + 静音配音（完全离线、适合 CI）
pnpm dev create --topic "城市夜景" --offline --silent --width 720 --height 1280

# 构建后使用
pnpm build
node dist/cli.js create --topic "城市夜景"
```

## CLI

```text
video-agent create --topic "主题" [选项]
video-agent materials add <文件...> [--tags 城市,夜景]
video-agent materials list [--json]
video-agent serve [--port 8787] [--host 127.0.0.1]
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `-t, --topic <主题>` | 视频主题（必填） |
| `-c, --config <路径>` | 配置文件，默认 `./video-agent.config.json` |
| `--out <目录>` | 成片输出目录 |
| `--offline` | 强制使用离线脚本模板 |
| `--silent` | 使用静音占位配音（仅演示/测试） |
| `--voice <音色>` | 覆盖 TTS 音色 |
| `--width/--height` | 覆盖输出尺寸，默认 1080×1920 |
| `--json` | 以 JSON 输出结果 |

## 配置

复制示例配置后按需修改：

```bash
cp video-agent.config.example.json video-agent.config.json
```

`video-agent.config.json` 已被 `.gitignore` 忽略，适合放本地配置。密钥建议通过环境变量注入，不要写进仓库。完整变量见 [.env.example](.env.example)。

### 脚本供应商

| `script.provider` | 行为 |
| --- | --- |
| `auto`（默认） | 有 `SCRIPT_API_KEY` 时调用大模型，否则使用离线模板 |
| `openai` | 调用 OpenAI 兼容的 `POST {baseUrl}/chat/completions` |
| `offline` | 内置 5 段式模板，不调用外部服务 |

相关变量：`SCRIPT_API_KEY`、`SCRIPT_BASE_URL`、`SCRIPT_MODEL`、`SCRIPT_TARGET_DURATION`、`SCRIPT_MAX_SEGMENTS`。

> 任何兼容 OpenAI Chat Completions 的服务都可以接入，例如 OpenAI、DeepSeek、通义、自建网关等。模型需支持 `response_format: json_object` 或至少能稳定输出 JSON；解析器也会从代码围栏/说明文字中提取 JSON。

### 配音供应商

| `tts.provider` | 行为 |
| --- | --- |
| `edge`（默认） | 微软 Edge 朗读接口，免费、无需密钥，返回句级时间戳 |
| `openai` | 调用 OpenAI 兼容的 `POST {baseUrl}/audio/speech` |
| `silent` | 生成静音占位音轨，仅用于演示/测试 |

相关变量：`TTS_VOICE`、`TTS_RATE`、`TTS_API_KEY`、`TTS_BASE_URL`、`TTS_MODEL`、`TTS_FALLBACK`。`TTS_FALLBACK=silent`（默认）时，配音失败会继续出片并告警；设为 `error` 则中断任务。

> Edge TTS 使用的是微软 Edge 的朗读接口，不是带 SLA 的正式 Azure 服务；生产环境建议切换为已购买的 TTS 供应商。

### 视频与字幕

- 默认 1080×1920、30fps、H.264 + AAC。
- 每个分镜时长 = 配音时长 + `video.tailPaddingSec`（默认 0.4s），且不小于 `video.minSegmentSec`。
- 字幕优先使用 TTS 返回的句级时间戳；没有时间戳时按字符占比估算。字幕按 `subtitles.maxCharsPerLine × maxLines` 拆屏，手动换行避免溢出。
- 分镜之间统一使用 `fade` 淡入淡出（`video.transitionDurationSec`，默认 0.2s）。
- 字幕字体默认 `Noto Sans CJK SC`，可通过 `subtitles.fontFamily` 或 `SUBTITLE_FONT` 修改。

## 素材库

素材库默认是 `./materials/`，索引保存在 `.materials.json`（自动维护）。添加素材：

```bash
# 本地文件
pnpm dev materials add ./clips/city-night.mp4 --tags 城市,夜景

# 查看
pnpm dev materials list
```

素材标签来源：文件名分词（`city-night_01.mp4` → `city`、`night`、`01`）+ `--tags` 自定义标签。匹配时：

1. 分镜关键词命中标签得分最高；
2. 其次匹配标题/文件名；
3. 未命中时默认生成渐变背景（`materials.allowUnmatched=true` 可改为使用任意未使用素材）。

脚本生成时会把素材库标签一起传给大模型，引导它优先选择能匹配到素材的关键词。

## HTTP API

```bash
pnpm dev serve --port 8787
```

启动后可访问 `http://127.0.0.1:8787/` 查看接口清单。

```bash
# 创建任务
curl -s -X POST http://127.0.0.1:8787/api/videos \
  -H 'content-type: application/json' \
  -d '{"topic":"城市夜景"}'

# 查询状态（state: queued/running/succeeded/failed）
curl -s http://127.0.0.1:8787/api/videos/<id>

# 下载成片 / 字幕
curl -o video.mp4 http://127.0.0.1:8787/api/videos/<id>/video
curl -s http://127.0.0.1:8787/api/videos/<id>/subtitles

# 上传素材
curl -s -X POST http://127.0.0.1:8787/api/materials \
  -F file=@./clips/city-night.mp4 \
  -F tags=城市,夜景

# 素材列表 / 删除
curl -s http://127.0.0.1:8787/api/materials
curl -s -X DELETE http://127.0.0.1:8787/api/materials/<materialId>
```

服务默认只监听 `127.0.0.1`。任务在进程内串行执行；重启后内存中的任务列表会丢失，但已生成的 `output/` 目录仍在。

## 输出结构

```text
output/<jobId>/
├── video.mp4        # 成片
├── subtitles.srt    # 全片字幕
├── script.json      # 脚本与分镜关键词
├── result.json      # 每个分镜的素材、配音、时长、字幕数量
├── segments/        # 分镜中间文件（含 ASS 字幕、背景图）
└── error.json       # 失败时记录错误
```

## 测试

```bash
pnpm typecheck
pnpm test
```

测试包含：

- 单元测试：脚本 JSON 解析/归一化、配置合并、字幕拆屏与时间码、Edge 元数据解析、素材标签与匹配。
- 集成测试：用离线脚本 + 静音配音跑完整链路，并用 ffprobe 校验成片；启动真实 HTTP 服务，覆盖上传素材、创建任务、轮询、Range 播放、删除素材。

集成测试需要 ffmpeg 与 CJK 字体；CI 会自动安装 `fonts-noto-cjk`。

## 已知限制与下一步

- 本版本不包含抖音号发布；发布链路计划在下一步接入。
- 素材匹配是关键词规则，不是向量语义检索；素材少时观感主要依赖渐变背景。
- 单进程串行任务，未做任务持久化/断点续跑；适合单机 MVP。
- 转场是固定的淡入淡出，暂未提供多种转场模板。
- 未配置大模型密钥时脚本来自离线模板，内容质量有限；配置 `SCRIPT_API_KEY` 后走真实模型。
- Edge TTS 依赖第三方接口，稳定性和音色受微软服务影响；可切换到 `openai` 兼容供应商。

## 目录结构

```text
src/
├── cli.ts                 # 命令行入口
├── pipeline.ts            # 主流程编排
├── config.ts              # 配置加载/校验
├── script/                # 脚本供应商（openai / offline）与 JSON 归一化
├── tts/                   # 配音供应商（edge / openai / silent）与时间戳估算
├── materials/             # 素材库、索引、匹配规则
├── media/                 # ffmpeg/ffprobe 封装、渐变背景生成
├── subtitles/             # ASS/SRT 字幕生成
├── render/                # 分镜渲染与成片拼接
├── server/                # HTTP API、任务队列
└── util/                  # 文件、文本、时间码工具
```

## License

MIT
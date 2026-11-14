# video-agent

视频创作智能体：输入主题或剧本，自动完成 **脚本/分镜生成 → 角色与道具一致性 → 素材匹配 / AI 画面（文生视频、图生视频） → 语音合成 → 规则化剪辑 → 竖屏成片**，并提供网页控制台、CLI 与本地 HTTP API。

当前版本包含完整的本地创作闭环：网页端可以生成脚本、管理素材与角色库、创建与查看任务、配置模型、授权抖音号并发布成片；并支持按用户分配菜单权限。短剧场景下，同一角色/道具的参考图和外观设定会贯穿每个镜头，也支持先花几秒生成测试视频确认模型效果，并在调用任何付费模型前完成本地预检。

## 能力

- **网页控制台**：创作、任务、角色库、素材库、发布、设置六个页面，移动端自适应；无需前端构建步骤，`pnpm dev serve` 即可使用。
- **用户与权限**：首次启动创建管理员；管理员在「设置 → 用户与权限」添加成员并勾选可见菜单。不同账号登录后只看到被授权的页面，服务端 API 同样按权限校验。
- **主题 / 剧本 → 分镜**：默认 `auto` 模式。配置了脚本 API Key 时调用 OpenAI 兼容的 Chat Completions 接口；没有密钥时使用内置离线模板，保证开箱即可跑通。分镜带 `scene`（场景）、`shot`（镜头）与 `cast`（出场角色/道具），可直接粘贴剧本或故事大纲按剧本改编。
- **本地素材库 + 上传**：支持 mp4/mov/webm/mkv 与 jpg/png/webp；自动探测时长、尺寸；按文件名和自定义标签匹配分镜关键词。没有命中时生成渐变背景，不会把无关素材硬塞进片子。
- **可替换 TTS**：默认使用 Edge TTS（免费、无需密钥，中文音色 `zh-CN-XiaoxiaoNeural`）；也可切换 OpenAI 兼容 `/audio/speech` 或静音占位。Edge 返回句级时间戳，用于字幕对齐。
- **角色库与跨镜头一致性**：为人物/道具保存名称、外观设定和参考图；生成时把设定写进每个出场分镜的提示词，并把参考图作为图生视频输入，让同一人物、同一道具在后续镜头（甚至后续视频）保持同一形象。
- **AI 画面生成（可选）**：通过通用 HTTP 文生视频 / 图生视频接口为分镜生成画面；有角色参考图时自动携带 `image` 与 `reference_images`，失败时按配置回退素材库或渐变背景。
- **预检与费用保护**：任务入队前与流水线开始前做本地预检（配置、密钥、剧本长度、参考图、目录可写、ffmpeg），问题一次性列出并标明阶段，不会先扣费再报错；离线脚本、静音配音、画面回退等降级会在任务详情里显式告警。
- **测试视频**：设置页输入几句提示词，选择 3 秒或 5 秒，真实生成一条测试视频并内嵌播放，正式出片前先确认模型效果。
- **规则化自动剪辑**：每个分镜时长由配音时长决定，素材自动铺满 9:16 画幅，字幕烧录，分镜间统一淡入淡出转场，最后拼接为成片。
- **抖音授权发布**：OAuth 授权、令牌自动刷新、上传成片并创建抖音作品；发布历史保存在本地。
- **模型配置**：网页设置页可修改脚本、配音、AI 画面、视频/字幕、素材与抖音参数，保存到 `data/settings.json`，新任务生效。
- **产物完整**：成片 `video.mp4`、字幕 `subtitles.srt`、脚本 `script.json`、执行结果 `result.json`。

## 快速开始

环境要求：

- Node.js >= 20.11
- pnpm（仓库使用 pnpm 11）
- 系统安装 CJK 字体（推荐 `Noto Sans CJK SC`；Ubuntu：`sudo apt-get install fonts-noto-cjk`）
- ffmpeg/ffprobe 由 `ffmpeg-static` / `ffprobe-static` 自动安装，无需系统预装

```bash
pnpm install
pnpm dev serve
```

打开 `http://127.0.0.1:8787/`：

1. 首次打开会要求创建管理员账号（用户名、显示名称、密码）；账号保存在本机 `data/users.json`。
2. 在「设置」里填入脚本模型 API Key（不填也能用离线模板）。
3. 在「设置 → 用户与权限」添加成员，勾选每个人可见的菜单。
4. 在「素材库」上传几段竖屏素材；也可以不传，直接用渐变背景。
5. （做短剧时）在「角色库」添加人物与关键道具，填外观设定并上传参考图。
6. 回到「创作」输入主题，可粘贴剧本，勾选要出场的角色/道具，预览分镜后创建任务。
7. 在「任务」里查看进度、播放成片、下载字幕；有降级或失败时页面会直接说明阶段与原因。配置好抖音后可一键发布。

也可以直接用 CLI 生成一条演示成片：

```bash
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

## 人物对话（多音色）

默认是第三人称旁白；勾选创作页的「人物对话（多音色）」后，分镜按人物台词生成：

- 脚本输出 `lines: [{speaker, text}]`，`narration` 用“角色：台词”拼接，字幕逐句显示说话人。
- 角色库可以试听音色：音色下拉按设置里当前供应商/模型列出（Edge / OpenAI / ElevenLabs / 百炼 qwen-tts / CosyVoice / MiniMax），选好点「试听」，用该角色设定合成一句示例台词；试听不改设置、不落任务，失败会在按钮下方显示具体原因。角色设定里选的音色会真正用于成片：对话配音按说话人分别用各自的音色合成（Edge/OpenAI/百炼/ElevenLabs 都支持）。
- 配音逐句合成：每个说话人一个音色（Edge voice）。角色库里可以给角色指定音色；没指定时按角色描述自动匹配——描述里写了性别/年龄（如「25 岁女性，齐肩短发」「45 岁男性，声音低沉」）就从对应听感的音色里挑，同一个角色每次生成结果稳定，并尽量避开旁白和其他角色的音色；描述里读不出特征时退回按名字稳定分配。
- 语速跟着人物设定微调（年长角色慢一点、年轻角色快一点）；音高也随年龄微调（年长压低、年轻略提高），喊叫/耳语台词自动加减音量；多句拼接时逐句做响度归一（EBU R128），避免男声/女声混在一起时一句大一句小。
- 视频模型本身不出声：配音先在 TTS 阶段按角色生成，再与画面对齐；需要口型对齐时接下面的 VideoRetalk。
- 每句配音的时间轴是真实时长，多句按顺序拼接成该分镜的音轨，再接画面。
- 非 Edge 供应商不支持切换音色时，仍逐句合成，字幕保留说话人；静音占位仅用于演示/测试。
- Edge 是免费基础音色；要更接近短剧演员的自然表演，可在设置里换成 OpenAI 兼容 TTS（如 `gpt-4o-mini-tts`），系统会为每个角色分配不同音色，并按角色设定传 `instructions` 表演提示（口语化、停顿起伏、不要朗读腔）。
- 百炼原生方案：配音供应商选「阿里百炼」，模型填 `qwen-tts` 或 `qwen3-tts-flash`（多模态 HTTP）、`cosyvoice-v3`（WebSocket 流式）或百炼上的第三方模型如 `MiniMax/speech-2.8-turbo`（原生 multimodal-generation 接口，入参为 `input.audio` + `parameters.voice`）；接口地址填 `https://dashscope.aliyuncs.com` 或完整接口地址均可。音色填百炼/模型对应的音色 id。声音复刻得到的 voice id 可直接填到角色库的音色里（复刻本身在百炼控制台完成）。
- 更自然的方案：配音供应商选 `ElevenLabs`（`eleven_multilingual_v2`），角色库的 voice 填 ElevenLabs `voice_id`，接口地址填 `https://api.elevenlabs.io`、密钥填 `TTS_API_KEY`；合成时按短剧对白给 `stability/style` 表演参数。
- 对白之间会自动留停顿（首次开口 0.12s、同一人 0.18s、换人 0.32s），并按每句内容补情绪提示（争执/疑问/哭腔/耳语/笑意），避免一句顶一句的念稿感。
- 音色分配：角色库里给角色填 `voice` 就固定用该音色（ElevenLabs 填 `voice_id`，可用平台的声音克隆得到“演员本声”）；没填时按描述里的性别、年龄从对应听感的音色池挑，同一角色全片稳定、不同角色互不相同、也不和旁白撞车；同性别同龄角色特别多时先在整池里找没人用过的音色。
- 人声后期（`src/audio/mix.ts`）：每条分镜音轨统一做高通 90Hz 去喷麦与低频轰鸣 → 3:1 轻压缩压平忽大忽小 → 26ms 早期反射给一点房间感 → EBU R128 归一到 -16 LUFS。TTS 直出的干声又小又飘，直接贴画面就像有人在旁边念稿，这一步让它像成片里的一条人声；字幕与分镜时长按处理后音轨重算。
- 单句内部也按标点朗读：`，、` 停 150ms、`；` 210ms、`。` 320ms、`！？` 360ms、`……` 420ms；感叹句与「滚、凭什么、竟然、不可能」等强情绪词会更快更高更响，疑问句略慢并抬高，`……` 与「对不起、算了、原来」等泄气句放慢压低，5 字以内短句轻微放慢。这样即使仍用免费的 Edge 音色，也不会把一整句话一口气念完（这是“播音腔”最主要的来源）。
- 同一角色连续说的台词会合并成一个说话轮次再合成，拿到完整上下文；轮次内部再按标点分句，避免每句都有句尾收束的“背书感”。声线分配与合成策略详见 [docs/voice-design.md](docs/voice-design.md)。
- 命令行为 `video-agent create --dialogue`；API 为 `dialogue: true`（创建任务与 `/api/scripts/generate` 预览都支持）。

## 口型同步（人物对白）

对话模式的台词音轨可以和画面做口型对齐，默认接 **阿里云百炼 VideoRetalk**（`videoretalk`）：

- 设置 → 口型同步：选「阿里百炼 VideoRetalk」，填**北京地域**的 API Key；模型、接口地址、轮询/超时都有默认值。
- 链路：分镜渲染 → 上传视频与该分镜配音到百炼临时存储 → 提交 `videoretalk` 异步任务 → 轮询 → 下载口型对齐视频 → 替换该分镜后再拼接成片。
- 只对「对话模式 + 分镜有台词 + 本镜出现角色」的分镜调用；其余分镜跳过。
- 失败默认回退为未对口型片段并写进 warnings；设置里可改为直接中断。
- 计费：VideoRetalk 按生成时长 0.08 元/秒；视频/音频需 2–120 秒、视频边长 640–2048、人物正面近景。临时文件 48 小时有效。

相关环境变量：`LIPSYNC_ENABLED`（总开关，`false` 时成片完全不调用口型校验）、`LIPSYNC_PROVIDER=dashscope`、`LIPSYNC_API_KEY`、`LIPSYNC_BASE_URL`、`LIPSYNC_MODEL`、`LIPSYNC_TIMEOUT_MS`、`LIPSYNC_POLL_INTERVAL_MS`。

## 创作页的短剧品控

创作页把短剧行业里最容易踩的坑做成可执行检查，都是本地计算，不调用模型、不产生费用：

- **流程与边界**：折叠面板说明每个阶段谁负责——策划、剧本（钩子/反转）、备案与版权、封面与投放由人负责；分镜拆解、画面生成、配音字幕、成片合成由平台承接。
- **创作品控**（生成脚本预览后出现，并给出 0–100 分）：
  - 结尾钩子：最后一句要有疑问、反转或悬念；
  - 台词长度：单句不超过 30 字，适配配音与字幕；
  - 景别多样：至少两种景别，避免一个机位到底；
  - 节奏均衡：单镜 4–8 秒为宜，过长建议拆镜；
  - 人物一致性：分镜里出现的角色/道具要有参考图，跨镜头才不变脸；
  - 发布提醒：备案、素材商用授权、封面与投放需要人工确认，不计入分数。
- **分镜去重与拼接校验**：脚本层去掉重复台词与重复分镜；相邻分镜场景/镜头描述雷同时自动换机位，并把本镜台词写进画面提示词；成片前校验每个分镜的渲染文件都进入拼接、成片时长与分镜合计一致，`result.json` 里记录每段的渲染文件与内容哈希。

## 网页控制台

| 页面 | 能力 |
| --- | --- |
| 创作 `#/create` | 输入主题/剧本、勾选角色与道具、时长、分镜数（可选 1 = 一镜到底）、配音音色；预览分镜（含场景/镜头/出场角色）；创建任务 |
| 任务 `#/jobs` | 任务列表、进度轮询、成片播放、字幕/脚本/结果下载、抖音发布；失败阶段与降级告警 |
| 角色库 `#/cast` | 添加/编辑角色与道具、上传或更换参考图、删除；设定跨任务复用 |
| 素材库 `#/materials` | 拖拽/选择上传，编辑标题与标签，预览、下载、删除 |
| 发布 `#/publish` | 抖音授权状态、授权/重新授权/断开、发布历史 |
| 设置 `#/settings` | 脚本模型、配音、AI 画面、视频与字幕、素材策略、抖音应用配置 |

设置页不会回显已保存的密钥，只显示“已配置”和末四位提示；留空表示保持不变，勾选“清除”后保存才会删除。

脚本模型、配音、AI 画面生成和抖音开放平台四个分组都有“测试”按钮，使用**已保存**的配置验证连通性：脚本/配音会实际生成一次内容；AI 画面可输入测试描述并选择 3 秒或 5 秒，实际生成并预览一段测试视频（会消耗额度，测试视频缓存在 `.cache/settings-test`，只保留最近 20 条）。如果生成较慢，页面会在超时后**自动继续查询同一个任务**（每 5 秒一次，最多 15 分钟，不会重新提交或重复扣费），并显示已等待时间与平台状态；平台拒绝请求时（如密钥无效、限流、时长/尺寸不支持）会显示平台返回的错误码与原文，并给出可执行的建议；抖音会用应用凭证换取 `client_token`。同一个测试（相同接口地址、模型、时长、描述）同时只会有一次提交：连点、自动续查和多标签页共享同一个任务，查询出错或超时都会保留任务 ID 继续查询，不会重复提交、重复扣费；不要在任务未完成时反复点测试。

画面生成是付费操作，因此测试的超时处理遵守两条规则：

- **超时不算失败**：一次测试请求最多等待 3 分钟，超过后接口仍返回 `200` 并带 `pending: true` 与任务 ID，提示“已提交、平台可能已扣费”，而不是报错；
- **不重复提交**：任务没出片时，服务端会记住它（30 分钟内有效），同一配置、描述与时长再次点击测试会复用该任务继续查询；也可以在“已有任务 ID”里填上平台返回的任务号点“取回视频”（等价于传 `resumeTaskId`）。只有拿到成片或任务真正失败后才清除记录。

聚合平台返回结构差异较大，成片地址会按内容智能识别，兼容 `video_url`、`data[0].url`、`output.video_url`、`result.videos[].url` 等嵌套与数组形式；封面图、缩略图不会被误当成视频。任务已完成却找不到可用地址时，错误信息会带上响应片段，便于判断是字段不兼容还是平台异常。

## 用户与权限

- **首次初始化**：没有 `data/users.json` 时，网页会显示“创建管理员账号”。创建后需要登录才能使用工作台。
- **菜单权限**：创作、任务、角色库、素材库、发布、设置六个菜单可以按用户勾选；管理员始终拥有全部菜单。
- **服务端校验**：菜单隐藏之外，除公开接口外的所有 `/api/*` 接口都会校验会话与模块权限，直接调用接口也无法越权；设置写操作需要 `settings` 权限，用户管理仅管理员可用。
- **依赖关系**：勾选“创作”会自动包含“任务”，因为创建视频后需要查看任务进度；勾选“素材库”会自动包含“角色库”，因为两者都是创作资源。
- **账号管理**：管理员可在「设置 → 用户与权限」添加用户、修改显示名称/密码/角色/权限、禁用或删除账号。至少保留一个启用的管理员，不能删除或降级自己。
- **会话**：登录使用 HttpOnly、SameSite=Lax 的会话 Cookie，默认 7 天；会话保存在进程内存，重启服务后需要重新登录。密码使用 scrypt 加盐哈希，不保存明文。
- **找回管理员**：如果忘记管理员密码，可由另一个管理员重置；如果所有管理员都无法登录，停止服务后删除 `data/users.json` 会重新进入首次初始化（会清空所有账号）。

## 配置

配置优先级从低到高：

1. 内置默认值
2. `video-agent.config.json`
3. 环境变量
4. 网页设置 `data/settings.json`
5. 命令行参数

网页设置保存在 `data/settings.json`（权限 `0600`，已被 `.gitignore` 忽略），保存后会原地更新运行中的配置；新任务生效，已排队/运行中的任务使用创建时的快照。

复制示例配置后按需修改：

```bash
cp video-agent.config.example.json video-agent.config.json
```

密钥建议通过环境变量注入，不要写进仓库。完整变量见 [.env.example](.env.example)。

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

### AI 画面生成

`videoGen.provider` 默认为 `http`，并预置阿里百炼（DashScope）的 Wan 视频模型：服务地址 `https://dashscope.aliyuncs.com`、模型 `wan3.0-video`、提交路径 `/api/v1/services/aigc/video-generation/video-synthesis`、查询路径 `/api/v1/tasks/{id}`。**API Key 需要自己填写**（设置页「AI 画面生成」的 API Key，或 `VIDEOGEN_API_KEY`）；没有 Key 时任务会在本地预检阶段直接报错，不会发起付费请求。不需要 AI 画面时把供应商改为「不使用」。

`protocol` 决定请求格式：`auto`（默认）按服务地址判断——`dashscope.aliyuncs.com` 用阿里百炼异步接口，其他地址用下面的通用 HTTP 契约；也可以显式设为 `dashscope` 或 `generic`。

服务地址填的是阿里百炼（`dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com`）时会自动纠正成异步写法：协议若是「通用 HTTP 契约」会改回 `dashscope`，提交/查询路径还是通用默认值（`/v1/videos/generations`）也会换成上面的百炼路径；只填域名（少了 `https://`）或把完整接口地址粘进「服务地址」也会被纠正。这样就不会出现平台报 `AccessDenied: current user api does not support synchronous calls`（该接口只支持异步调用，需要 `X-DashScope-Async: enable`）。

阿里百炼模式（`protocol=dashscope`）的请求与轮询：

```http
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
Authorization: Bearer <API_KEY>
X-DashScope-Async: enable

{"model": "wan3.0-video", "input": {"prompt": "...", "img_url": "data:image/png;base64,..."}, "parameters": {"duration": 5, "size": "720*1280"}}

GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}
→ {"output": {"task_id": "...", "task_status": "SUCCEEDED", "video_url": "https://..."}}
```

轮询会识别 `PENDING` / `RUNNING` / `SUCCEEDED` / `FAILED` 等状态。百炼/万相 3.0 的分镜会带上角色库参考图：`media[type=reference_image]`（最多 10 张），没有参考图时才用 `media[type=first_frame]` 首帧——首帧和参考图在平台上互斥，同一请求不能混用；早期 Wan 模型仍走 `input.img_url`。

> **百炼的两个相反报错**：提交时缺 `X-DashScope-Async: enable` 会报 `current user api does not support synchronous calls`；任务查询接口是同步的，给查询请求加了这个头则报 `current user api does not support asynchronous calls`。现在只在**提交**请求加异步头，查询不带。
>
> 接入步骤：设置 → AI 画面生成 → 点「一键填入百炼 Wan 3.0 默认值」→ 填 API Key → 保存设置 → 点「生成测试视频」。默认值为：接口协议「阿里百炼 DashScope」、接口地址 `https://dashscope.aliyuncs.com`、模型 `wan3.0-video`、提交路径 `/api/v1/services/aigc/video-generation/video-synthesis`、查询路径 `/api/v1/tasks/{id}`。
>
> 万相 3.0 的请求体是 `{model, input:{prompt, media[]}, parameters:{resolution, ratio, duration}}`：竖屏默认 `720P` + `9:16`，时长 2–30 秒；图生视频首帧放 `media:[{type:"first_frame", url:"data:image/png;base64,..."}]`。早期 Wan 模型仍用 `parameters.size` 与 `input.img_url`。
>
> 地址用业务空间专属域名（`https://{业务空间ID}.cn-beijing.maas.aliyuncs.com`）时，API Key、模型和地址必须在同一地域；官方文档建议生产环境使用这种域名。自定义域名/反向代理请显式选择「通用 HTTP 契约」，程序不会把它误判成百炼。

同一个测试的并发请求（双击、两个标签页、自动续查同时触发）共用一次执行，只会提交一条任务；页面成功时也会写明「本次只提交 1 次生成」。如果上一个任务还在生成时改了提示词或时长再点测试，页面会先弹确认——重新提交会再生成一条并再次扣费；只想起回旧任务就把提示词和时长改回原样。

> 反向代理/自建网关如果改写了域名和路径，请把「接口协议」显式设为「阿里百炼 DashScope」，否则无法识别为百炼接口。

通用 HTTP 契约（`protocol=generic`，任务创建时打开“AI 画面”开关）：

接口约定（`baseUrl` + `submitPath`）：

```http
POST {baseUrl}{submitPath}
Content-Type: application/json

{
  "model": "video-gen-1",
  "prompt": "...",
  "duration_sec": 5,
  "aspect_ratio": "9:16",
  "image": "data:image/png;base64,...",
  "reference_images": [
    {"role": "character", "name": "林小满", "image": "data:image/png;base64,..."}
  ]
}
```

`image` 与 `reference_images` 只在有参考图时出现：第一个出场角色（没有角色则取第一张参考图）同时作为首帧 `image`，所有出场角色/道具按顺序放进 `reference_images`。没有参考图时就是纯文生视频，请求体只有前四个字段。图片以 data URL 传输，单张上限 8MB，支持 jpg/png/webp。

返回 `{"video_url":"https://..."}` 表示同步完成；返回 `{"id":"task-1"}` 或 `{"task_id":"task-1"}` 表示异步任务。随后轮询：

```http
GET {baseUrl}{pollPath}    # pollPath 中的 {id} 会替换为任务 ID
```

状态为 `queued` / `running` / `succeeded` / `failed`；成功后返回 `video_url`。响应字段兼容 `{"data": {...}}` 包裹。下载后会用 ffprobe 校验，失败时按 `videoGen.fallbackToMaterials` 回退素材库或渐变背景。

状态与地址字段的兼容：除了 `status` / `state` 与 `video_url`，也识别嵌套结构（`data.status`、`data.task.status`、`data.output.video_url`、`output.url`、`videos[0].file_url` 等）与数组；封面、缩略图字段会被跳过。任务已完成但没解析到地址时，错误信息会带上响应结构摘要，提示用「视频地址字段」补一条点号路径（如 `data.output.video_url`），配置后没取到会自动回退识别。

相关变量：`VIDEOGEN_PROVIDER`、`VIDEOGEN_PROTOCOL`、`VIDEOGEN_BASE_URL`、`VIDEOGEN_MODEL`、`VIDEOGEN_API_KEY`、`VIDEOGEN_SUBMIT_PATH`、`VIDEOGEN_POLL_PATH`、`VIDEOGEN_RESULT_PATH`。

> 默认内置阿里百炼（DashScope）异步视频协议；通用 HTTP 契约适合自建网关。使用 Runway、可灵、即梦等其它模型时，请通过网关把厂商 API 适配成通用格式。

### 抖音开放平台

1. 在[抖音开放平台](https://developer.open-douyin.com/)创建应用，获取 `client_key` 与 `client_secret`。
2. 为应用申请 `user_info` 与 `video.create` 权限，并配置回调地址，例如 `http://127.0.0.1:8787/api/douyin/callback`。
3. 在网页「设置 → 抖音开放平台」填入应用信息，保存后点击「授权抖音」。
4. 授权成功后，在任务详情或「发布」页填写文案并发布。

说明：

- 未填写 `redirectUri` 时，默认使用 `http://<server.host>:<server.port>/api/douyin/callback`；设置页会显示当前生效地址。
- 授权令牌保存在 `.cache/douyin-token.json`（`0600`），发布历史保存在 `data/publishes.json`。
- 发布文案限制 55 个字符；发布前会确保令牌有效，过期前 60 秒自动刷新。
- 开放平台的应用审核、权限与沙箱限制由抖音控制；未通过审核的应用可能无法真正发布。
- 发布失败会返回抖音接口的错误码与描述，便于排查。

相关变量：`DOUYIN_CLIENT_KEY`、`DOUYIN_CLIENT_SECRET`、`DOUYIN_REDIRECT_URI`、`DOUYIN_SCOPE`、`DOUYIN_API_BASE_URL`。

### 视频与字幕

- 默认 1080×1920、30fps、H.264 + AAC。
- 每个分镜时长 = 配音时长 + `video.tailPaddingSec`（默认 0.4s），且不小于 `video.minSegmentSec`。
- 字幕优先使用 TTS 返回的句级时间戳；没有时间戳时按字符占比估算。字幕按 `subtitles.maxCharsPerLine × maxLines` 拆屏，手动换行避免溢出。
- 分镜之间统一使用 `fade` 淡入淡出（`video.transitionDurationSec`，默认 0.2s）。
- 字幕字体默认 `Noto Sans CJK SC`，可通过 `subtitles.fontFamily` 或 `SUBTITLE_FONT` 修改。

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
| `--story <文本>` | 剧本/大纲，分镜按剧本生成 |
| `--cast <id,id>` | 使用角色库中的角色/道具（默认全部） |
| `--width/--height` | 覆盖输出尺寸，默认 1080×1920 |
| `--json` | 以 JSON 输出结果 |

`serve` 会同时启动网页控制台与 API，默认只监听 `127.0.0.1:8787`。

## HTTP API

```bash
pnpm dev serve --port 8787
```

启动后访问 `http://127.0.0.1:8787/` 打开网页控制台，`/api` 返回接口清单。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api` | 接口清单 |
| `GET` | `/api/auth/session` | 当前登录状态；未初始化时 `needsSetup: true` |
| `POST` | `/api/auth/setup` | 首次创建管理员，`{username,displayName?,password}` |
| `POST` | `/api/auth/login` | 登录，`{username,password}`，返回会话 Cookie |
| `POST` | `/api/auth/logout` | 退出登录并清除 Cookie |
| `GET/POST` | `/api/users` | 用户列表 / 添加用户（仅管理员） |
| `PATCH/DELETE` | `/api/users/:id` | 修改（密码/角色/权限/禁用）/ 删除用户（仅管理员） |
| `GET/PUT` | `/api/settings` | 读取/保存设置（密钥只返回是否已配置；保存需要 `settings` 权限） |
| `POST` | `/api/settings/test` | 测试设置配置，`{"kind":"script"\|"tts"\|"videogen"\|"douyin"}`；`videogen` 可带 `prompt`、`durationSec`（3 或 5）与 `resumeTaskId`，返回测试视频地址，或在未出片时返回 `pending` 与 `taskId` |
| `GET` | `/api/settings/test/video/:name` | 读取最近生成的 AI 画面测试视频（需要 `settings` 权限） |
| `GET/POST` | `/api/cast` | 角色/道具列表 / 添加（multipart：`kind`、`name`、`description?`、`file?`） |
| `PATCH/DELETE` | `/api/cast/:id` | 修改设定 / 删除 |
| `GET` | `/api/cast/:id/image` | 参考图 |
| `POST` | `/api/cast/:id/image` | 更换参考图（multipart：`file`） |

| `GET/POST` | `/api/materials` | 素材列表 / 上传（multipart：`file`、`title`、`tags`） |
| `GET/DELETE` | `/api/materials/:id` | 素材详情 / 删除 |
| `GET` | `/api/materials/:id/file` | 素材文件（支持 Range） |
| `POST` | `/api/scripts/generate` | 预览脚本，`{topic,story?,castIds?,targetDurationSec,maxSegments}` |
| `GET/POST` | `/api/videos` | 任务列表 / 创建任务 |
| `GET` | `/api/videos/:id` | 任务详情（脚本、分镜、成片信息） |
| `GET` | `/api/videos/:id/video` | 成片（支持 Range） |
| `GET` | `/api/videos/:id/poster` | 播放器封面（JPEG） |
| `GET` | `/api/videos/:id/subtitles` | SRT 字幕 |
| `GET` | `/api/videos/:id/script` | 脚本 JSON |
| `GET` | `/api/videos/:id/result` | 执行结果 JSON |
| `POST` | `/api/videos/:id/publish` | 发布到抖音，`{text,coverTsp?}` |
| `GET` | `/api/videos/:id/publish` | 该任务的发布记录 |
| `GET` | `/api/publishes` | 全部发布记录 |
| `GET` | `/api/douyin/status` | 抖音配置/授权状态 |
| `GET` | `/api/douyin/authorize` | 获取授权 URL |
| `GET` | `/api/douyin/callback` | OAuth 回调 |
| `POST` | `/api/douyin/refresh` | 手动刷新令牌 |
| `POST` | `/api/douyin/disconnect` | 断开授权 |

创建任务示例（先登录，Cookie 会保存到 `/tmp/video-agent.cookies`）：

```bash
curl -s -c /tmp/video-agent.cookies -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}'

curl -s -b /tmp/video-agent.cookies -X POST http://127.0.0.1:8787/api/videos \
  -H 'content-type: application/json' \
  -d '{"topic":"城市夜景","targetDurationSec":30,"maxSegments":4,"ttsProvider":"edge","subtitlesEnabled":true,"videoGenEnabled":false}'
```

带剧本与角色时：

```bash
curl -s -b /tmp/video-agent.cookies -X POST http://127.0.0.1:8787/api/videos \
  -H 'content-type: application/json' \
  -d '{"topic":"钟表店","story":"林小满在钟表店遇到一位神秘客人。","castIds":["<角色 id>"],"maxSegments":4}'
```

`story` 最多 6000 个字符；`castIds` 省略表示使用角色库全部设定，传入不存在的 id 会直接返回 400。创建任务前会先做本地预检，配置、参考图或运行环境有问题时返回 400（`PREFLIGHT_FAILED` / `INVALID_OPTIONS` / `CAST_NOT_FOUND`），不会先调用模型。

除 `/api`、`/api/auth/*` 与抖音 OAuth 回调外，所有 API 都需要登录会话。接口按菜单权限校验：创作对应脚本/创建任务，任务对应任务读取，角色库对应角色/道具读写，素材库对应素材读写，发布对应抖音与发布记录；设置写操作需要 `settings` 权限，用户管理仅管理员可用。

任务状态为 `queued` / `running` / `succeeded` / `failed`。任务在进程内串行执行；重启后内存中的任务列表会丢失，但已生成的 `output/` 目录仍在。

## 输出结构

```text
output/<jobId>/
├── video.mp4        # 成片
├── poster.jpg       # 播放器封面
├── subtitles.srt    # 全片字幕
├── script.json      # 脚本与分镜关键词
├── result.json      # 每个分镜的素材/生成画面、配音、时长、字幕数量
├── segments/        # 分镜中间文件（含 ASS 字幕、背景图）
└── error.json       # 失败时记录错误
```

`result.json` 中的每个分镜带有 `source`：`material`（素材库）、`generated`（AI 生成）或 `background`（渐变背景）；图生视频的分镜额外带 `imageToVideo: true`。顶层还有 `story`、`cast`（本片使用的角色/道具）与 `warnings`（离线脚本、静音配音、画面回退等降级提示）。

## 剧本与角色一致性

- **剧本**：创作页可粘贴剧本/故事大纲（最多 6000 字），脚本模型会按剧本改编成分镜；不填时只围绕主题创作。离线模板没有理解能力，会把剧本首句带进分镜并在任务里告警提示“离线模板不改编剧本”。
- **角色库**：`cast/` 目录保存角色（`character`）与道具（`prop`）的设定和参考图，索引为 `cast/.cast.json`。名称唯一（不区分大小写），参考图支持 jpg/png/webp；直接把图片放进 `cast/` 也会自动导入（`char-` / `prop-` 前缀决定类型）。
- **一致性怎么生效**：分镜的 `cast` 字段按名称匹配角色库 → 把外观设定写进提示词（`场景/镜头/人物/道具/一致性要求`）→ 有参考图时作为图生视频输入；同一设定可跨任务复用。
- **预检**：`preflightVideoJob` 在本地检查脚本/配音密钥、AI 画面地址与路径、剧本长度、参考图是否存在、目录是否可写、ffmpeg/ffprobe 是否可用；`POST /api/videos` 入队前和流水线开始时各跑一次（媒体工具探测有缓存）。错误统一带 `【阶段】` 前缀，任务详情显示 `errorStage`。
- **降级告警**：离线脚本、静音配音、AI 画面回退都会写进任务的 `warnings`，在任务详情顶部展示，不再静默继续。

## 素材库

素材库默认是 `./materials/`，索引保存在 `.materials.json`（自动维护）。添加素材：

```bash
# 本地文件
pnpm dev materials add ./clips/city-night.mp4 --tags 城市,夜景

# 查看
pnpm dev materials list
```

素材标签来源：文件名分词（`city-night_01.mp4` → `city`、`night`、`01`）+ 自定义标签。匹配时：

1. 分镜关键词命中标签得分最高；
2. 其次匹配标题/文件名；
3. 未命中时默认生成渐变背景（`materials.allowUnmatched=true` 可改为使用任意未使用素材）。

脚本生成时会把素材库标签一起传给大模型，引导它优先选择能匹配到素材的关键词。

## 测试

```bash
pnpm typecheck
pnpm test
```

测试包含：

- 单元测试：脚本 JSON 解析/归一化（含 `scene`/`shot`/`cast`）、配置合并与设置持久化、用户存储/密码哈希/权限归一化、字幕拆屏与时间码、Edge 元数据解析、素材标签与匹配、抖音 OAuth/上传/发布（本地 mock）、HTTP 文生/图生视频提交/轮询/下载、角色库 CRUD 与自动导入、预检规则。
- 集成测试：用离线脚本 + 静音配音跑完整链路，并用 ffprobe 校验成片；启动真实 HTTP 服务，覆盖首次初始化、登录/登出、菜单权限与用户管理、静态页面、设置读写与密钥屏蔽、素材上传/Range 播放、脚本预览、任务轮询、抖音授权回调与发布、断开授权；角色库 CRUD/参考图、带剧本与角色的任务、预检拦截。
- 流水线测试覆盖 AI 生成画面、失败回退，以及剧本 + 角色参考图的图生视频请求。

集成测试需要 ffmpeg 与 CJK 字体；CI 会自动安装 `fonts-noto-cjk`。

## 已知限制与下一步

- 抖音发布依赖开放平台应用权限与审核；自动化测试使用本地 mock，未在真实账号上验证发布结果。
- AI 画面生成内置阿里百炼（DashScope）异步协议与通用 HTTP 契约；其它厂商需通过网关适配。DashScope 模式的图生视频只发首帧 `img_url`，多张角色参考图请用通用 HTTP 契约。
- 角色一致性依赖参考图与提示词，不是人脸/物体特征锁定；参考图角度差异过大时仍可能出现外观漂移。
- 素材匹配是关键词规则，不是向量语义检索；素材少时观感主要依赖渐变背景。
- 单进程串行任务，未做任务持久化/断点续跑；适合单机 MVP。
- 转场是固定的淡入淡出，暂未提供多种转场模板。
- 未配置大模型密钥时脚本来自离线模板，内容质量有限；配置 `SCRIPT_API_KEY` 后走真实模型。
- Edge TTS 依赖第三方接口，稳定性和音色受微软服务影响；可切换到 `openai` 兼容供应商。
- 账号体系是本地账号密码，不包含 SSO、邮箱验证或找回密码邮件；忘记密码需要其他管理员重置，或删除 `data/users.json` 重新初始化。
- 会话保存在进程内存，服务重启后所有用户需要重新登录；多实例部署需要改为共享会话存储。
- 网页控制台与 API 默认只监听本机；即使有账号体系，也不建议直接暴露到公网，远程访问请放在 HTTPS 反向代理之后。

## 目录结构

```text
src/
├── cli.ts                 # 命令行入口
├── pipeline.ts            # 主流程编排
├── config.ts              # 配置加载/校验
├── preflight.ts           # 调用模型前的本地预检与错误阶段
├── script/                # 脚本供应商（openai / offline）与 JSON 归一化
├── cast/                  # 角色/道具库、名称解析与分镜提示词
├── tts/                   # 配音供应商（edge / openai / silent）与时间戳估算
├── materials/             # 素材库、索引、匹配规则
├── videogen/              # 通用 HTTP 文生/图生视频供应商
├── publish/               # 抖音 OAuth、令牌与发布记录
├── media/                 # ffmpeg/ffprobe 封装、渐变背景生成
├── subtitles/             # ASS/SRT 字幕生成
├── render/                # 分镜渲染与成片拼接
├── server/                # HTTP API、任务队列、测试视频、设置/用户存储、会话鉴权
└── util/                  # 文件、文本、时间码工具
web/                       # 无构建步骤的网页控制台（原生 ES Modules）
cast/                      # 角色/道具设定与参考图（运行时数据，已 gitignore）
data/                      # 运行时数据：settings.json、users.json（已 gitignore）
```

## License

MIT

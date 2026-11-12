import { api, uploadMaterial } from "./api.js";
import { icon, hydrateIcons } from "./icons.js";

const EDGE_VOICES = [
  ["zh-CN-XiaoxiaoNeural", "晓晓 · 女声（默认）"],
  ["zh-CN-YunxiNeural", "云希 · 男声"],
  ["zh-CN-XiaoyiNeural", "晓伊 · 女声"],
  ["zh-CN-YunjianNeural", "云健 · 男声"],
  ["zh-CN-YunyangNeural", "云扬 · 男声"],
  ["zh-CN-XiaochenNeural", "晓辰 · 女声"],
  ["zh-CN-liaoning-XiaobeiNeural", "晓北 · 东北女声"],
  ["zh-CN-shaanxi-XiaoniNeural", "晓妮 · 陕西女声"],
  ["zh-HK-HiuMaanNeural", "曉曼 · 粤语女声"],
  ["zh-TW-HsiaoChenNeural", "曉臻 · 台湾女声"],
];

const TOPIC_SUGGESTIONS = [
  "城市夜景怎么拍才有电影感",
  "3 分钟学会一杯手冲咖啡",
  "新手第一次去健身房该练什么",
  "周末去海边小镇的两天一夜",
  "如何挑选一台适合自己的相机",
];

const STAGES = [
  { key: "queued", label: "排队等待" },
  { key: "script", label: "生成脚本" },
  { key: "tts", label: "合成配音" },
  { key: "visual", label: "准备画面" },
  { key: "render", label: "剪辑分镜" },
  { key: "concat", label: "拼接成片" },
  { key: "done", label: "完成" },
];

const STAGE_INDEX = {
  queued: 0,
  script: 1,
  tts: 2,
  materials: 3,
  videogen: 3,
  render: 4,
  concat: 5,
  done: 6,
};

const STATUS_TEXT = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
};

const STATUS_CLASS = {
  queued: "pill-soft",
  running: "pill-info",
  succeeded: "pill-success",
  failed: "pill-danger",
};

const state = {
  settings: null,
  jobs: [],
  job: null,
  materials: [],
  douyin: null,
  publishes: [],
  scriptPreview: null,
  createTopic: "",
  pollTimer: null,
  uploadFile: null,
  route: { name: "create" },
};

const view = document.getElementById("view");

/* ---------------- utils ---------------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(value) {
  return esc(value);
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function toast(message, type = "info") {
  const container = document.getElementById("toasts");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const iconName = type === "success" ? "check-circle" : type === "error" ? "alert" : "info";
  node.innerHTML = `${icon(iconName, 16)}<div>${esc(message)}</div>`;
  container.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    node.style.transition = "all .2s ease";
    setTimeout(() => node.remove(), 220);
  }, type === "error" ? 6000 : 4200);
}

function loadingView(text = "正在加载…") {
  return `<div class="loading-view"><span class="spinner"></span><span>${esc(text)}</span></div>`;
}

function errorView(error) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon("alert", 30)}</div>
    <h3>加载失败</h3>
    <p>${esc(error instanceof Error ? error.message : String(error))}</p>
    <button class="btn btn-primary" id="retry-btn" type="button">重新加载</button>
  </div>`;
}

function emptyState(iconName, title, text, actionHtml = "") {
  return `<div class="empty-state">
    <div class="empty-icon">${icon(iconName, 30)}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${actionHtml}
  </div>`;
}

function statusBadge(status) {
  return `<span class="pill ${STATUS_CLASS[status] ?? "pill-soft"}">${STATUS_TEXT[status] ?? status}</span>`;
}

function setPage(crumb, title) {
  document.getElementById("crumb").textContent = crumb;
  document.getElementById("page-title").textContent = title;
  document.title = `${title} · 视频创作智能体`;
}

function setActiveNav(name) {
  for (const link of document.querySelectorAll("#nav a")) {
    const active = link.dataset.nav === name;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function clearPoll() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "jobs" && parts[1]) return { name: "job", id: parts[1] };
  if (["jobs", "materials", "publish", "settings"].includes(parts[0])) return { name: parts[0] };
  return { name: "create" };
}

async function render() {
  clearPoll();
  view.oninput = null;
  view.onchange = null;
  const route = parseRoute();
  state.route = route;
  const navName = route.name === "job" ? "jobs" : route.name;
  setActiveNav(navName);
  try {
    if (route.name === "create") await renderCreate();
    else if (route.name === "jobs") await renderJobs();
    else if (route.name === "job") await renderJob(route.id);
    else if (route.name === "materials") await renderMaterials();
    else if (route.name === "publish") await renderPublish();
    else if (route.name === "settings") await renderSettings();
  } catch (error) {
    console.error(error);
    view.innerHTML = errorView(error);
    document.getElementById("retry-btn")?.addEventListener("click", () => render());
  }
}

/* ---------------- service / settings ---------------- */

async function ensureSettings(force = false) {
  if (state.settings && !force) return state.settings;
  const data = await api("/api/settings");
  state.settings = data.settings;
  updateModelPill();
  return state.settings;
}

function updateModelPill() {
  const pill = document.getElementById("model-pill");
  const settings = state.settings;
  if (!settings) {
    pill.textContent = "未连接";
    return;
  }
  const scriptLabel =
    settings.script.provider === "offline"
      ? "离线模板"
      : settings.script.provider === "auto" && !settings.script.apiKeySet
        ? "离线模板"
        : settings.script.model || "大模型";
  const ttsLabel =
    settings.tts.provider === "edge"
      ? "Edge 配音"
      : settings.tts.provider === "openai"
        ? "OpenAI 配音"
        : "静音";
  pill.textContent = `${scriptLabel} · ${ttsLabel}`;
  pill.title = `脚本：${settings.script.provider}；配音：${settings.tts.provider}`;
}

async function checkService() {
  const status = document.getElementById("service-status");
  try {
    const health = await api("/healthz");
    status.classList.remove("offline");
    status.innerHTML = `<span class="dot"></span><span>服务在线 · v${esc(health.version)}</span>`;
    return true;
  } catch {
    status.classList.add("offline");
    status.innerHTML = `<span class="dot"></span><span>服务未连接</span>`;
    return false;
  }
}

function updateJobBadge(jobs) {
  const badge = document.getElementById("nav-job-badge");
  const active = jobs.filter((job) => job.state === "queued" || job.state === "running").length;
  badge.hidden = active === 0;
  badge.textContent = String(active);
}

async function refreshJobBadge() {
  try {
    const data = await api("/api/videos");
    updateJobBadge(data.jobs ?? []);
  } catch {
    /* 忽略角标刷新失败 */
  }
}

/* ---------------- create ---------------- */

function previewEmpty() {
  return `<div class="preview-empty">
    ${icon("wand", 44)}
    <strong>还没有脚本</strong>
    <p>填写主题后点击「生成脚本预览」，可以看到标题、口播和画面关键词。</p>
  </div>`;
}

function renderPreview(data) {
  const body = document.getElementById("preview-body");
  const pill = document.getElementById("preview-provider");
  if (!body) return;
  const script = data.script;
  if (pill) {
    pill.textContent = `${script.provider === "offline" ? "离线模板" : script.provider} · ${script.segments.length} 段`;
    pill.className = "pill pill-brand";
  }
  body.innerHTML = `<div class="script-preview">
    <div class="script-head">
      <h3>${esc(script.title)}</h3>
      <p>${esc(script.summary)}</p>
      <div class="script-meta">
        <span class="pill pill-soft">目标 ${esc(data.targetDurationSec)} 秒</span>
        <span class="pill pill-soft">${esc(script.segments.length)} 个分镜</span>
      </div>
    </div>
    ${script.segments
      .map(
        (segment) => `<div class="script-segment">
          <span class="seg-index">${esc(segment.id)}</span>
          <div>
            <p class="seg-text">${esc(segment.narration)}</p>
            ${
              segment.keywords?.length
                ? `<div class="seg-tags">${segment.keywords.map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join("")}</div>`
                : ""
            }
          </div>
        </div>`,
      )
      .join("")}
    <p class="fineprint">预览和正式生成会各自调用一次模型，分镜内容可能略有差异。</p>
  </div>`;
}

async function renderCreate() {
  setPage("创作", "开始创作");
  const settings = await ensureSettings();
  if (state.route.name !== "create") return;
  const target = Number(settings.script.targetDurationSec) || 45;
  const durations = [...new Set([15, 30, 45, 60, target])].sort((a, b) => a - b);
  const segmentOptions = [...new Set([3, 4, 5, 6, Number(settings.script.maxSegments) || 6])].sort(
    (a, b) => a - b,
  );
  const videoGenReady = settings.videoGen.provider === "http";

  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">AI Video Studio</p>
      <h2>把一个主题，变成一条竖屏成片</h2>
      <p>输入主题，智能体自动生成脚本、匹配素材或 AI 画面、合成配音与字幕，并剪辑输出 9:16 成片。</p>
    </section>

    <div class="create-grid">
      <section class="card form-card">
        <div class="card-body">
          <div class="field">
            <label for="topic">视频主题</label>
            <textarea class="textarea" id="topic" maxlength="200" rows="2" placeholder="例如：3 分钟看懂城市夜景怎么拍">${esc(state.createTopic)}</textarea>
            <div class="hint-row"><span>一句话描述即可，越具体越好</span><span id="topic-count">${state.createTopic.length} / 200</span></div>
            <div class="chips" id="topic-chips">
              ${TOPIC_SUGGESTIONS.map((topic) => `<button type="button" class="chip" data-topic="${attr(topic)}">${esc(topic)}</button>`).join("")}
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <span class="field-label">目标时长</span>
              <div class="segmented" id="duration">
                ${durations
                  .map(
                    (value) =>
                      `<button type="button" data-value="${value}" class="${value === target ? "active" : ""}">${value}s</button>`,
                  )
                  .join("")}
              </div>
            </div>
            <div class="field">
              <label for="segments">分镜数量</label>
              <select class="select" id="segments">
                ${segmentOptions.map((value) => `<option value="${value}" ${value === Number(settings.script.maxSegments) ? "selected" : ""}>${value} 个分镜</option>`).join("")}
              </select>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="voice">配音音色</label>
              <input class="input" id="voice" list="voice-options" value="${attr(settings.tts.voice)}" />
              <datalist id="voice-options">
                ${EDGE_VOICES.map(([value, label]) => `<option value="${attr(value)}">${esc(label)}</option>`).join("")}
              </datalist>
              <span class="hint">${settings.tts.provider === "edge" ? "Edge TTS 中文音色，可直接输入其他音色 ID" : `当前配音供应商：${esc(settings.tts.provider)}`}</span>
            </div>
            <div class="field">
              <span class="field-label">字幕与画面</span>
              <label class="switch">
                <input type="checkbox" id="subtitles" ${settings.subtitles.enabled ? "checked" : ""} />
                <span class="track"></span>
                <span>烧录字幕</span>
              </label>
              <span class="hint">按配音时间轴自动对齐，同时导出 SRT</span>
              <label class="switch ${videoGenReady ? "" : "disabled"}" id="videogen-row" title="${videoGenReady ? "无匹配素材的分镜改用 AI 画面" : "未配置 AI 画面模型，可在设置中启用"}">
                <input type="checkbox" id="videogen" ${videoGenReady ? "checked" : "disabled"} />
                <span class="track"></span>
                <span>AI 生成画面</span>
              </label>
              <span class="hint">${videoGenReady ? `已启用 ${esc(settings.videoGen.model)}，无匹配素材时调用` : "未配置 AI 画面模型，可在设置中启用"}</span>
            </div>
          </div>

          <div class="actions">
            <button class="btn btn-ghost" id="preview-btn" type="button">${icon("wand", 16)} 生成脚本预览</button>
            <button class="btn btn-primary" id="create-btn" type="button">${icon("play", 16)} 开始生成视频</button>
          </div>
          <p class="fineprint">未配置大模型时使用离线模板；配音默认使用 Edge TTS，失败会回退静音占位。</p>
        </div>
      </section>

      <aside class="card preview-card">
        <div class="card-head">
          <div>
            <div class="card-title">脚本预览</div>
            <div class="card-sub">生成前先看看分镜和画面关键词</div>
          </div>
          <span class="pill pill-soft" id="preview-provider">待生成</span>
        </div>
        <div class="card-body" id="preview-body">${state.scriptPreview ? "" : previewEmpty()}</div>
      </aside>
    </div>`;

  if (state.scriptPreview) renderPreview(state.scriptPreview);

  const topicInput = document.getElementById("topic");
  const topicCount = document.getElementById("topic-count");
  topicInput.addEventListener("input", () => {
    state.createTopic = topicInput.value;
    topicCount.textContent = `${topicInput.value.length} / 200`;
  });

  document.getElementById("topic-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-topic]");
    if (!chip) return;
    topicInput.value = chip.dataset.topic;
    state.createTopic = topicInput.value;
    topicCount.textContent = `${topicInput.value.length} / 200`;
    topicInput.focus();
  });

  document.getElementById("duration").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    for (const item of document.querySelectorAll("#duration button")) item.classList.remove("active");
    button.classList.add("active");
  });

  document.getElementById("preview-btn").addEventListener("click", () => {
    void previewScript();
  });
  document.getElementById("create-btn").addEventListener("click", () => {
    void createVideo();
  });
}

function readCreateForm() {
  const activeDuration = document.querySelector("#duration button.active");
  const voice = document.getElementById("voice")?.value.trim() ?? "";
  return {
    topic: document.getElementById("topic")?.value.trim() ?? "",
    targetDurationSec: Number(activeDuration?.dataset.value ?? 45),
    maxSegments: Number(document.getElementById("segments")?.value ?? 6),
    voice,
    subtitlesEnabled: Boolean(document.getElementById("subtitles")?.checked),
    videoGenEnabled: Boolean(document.getElementById("videogen")?.checked),
  };
}

async function previewScript() {
  const values = readCreateForm();
  if (!values.topic) {
    toast("请先填写视频主题", "error");
    document.getElementById("topic")?.focus();
    return;
  }
  const button = document.getElementById("preview-btn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 生成中…`;
  try {
    const data = await api("/api/scripts/generate", {
      method: "POST",
      body: {
        topic: values.topic,
        targetDurationSec: values.targetDurationSec,
        maxSegments: values.maxSegments,
      },
    });
    state.scriptPreview = data;
    renderPreview(data);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("wand", 16)} 生成脚本预览`;
  }
}

async function createVideo() {
  const values = readCreateForm();
  if (!values.topic) {
    toast("请先填写视频主题", "error");
    document.getElementById("topic")?.focus();
    return;
  }
  const settings = await ensureSettings();
  const body = {
    topic: values.topic,
    targetDurationSec: values.targetDurationSec,
    maxSegments: values.maxSegments,
    subtitlesEnabled: values.subtitlesEnabled,
    videoGenEnabled: values.videoGenEnabled,
    ttsProvider: settings.tts.provider,
  };
  if (values.voice) body.voice = values.voice;
  const button = document.getElementById("create-btn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 正在创建…`;
  try {
    const job = await api("/api/videos", { method: "POST", body });
    toast("任务已创建，正在生成", "success");
    location.hash = `#/jobs/${job.id}`;
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.innerHTML = `${icon("play", 16)} 开始生成视频`;
  }
}

/* ---------------- jobs ---------------- */

function jobCard(job) {
  const percent = job.state === "succeeded" ? 100 : Number(job.progress?.percent) || 0;
  const barClass = job.state === "succeeded" ? "done" : job.state === "failed" ? "failed" : "";
  return `<a class="card job-card" href="#/jobs/${attr(job.id)}">
    <span class="job-thumb">${icon("film", 22)}</span>
    <div class="job-card-main">
      <div class="job-top">
        <span class="job-topic">${esc(job.topic)}</span>
        ${statusBadge(job.state)}
      </div>
      <div class="job-meta-row">
        <span>${formatDate(job.createdAt)}</span>
        ${job.durationSec ? `<span>${formatDuration(job.durationSec)}</span>` : ""}
        <span>${esc(job.progress?.message ?? "")}</span>
      </div>
      <div class="progress mt-8"><div class="progress-bar ${barClass}" style="width:${percent}%"></div></div>
    </div>
    <span class="job-card-side">
      <span class="muted small">${percent}%</span>
    </span>
  </a>`;
}

function jobListHtml(jobs) {
  if (!jobs.length) {
    return emptyState(
      "film",
      "还没有任务",
      "填写一个主题，生成你的第一条竖屏成片。",
      `<a class="btn btn-primary" href="#/create">${icon("plus", 16)} 开始创作</a>`,
    );
  }
  return `<div class="job-list">${jobs.map(jobCard).join("")}</div>`;
}

async function renderJobs() {
  setPage("任务", "任务列表");
  view.innerHTML = loadingView("正在读取任务…");
  const data = await api("/api/videos");
  if (state.route.name !== "jobs") return;
  const jobs = data.jobs ?? [];
  state.jobs = jobs;
  updateJobBadge(jobs);
  const active = jobs.some((job) => job.state === "queued" || job.state === "running");
  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Jobs</p>
      <h2>任务</h2>
      <p>所有生成任务都在本机执行，完成后可直接播放、下载或发布到抖音。</p>
    </section>
    <div class="row-between">
      <span class="muted small" id="job-count">共 ${jobs.length} 个任务${active ? " · 有任务正在生成" : ""}</span>
      <button class="btn btn-ghost btn-sm" id="refresh-jobs" type="button">${icon("refresh", 15)} 刷新</button>
    </div>
    <div class="mt-16" id="job-list">${jobListHtml(jobs)}</div>`;

  document.getElementById("refresh-jobs").addEventListener("click", () => {
    void refreshJobList();
  });
  if (active) {
    state.pollTimer = setInterval(() => {
      void refreshJobList();
    }, 3000);
  }
}

async function refreshJobList() {
  try {
    const data = await api("/api/videos");
    const jobs = data.jobs ?? [];
    state.jobs = jobs;
    updateJobBadge(jobs);
    const list = document.getElementById("job-list");
    if (list) list.innerHTML = jobListHtml(jobs);
    const count = document.getElementById("job-count");
    if (count) {
      const active = jobs.some((job) => job.state === "queued" || job.state === "running");
      count.textContent = `共 ${jobs.length} 个任务${active ? " · 有任务正在生成" : ""}`;
      if (!active) clearPoll();
    }
  } catch (error) {
    clearPoll();
    toast(error.message, "error");
  }
}

function progressBarHtml(job) {
  const percent = job.state === "succeeded" ? 100 : Number(job.progress?.percent) || 0;
  const barClass = job.state === "succeeded" ? "done" : job.state === "failed" ? "failed" : "";
  return `<div class="progress"><div class="progress-bar ${barClass}" id="job-progress-bar" style="width:${percent}%"></div></div>`;
}

function stagesHtml(job) {
  const current = STAGE_INDEX[job.progress?.stage] ?? 0;
  const failed = job.state === "failed";
  return STAGES.map((stage, index) => {
    let className = "";
    if (job.state === "succeeded") className = "done";
    else if (index < current) className = "done";
    else if (index === current) className = failed ? "failed" : "active";
    return `<div class="stage ${className}"><span class="stage-dot"></span><span>${stage.label}</span></div>`;
  }).join("");
}

function publishRecordsHtml(job) {
  const records = state.publishes.filter((item) => item.jobId === job.id);
  if (!records.length) return "";
  return `<div class="divider mt-12"></div>
    <div class="hint mt-8">发布记录</div>
    ${records
      .map(
        (record) => `<div class="publish-item" style="padding:10px 0">
          <span class="publish-icon">${icon("check-circle", 18)}</span>
          <div class="publish-main">
            <div class="publish-text">${esc(record.text)}</div>
            <div class="publish-meta"><span>item_id：${esc(record.itemId)}</span><span>${formatDate(record.createdAt)}</span></div>
          </div>
        </div>`,
      )
      .join("")}`;
}

function publishCardHtml(job) {
  const douyin = state.douyin;
  if (!douyin) return "";
  if (!douyin.configured) {
    return `<section class="card"><div class="card-head"><div><div class="card-title">发布到抖音</div><div class="card-sub">需要先配置开放平台应用</div></div></div>
      <div class="card-body">
        <div class="settings-note">${icon("info", 16)}<span>尚未配置抖音开放平台 client_key / client_secret。</span></div>
        <a class="btn btn-ghost btn-sm mt-12" href="#/settings">前往设置</a>
      </div></section>`;
  }
  if (!douyin.authorized) {
    return `<section class="card"><div class="card-head"><div><div class="card-title">发布到抖音</div><div class="card-sub">授权后即可把成片发布到抖音号</div></div></div>
      <div class="card-body">
        <div class="settings-note">${icon("info", 16)}<span>还没有授权抖音账号，授权令牌只保存在本机。</span></div>
        <button class="btn btn-primary btn-sm mt-12" id="connect-douyin" type="button">${icon("external", 15)} 授权抖音</button>
      </div></section>`;
  }
  return `<section class="card"><div class="card-head"><div><div class="card-title">发布到抖音</div><div class="card-sub">${esc(douyin.token?.nickname || douyin.token?.openId || "已授权")}</div></div><span class="pill pill-success">已授权</span></div>
    <div class="card-body">
      <div class="field">
        <label for="publish-text">发布文案</label>
        <textarea class="textarea" id="publish-text" maxlength="55" rows="2" placeholder="写一句发布文案">${esc(job.topic)}</textarea>
        <span class="char-count" id="publish-count">${esc(job.topic).length} / 55</span>
      </div>
      <div class="field mt-8">
        <label for="publish-cover">封面时间（秒，可选）</label>
        <input class="input" id="publish-cover" type="number" min="0" step="0.1" placeholder="例如 1.5" />
      </div>
      <button class="btn btn-primary btn-block mt-12" id="publish-btn" type="button">${icon("send", 15)} 发布到抖音</button>
      ${publishRecordsHtml(job)}
    </div></section>`;
}

function scriptSectionHtml(job) {
  if (!job.segments?.length) return "";
  return `<section class="card mt-24">
    <div class="card-head">
      <div><div class="card-title">分镜脚本</div><div class="card-sub">${esc(job.script?.title ?? job.topic)}</div></div>
      <span class="pill pill-soft">${job.segments.length} 段</span>
    </div>
    <div class="card-body">
      <div class="script-table">
        ${job.segments
          .map((segment) => {
            const visual =
              segment.source === "generated"
                ? `AI 生成画面${segment.generated?.model ? ` · ${segment.generated.model}` : ""}`
                : segment.material
                  ? `${segment.material.title}（${segment.material.type === "video" ? "视频" : "图片"}）`
                  : "渐变背景";
            return `<div class="script-row">
              <span class="num">${esc(segment.index)}</span>
              <div>
                <p class="narration">${esc(segment.narration)}</p>
                <div class="keywords">${(segment.keywords ?? []).map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join("")}</div>
              </div>
              <div class="visual">
                <strong>画面来源</strong>
                ${esc(visual)}
                <div class="material-meta">${formatDuration(segment.durationSec)}</div>
              </div>
            </div>`;
          })
          .join("")}
      </div>
    </div>
  </section>`;
}

function renderJobView() {
  const job = state.job;
  if (!job) return;
  const succeeded = job.state === "succeeded";
  const placeholderIcon = job.state === "failed" ? icon("alert", 34) : "";
  const player = succeeded && job.videoUrl
    ? `<div class="video-frame"><video controls playsinline preload="auto" ${job.posterUrl ? `poster="${attr(job.posterUrl)}"` : ""} src="${attr(job.videoUrl)}"></video></div>`
    : `<div class="video-frame"><div class="video-placeholder">
        ${job.state === "failed" ? placeholderIcon : `<span class="spinner"></span>`}
        <strong>${job.state === "failed" ? "生成失败" : STATUS_TEXT[job.state] ?? "处理中"}</strong>
        <p id="job-placeholder-message">${esc(job.progress?.message ?? "")}</p>
      </div></div>`;

  const downloads = succeeded
    ? `<section class="card"><div class="card-head"><div class="card-title">下载</div></div>
        <div class="card-body downloads">
          <a class="download-link" href="${attr(job.videoUrl)}" download><span>${icon("video", 15)} MP4 成片</span><span>${job.durationSec ? formatDuration(job.durationSec) : ""}</span></a>
          <a class="download-link" href="${attr(job.subtitlesUrl)}" download><span>${icon("book", 15)} SRT 字幕</span><span>字幕文件</span></a>
          <a class="download-link" href="${attr(job.scriptUrl)}" download><span>${icon("code", 15)} 脚本 JSON</span><span>分镜与关键词</span></a>
          <a class="download-link" href="${attr(job.resultUrl)}" download><span>${icon("layers", 15)} 结果 JSON</span><span>完整元数据</span></a>
        </div></section>`
    : "";

  view.innerHTML = `
    <a class="back-link" href="#/jobs">${icon("arrow-left", 14)} 返回任务列表</a>
    <div class="job-layout">
      <section class="card player-card">
        ${player}
        <div class="player-foot">
          <div class="meta">
            <span class="truncate" style="max-width:320px">${esc(job.topic)}</span>
            <span>${formatDate(job.createdAt)}</span>
            ${job.durationSec ? `<span>${formatDuration(job.durationSec)}</span>` : ""}
            ${job.video ? `<span>${job.video.width}×${job.video.height}</span>` : ""}
          </div>
          <a class="btn btn-ghost btn-sm" href="#/create">再做一个</a>
        </div>
      </section>

      <div class="job-side">
        <section class="card"><div class="card-body">
          <div class="status-line">
            <strong id="job-status-text">${esc(job.progress?.message ?? STATUS_TEXT[job.state] ?? "")}</strong>
            <span id="job-status-badge" class="pill ${STATUS_CLASS[job.state] ?? "pill-soft"}">${STATUS_TEXT[job.state] ?? job.state}</span>
          </div>
          <div class="mt-12">${progressBarHtml(job)}</div>
          <p class="hint mt-8" id="job-message">${esc(job.progress?.message ?? "")}</p>
          <div class="stage-list" id="job-stages">${stagesHtml(job)}</div>
          ${job.error ? `<div class="error-box mt-12">${esc(job.error)}</div>` : ""}
        </div></section>
        ${downloads}
        ${succeeded ? publishCardHtml(job) : ""}
      </div>
    </div>
    ${scriptSectionHtml(job)}`;

  document.getElementById("connect-douyin")?.addEventListener("click", () => {
    void connectDouyin();
  });
  const publishButton = document.getElementById("publish-btn");
  if (publishButton) {
    const textArea = document.getElementById("publish-text");
    const counter = document.getElementById("publish-count");
    textArea?.addEventListener("input", () => {
      if (counter) counter.textContent = `${textArea.value.length} / 55`;
    });
    publishButton.addEventListener("click", () => {
      void publishJob(job);
    });
  }
}

async function renderJob(id) {
  setPage("任务", "任务详情");
  view.innerHTML = loadingView("正在读取任务…");
  const [job, publishData, douyin] = await Promise.all([
    api(`/api/videos/${id}`),
    api(`/api/videos/${id}/publish`).catch(() => ({ publishes: [] })),
    api("/api/douyin/status").catch(() => null),
  ]);
  if (state.route.name !== "job" || state.route.id !== id) return;
  state.job = job;
  state.publishes = publishData.publishes ?? [];
  state.douyin = douyin;
  renderJobView();
  if (job.state === "queued" || job.state === "running") {
    state.pollTimer = setInterval(() => {
      void pollJob(id);
    }, 1500);
  }
}

function updateJobProgress(job) {
  const statusText = document.getElementById("job-status-text");
  if (statusText) statusText.textContent = job.progress?.message ?? STATUS_TEXT[job.state] ?? "";
  const badge = document.getElementById("job-status-badge");
  if (badge) {
    badge.className = `pill ${STATUS_CLASS[job.state] ?? "pill-soft"}`;
    badge.textContent = STATUS_TEXT[job.state] ?? job.state;
  }
  const bar = document.getElementById("job-progress-bar");
  if (bar) {
    bar.style.width = `${Number(job.progress?.percent) || 0}%`;
    bar.className = `progress-bar ${job.state === "failed" ? "failed" : ""}`;
  }
  const message = document.getElementById("job-message");
  if (message) message.textContent = job.progress?.message ?? "";
  const placeholder = document.getElementById("job-placeholder-message");
  if (placeholder) placeholder.textContent = job.progress?.message ?? "";
  const stages = document.getElementById("job-stages");
  if (stages) stages.innerHTML = stagesHtml(job);
}

async function pollJob(id) {
  try {
    const job = await api(`/api/videos/${id}`);
    if (state.route.name !== "job" || state.route.id !== id) {
      clearPoll();
      return;
    }
    state.job = job;
    if (job.state === "succeeded" || job.state === "failed") {
      clearPoll();
      const publishData = await api(`/api/videos/${id}/publish`).catch(() => ({ publishes: [] }));
      state.publishes = publishData.publishes ?? [];
      renderJobView();
      void refreshJobBadge();
      if (job.state === "succeeded") toast("成片已生成，可以播放或发布", "success");
      else toast(job.error || "任务失败", "error");
      return;
    }
    updateJobProgress(job);
  } catch (error) {
    clearPoll();
    toast(error.message, "error");
  }
}

async function publishJob(job) {
  const text = document.getElementById("publish-text")?.value.trim() ?? "";
  const coverValue = document.getElementById("publish-cover")?.value;
  if (!text) {
    toast("请填写发布文案", "error");
    return;
  }
  const body = { text };
  if (coverValue !== "" && coverValue !== undefined) {
    const seconds = Number(coverValue);
    if (!Number.isFinite(seconds) || seconds < 0) {
      toast("封面时间必须是数字", "error");
      return;
    }
    body.coverTsp = Math.round(seconds * 1000);
  }
  const button = document.getElementById("publish-btn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 发布中…`;
  try {
    const data = await api(`/api/videos/${job.id}/publish`, { method: "POST", body });
    state.publishes = [data.publish, ...state.publishes];
    toast("已发布到抖音", "success");
    renderJobView();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.innerHTML = `${icon("send", 15)} 发布到抖音`;
  }
}

/* ---------------- materials ---------------- */

function materialCard(material) {
  const preview =
    material.type === "video"
      ? `<video muted loop playsinline preload="metadata" data-hover-video src="${attr(material.url)}"></video>`
      : `<img loading="lazy" src="${attr(material.url)}" alt="${attr(material.title)}" />`;
  const meta = [
    material.width && material.height ? `${material.width}×${material.height}` : "",
    material.type === "video" && material.durationSec ? formatDuration(material.durationSec) : "",
    formatBytes(material.sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
  return `<article class="card material-card">
    <div class="material-thumb">
      ${preview}
      <span class="material-type">${material.type === "video" ? "视频" : "图片"}</span>
    </div>
    <div class="material-body">
      <div class="material-title" title="${attr(material.title)}">${esc(material.title)}</div>
      <div class="material-meta">${esc(meta)}</div>
      <div class="material-tags">
        ${(material.tags ?? []).slice(0, 5).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}
      </div>
    </div>
    <div class="material-foot">
      <span class="material-meta">${formatDate(material.addedAt)}</span>
      <button class="icon-btn" type="button" data-delete-material="${attr(material.id)}" title="删除素材">${icon("trash", 15)}</button>
    </div>
  </article>`;
}

function renderUploadCard() {
  return `<section class="card">
    <div class="card-head">
      <div><div class="card-title">上传素材</div><div class="card-sub">上传后会自动探测尺寸、时长并加入关键词匹配</div></div>
    </div>
    <div class="card-body">
      <div class="dropzone" id="dropzone">
        ${icon("upload", 28)}
        <strong id="drop-title">点击或拖拽文件到这里</strong>
        <small id="drop-hint">支持 mp4 / mov / webm / mkv 与 jpg / png / webp</small>
        <input type="file" id="file-input" accept="video/*,image/*,.mkv,.mov,.webm,.m4v,.jpg,.jpeg,.png,.webp" />
      </div>
      <div class="field-grid-2 mt-16">
        <div class="field">
          <label for="material-title">标题 <span class="optional">可选</span></label>
          <input class="input" id="material-title" maxlength="80" placeholder="例如：城市夜景空镜" />
        </div>
        <div class="field">
          <label for="material-tags">标签 <span class="optional">可选</span></label>
          <input class="input" id="material-tags" placeholder="城市,夜景（逗号分隔）" />
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary" id="upload-btn" type="button" disabled>${icon("upload", 16)} 上传素材</button>
      </div>
    </div>
  </section>`;
}

async function renderMaterials() {
  setPage("素材", "素材库");
  view.innerHTML = loadingView("正在读取素材…");
  const data = await api("/api/materials");
  if (state.route.name !== "materials") return;
  const materials = data.materials ?? [];
  state.materials = materials;
  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Materials</p>
      <h2>素材库</h2>
      <p>本地素材会按标签、标题和文件名参与分镜匹配；没有命中时默认使用渐变背景，也可以启用 AI 画面生成。</p>
    </section>
    ${renderUploadCard()}
    <div class="materials-toolbar mt-24">
      <span class="muted small">共 ${materials.length} 条素材</span>
      <a class="btn btn-ghost btn-sm" href="#/create">${icon("plus", 15)} 去创作</a>
    </div>
    ${
      materials.length
        ? `<div class="material-grid">${materials.map(materialCard).join("")}</div>`
        : emptyState("image", "素材库还是空的", "上传几段视频或图片，生成时就能自动匹配到分镜。")
    }`;

  const fileInput = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");
  const uploadButton = document.getElementById("upload-btn");
  const titleInput = document.getElementById("material-title");
  const tagsInput = document.getElementById("material-tags");
  const dropTitle = document.getElementById("drop-title");
  const dropHint = document.getElementById("drop-hint");

  function selectFile(file) {
    if (!file) return;
    state.uploadFile = file;
    dropTitle.textContent = file.name;
    dropHint.textContent = formatBytes(file.size);
    uploadButton.disabled = false;
    if (!titleInput.value.trim()) {
      titleInput.value = file.name.replace(/\.[^.]+$/, "");
    }
  }

  dropzone.addEventListener("click", (event) => {
    if (event.target === fileInput) return;
    fileInput.click();
  });
  fileInput.addEventListener("click", (event) => event.stopPropagation());
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    selectFile(event.dataTransfer?.files?.[0]);
  });
  fileInput.addEventListener("change", () => selectFile(fileInput.files?.[0]));
  uploadButton.addEventListener("click", async () => {
    if (!state.uploadFile) return;
    uploadButton.disabled = true;
    uploadButton.innerHTML = `<span class="spinner"></span> 上传中…`;
    try {
      await uploadMaterial(state.uploadFile, {
        title: titleInput.value,
        tags: tagsInput.value,
      });
      state.uploadFile = null;
      toast("素材已上传", "success");
      await renderMaterials();
    } catch (error) {
      toast(error.message, "error");
      uploadButton.disabled = false;
      uploadButton.innerHTML = `${icon("upload", 16)} 上传素材`;
    }
  });

  for (const button of view.querySelectorAll("[data-delete-material]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.deleteMaterial;
      if (!window.confirm("确定删除这条素材？")) return;
      try {
        await api(`/api/materials/${id}`, { method: "DELETE" });
        toast("素材已删除", "success");
        await renderMaterials();
      } catch (error) {
        toast(error.message, "error");
      }
    });
  }

  for (const video of view.querySelectorAll("[data-hover-video]")) {
    video.addEventListener("mouseenter", () => {
      void video.play().catch(() => undefined);
    });
    video.addEventListener("mouseleave", () => {
      video.pause();
      video.currentTime = 0;
    });
  }
}

/* ---------------- publish ---------------- */

async function connectDouyin() {
  try {
    const data = await api("/api/douyin/authorize");
    if (!data.url) throw new Error("没有拿到授权地址");
    window.location.href = data.url;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function disconnectDouyin() {
  if (!window.confirm("确定断开抖音授权？本机保存的令牌会被删除。")) return;
  try {
    await api("/api/douyin/disconnect", { method: "POST" });
    toast("已断开抖音授权", "success");
    await render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function refreshDouyin() {
  try {
    await api("/api/douyin/refresh", { method: "POST" });
    toast("授权已刷新", "success");
    await render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "success");
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

function douyinSetupHtml(douyin) {
  const redirectUri = douyin?.redirectUri || "http://127.0.0.1:8787/api/douyin/callback";
  return `<div class="mt-16">
    <div class="hint">回调地址（需在抖音开放平台登记）</div>
    <div class="code-line">
      <code>${esc(redirectUri)}</code>
      <button class="btn-link" type="button" data-copy="${attr(redirectUri)}">${icon("copy", 14)} 复制</button>
    </div>
    <ol class="setup-steps">
      <li>在抖音开放平台创建应用，申请「视频发布」相关能力，获取 client_key 与 client_secret。</li>
      <li>把上面的回调地址填入开放平台的授权回调地址。</li>
      <li>在「设置 → 抖音开放平台」保存应用信息，然后点击「授权抖音」完成扫码授权。</li>
    </ol>
  </div>`;
}

async function renderPublish() {
  setPage("发布", "发布");
  view.innerHTML = loadingView("正在读取抖音授权…");
  const [douyin, data] = await Promise.all([api("/api/douyin/status"), api("/api/publishes")]);
  if (state.route.name !== "publish") return;
  state.douyin = douyin;
  const publishes = data.publishes ?? [];
  state.publishes = publishes;

  const authorized = Boolean(douyin.authorized);
  const configured = Boolean(douyin.configured);
  const account = authorized
    ? `<div class="account">
        <div class="avatar">${douyin.token?.avatar ? `<img src="${attr(douyin.token.avatar)}" alt="" />` : esc((douyin.token?.nickname || "抖").slice(0, 1))}</div>
        <div>
          <div class="account-name">${esc(douyin.token?.nickname || "抖音账号")}</div>
          <div class="account-meta">open_id：${esc(douyin.token?.openId ?? "")}</div>
          <div class="account-meta">令牌有效期至 ${formatDate(douyin.token?.expiresAt)}${douyin.token?.expired ? "（已过期，发布时会尝试刷新）" : ""}</div>
        </div>
      </div>
      <div class="account-actions">
        <button class="btn btn-ghost btn-sm" id="refresh-douyin" type="button">${icon("refresh", 15)} 刷新授权</button>
        <button class="btn btn-danger btn-sm" id="disconnect-douyin" type="button">断开连接</button>
      </div>`
    : `<div class="settings-note mt-16">${icon("info", 16)}<span>${configured ? "应用已配置，授权后即可把成片发布到抖音号。" : "还没有配置抖音开放平台应用，请先到设置中填写应用信息。"}</span></div>
      <div class="account-actions">
        ${configured ? `<button class="btn btn-primary" id="connect-douyin" type="button">${icon("external", 15)} 授权抖音</button>` : `<a class="btn btn-primary" href="#/settings">${icon("sliders", 15)} 去配置</a>`}
      </div>`;

  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Publishing</p>
      <h2>发布到抖音</h2>
      <p>通过抖音开放平台授权后，可以把生成的成片直接发布到自己的抖音号。令牌只保存在本机。</p>
    </section>
    <div class="publish-grid">
      <section class="card account-card">
        <div class="card-head">
          <div><div class="card-title">抖音账号</div><div class="card-sub">OAuth 授权状态</div></div>
          <span class="pill ${authorized ? "pill-success" : configured ? "pill-warning" : "pill-soft"}">${authorized ? "已授权" : configured ? "待授权" : "未配置"}</span>
        </div>
        <div class="card-body">
          ${account}
          ${douyinSetupHtml(douyin)}
        </div>
      </section>
      <section class="card">
        <div class="card-head">
          <div><div class="card-title">发布记录</div><div class="card-sub">最近 ${publishes.length} 条</div></div>
        </div>
        <div class="card-body">
          ${
            publishes.length
              ? `<div class="publish-list">${publishes
                  .map(
                    (record) => `<div class="publish-item">
                      <span class="publish-icon">${icon("check-circle", 18)}</span>
                      <div class="publish-main">
                        <div class="publish-text">${esc(record.text)}</div>
                        <div class="publish-meta">
                          <span>${esc(record.topic)}</span>
                          <span>item_id：${esc(record.itemId)}</span>
                          <span>${formatDate(record.createdAt)}</span>
                        </div>
                      </div>
                    </div>`,
                  )
                  .join("")}</div>`
              : emptyState("send", "还没有发布记录", "生成成片后，在任务详情页点击「发布到抖音」。")
          }
        </div>
      </section>
    </div>`;

  document.getElementById("connect-douyin")?.addEventListener("click", () => {
    void connectDouyin();
  });
  document.getElementById("disconnect-douyin")?.addEventListener("click", () => {
    void disconnectDouyin();
  });
  document.getElementById("refresh-douyin")?.addEventListener("click", () => {
    void refreshDouyin();
  });
  for (const button of view.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () => {
      void copyText(button.dataset.copy);
    });
  }
}

/* ---------------- settings ---------------- */

function options(list, current) {
  return list
    .map(([value, label]) => `<option value="${attr(value)}" ${String(value) === String(current) ? "selected" : ""}>${esc(label)}</option>`)
    .join("");
}

function secretField(id, label, secret = {}, hintText = "") {
  const set = Boolean(secret.set);
  const placeholder = set ? `已配置（${secret.hint ?? ""}），留空保持不变` : "未配置";
  return `<div class="field">
    <label for="${id}">${label}</label>
    <input class="input" type="password" id="${id}" autocomplete="new-password" placeholder="${attr(placeholder)}" />
    <div class="row-between">
      <span class="hint">${esc(hintText || "保存在本机 data/settings.json，不会回显")}</span>
      ${set ? `<label class="switch"><input type="checkbox" id="${id}-clear" /><span class="track"></span><span>清除</span></label>` : ""}
    </div>
  </div>`;
}

function numberField(id, label, value, { min, max, step = 1, hint = "" } = {}) {
  return `<div class="field">
    <label for="${id}">${label}</label>
    <input class="input" type="number" id="${id}" value="${attr(value)}" ${min !== undefined ? `min="${min}"` : ""} ${max !== undefined ? `max="${max}"` : ""} step="${step}" />
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
  </div>`;
}

function switchField(id, label, checked, hint = "") {
  return `<label class="switch">
    <input type="checkbox" id="${id}" ${checked ? "checked" : ""} />
    <span class="track"></span>
    <span>${esc(label)}</span>
  </label>
  ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}`;
}

async function renderSettings() {
  setPage("设置", "设置");
  view.innerHTML = loadingView("正在读取设置…");
  const [settingsData, douyin] = await Promise.all([
    api("/api/settings"),
    api("/api/douyin/status").catch(() => null),
  ]);
  if (state.route.name !== "settings") return;
  const s = settingsData.settings;
  state.settings = s;
  state.douyin = douyin;
  updateModelPill();
  const redirectUri = s.douyin.effectiveRedirectUri;

  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Settings</p>
      <h2>设置</h2>
      <p>配置脚本模型、配音、AI 画面与抖音开放平台。保存后对新任务生效，正在运行的任务使用创建时的配置。</p>
    </section>

    <div class="settings-layout">
      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">脚本模型</div><div class="card-sub">生成分镜、口播和画面关键词；auto 会在有密钥时调用大模型</div></div>
          <span class="pill pill-soft">${esc(s.script.provider)}</span>
        </div>
        <div class="card-body">
          <div class="field-grid-3">
            <div class="field">
              <label for="script-provider">供应商</label>
              <select class="select" id="script-provider">
                ${options([["auto", "auto（有密钥用大模型）"], ["openai", "OpenAI 兼容接口"], ["offline", "离线模板"]], s.script.provider)}
              </select>
            </div>
            <div class="field">
              <label for="script-model">模型</label>
              <input class="input" id="script-model" value="${attr(s.script.model)}" placeholder="gpt-4o-mini" />
            </div>
            <div class="field">
              <label for="script-base-url">接口地址</label>
              <input class="input" id="script-base-url" value="${attr(s.script.baseUrl)}" placeholder="https://api.openai.com/v1" />
            </div>
          </div>
          ${secretField("script-api-key", "API Key", { set: s.script.apiKeySet, hint: s.script.apiKeyHint })}
          <div class="field-grid-3">
            ${numberField("script-temperature", "温度", s.script.temperature, { min: 0, max: 2, step: 0.1 })}
            ${numberField("script-duration", "目标时长（秒）", s.script.targetDurationSec, { min: 5, max: 600 })}
            ${numberField("script-segments", "分镜数量", s.script.maxSegments, { min: 2, max: 20 })}
          </div>
          ${switchField("script-fallback", "大模型失败时回退离线模板", s.script.fallbackToOffline)}
          <div class="test-row">
            <button class="btn btn-ghost btn-sm" type="button" data-test="script">测试脚本模型</button>
            <span class="test-result" id="test-script-result">测试使用已保存的配置</span>
          </div>
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">配音</div><div class="card-sub">Edge TTS 免费无需密钥；也支持 OpenAI 兼容语音接口</div></div>
          <span class="pill pill-soft">${esc(s.tts.provider)}</span>
        </div>
        <div class="card-body">
          <div class="field-grid-3">
            <div class="field">
              <label for="tts-provider">供应商</label>
              <select class="select" id="tts-provider">
                ${options([["edge", "Edge TTS（免费）"], ["openai", "OpenAI 兼容 /audio/speech"], ["silent", "静音占位"]], s.tts.provider)}
              </select>
            </div>
            <div class="field">
              <label for="tts-voice">音色</label>
              <input class="input" id="tts-voice" list="tts-voice-options" value="${attr(s.tts.voice)}" />
              <datalist id="tts-voice-options">
                ${EDGE_VOICES.map(([value, label]) => `<option value="${attr(value)}">${esc(label)}</option>`).join("")}
              </datalist>
            </div>
            ${numberField("tts-rate", "语速", s.tts.rate, { min: 0.5, max: 2, step: 0.1 })}
          </div>
          <div class="field-grid-3">
            <div class="field">
              <label for="tts-base-url">接口地址</label>
              <input class="input" id="tts-base-url" value="${attr(s.tts.baseUrl)}" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="field">
              <label for="tts-model">模型</label>
              <input class="input" id="tts-model" value="${attr(s.tts.model)}" placeholder="tts-1" />
            </div>
            <div class="field">
              <label for="tts-fallback">失败处理</label>
              <select class="select" id="tts-fallback">
                ${options([["silent", "回退静音占位"], ["error", "中断任务"]], s.tts.fallback)}
              </select>
            </div>
          </div>
          ${secretField("tts-api-key", "TTS API Key", { set: s.tts.apiKeySet, hint: s.tts.apiKeyHint })}
          ${switchField("tts-cache", "缓存配音结果", s.tts.cache)}
          <div class="test-row">
            <button class="btn btn-ghost btn-sm" type="button" data-test="tts">测试配音</button>
            <span class="test-result" id="test-tts-result">测试使用已保存的配置</span>
          </div>
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">AI 画面生成</div><div class="card-sub">可选：为没有素材命中的分镜调用文生视频接口</div></div>
          <span class="pill ${s.videoGen.provider === "http" ? "pill-brand" : "pill-soft"}">${s.videoGen.provider === "http" ? "已启用" : "未启用"}</span>
        </div>
        <div class="card-body">
          <div class="settings-note">${icon("info", 16)}<span>接口约定：POST {baseUrl}{submitPath} 提交 <code>{model, prompt, duration_sec, aspect_ratio}</code>，返回 video_url 或任务 id；GET {baseUrl}{pollPath}（{id} 替换为任务 ID）查询状态与 video_url。返回字段兼容 <code>{data: {...}}</code> 包裹。</span></div>
          <div class="field-grid-3">
            <div class="field">
              <label for="videogen-provider">供应商</label>
              <select class="select" id="videogen-provider">
                ${options([["none", "不使用"], ["http", "HTTP 文生视频接口"]], s.videoGen.provider)}
              </select>
            </div>
            <div class="field">
              <label for="videogen-model">模型</label>
              <input class="input" id="videogen-model" value="${attr(s.videoGen.model)}" placeholder="video-gen-1" />
            </div>
            <div class="field">
              <label for="videogen-base-url">接口地址</label>
              <input class="input" id="videogen-base-url" value="${attr(s.videoGen.baseUrl)}" placeholder="https://api.example.com" />
            </div>
          </div>
          ${secretField("videogen-api-key", "API Key", { set: s.videoGen.apiKeySet, hint: s.videoGen.apiKeyHint })}
          <div class="field-grid-2">
            <div class="field">
              <label for="videogen-submit-path">提交路径</label>
              <input class="input" id="videogen-submit-path" value="${attr(s.videoGen.submitPath)}" />
            </div>
            <div class="field">
              <label for="videogen-poll-path">查询路径模板</label>
              <input class="input" id="videogen-poll-path" value="${attr(s.videoGen.pollPath)}" />
            </div>
          </div>
          <div class="field-grid-3">
            ${numberField("videogen-poll-interval", "轮询间隔（毫秒）", s.videoGen.pollIntervalMs, { min: 200, max: 60000, step: 100 })}
            ${numberField("videogen-timeout", "超时（毫秒）", s.videoGen.timeoutMs, { min: 5000, max: 1800000, step: 1000 })}
            ${numberField("videogen-clip-duration", "单段时长（秒）", s.videoGen.clipDurationSec, { min: 2, max: 60 })}
          </div>
          ${switchField("videogen-fallback", "生成失败时回退素材库", s.videoGen.fallbackToMaterials)}
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">视频与字幕</div><div class="card-sub">输出画幅、编码与字幕样式</div></div>
        </div>
        <div class="card-body">
          <div class="field-grid-2">
            ${numberField("video-width", "宽度", s.video.width, { min: 160, max: 7680 })}
            ${numberField("video-height", "高度", s.video.height, { min: 160, max: 7680 })}
            ${numberField("video-fps", "帧率", s.video.fps, { min: 10, max: 60 })}
            ${numberField("video-crf", "CRF（越小越清晰）", s.video.crf, { min: 0, max: 51 })}
          </div>
          ${switchField("subtitles-enabled", "烧录字幕", s.subtitles.enabled)}
          <div class="field-grid-3">
            <div class="field">
              <label for="subtitle-font">字体</label>
              <input class="input" id="subtitle-font" value="${attr(s.subtitles.fontFamily)}" />
            </div>
            ${numberField("subtitle-size", "字号", s.subtitles.fontSize, { min: 12, max: 160 })}
            ${numberField("subtitle-margin", "底部边距", s.subtitles.marginV, { min: 0, max: 2000 })}
            ${numberField("subtitle-chars", "每行字数", s.subtitles.maxCharsPerLine, { min: 4, max: 60 })}
            ${numberField("subtitle-lines", "最多行数", s.subtitles.maxLines, { min: 1, max: 4 })}
          </div>
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">素材匹配</div><div class="card-sub">关键词没有命中时的兜底策略</div></div>
        </div>
        <div class="card-body">
          ${switchField("materials-unmatched", "没有关键词命中时使用任意未使用素材", s.materials.allowUnmatched, "关闭时使用渐变背景，避免硬塞无关素材")}
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">抖音开放平台</div><div class="card-sub">用于授权抖音号并发布成片</div></div>
          <span class="pill ${douyin?.authorized ? "pill-success" : douyin?.configured ? "pill-warning" : "pill-soft"}">${douyin?.authorized ? "已授权" : douyin?.configured ? "待授权" : "未配置"}</span>
        </div>
        <div class="card-body">
          <div class="field-grid-2">
            <div class="field">
              <label for="douyin-client-key">client_key</label>
              <input class="input" id="douyin-client-key" value="${attr(s.douyin.clientKey)}" placeholder="开放平台应用的 client_key" />
            </div>
            <div class="field">
              <label for="douyin-scope">scope</label>
              <input class="input" id="douyin-scope" value="${attr(s.douyin.scope)}" placeholder="user_info,video.create" />
            </div>
          </div>
          ${secretField("douyin-client-secret", "client_secret", { set: s.douyin.clientSecretSet, hint: s.douyin.clientSecretHint })}
          <div class="field-grid-2">
            <div class="field">
              <label for="douyin-redirect-uri">回调地址 <span class="optional">留空使用默认</span></label>
              <input class="input" id="douyin-redirect-uri" value="${attr(s.douyin.redirectUri)}" placeholder="${attr(redirectUri)}" />
            </div>
            <div class="field">
              <label for="douyin-api-base">接口地址</label>
              <input class="input" id="douyin-api-base" value="${attr(s.douyin.apiBaseUrl)}" />
            </div>
          </div>
          <div class="settings-note">${icon("shield", 16)}<span>当前生效回调地址：<span class="mono">${esc(redirectUri)}</span> <button class="btn-link" type="button" data-copy="${attr(redirectUri)}">${icon("copy", 13)} 复制</button>。修改后请先保存，再发起授权。令牌只保存在本机 <span class="mono">.cache/douyin-token.json</span>。</span></div>
          <div class="test-row">
            ${douyin?.configured ? `<button class="btn btn-ghost btn-sm" type="button" id="settings-connect-douyin">${icon("external", 15)} ${douyin.authorized ? "重新授权" : "授权抖音"}</button>` : ""}
            ${douyin?.authorized ? `<button class="btn btn-danger btn-sm" type="button" id="settings-disconnect-douyin">断开连接</button>` : ""}
            <span class="hint">应用信息保存后生效</span>
          </div>
        </div>
      </section>

      <div class="save-bar">
        <span class="save-state" id="save-state">修改后点击保存；新任务生效</span>
        <button class="btn btn-primary" id="save-settings" type="button">保存设置</button>
      </div>
    </div>`;

  const markDirty = () => {
    const stateEl = document.getElementById("save-state");
    if (stateEl) stateEl.textContent = "有未保存的修改";
  };
  view.oninput = markDirty;
  view.onchange = markDirty;

  document.getElementById("save-settings").addEventListener("click", () => {
    void saveSettings();
  });

  for (const button of view.querySelectorAll("[data-test]")) {
    button.addEventListener("click", () => {
      void testProvider(button.dataset.test, button);
    });
  }
  document.getElementById("settings-connect-douyin")?.addEventListener("click", () => {
    void connectDouyin();
  });
  document.getElementById("settings-disconnect-douyin")?.addEventListener("click", () => {
    void disconnectDouyin();
  });
  for (const button of view.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () => {
      void copyText(button.dataset.copy);
    });
  }
}

function collectSettings() {
  const value = (id) => document.getElementById(id)?.value ?? "";
  const number = (id) => Number(value(id));
  const checked = (id) => Boolean(document.getElementById(id)?.checked);
  const secret = (id) => {
    const clear = document.getElementById(`${id}-clear`);
    if (clear?.checked) return null;
    const raw = value(id).trim();
    return raw ? raw : undefined;
  };
  const script = {
    provider: value("script-provider"),
    model: value("script-model").trim(),
    baseUrl: value("script-base-url").trim(),
    temperature: number("script-temperature"),
    targetDurationSec: number("script-duration"),
    maxSegments: number("script-segments"),
    fallbackToOffline: checked("script-fallback"),
  };
  const scriptKey = secret("script-api-key");
  if (scriptKey !== undefined) script.apiKey = scriptKey;

  const tts = {
    provider: value("tts-provider"),
    voice: value("tts-voice").trim(),
    rate: number("tts-rate"),
    baseUrl: value("tts-base-url").trim(),
    model: value("tts-model").trim(),
    fallback: value("tts-fallback"),
    cache: checked("tts-cache"),
  };
  const ttsKey = secret("tts-api-key");
  if (ttsKey !== undefined) tts.apiKey = ttsKey;

  const videoGen = {
    provider: value("videogen-provider"),
    model: value("videogen-model").trim(),
    baseUrl: value("videogen-base-url").trim(),
    submitPath: value("videogen-submit-path").trim(),
    pollPath: value("videogen-poll-path").trim(),
    pollIntervalMs: number("videogen-poll-interval"),
    timeoutMs: number("videogen-timeout"),
    clipDurationSec: number("videogen-clip-duration"),
    fallbackToMaterials: checked("videogen-fallback"),
  };
  const videoGenKey = secret("videogen-api-key");
  if (videoGenKey !== undefined) videoGen.apiKey = videoGenKey;

  const douyin = {
    clientKey: value("douyin-client-key").trim(),
    redirectUri: value("douyin-redirect-uri").trim(),
    scope: value("douyin-scope").trim(),
    apiBaseUrl: value("douyin-api-base").trim(),
  };
  const clientSecret = secret("douyin-client-secret");
  if (clientSecret !== undefined) douyin.clientSecret = clientSecret;

  return {
    script,
    tts,
    videoGen,
    video: {
      width: number("video-width"),
      height: number("video-height"),
      fps: number("video-fps"),
      crf: number("video-crf"),
    },
    subtitles: {
      enabled: checked("subtitles-enabled"),
      fontFamily: value("subtitle-font").trim(),
      fontSize: number("subtitle-size"),
      marginV: number("subtitle-margin"),
      maxCharsPerLine: number("subtitle-chars"),
      maxLines: number("subtitle-lines"),
    },
    materials: {
      allowUnmatched: checked("materials-unmatched"),
    },
    douyin,
  };
}

async function saveSettings() {
  const button = document.getElementById("save-settings");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 保存中…`;
  try {
    const data = await api("/api/settings", { method: "PUT", body: collectSettings() });
    state.settings = data.settings;
    updateModelPill();
    toast("设置已保存", "success");
    const scrollY = window.scrollY;
    await renderSettings();
    window.scrollTo(0, scrollY);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "保存设置";
  }
}

async function testProvider(kind, button) {
  const result = document.getElementById(`test-${kind}-result`);
  button.disabled = true;
  if (result) {
    result.textContent = "测试中…";
    result.className = "test-result";
  }
  try {
    const data = await api("/api/settings/test", { method: "POST", body: { kind } });
    if (result) {
      result.textContent =
        kind === "script"
          ? `连接成功：${data.provider}，生成 ${data.segments} 个分镜`
          : `连接成功：${data.provider} / ${data.voice}，${Number(data.durationSec).toFixed(1)} 秒`;
      result.className = "test-result ok";
    }
  } catch (error) {
    if (result) {
      result.textContent = `测试失败：${error.message}`;
      result.className = "test-result fail";
    }
  } finally {
    button.disabled = false;
  }
}

/* ---------------- boot ---------------- */

function handleDouyinQuery() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("douyin");
  if (!result) return;
  if (result === "connected") {
    toast("抖音授权成功", "success");
  } else if (result === "error") {
    toast(`抖音授权失败：${params.get("message") || "未知错误"}`, "error");
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
}

async function init() {
  hydrateIcons();
  window.addEventListener("hashchange", () => {
    void render();
  });
  handleDouyinQuery();
  await checkService();
  try {
    await ensureSettings();
  } catch (error) {
    toast(error.message, "error");
  }
  void refreshJobBadge();
  await render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
} else {
  void init();
}

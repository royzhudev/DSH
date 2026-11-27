import { api, replaceCastImage, uploadCast, uploadMaterial } from "./api.js";
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
  { key: "preflight", label: "检查配置" },
  { key: "script", label: "生成脚本" },
  { key: "tts", label: "合成配音" },
  { key: "visual", label: "准备画面" },
  { key: "render", label: "剪辑分镜" },
  { key: "concat", label: "拼接成片" },
  { key: "done", label: "完成" },
];

const MENU_META = [
  { key: "create", label: "创作", desc: "生成脚本、创建视频" },
  { key: "jobs", label: "任务", desc: "查看进度、播放与下载成片" },
  { key: "cast", label: "角色库", desc: "管理角色/道具设定与参考图" },
  { key: "materials", label: "素材库", desc: "上传、预览与删除素材" },
  { key: "publish", label: "发布", desc: "抖音授权与发布记录" },
  { key: "settings", label: "设置", desc: "模型、抖音与系统配置" },
];

const MENU_KEYS = MENU_META.map((item) => item.key);

const STAGE_INDEX = {
  queued: 0,
  preflight: 1,
  script: 2,
  tts: 3,
  materials: 4,
  videogen: 4,
  render: 5,
  concat: 6,
  done: 7,
};

const CAST_KIND_LABEL = { character: "角色", prop: "道具" };

const STAGE_LABEL = Object.fromEntries(STAGES.map((stage) => [stage.key, stage.label]));

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

/** 上一次未出片的 AI 画面测试任务；再次点击时复用它，避免重复扣费。 */
let pendingVideoTest = null;
// 测试视频超时后自动继续查询，避免用户反复点、反复提交（会重复扣费）。
let videoTestAuto = { timer: 0, startedAt: 0, taskId: "" };

function stopVideoTestAuto() {
  if (videoTestAuto.timer) {
    clearTimeout(videoTestAuto.timer);
    videoTestAuto.timer = 0;
  }
}

function formatWaited(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const state = {
  user: null,
  permissions: [],
  users: [],
  booted: false,
  settings: null,
  jobs: [],
  job: null,
  materials: [],
  cast: [],
  castIds: null,
  castUploadFile: null,
  douyin: null,
  publishes: [],
  scriptPreview: null,
  previewStale: false,
  createDialogue: false,
  createTopic: "",
  createStory: "",
  pollTimer: null,
  editTimer: null,
  uploadFile: null,
  castDenied: false,
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
  if (state.editTimer) {
    clearInterval(state.editTimer);
    state.editTimer = null;
  }
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "jobs" && parts[1]) return { name: "job", id: parts[1] };
  if (["jobs", "cast", "materials", "publish", "settings"].includes(parts[0])) return { name: parts[0] };
  return { name: "create" };
}

async function render() {
  clearPoll();
  view.oninput = null;
  view.onchange = null;
  if (!state.user) return;
  const route = parseRoute();
  state.route = route;
  const menu = route.name === "job" ? "jobs" : route.name;
  if (!state.permissions.includes(menu)) {
    const first = MENU_KEYS.find((key) => state.permissions.includes(key));
    if (first) {
      if (location.hash !== `#/${first}`) location.hash = `#/${first}`;
      return;
    }
    showNoAccess();
    return;
  }
  const navName = route.name === "job" ? "jobs" : route.name;
  setActiveNav(navName);
  try {
    if (route.name === "create") await renderCreate();
    else if (route.name === "jobs") await renderJobs();
    else if (route.name === "job") await renderJob(route.id);
    else if (route.name === "cast") await renderCast();
    else if (route.name === "materials") await renderMaterials();
    else if (route.name === "publish") await renderPublish();
    else if (route.name === "settings") await renderSettings();
  } catch (error) {
    if (handleAuthError(error)) return;
    console.error(error);
    view.innerHTML = errorView(error);
    document.getElementById("retry-btn")?.addEventListener("click", () => render());
  }
}

/* ---------------- auth ---------------- */

function initialOf(name) {
  const text = String(name ?? "").trim();
  if (!text) return "?";
  return text.slice(0, 1).toUpperCase();
}

function renderAuth(mode, message = "") {
  const setup = mode === "setup";
  const screen = document.getElementById("auth-screen");
  screen.hidden = false;
  screen.innerHTML = `<div class="auth-card">
    <div class="auth-brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
        </svg>
      </span>
      <span class="brand-text"><strong>视频创作智能体</strong><small>AI VIDEO STUDIO</small></span>
    </div>
    <div class="auth-head">
      <p class="eyebrow">${setup ? "First run" : "Welcome back"}</p>
      <h1>${setup ? "创建管理员账号" : "登录工作台"}</h1>
      <p>${setup ? "首次使用需要初始化管理员。之后可在「设置 → 用户与权限」添加成员并分配菜单。" : "登录后按账号权限显示可用菜单。账号由管理员在设置中添加。"}</p>
    </div>
    <form class="auth-form" id="auth-form" data-mode="${mode}" novalidate>
      ${
        setup
          ? `<div class="field">
              <label for="auth-display">显示名称</label>
              <input class="input" id="auth-display" name="displayName" autocomplete="name" placeholder="例如 管理员" maxlength="40" />
            </div>`
          : ""
      }
      <div class="field">
        <label for="auth-username">用户名</label>
        <input class="input" id="auth-username" name="username" autocomplete="username" placeholder="输入用户名" required autofocus />
      </div>
      <div class="field">
        <label for="auth-password">密码</label>
        <input class="input" type="password" id="auth-password" name="password" autocomplete="${setup ? "new-password" : "current-password"}" placeholder="${setup ? "至少 8 位" : "输入密码"}" required />
      </div>
      ${
        setup
          ? `<div class="field">
              <label for="auth-confirm">确认密码</label>
              <input class="input" type="password" id="auth-confirm" name="confirm" autocomplete="new-password" placeholder="再次输入密码" required />
            </div>`
          : ""
      }
      <div class="auth-error" id="auth-error" ${message ? "" : "hidden"}>${esc(message)}</div>
      <button class="btn btn-primary btn-block" type="submit">${setup ? "创建并进入" : "登录"}</button>
    </form>
    <p class="auth-foot">${setup ? "账号保存在本机 data/users.json，密码仅保存加盐哈希。" : "忘记密码时，请联系管理员在设置中重置。"}</p>
  </div>`;
  hydrateIcons();
}

function bindAuthForm() {
  const form = document.getElementById("auth-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAuth(form);
  });
  form.addEventListener("input", () => {
    const error = document.getElementById("auth-error");
    if (error) error.hidden = true;
  });
}

async function submitAuth(form) {
  const mode = form.dataset.mode === "setup" ? "setup" : "login";
  const username = form.querySelector("#auth-username")?.value.trim() ?? "";
  const password = form.querySelector("#auth-password")?.value ?? "";
  const displayName = form.querySelector("#auth-display")?.value.trim() ?? "";
  const confirm = form.querySelector("#auth-confirm")?.value ?? password;
  const errorEl = document.getElementById("auth-error");
  const button = form.querySelector('button[type="submit"]');
  const fail = (text) => {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = text;
    }
    if (button) {
      button.disabled = false;
      button.textContent = mode === "setup" ? "创建并进入" : "登录";
    }
  };
  if (!username) return fail("请填写用户名");
  if (password.length < 8) return fail("密码至少需要 8 位");
  if (mode === "setup" && password !== confirm) return fail("两次输入的密码不一致");
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> ${mode === "setup" ? "正在创建…" : "登录中…"}`;
  }
  try {
    const body = mode === "setup" ? { username, displayName, password } : { username, password };
    const data = await api(`/api/auth/${mode}`, { method: "POST", body });
    state.user = data.user;
    state.permissions = data.menus ?? [];
    await startApp();
  } catch (error) {
    fail(error.message);
  }
}

function applySession() {
  const user = state.user;
  if (!user) return;
  for (const link of document.querySelectorAll("#nav a[data-nav]")) {
    link.hidden = !state.permissions.includes(link.dataset.nav);
  }
  const newVideo = document.getElementById("new-video-btn");
  if (newVideo) newVideo.hidden = !state.permissions.includes("create");
  const menu = document.getElementById("user-menu");
  if (menu) menu.hidden = false;
  const avatar = document.getElementById("user-avatar");
  if (avatar) avatar.textContent = initialOf(user.displayName || user.username);
  const name = document.getElementById("user-name");
  if (name) name.textContent = user.displayName || user.username;
  const role = document.getElementById("user-role");
  if (role) role.textContent = user.role === "admin" ? "管理员" : "成员";
}

function showAuth(mode, message = "") {
  state.user = null;
  state.permissions = [];
  state.users = [];
  state.settings = null;
  state.booted = false;
  clearPoll();
  view.innerHTML = "";
  document.body.classList.add("auth-locked");
  const menu = document.getElementById("user-menu");
  if (menu) menu.hidden = true;
  renderAuth(mode, message);
  bindAuthForm();
}

function handleAuthError(error) {
  if (error && error.status === 401) {
    if (state.user) showAuth("login", "登录已过期，请重新登录");
    return true;
  }
  return false;
}

function showNoAccess() {
  setPage("提示", "没有可用模块");
  view.innerHTML = emptyState(
    "shield",
    "没有可用模块",
    "当前账号还没有被分配任何菜单权限，请联系管理员。",
    `<button class="btn btn-primary" type="button" id="no-access-logout">退出登录</button>`,
  );
  document.getElementById("no-access-logout")?.addEventListener("click", () => {
    void logout();
  });
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* 会话可能已经过期，直接回到登录页 */
  }
  showAuth("login");
}

async function startApp() {
  view.innerHTML = loadingView("正在加载…");
  applySession();
  document.body.classList.remove("auth-locked");
  const screen = document.getElementById("auth-screen");
  if (screen) screen.hidden = true;
  if (!state.booted) {
    state.booted = true;
    await checkService();
    try {
      await ensureSettings();
    } catch (error) {
      if (handleAuthError(error)) return;
      toast(error.message, "error");
    }
    void refreshJobBadge();
  }
  await render();
}

/* ---------------- service / settings ---------------- */

async function ensureSettings(force = false) {
  if (state.settings && !force) return state.settings;
  const data = await api("/api/settings");
  state.settings = data.settings;
  updateModelPill();
  return state.settings;
}

const voiceCatalogCache = new Map();

/** 拉取当前配音供应商/模型的音色列表；失败时退回 Edge 常用音色，保证输入框仍能用。 */
async function loadVoiceCatalog(force = false, provider, model) {
  // 没有显式指定时，跟随设置里保存的供应商/模型，避免沿用页面打开前的旧缓存。
  if (!provider && state.settings?.tts?.provider) {
    provider = state.settings.tts.provider;
    model = state.settings.tts.model;
  }
  const key = `${provider ?? ""}|${model ?? ""}`;
  if (!force && voiceCatalogCache.has(key)) return voiceCatalogCache.get(key);
  const query = new URLSearchParams();
  if (provider) query.set("provider", provider);
  if (model) query.set("model", model);
  const suffix = query.toString() ? `?${query}` : "";
  try {
    const data = await api(`/api/tts/voices${suffix}`);
    const catalog = data.catalog;
    voiceCatalogCache.set(key, catalog);
    return catalog;
  } catch {
    const fallback = {
      provider: provider ?? "edge",
      model: model ?? "",
      allowCustom: true,
      hint: "读取音色列表失败，可手动输入音色 ID。",
      voices: EDGE_VOICES.map(([value, label]) => ({ value, label })),
    };
    return fallback;
  }
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
  if (!state.permissions.includes("jobs")) return;
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

const REVIEW_LEVEL_MARK = { ok: "✓", warn: "!", todo: "–" };
const REVIEW_STAGE_NAME = { plan: "策划", script: "剧本", storyboard: "分镜", assets: "素材", publish: "发布" };

function renderCreationReview(review) {
  if (!review || !Array.isArray(review.items) || review.items.length === 0) return "";
  const items = review.items
    .map(
      (item) => `<li class="review-item review-${esc(item.level)}">
        <span class="review-mark" aria-hidden="true">${REVIEW_LEVEL_MARK[item.level] ?? "·"}</span>
        <div>
          <p class="review-title">${esc(item.title)}<span class="review-stage">${esc(REVIEW_STAGE_NAME[item.stage] ?? item.stage)}</span></p>
          <p class="review-detail">${esc(item.detail)}</p>
        </div>
      </li>`,
    )
    .join("");
  return `<div class="review-block">
    <div class="review-head">
      <span class="review-score">品控 ${esc(review.score)} 分</span>
      <span class="hint">本地检查，不调用模型、不产生费用</span>
    </div>
    <ul class="review-list">${items}</ul>
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
    <p class="preview-edit-hint">${icon("wand", 14)} 下面的标题、摘要、旁白/台词、场景、镜头和关键词都可以直接点击修改；开始生成视频会按修改后的脚本执行。</p>
    <div class="script-head">
      <input class="input script-edit-input" data-preview="title" value="${attr(script.title)}" maxlength="80" aria-label="脚本标题" />
      <textarea class="input script-edit-area" data-preview="summary" rows="2" maxlength="300" aria-label="脚本摘要">${esc(script.summary)}</textarea>
      <div class="script-meta">
        <span class="pill pill-soft">目标 ${esc(data.targetDurationSec)} 秒</span>
        <span class="pill pill-soft">${esc(script.segments.length)} 个分镜</span>
        ${(data.cast ?? []).length ? `<span class="pill pill-soft">${esc(data.cast.length)} 个角色/道具</span>` : ""}
        <span class="pill pill-brand">可直接修改</span>
      </div>
    </div>
    ${script.segments
      .map(
        (segment, index) => `<div class="script-segment" data-seg="${index}">
          <span class="seg-index">${esc(segment.id)}</span>
          <div class="script-edit-main">
            ${
              (segment.lines ?? []).length
                ? `<div class="seg-lines-edit">${segment.lines
                    .map(
                      (line, lineIndex) => `<div class="seg-line-edit" data-line="${lineIndex}">
                        <input class="input seg-speaker-input" data-preview="line-speaker" data-seg="${index}" data-line="${lineIndex}" value="${attr(line.speaker)}" maxlength="24" aria-label="说话人" />
                        <input class="input" data-preview="line-text" data-seg="${index}" data-line="${lineIndex}" value="${attr(line.text)}" maxlength="300" aria-label="台词" />
                      </div>`,
                    )
                    .join("")}</div>`
                : `<textarea class="input script-edit-area" data-preview="narration" data-seg="${index}" rows="3" maxlength="800" aria-label="分镜旁白">${esc(segment.narration)}</textarea>`
            }
            <div class="seg-edit-row">
              <input class="input" data-preview="scene" data-seg="${index}" value="${attr(segment.scene ?? "")}" placeholder="场景：地点/时间/光线" maxlength="300" aria-label="场景" />
              <input class="input" data-preview="shot" data-seg="${index}" value="${attr(segment.shot ?? "")}" placeholder="镜头：景别/动作/构图" maxlength="300" aria-label="镜头" />
            </div>
            <input class="input" data-preview="keywords" data-seg="${index}" value="${attr((segment.keywords ?? []).join("、"))}" placeholder="画面关键词，用、或逗号分隔" maxlength="300" aria-label="画面关键词" />
            ${
              (segment.cast ?? []).length
                ? `<div class="seg-tags">${segment.cast.map((name) => `<span class="tag tag-brand">${esc(name)}</span>`).join("")}</div>`
                : ""
            }
          </div>
        </div>`,
      )
      .join("")}
    ${renderCreationReview(data.review)}
    <p class="fineprint">标题、摘要、旁白/台词、场景、镜头和画面关键词都可以直接改；点「开始生成视频」会按改后的脚本成片，不再重新生成剧本。修改后这里显示的品控评分仍是原生成结果。</p>
  </div>`;
}

/** 把预览里的手工修改同步回 state，生成视频时随任务一起提交。 */
/** 主题改了以后，右侧预览就不再对应当前主题；明确提示并暂时禁止开拍，避免成片和预览对不上。 */
function setPreviewStale(stale) {
  state.previewStale = stale;
  const note = document.getElementById("preview-stale");
  if (note) note.hidden = !stale;
  const button = document.getElementById("create-btn");
  if (button && !button.dataset.busy) button.disabled = stale;
}

function updatePreviewFromInput(input) {
  const preview = state.scriptPreview;
  if (!preview?.script) return;
  const field = input.dataset.preview;
  const segmentIndex = input.dataset.seg === undefined ? -1 : Number(input.dataset.seg);
  if (field === "title") preview.script.title = input.value;
  else if (field === "summary") preview.script.summary = input.value;
  else if (segmentIndex >= 0) {
    const segment = preview.script.segments[segmentIndex];
    if (!segment) return;
    if (field === "narration") segment.narration = input.value;
    else if (field === "scene") segment.scene = input.value;
    else if (field === "shot") segment.shot = input.value;
    else if (field === "keywords") {
      segment.keywords = input.value
        .split(/[、,，\s]+/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    } else if (field === "line-speaker" || field === "line-text") {
      const line = segment.lines?.[Number(input.dataset.line)];
      if (!line) return;
      if (field === "line-speaker") line.speaker = input.value;
      else line.text = input.value;
      segment.narration = segment.lines.map((item) => `${item.speaker}：${item.text}`).join("");
    }
  }
  preview.edited = true;
}

function castPickerHtml(cast, denied = false) {
  if (denied) {
    return `<div class="settings-note">${icon("info", 16)}<span>当前账号没有「角色库」菜单权限，本片会使用角色库中已保存的全部设定；需要挑选出场角色时请联系管理员开通权限。</span></div>`;
  }
  if (!cast.length) {
    return `<div class="settings-note">${icon("info", 16)}<span>角色库还没有设定。先在「角色库」上传人物或道具的参考图和外观描述，生成时会自动保持跨镜头一致。</span><a class="btn-link" href="#/cast">去添加</a></div>`;
  }
  const selected = new Set(state.castIds ?? cast.map((asset) => asset.id));
  return `<div class="cast-picker" id="cast-picker">
    ${cast
      .map(
        (asset) => `<button class="cast-chip ${selected.has(asset.id) ? "active" : ""}" type="button" data-cast-id="${attr(asset.id)}" aria-pressed="${selected.has(asset.id)}">
          <span class="cast-chip-thumb">${asset.imageUrl ? `<img src="${attr(asset.imageUrl)}" alt="" loading="lazy" />` : icon(asset.kind === "character" ? "users" : "box", 16)}</span>
          <span class="cast-chip-main"><strong>${esc(asset.name)}</strong><small>${esc(CAST_KIND_LABEL[asset.kind] ?? asset.kind)}${asset.imageFile ? " · 有参考图" : ""}</small></span>
        </button>`,
      )
      .join("")}
  </div>
  <div class="hint-row">
    <span>选中的角色/道具会参与分镜编排；有参考图的分镜会用图生视频延续形象</span>
    <span class="cast-picker-actions">
      <button class="btn-link" type="button" id="cast-select-all">全选</button>
      <button class="btn-link" type="button" id="cast-select-none">清空</button>
    </span>
  </div>`;
}

function updateCastPickerSelection() {
  const cast = state.cast ?? [];
  const selected = new Set(state.castIds ?? cast.map((asset) => asset.id));
  for (const chip of document.querySelectorAll("#cast-picker [data-cast-id]")) {
    const active = selected.has(chip.dataset.castId);
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
}

async function renderCreate() {
  setPage("创作", "开始创作");
  const settings = await ensureSettings();
  let cast = [];
  let castDenied = false;
  try {
    cast = (await api("/api/cast")).cast ?? [];
  } catch (error) {
    // 没有角色库权限时仍然可以创作，服务端会使用全部角色设定。
    castDenied = error.status === 403;
  }
  if (state.route.name !== "create") return;
  state.cast = cast;
  state.castDenied = castDenied;
  if (state.castIds === null) {
    state.castIds = cast.map((asset) => asset.id);
  } else {
    // 角色可能已在别的页面被删除，避免提交时带着失效 id。
    const known = new Set(cast.map((asset) => asset.id));
    state.castIds = state.castIds.filter((id) => known.has(id));
  }
  const target = 15;
  const durations = [15, 30, 45, 60, 90, 120];
  const segmentOptions = [...new Set([1, 3, 4, 5, 6, Number(settings.script.maxSegments) || 6])].sort(
    (a, b) => a - b,
  );
  const videoGenReady = settings.videoGen.provider === "http";
  const castWithImages = cast.filter((asset) => asset.imageFile).length;
  const voiceCatalog = await loadVoiceCatalog(
    true,
    settings.tts.provider,
    settings.tts.model,
  );

  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">AI Video Studio</p>
      <h2>把一个主题或剧本，变成一条竖屏短剧</h2>
      <p>输入主题或粘贴剧本，智能体生成分镜、匹配素材或 AI 画面、合成配音与字幕；角色与道具会在后续镜头里保持同一形象。</p>
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

          <div class="field">
            <label for="story">剧本 / 大纲 <span class="optional">可选</span></label>
            <textarea class="textarea" id="story" maxlength="6000" rows="5" placeholder="粘贴剧本或故事大纲，例如：
林小满在老城区开了一家钟表店，某天一位客人送来一块旧怀表……">${esc(state.createStory)}</textarea>
            <div class="hint-row"><span>填写后分镜会严格按剧本改编；不填则只围绕主题创作</span><span id="story-count">${state.createStory.length} / 6000</span></div>
          </div>

          <div class="field">
            <span class="field-label">角色与道具</span>
            ${castPickerHtml(cast, castDenied)}
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
                ${segmentOptions.map((value) => `<option value="${value}" ${value === Number(settings.script.maxSegments) ? "selected" : ""}>${value === 1 ? "1 个分镜（一镜到底）" : `${value} 个分镜`}</option>`).join("")}
              </select>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="voice">配音音色</label>
              <input class="input" id="voice" list="voice-options" value="${attr(settings.tts.voice)}" />
              <datalist id="voice-options">
                ${voiceCatalog.voices.map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`).join("")}
              </datalist>
              <span class="hint">${esc(voiceCatalog.hint)}</span>
            </div>
            <div class="field">
              <span class="field-label">字幕与画面</span>
              <label class="switch">
                <input type="checkbox" id="subtitles" ${settings.subtitles.enabled ? "checked" : ""} />
                <span class="track"></span>
                <span>烧录字幕</span>
              </label>
              <span class="hint">按配音时间轴自动对齐，同时导出 SRT</span>
              <label class="switch ${videoGenReady ? "" : "disabled"}" id="videogen-row" title="${videoGenReady ? "有角色参考图的分镜使用图生视频，其余分镜文生视频" : "未配置 AI 画面模型，可在设置中启用"}">
                <input type="checkbox" id="videogen" ${videoGenReady ? "checked" : "disabled"} />
                <span class="track"></span>
                <span>AI 生成画面</span>
              </label>
              <span class="hint">${videoGenReady ? `${esc(settings.videoGen.model)}${castWithImages > 0 ? ` · ${castWithImages} 个角色/道具可图生视频` : " · 有参考图时自动图生视频"}` : "未配置 AI 画面模型，可在设置中启用"}</span>
              <label class="switch">
                <input type="checkbox" id="dialogue" ${state.createDialogue ? "checked" : ""} />
                <span class="track"></span>
                <span>人物对话（多音色）</span>
              </label>
              <span class="hint">分镜写成“角色：台词”，每个角色用自己的音色；关闭则用第三人称旁白讲解。角色音色可在「角色与道具」里设置，未设置会自动分配。${settings.lipsync.enabled && settings.lipsync.provider === "dashscope" ? "成片会调用百炼 VideoRetalk 对齐口型（按秒计费）。" : "需要口型对齐时在设置里启用口型同步。"}</span>
            </div>
          </div>

          <div class="actions">
            <button class="btn btn-ghost" id="preview-btn" type="button">${icon("wand", 16)} 生成脚本预览</button>
            <button class="btn btn-primary" id="create-btn" type="button">${icon("play", 16)} 开始生成视频</button>
          </div>
          <p class="fineprint">创建前会先检查配置、参考图与运行环境；有问题会立即提示，不会先调用模型产生费用。未配置大模型时使用离线模板。</p>

          <details class="flow-guide">
            <summary>短剧制作流程：平台做什么、你还要做什么</summary>
            <ul class="flow-list">
              <li><span class="flow-stage">策划</span><span class="flow-badge flow-self">自己做</span><span>选题、受众、商业模式与合规预审：平台只能辅助给方向，判断能不能火要靠你。</span></li>
              <li><span class="flow-stage">剧本</span><span class="flow-badge flow-assist">需人工</span><span>平台生成大纲与分镜初稿；反转、节奏、每集结尾钩子必须人工打磨。</span></li>
              <li><span class="flow-stage">分镜</span><span class="flow-badge flow-platform">平台承接</span><span>自动拆分镜并写画面提示词；支持改单镜提示词、场景与景别。</span></li>
              <li><span class="flow-stage">素材</span><span class="flow-badge flow-platform">平台承接</span><span>人设锁定、图生视频、配音、字幕、BGM：角色卡保证跨镜头同一形象。</span></li>
              <li><span class="flow-stage">成片</span><span class="flow-badge flow-platform">平台承接</span><span>自动拼接、对齐音画、加字幕转场并导出竖屏成片；节奏仍需人工微调。</span></li>
              <li><span class="flow-stage">发布</span><span class="flow-badge flow-self">自己做</span><span>备案、版权与素材商用授权、封面标题、投流与数据复盘：平台不承接。</span></li>
            </ul>
            <p class="fineprint">生成脚本预览后，右侧会给出“创作品控”检查：钩子、台词长度、景别、节奏、人物一致性。</p>
          </details>
        </div>
      </section>

      <aside class="card preview-card">
        <div class="card-head">
          <div>
            <div class="card-title">脚本预览</div>
            <div class="card-sub">生成前先看看分镜、出场角色与画面关键词</div>
          </div>
          <span class="pill pill-soft" id="preview-provider">待生成</span>
        </div>
        <div class="hint preview-stale" id="preview-stale" hidden>主题已修改，右侧脚本对应的是旧主题。请重新生成脚本预览，或把主题改回去再生成视频。</div>
        <div class="card-body" id="preview-body">${state.scriptPreview ? "" : previewEmpty()}</div>
      </aside>
    </div>`;

  if (state.scriptPreview) renderPreview(state.scriptPreview);

  const topicInput = document.getElementById("topic");
  const topicCount = document.getElementById("topic-count");
  topicInput.addEventListener("input", () => {
    state.createTopic = topicInput.value;
    setPreviewStale(Boolean(state.scriptPreview) && state.scriptPreview.topic !== topicInput.value.trim());
    topicCount.textContent = `${topicInput.value.length} / 200`;
  });

  const storyInput = document.getElementById("story");
  const storyCount = document.getElementById("story-count");
  storyInput.addEventListener("input", () => {
    state.createStory = storyInput.value;
    storyCount.textContent = `${storyInput.value.length} / 6000`;
  });

  document.getElementById("dialogue").addEventListener("change", (event) => {
    state.createDialogue = Boolean(event.target.checked);
  });

  document.getElementById("topic-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-topic]");
    if (!chip) return;
    topicInput.value = chip.dataset.topic;
    state.createTopic = topicInput.value;
    topicCount.textContent = `${topicInput.value.length} / 200`;
    topicInput.focus();
  });

  document.getElementById("cast-picker")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-cast-id]");
    if (!chip) return;
    const selected = new Set(state.castIds ?? []);
    const id = chip.dataset.castId;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    state.castIds = [...selected];
    updateCastPickerSelection();
  });
  document.getElementById("cast-select-all")?.addEventListener("click", () => {
    state.castIds = (state.cast ?? []).map((asset) => asset.id);
    updateCastPickerSelection();
  });
  document.getElementById("cast-select-none")?.addEventListener("click", () => {
    state.castIds = [];
    updateCastPickerSelection();
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
    story: document.getElementById("story")?.value.trim() ?? "",
    castIds: state.castDenied ? undefined : (state.castIds ?? []),
    targetDurationSec: Number(activeDuration?.dataset.value ?? 15),
    maxSegments: Number(document.getElementById("segments")?.value ?? 6),
    voice,
    subtitlesEnabled: Boolean(document.getElementById("subtitles")?.checked),
    videoGenEnabled: Boolean(document.getElementById("videogen")?.checked),
    dialogue: Boolean(document.getElementById("dialogue")?.checked),
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
        story: values.story || undefined,
        castIds: values.castIds,
        targetDurationSec: values.targetDurationSec,
        maxSegments: values.maxSegments,
        ...(values.dialogue ? { dialogue: true } : {}),
      },
    });
    state.scriptPreview = { ...data, topic: values.topic, edited: false };
    setPreviewStale(false);
    renderPreview(state.scriptPreview);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("wand", 16)} 生成脚本预览`;
  }
}

async function createVideo() {
  const values = readCreateForm();
  if (state.previewStale) {
    toast("主题已修改，请重新生成脚本预览后再开始生成", "error");
    return;
  }
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
    ...(values.castIds ? { castIds: values.castIds } : {}),
    ...(values.dialogue ? { dialogue: true } : {}),
  };
  if (values.story) body.story = values.story;
  if (values.voice) body.voice = values.voice;
  // 只有预览对应的主题没变时才带上编辑过的脚本，避免改了主题还按旧脚本成片。
  if (state.scriptPreview?.script && state.scriptPreview.topic === values.topic) {
    body.script = state.scriptPreview.script;
  }
  const button = document.getElementById("create-btn");
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 正在检查并创建…`;
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

function miniappPublishCardHtml(job) {
  const douyin = state.douyin;
  return `<section class="card"><div class="card-head"><div><div class="card-title">发布到抖音</div><div class="card-sub">个人号小程序投稿，发布前手动确认</div></div><span class="pill pill-warning">人工确认</span></div>
    <div class="card-body">
      ${douyin.publicBaseUrlSet ? "" : `<div class="settings-note">${icon("alert", 16)}<span>还没有配置 https 公网素材地址，暂时不能生成下载二维码。可以先把成片下载到手机相册，再在小程序里选择视频。</span></div>`}
      <div class="hint">先在手机上下载成片，再打开已开通「短视频自主挂载」的个人主体小程序，选择相册里的成片并确认发布。小程序会用抖音官方发布器拉起投稿页，不经过服务端静默发布。</div>
      ${douyin.publicBaseUrlSet ? `<button class="btn btn-primary btn-block mt-12" id="miniapp-publish-btn" type="button">${icon("qrcode", 15)} 生成手机下载二维码</button>` : `<a class="btn btn-primary btn-block mt-12" href="/api/videos/${attr(job.id)}/video" download>${icon("download", 15)} 下载成片</a>`}
      <div id="miniapp-publish-result"></div>
      <div class="hint mt-8">发布结果只在抖音 App 内确认，网页不会自动显示已发布；500+ 粉等资格以抖音开放平台当前审核为准。</div>
    </div></section>`;
}

function publishCardHtml(job) {
  const douyin = state.douyin;
  if (!douyin) return "";
  if (douyin.mode === "miniapp") return miniappPublishCardHtml(job);
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

function segmentEditStatusHtml(job) {
  const edit = job.edit;
  if (!edit) return "";
  if (edit.status === "running") {
    return `<div class="segment-edit-status running" id="segment-edit-status">${icon("wand", 15)}<span>正在局部修改分镜 ${esc(edit.segmentIndex)}：${esc(edit.prompt)}。完成后成片和播放器会自动刷新，请不要关闭页面。</span></div>`;
  }
  if (edit.status === "failed") {
    return `<div class="segment-edit-status failed" id="segment-edit-status">${icon("alert", 15)}<span>分镜 ${esc(edit.segmentIndex)} 局部修改失败：${esc(edit.error ?? "未知错误")}。可以修改描述后重试。</span></div>`;
  }
  return `<div class="segment-edit-status" id="segment-edit-status">${icon("check", 15)}<span>分镜 ${esc(edit.segmentIndex)} 已局部修改：${esc(edit.prompt)}。成片已重新拼接，原台词音轨保持不变。</span></div>`;
}

function segmentEditDialogHtml() {
  return `<dialog class="user-dialog" id="segment-edit-dialog">
    <form id="segment-edit-form" novalidate>
      <div class="dialog-head">
        <div>
          <div class="card-title">局部修改分镜</div>
          <div class="card-sub" id="segment-edit-sub">用一句话说明要改哪里，画面模型只重绘这一镜</div>
        </div>
        <button class="icon-btn" type="button" id="close-segment-edit-dialog" aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="dialog-body">
        <input type="hidden" id="segment-edit-index" value="" />
        <div class="field">
          <label for="segment-edit-prompt">修改要求</label>
          <textarea class="textarea" id="segment-edit-prompt" rows="4" maxlength="2000" placeholder="例如：编辑视频，把男生手里的纸杯换成红色礼盒；保持人物、动作和镜头不变"></textarea>
          <span class="hint">支持增删元素、替换服装/道具、改背景或风格。写清「改什么、保留什么」效果更稳；单镜需 2–10 秒。</span>
        </div>
        <div class="settings-note">${icon("info", 16)}<span>编辑只改画面，原分镜的台词音轨和字幕时间轴会保留；成片会自动重新拼接。光影或文字区域改动过大时可能出现轻微伪影。模型处理通常需要几分钟，请留在本页等待。</span></div>
        <div class="dialog-error" id="segment-edit-error" hidden></div>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" id="cancel-segment-edit">取消</button>
        <button class="btn btn-primary" type="submit" id="save-segment-edit">${icon("wand", 15)} 开始修改</button>
      </div>
    </form>
  </dialog>`;
}

function scriptSectionHtml(job) {
  if (!job.segments?.length) return "";
  const cast = job.cast ?? [];
  // 局部修改依赖百炼视频编辑模型；Seedance 聚合渠道下按钮不可用，避免点了才报错。
  const videoChannel = state.settings?.videoGenChannels?.find(
    (item) => item.channel === state.settings?.videoGen?.channel,
  );
  const videoEditReady = videoChannel
    ? videoChannel.editSupported
    : state.settings?.videoGen?.channel !== "aggregator-seedance2" &&
        state.settings?.videoGen?.channel !== "airongce-seedance";
  return `<section class="card mt-24">
    <div class="card-head">
      <div><div class="card-title">分镜脚本</div><div class="card-sub">${esc(job.script?.title ?? job.topic)}</div></div>
      <span class="pill pill-soft">${job.segments.length} 段</span>
    </div>
    <div class="card-body">
      ${
        cast.length
          ? `<div class="cast-summary">
              <span class="muted small">本片角色/道具</span>
              ${cast
                .map(
                  (asset) => `<span class="tag tag-brand">${esc(asset.name)} · ${esc(CAST_KIND_LABEL[asset.kind] ?? asset.kind)}${asset.imageFile ? " · 有参考图" : ""}</span>`,
                )
                .join("")}
            </div>`
          : ""
      }
      ${segmentEditStatusHtml(job)}
      <div class="script-table">
        ${job.segments
          .map((segment) => {
            const visual =
              segment.source === "generated"
                ? `AI 生成画面${segment.imageToVideo ? "（图生视频）" : ""}${segment.generated?.model ? ` · ${segment.generated.model}` : ""}`
                : segment.material
                  ? `${segment.material.title}（${segment.material.type === "video" ? "视频" : "图片"}）`
                  : "渐变背景";
            return `<div class="script-row">
              <span class="num">${esc(segment.index)}</span>
              <div>
                <p class="narration">${esc(segment.narration)}</p>
                ${segment.scene || segment.shot ? `<p class="seg-shot">${[segment.scene, segment.shot].filter(Boolean).map((text) => esc(text)).join(" · ")}</p>` : ""}
                ${
                  (segment.cast ?? []).length
                    ? `<div class="keywords">${segment.cast.map((item) => `<span class="tag tag-brand">${esc(item.name)}</span>`).join("")}</div>`
                    : ""
                }
                <div class="keywords">${(segment.keywords ?? []).map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join("")}</div>
              </div>
              <div class="visual">
                <strong>画面来源</strong>
                ${esc(visual)}
                ${segment.edited ? `<div><span class="pill pill-brand">已局部修改</span></div>` : ""}
                <div class="material-meta">${formatDuration(segment.durationSec)}</div>
                ${
                  job.state === "succeeded" && segment.renderedFile && videoEditReady
                    ? `<button class="btn btn-ghost btn-sm segment-edit-btn mt-8" type="button" data-seg="${esc(segment.index)}" ${job.edit?.status === "running" ? "disabled" : ""}>${icon("wand", 14)} 局部修改</button>`
                    : ""
                }
              </div>
            </div>`;
          })
          .join("")}
      </div>
    </div>
  </section>`;
}

function warningsHtml(job) {
  const warnings = job.warnings ?? [];
  if (!warnings.length) return "";
  return `<div class="warning-box mt-12">
    <div class="warning-head">${icon("alert", 15)}<strong>生成过程中有以下问题，请确认是否符合预期</strong></div>
    <ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
  </div>`;
}

function jobErrorHtml(job) {
  if (!job.error) return "";
  const stage = job.errorStage ? STAGE_LABEL[job.errorStage] : "";
  return `<div class="error-box mt-12">
    ${stage ? `<strong>失败于：${esc(stage)}</strong><br />` : ""}
    ${esc(job.error)}
  </div>`;
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
          ${jobErrorHtml(job)}
          ${warningsHtml(job)}
        </div></section>
        ${downloads}
        ${succeeded ? publishCardHtml(job) : ""}
      </div>
    </div>
    ${scriptSectionHtml(job)}
    ${succeeded ? segmentEditDialogHtml() : ""}`;

  document.querySelectorAll(".segment-edit-btn").forEach((button) => {
    button.addEventListener("click", () => {
      openSegmentEdit(job, Number(button.dataset.seg));
    });
  });
  document.getElementById("close-segment-edit-dialog")?.addEventListener("click", closeSegmentEdit);
  document.getElementById("cancel-segment-edit")?.addEventListener("click", closeSegmentEdit);
  const editForm = document.getElementById("segment-edit-form");
  editForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitSegmentEdit(job);
  });
  if (job.edit?.status === "running") startEditPolling(job.id);

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
  const miniappPublishButton = document.getElementById("miniapp-publish-btn");
  if (miniappPublishButton) {
    miniappPublishButton.addEventListener("click", () => {
      void createMiniappShare(job);
    });
  }
}

function openSegmentEdit(job, index) {
  const segment = job.segments?.find((item) => Number(item.index) === index);
  const dialog = document.getElementById("segment-edit-dialog");
  if (!segment || !dialog) return;
  document.getElementById("segment-edit-index").value = String(index);
  document.getElementById("segment-edit-prompt").value = "";
  const sub = document.getElementById("segment-edit-sub");
  if (sub) sub.textContent = `分镜 ${index} · ${segment.narration || "无旁白"}`;
  const error = document.getElementById("segment-edit-error");
  if (error) error.hidden = true;
  dialog.showModal();
  document.getElementById("segment-edit-prompt")?.focus();
}

function closeSegmentEdit() {
  document.getElementById("segment-edit-dialog")?.close();
}

async function submitSegmentEdit(job) {
  const index = Number(document.getElementById("segment-edit-index")?.value);
  const prompt = document.getElementById("segment-edit-prompt")?.value.trim() ?? "";
  const error = document.getElementById("segment-edit-error");
  if (error) error.hidden = true;
  if (!prompt) {
    if (error) {
      error.textContent = "请填写要修改的内容";
      error.hidden = false;
    }
    return;
  }
  const button = document.getElementById("save-segment-edit");
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> 提交中…`;
  }
  try {
    const updated = await api(`/api/videos/${job.id}/edit`, {
      method: "POST",
      body: { segmentIndex: index, prompt },
    });
    state.job = updated;
    closeSegmentEdit();
    renderJobView();
    startEditPolling(job.id);
    toast("已提交局部修改，正在重绘这一镜", "success");
  } catch (err) {
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("wand", 15)} 开始修改`;
    }
  }
}

function startEditPolling(id) {
  if (state.editTimer) clearInterval(state.editTimer);
  state.editTimer = setInterval(() => {
    void pollEdit(id);
  }, 2500);
}

async function pollEdit(id) {
  try {
    const job = await api(`/api/videos/${id}`);
    if (state.route.name !== "job" || state.route.id !== id) {
      clearInterval(state.editTimer);
      state.editTimer = null;
      return;
    }
    state.job = job;
    if (job.edit?.status === "running") {
      const status = document.getElementById("segment-edit-status");
      if (status) {
        status.innerHTML = `${icon("wand", 15)}<span>正在局部修改分镜 ${esc(job.edit.segmentIndex)}：${esc(job.edit.prompt)}。完成后成片和播放器会自动刷新，请不要关闭页面。</span>`;
      }
      return;
    }
    clearInterval(state.editTimer);
    state.editTimer = null;
    renderJobView();
    void refreshJobBadge();
    if (job.edit?.status === "succeeded") toast("局部修改完成，成片已重新拼接", "success");
    else if (job.edit?.status === "failed") toast(job.edit.error || "局部修改失败", "error");
  } catch (err) {
    clearInterval(state.editTimer);
    state.editTimer = null;
    toast(err.message, "error");
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

async function createMiniappShare(job) {
  const button = document.getElementById("miniapp-publish-btn");
  const result = document.getElementById("miniapp-publish-result");
  if (!button || !result) return;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 生成中…`;
  result.innerHTML = "";
  try {
    const data = await api(`/api/videos/${job.id}/douyin/miniapp`, { method: "POST" });
    result.innerHTML = `<div class="miniapp-share-result">
      <img class="miniapp-share-qr" src="${attr(data.qrDataUrl)}" alt="成片下载二维码" />
      <div class="miniapp-share-body">
        <div class="miniapp-share-title">用手机扫码下载成片</div>
        <div class="miniapp-share-actions">
          <a class="btn btn-primary btn-sm" href="${attr(data.videoUrl)}" target="_blank" rel="noreferrer">${icon("external", 15)} 打开下载链接</a>
          <button class="btn btn-ghost btn-sm" type="button" id="miniapp-copy-video">${icon("copy", 15)} 复制链接</button>
        </div>
        <div class="hint">链接 24 小时内有效。下载到相册后，打开小程序「发布到抖音」，选择这条成片并确认发布。</div>
      </div>
    </div>`;
    document.getElementById("miniapp-copy-video")?.addEventListener("click", () => {
      void copyText(data.videoUrl);
    });
    toast("已生成手机下载二维码", "success");
  } catch (error) {
    result.innerHTML = `<div class="settings-note">${icon("alert", 16)}<span>${esc(error.message)}</span></div>`;
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("qrcode", 15)} 生成手机下载二维码`;
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

/* ---------------- cast ---------------- */

function castThumb(asset) {
  if (!asset.imageUrl) {
    return `<span class="cast-placeholder">${icon(asset.kind === "character" ? "users" : "box", 26)}</span>`;
  }
  const version = encodeURIComponent(asset.updatedAt ?? "");
  return `<img loading="lazy" src="${attr(asset.imageUrl)}?v=${version}" alt="${attr(asset.name)}" />`;
}

function castCardHtml(asset, imageGenReady = false) {
  const canGenerate = imageGenReady && Boolean(asset.description?.trim());
  const generateHint = !imageGenReady
    ? "先在「设置 → AI 角色图生成」填写 API Key"
    : !asset.description?.trim()
      ? "先补充外观设定"
      : asset.imageFile
        ? "按外观设定重新生成参考图（会覆盖当前参考图）"
        : "按外观设定生成参考图";
  const meta = [
    asset.imageFile ? "参考图已上传" : "仅文字设定",
    asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<article class="card cast-card" data-cast="${attr(asset.id)}">
    <div class="cast-thumb">
      ${castThumb(asset)}
      <span class="material-type">${esc(CAST_KIND_LABEL[asset.kind] ?? asset.kind)}</span>
    </div>
    <div class="material-body">
      <div class="material-title" title="${attr(asset.name)}">${esc(asset.name)}</div>
      <p class="cast-desc">${esc(asset.description || "（未填写外观设定，建议补充）")}</p>
      <div class="material-meta">${esc(meta)}</div>
      <button class="btn btn-ghost btn-sm cast-generate-btn" type="button" data-generate-cast="${attr(asset.id)}" ${canGenerate ? "" : "disabled"} title="${attr(generateHint)}">${icon("wand", 14)} 按外观生成参考图</button>
    </div>
    <div class="material-foot">
      <div class="cast-actions">
        <button class="icon-btn" type="button" data-edit-cast="${attr(asset.id)}" title="编辑设定">${icon("pencil", 15)}</button>
        <button class="icon-btn" type="button" data-replace-cast="${attr(asset.id)}" title="${asset.imageFile ? "更换参考图" : "上传参考图"}">${icon("image", 15)}</button>
        ${asset.imageFile ? `<button class="icon-btn" type="button" data-clear-cast="${attr(asset.id)}" title="清空参考图" aria-label="清空参考图">${icon("x", 15)}</button>` : ""}
        <button class="icon-btn" type="button" data-delete-cast="${attr(asset.id)}" title="删除">${icon("trash", 15)}</button>
      </div>
      <span class="material-meta">${formatDate(asset.updatedAt)}</span>
    </div>
  </article>`;
}

const TTS_PROVIDER_LABELS = {
  edge: "Edge TTS",
  openai: "OpenAI 兼容",
  elevenlabs: "ElevenLabs",
  bailian: "阿里百炼",
  silent: "静音",
};

function voiceSourcePrefix(voiceCatalog) {
  if (!voiceCatalog?.provider) return "";
  const provider = TTS_PROVIDER_LABELS[voiceCatalog.provider] ?? voiceCatalog.provider;
  const model = voiceCatalog.model ? ` · ${voiceCatalog.model}` : "";
  return `音色列表来自设置里的 ${provider}${model}；`;
}

function castUploadCardHtml(voiceCatalog = null, imageGenReady = false) {
  const castVoiceOptions = voiceCatalog?.voices?.length
    ? voiceCatalog.voices
    : EDGE_VOICES.map(([value, label]) => ({ value, label }));
  const castVoiceHint = `${voiceSourcePrefix(voiceCatalog)}${
    voiceCatalog?.hint ?? "开启「人物对话」时，这个角色用该音色；留空时按设定里的性别自动挑男声/女声。"
  }成片配音会按这里给每个角色分别合成；列表是常用音色，模型支持的其他 id 可直接输入。`;
  return `<section class="card">
    <div class="card-head">
      <div><div class="card-title">添加角色或道具</div><div class="card-sub">名称 + 外观设定 + 参考图；参考图会用于图生视频，让后续镜头保持同一形象</div></div>
    </div>
    <div class="card-body">
      <div class="field-row">
        <div class="field">
          <span class="field-label">类型</span>
          <div class="segmented" id="cast-kind">
            <button type="button" data-value="character" class="active">角色</button>
            <button type="button" data-value="prop">道具</button>
          </div>
        </div>
        <div class="field">
          <label for="cast-name">名称</label>
          <input class="input" id="cast-name" maxlength="40" placeholder="例如：林小满 / 旧怀表" />
          <span class="hint">名称会和剧本里的出场名称对应，请保持简短一致</span>
        </div>
      </div>
      <div class="field">
        <label for="cast-desc">外观设定 <span class="optional">建议填写</span></label>
        <textarea class="textarea" id="cast-desc" maxlength="500" rows="3" placeholder="例如：25 岁女性，齐肩短发，米色风衣，左眉有一道浅疤"></textarea>
        <span class="hint">会写进每个出场分镜的提示词，越具体越容易保持一致</span>
      </div>
      <div class="field">
        <label for="cast-voice">对话配音音色 <span class="optional">可选</span></label>
        <div class="input-with-action">
          <input class="input" id="cast-voice" list="cast-voice-options" placeholder="留空自动分配；或选择当前供应商的音色" maxlength="120" />
          <button class="btn btn-ghost btn-sm" type="button" id="cast-voice-preview">试听</button>
          <button class="btn btn-ghost btn-sm" type="button" id="cast-voice-refresh">刷新音色</button>
        </div>
        <datalist id="cast-voice-options">
          ${castVoiceOptions.map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`).join("")}
        </datalist>
        <span class="hint" id="cast-voice-hint">${esc(castVoiceHint)}</span>
        <span class="hint" id="cast-voice-preview-status"></span>
      </div>
      <div class="dropzone" id="cast-dropzone">
        ${icon("upload", 26)}
        <strong id="cast-drop-title">点击或拖拽上传参考图</strong>
        <small id="cast-drop-hint">支持 jpg / png / webp，可选；没有参考图时只做文字一致性</small>
        <input type="file" id="cast-file-input" accept="image/*,.jpg,.jpeg,.png,.webp" />
      </div>
      <span class="hint">${imageGenReady ? "也可以先添加，再在卡片上点「按外观生成参考图」让 AI 出一张；两种方式可以随时替换。" : "也可以先添加，之后在「设置 → AI 角色图生成」填好 API Key，再在卡片上一键生成参考图。"}</span>
      <div class="actions">
        <button class="btn btn-primary" id="cast-add-btn" type="button" disabled>${icon("plus", 16)} 添加</button>
      </div>
    </div>
  </section>`;
}

function castDialogHtml(voiceCatalog = null) {
  const castVoiceOptions = voiceCatalog?.voices?.length
    ? voiceCatalog.voices
    : EDGE_VOICES.map(([value, label]) => ({ value, label }));
  const castVoiceHint = `${voiceSourcePrefix(voiceCatalog)}${voiceCatalog?.hint ?? "留空自动分配。"}成片配音会按这里给每个角色分别合成；模型支持的其他 id 可直接输入。`;
  return `<dialog class="user-dialog" id="cast-dialog">
    <form id="cast-form" novalidate>
      <div class="dialog-head">
        <div>
          <div class="card-title" id="cast-dialog-title">编辑角色/道具</div>
          <div class="card-sub" id="cast-dialog-sub">修改名称、类型与外观设定</div>
        </div>
        <button class="icon-btn" type="button" id="close-cast-dialog" aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="dialog-body">
        <input type="hidden" id="cast-edit-id" />
        <div class="field-grid-2">
          <div class="field">
            <label for="cast-edit-kind">类型</label>
            <select class="select" id="cast-edit-kind">
              <option value="character">角色</option>
              <option value="prop">道具</option>
            </select>
          </div>
          <div class="field">
            <label for="cast-edit-name">名称</label>
            <input class="input" id="cast-edit-name" maxlength="40" />
          </div>
        </div>
        <div class="field">
          <label for="cast-edit-desc">外观设定</label>
          <textarea class="textarea" id="cast-edit-desc" maxlength="500" rows="4"></textarea>
        </div>
        <div class="field">
          <label for="cast-edit-voice">对话配音音色</label>
          <div class="input-with-action">
            <input class="input" id="cast-edit-voice" list="cast-edit-voice-options" maxlength="120" placeholder="留空自动分配；或选择当前供应商的音色" />
            <button class="btn btn-ghost btn-sm" type="button" id="cast-edit-voice-preview">试听</button>
            <button class="btn btn-ghost btn-sm" type="button" id="cast-edit-voice-refresh">刷新音色</button>
          </div>
          <datalist id="cast-edit-voice-options">
            ${castVoiceOptions.map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`).join("")}
          </datalist>
          <span class="hint" id="cast-edit-voice-hint">${esc(castVoiceHint)}</span>
          <span class="hint" id="cast-edit-voice-preview-status"></span>
        </div>
        <div class="dialog-error" id="cast-form-error" hidden></div>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" id="cancel-cast-dialog">取消</button>
        <button class="btn btn-primary" type="submit" id="save-cast">保存</button>
      </div>
    </form>
  </dialog>`;
}

function openCastDialog(id) {
  const asset = (state.cast ?? []).find((item) => item.id === id);
  const dialog = document.getElementById("cast-dialog");
  if (!asset || !dialog) return;
  document.getElementById("cast-edit-id").value = asset.id;
  document.getElementById("cast-edit-kind").value = asset.kind;
  document.getElementById("cast-edit-name").value = asset.name;
  document.getElementById("cast-edit-desc").value = asset.description ?? "";
  document.getElementById("cast-edit-voice").value = asset.voice ?? "";
  const error = document.getElementById("cast-form-error");
  if (error) error.hidden = true;
  dialog.showModal();
  document.getElementById("cast-edit-name").focus();
}

async function saveCastEdit() {
  const id = document.getElementById("cast-edit-id")?.value ?? "";
  const kind = document.getElementById("cast-edit-kind")?.value ?? "character";
  const name = document.getElementById("cast-edit-name")?.value.trim() ?? "";
  const description = document.getElementById("cast-edit-desc")?.value.trim() ?? "";
  const voice = document.getElementById("cast-edit-voice")?.value.trim() ?? "";
  const error = document.getElementById("cast-form-error");
  const button = document.getElementById("save-cast");
  if (error) error.hidden = true;
  if (!name) {
    if (error) {
      error.hidden = false;
      error.textContent = "请填写名称";
    }
    return;
  }
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> 保存中…`;
  }
  try {
    await api(`/api/cast/${id}`, { method: "PATCH", body: { kind, name, description, voice } });
    document.getElementById("cast-dialog")?.close();
    toast("设定已更新", "success");
    await renderCast();
  } catch (caught) {
    if (error) {
      error.hidden = false;
      error.textContent = caught.message;
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存";
    }
  }
}

async function generateCastImage(id, button) {
  const asset = (state.cast ?? []).find((item) => item.id === id);
  if (!asset) return;
  if (!asset.description?.trim()) {
    toast("请先补充外观设定，AI 需要根据设定生成参考图", "error");
    return;
  }
  if (asset.imageFile && !window.confirm(`「${asset.name}」已有参考图，生成会覆盖它，继续吗？`)) return;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> 生成中，约需半分钟…`;
  try {
    const data = await api(`/api/cast/${id}/image/generate`, { method: "POST" });
    state.cast = (state.cast ?? []).map((item) => (item.id === id ? data.cast : item));
    toast("参考图已生成", "success");
    await renderCast();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function clearCastImage(id) {
  const asset = (state.cast ?? []).find((item) => item.id === id);
  if (!asset?.imageFile) return;
  if (!window.confirm(`确定清空「${asset.name}」的参考图？外观设定会保留，之后可以重新上传或按设定生成。`)) return;
  try {
    const data = await api(`/api/cast/${id}/image`, { method: "DELETE" });
    state.cast = (state.cast ?? []).map((item) => (item.id === id ? data.cast : item));
    toast("参考图已清空，可以按外观设定重新生成", "success");
    await renderCast();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteCast(id) {
  const asset = (state.cast ?? []).find((item) => item.id === id);
  if (!asset) return;
  if (!window.confirm(`确定删除「${asset.name}」？已有任务不受影响，之后的分镜将不再使用这个设定。`)) return;
  try {
    await api(`/api/cast/${id}`, { method: "DELETE" });
    state.castIds = (state.castIds ?? []).filter((item) => item !== id);
    toast("已删除", "success");
    await renderCast();
  } catch (error) {
    toast(error.message, "error");
  }
}

let castPreviewAudio = null;

/** 试听角色音色：用当前填写的音色与设定合成一句示例台词。 */
async function previewCastVoice(button, { voice, name, description, statusId }) {
  const status = statusId ? document.getElementById(statusId) : null;
  if (status) status.textContent = "";
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "试听中…";
  try {
    const response = await fetch("/api/cast/voice-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice, name, description }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error?.message ?? `试听失败（${response.status}）`);
    }
    const blob = await response.blob();
    const actualVoice = response.headers.get("x-preview-voice");
    const played = actualVoice ? decodeURIComponent(actualVoice) : voice;
    if (status) status.textContent = `正在播放：${played}（${state.settings?.tts?.provider ?? ""}）`;
    if (castPreviewAudio) {
      castPreviewAudio.pause();
      URL.revokeObjectURL(castPreviewAudio.src);
    }
    castPreviewAudio = new Audio(URL.createObjectURL(blob));
    await castPreviewAudio.play();
  } catch (error) {
    const provider = state.settings?.tts?.provider ?? "当前";
    const model = state.settings?.tts?.model ?? "";
    const detail = `${provider}${model ? ` / ${model}` : ""} 试听失败：${error.message}`;
    if (status) status.textContent = detail;
    toast(detail, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function renderCast() {
  setPage("角色库", "角色与道具");
  view.innerHTML = loadingView("正在读取角色库…");
  const data = await api("/api/cast");
  if (state.route.name !== "cast") return;
  const cast = data.cast ?? [];
  state.cast = cast;
  const imageGenReady = state.settings?.imageGen?.provider === "bailian" && Boolean(state.settings?.imageGen?.apiKeySet);
  // 每次都按设置里保存的供应商/模型重新拉一次，避免角色库停留在旧模型的音色列表。
  const voiceCatalog = await loadVoiceCatalog(
    true,
    state.settings?.tts?.provider,
    state.settings?.tts?.model,
  );
  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Cast & Props</p>
      <h2>角色与道具</h2>
      <p>给人物和关键物品建立设定与参考图。生成短剧时，同一角色/道具会复用同一套外观描述和参考图，保证跨镜头、甚至跨视频延续同一形象。</p>
    </section>
    ${castUploadCardHtml(voiceCatalog, imageGenReady)}
    <div class="materials-toolbar mt-24">
      <span class="muted small">共 ${cast.length} 个设定${cast.filter((asset) => asset.imageFile).length ? ` · ${cast.filter((asset) => asset.imageFile).length} 个有参考图` : ""}</span>
      <a class="btn btn-ghost btn-sm" href="#/create">${icon("plus", 15)} 去创作</a>
    </div>
    ${
      cast.length
        ? `<div class="material-grid">${cast.map((asset) => castCardHtml(asset, imageGenReady)).join("")}</div>`
        : emptyState("users", "还没有角色或道具", "添加人物或物品的参考图与外观设定，之后的分镜会保持同一形象。")
    }
    <input type="file" id="cast-image-input" accept="image/*,.jpg,.jpeg,.png,.webp" hidden />
    ${castDialogHtml(voiceCatalog)}`;

  const kindPicker = document.getElementById("cast-kind");
  const fileInput = document.getElementById("cast-file-input");
  const dropzone = document.getElementById("cast-dropzone");
  const addButton = document.getElementById("cast-add-btn");
  const dropTitle = document.getElementById("cast-drop-title");
  const dropHint = document.getElementById("cast-drop-hint");
  const nameInput = document.getElementById("cast-name");
  const descInput = document.getElementById("cast-desc");
  const imageInput = document.getElementById("cast-image-input");
  const voiceCatalogHint = (catalog) => `${voiceSourcePrefix(catalog)}${catalog.hint}`;
  async function refreshCastVoices(button, datalistId, hintId, statusId) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "刷新中…";
    try {
      const catalog = await loadVoiceCatalog(
        true,
        state.settings?.tts?.provider,
        state.settings?.tts?.model,
      );
      const datalist = document.getElementById(datalistId);
      if (datalist) {
        datalist.innerHTML = catalog.voices
          .map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`)
          .join("");
      }
      const hint = document.getElementById(hintId);
      if (hint) hint.textContent = voiceCatalogHint(catalog);
      const status = document.getElementById(statusId);
      if (status) status.textContent = `已按 ${catalog.model || catalog.provider} 刷新音色列表`;
    } catch (error) {
      toast(`刷新音色失败：${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }
  document.getElementById("cast-voice-refresh")?.addEventListener("click", (event) => {
    void refreshCastVoices(event.currentTarget, "cast-voice-options", "cast-voice-hint", "cast-voice-preview-status");
  });
  document.getElementById("cast-edit-voice-refresh")?.addEventListener("click", (event) => {
    void refreshCastVoices(event.currentTarget, "cast-edit-voice-options", "cast-edit-voice-hint", "cast-edit-voice-preview-status");
  });

  const voicePreview = document.getElementById("cast-voice-preview");
  const voiceInput = document.getElementById("cast-voice");
  const editVoicePreview = document.getElementById("cast-edit-voice-preview");
  let pendingReplaceId = null;

  function selectFile(file) {
    if (!file) return;
    state.castUploadFile = file;
    dropTitle.textContent = file.name;
    dropHint.textContent = formatBytes(file.size);
    addButton.disabled = false;
    if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
  }

  kindPicker.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    for (const item of kindPicker.querySelectorAll("button")) item.classList.remove("active");
    button.classList.add("active");
  });
  voicePreview?.addEventListener("click", () => {
    void previewCastVoice(voicePreview, {
      voice: voiceInput?.value.trim() ?? "",
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      statusId: "cast-voice-preview-status",
    });
  });
  editVoicePreview?.addEventListener("click", () => {
    void previewCastVoice(editVoicePreview, {
      voice: document.getElementById("cast-edit-voice")?.value.trim() ?? "",
      name: document.getElementById("cast-edit-name")?.value.trim() ?? "",
      description: document.getElementById("cast-edit-desc")?.value.trim() ?? "",
      statusId: "cast-edit-voice-preview-status",
    });
  });
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

  addButton.addEventListener("click", async () => {
    const kind = kindPicker.querySelector("button.active")?.dataset.value ?? "character";
    const name = nameInput.value.trim();
    if (!name) {
      toast("请填写名称", "error");
      nameInput.focus();
      return;
    }
    addButton.disabled = true;
    addButton.innerHTML = `<span class="spinner"></span> 添加中…`;
    try {
      await uploadCast(state.castUploadFile, {
        kind,
        name,
        description: descInput.value.trim(),
        voice: document.getElementById("cast-voice")?.value.trim() ?? "",
      });
      state.castUploadFile = null;
      toast("已添加到角色库", "success");
      await renderCast();
    } catch (error) {
      toast(error.message, "error");
      addButton.disabled = false;
      addButton.innerHTML = `${icon("plus", 16)} 添加`;
    }
  });

  for (const button of view.querySelectorAll("[data-edit-cast]")) {
    button.addEventListener("click", () => openCastDialog(button.dataset.editCast));
  }
  for (const button of view.querySelectorAll("[data-generate-cast]")) {
    button.addEventListener("click", () => {
      void generateCastImage(button.dataset.generateCast, button);
    });
  }
  for (const button of view.querySelectorAll("[data-clear-cast]")) {
    button.addEventListener("click", () => {
      void clearCastImage(button.dataset.clearCast);
    });
  }
  for (const button of view.querySelectorAll("[data-delete-cast]")) {
    button.addEventListener("click", () => {
      void deleteCast(button.dataset.deleteCast);
    });
  }
  for (const button of view.querySelectorAll("[data-replace-cast]")) {
    button.addEventListener("click", () => {
      pendingReplaceId = button.dataset.replaceCast;
      imageInput.value = "";
      imageInput.click();
    });
  }
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    if (!file || !pendingReplaceId) return;
    const id = pendingReplaceId;
    pendingReplaceId = null;
    try {
      await replaceCastImage(id, file);
      toast("参考图已更新", "success");
      await renderCast();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  document.getElementById("close-cast-dialog")?.addEventListener("click", () => {
    document.getElementById("cast-dialog")?.close();
  });
  document.getElementById("cancel-cast-dialog")?.addEventListener("click", () => {
    document.getElementById("cast-dialog")?.close();
  });
  document.getElementById("cast-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCastEdit();
  });
  const dialog = document.getElementById("cast-dialog");
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
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
  if (douyin?.mode === "miniapp") {
    return `<div class="mt-16">
      <div class="hint">个人号小程序投稿</div>
      <ol class="setup-steps">
        <li>在抖音开放平台创建个人主体小程序，申请并开通「短视频自主挂载」能力；绑定有效粉丝数超过 500 的普通抖音号。</li>
        <li>把仓库 <code>miniapp/</code> 目录导入抖音开发者工具，替换 <code>project.config.json</code> 里的 AppID，上传并提交审核。</li>
        <li>成片生成后，在任务详情页生成手机下载二维码，把成片保存到相册；打开小程序选择成片，在抖音发布器里确认发布。</li>
      </ol>
      <div class="settings-note">${icon("info", 16)}<span>这个模式不需要 client_key / client_secret，也不经过服务端静默发布；实际能否发布由抖音小程序的短视频挂载审核和账号资格决定。</span></div>
    </div>`;
  }
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

  const miniapp = douyin.mode === "miniapp";
  const authorized = !miniapp && Boolean(douyin.authorized);
  const configured = Boolean(douyin.configured);
  const account = miniapp
    ? `<div class="settings-note mt-16">${icon("info", 16)}<span>${douyin.publicBaseUrlSet ? "成片生成后，在任务详情页生成手机下载二维码，下载到相册后在已开通短视频挂载的小程序里选择发布。" : "还没配置公网素材地址；可以先在手机上打开任务下载成片，再在小程序里从相册选择。"}</span></div>
      <div class="account-actions">
        <a class="btn btn-primary" href="#/settings">${icon("sliders", 15)} 查看设置</a>
      </div>`
    : authorized
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
      <p>${miniapp ? "个人号小程序投稿：把成片下载到手机相册，在已开通「短视频自主挂载」的小程序里选择成片，再由抖音发布器确认发布；不需要 OAuth。" : "通过抖音开放平台授权后，可以把生成的成片直接发布到自己的抖音号。令牌只保存在本机。"}</p>
    </section>
    <div class="publish-grid">
      <section class="card account-card">
        <div class="card-head">
          <div><div class="card-title">抖音账号</div><div class="card-sub">${miniapp ? "个人号小程序投稿" : "OAuth 授权状态"}</div></div>
          <span class="pill ${miniapp ? (douyin.publicBaseUrlSet ? "pill-warning" : "pill-soft") : authorized ? "pill-success" : configured ? "pill-warning" : "pill-soft"}">${miniapp ? (douyin.publicBaseUrlSet ? "小程序待发布" : "待配公网地址") : authorized ? "已授权" : configured ? "待授权" : "未配置"}</span>
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
              : emptyState("send", "还没有发布记录", miniapp ? "生成成片后，在任务详情页下载成片，再打开小程序选择成片发布。" : "生成成片后，在任务详情页点击「发布到抖音」。")
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

/* ---------------- users (settings, admin only) ---------------- */

function permissionChips(user) {
  if (user.role === "admin") return `<span class="tag tag-brand">全部模块</span>`;
  const labels = MENU_META.filter((item) => user.permissions.includes(item.key)).map((item) => item.label);
  if (!labels.length) return `<span class="muted small">无菜单权限</span>`;
  return labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("");
}

function userRowHtml(user) {
  const isSelf = state.user?.id === user.id;
  return `<div class="user-row" data-user="${attr(user.id)}">
    <span class="user-avatar">${esc(initialOf(user.displayName || user.username))}</span>
    <div class="user-main">
      <div class="user-name-line">
        <strong>${esc(user.displayName)}</strong>
        ${isSelf ? `<span class="pill pill-soft">我</span>` : ""}
        ${user.disabled ? `<span class="pill pill-danger">已禁用</span>` : ""}
      </div>
      <div class="user-meta">@${esc(user.username)} · ${user.role === "admin" ? "管理员" : "成员"} · 创建于 ${formatDate(user.createdAt)}${user.lastLoginAt ? ` · 最近登录 ${formatDate(user.lastLoginAt)}` : ""}</div>
      <div class="user-perms">${permissionChips(user)}</div>
    </div>
    <div class="user-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-edit-user="${attr(user.id)}">编辑</button>
      <button class="btn btn-danger btn-sm" type="button" data-delete-user="${attr(user.id)}" ${isSelf ? "disabled" : ""}>删除</button>
    </div>
  </div>`;
}

function userDialogHtml() {
  return `<dialog class="user-dialog" id="user-dialog">
    <form id="user-form" novalidate>
      <div class="dialog-head">
        <div>
          <div class="card-title" id="user-dialog-title">添加用户</div>
          <div class="card-sub" id="user-dialog-sub">创建账号并分配可见菜单</div>
        </div>
        <button class="icon-btn" type="button" id="close-user-dialog" aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="dialog-body">
        <div class="field-grid-2">
          <div class="field">
            <label for="user-username">用户名</label>
            <input class="input" id="user-username" autocomplete="off" placeholder="3-32 位字母、数字或 _.-" />
            <span class="hint">登录使用，创建后不可修改</span>
          </div>
          <div class="field">
            <label for="user-display">显示名称</label>
            <input class="input" id="user-display" autocomplete="off" maxlength="40" placeholder="例如 剪辑师小王" />
          </div>
        </div>
        <div class="field">
          <label for="user-password">密码 <span class="optional" id="user-password-hint">至少 8 位</span></label>
          <input class="input" type="password" id="user-password" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="user-role-select">角色</label>
          <select class="select" id="user-role-select">
            <option value="member">成员（按勾选菜单访问）</option>
            <option value="admin">管理员（全部菜单与用户管理）</option>
          </select>
        </div>
        <div class="field">
          <label class="switch">
            <input type="checkbox" id="user-disabled" />
            <span class="track"></span>
            <span>禁用账号</span>
          </label>
          <span class="hint">禁用后立即注销该用户的登录会话，可随时重新启用。</span>
        </div>
        <div class="field">
          <span class="field-label">可见菜单</span>
          <div class="permission-grid" id="permission-grid">
            ${MENU_META.map(
              (item) => `<label class="permission-item">
                <input type="checkbox" value="${attr(item.key)}" />
                <span><strong>${esc(item.label)}</strong><small>${esc(item.desc)}</small></span>
              </label>`,
            ).join("")}
          </div>
          <span class="hint">勾选「创作」会自动包含「任务」，否则创建后无法查看进度。</span>
        </div>
        <div class="form-error" id="user-form-error" hidden></div>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" id="cancel-user-dialog">取消</button>
        <button class="btn btn-primary" type="submit" id="save-user">保存</button>
      </div>
    </form>
  </dialog>`;
}

function usersCardHtml() {
  return `<section class="card settings-card users-card">
    <div class="card-head">
      <div><div class="card-title">用户与权限</div><div class="card-sub">不同成员登录后只看到被勾选的菜单；服务端 API 同样按权限校验</div></div>
      <button class="btn btn-primary btn-sm" id="add-user" type="button">${icon("plus", 15)} 添加用户</button>
    </div>
    <div class="card-body">
      <div class="user-list" id="user-list">${state.users.map(userRowHtml).join("")}</div>
      <div class="settings-note">${icon("shield", 16)}<span>管理员默认拥有全部菜单和用户管理权限。成员权限保存后立即生效；删除或禁用账号会立刻注销其登录会话。</span></div>
    </div>
  </section>
  ${userDialogHtml()}`;
}

function syncUserPermissionControls() {
  const grid = document.getElementById("permission-grid");
  const role = document.getElementById("user-role-select")?.value;
  if (!grid) return;
  const admin = role === "admin";
  for (const checkbox of grid.querySelectorAll('input[type="checkbox"]')) {
    checkbox.disabled = admin;
    if (admin) checkbox.checked = true;
  }
  if (admin) return;
  const create = grid.querySelector('input[value="create"]');
  const jobs = grid.querySelector('input[value="jobs"]');
  if (create?.checked && jobs) jobs.checked = true;
  if (jobs && !jobs.checked && create) create.checked = false;
  const materials = grid.querySelector('input[value="materials"]');
  const cast = grid.querySelector('input[value="cast"]');
  if (materials?.checked && cast) cast.checked = true;
  if (cast && !cast.checked && materials) materials.checked = false;
}

function openUserDialog(id) {
  const dialog = document.getElementById("user-dialog");
  const form = document.getElementById("user-form");
  if (!dialog || !form) return;
  const user = id ? state.users.find((item) => item.id === id) : null;
  form.reset();
  document.getElementById("user-id")?.remove();
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.id = "user-id";
  hidden.value = user?.id ?? "";
  form.prepend(hidden);
  document.getElementById("user-dialog-title").textContent = user ? "编辑用户" : "添加用户";
  document.getElementById("user-dialog-sub").textContent = user ? `@${user.username}` : "创建账号并分配可见菜单";
  const username = document.getElementById("user-username");
  username.value = user?.username ?? "";
  username.disabled = Boolean(user);
  document.getElementById("user-display").value = user?.displayName ?? "";
  const password = document.getElementById("user-password");
  password.value = "";
  password.required = !user;
  password.placeholder = user ? "留空则不修改密码" : "至少 8 位";
  document.getElementById("user-password-hint").textContent = user ? "留空则不修改" : "至少 8 位";
  document.getElementById("user-role-select").value = user?.role ?? "member";
  const roleSelect = document.getElementById("user-role-select");
  roleSelect.disabled = Boolean(user && state.user?.id === user.id);
  roleSelect.title = roleSelect.disabled ? "不能修改自己的角色" : "";
  const disabledToggle = document.getElementById("user-disabled");
  disabledToggle.checked = Boolean(user?.disabled);
  disabledToggle.disabled = Boolean(user && state.user?.id === user.id);
  disabledToggle.title = disabledToggle.disabled ? "不能禁用自己的账号" : "";
  const selected = new Set(
    user ? (user.role === "admin" ? MENU_KEYS : user.permissions) : ["create", "jobs"],
  );
  for (const checkbox of document.querySelectorAll('#permission-grid input[type="checkbox"]')) {
    checkbox.checked = selected.has(checkbox.value);
  }
  const error = document.getElementById("user-form-error");
  if (error) error.hidden = true;
  syncUserPermissionControls();
  dialog.showModal();
  (user ? document.getElementById("user-display") : username).focus();
}

function bindUserRowActions() {
  for (const button of view.querySelectorAll("[data-edit-user]")) {
    button.addEventListener("click", () => openUserDialog(button.dataset.editUser));
  }
  for (const button of view.querySelectorAll("[data-delete-user]")) {
    button.addEventListener("click", () => {
      void deleteUser(button.dataset.deleteUser);
    });
  }
}

function bindUserManagement() {
  document.getElementById("add-user")?.addEventListener("click", () => openUserDialog());
  document.getElementById("user-role-select")?.addEventListener("change", syncUserPermissionControls);
  document.getElementById("permission-grid")?.addEventListener("change", syncUserPermissionControls);
  document.getElementById("close-user-dialog")?.addEventListener("click", () => {
    document.getElementById("user-dialog")?.close();
  });
  document.getElementById("cancel-user-dialog")?.addEventListener("click", () => {
    document.getElementById("user-dialog")?.close();
  });
  document.getElementById("user-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveUser();
  });
  const dialog = document.getElementById("user-dialog");
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  bindUserRowActions();
}

async function refreshUsers() {
  const data = await api("/api/users");
  state.users = data.users ?? [];
  const list = document.getElementById("user-list");
  if (list) {
    list.innerHTML = state.users.map(userRowHtml).join("");
    bindUserRowActions();
  }
}

async function saveUser() {
  const id = document.getElementById("user-id")?.value ?? "";
  const username = document.getElementById("user-username")?.value.trim() ?? "";
  const displayName = document.getElementById("user-display")?.value.trim() ?? "";
  const password = document.getElementById("user-password")?.value ?? "";
  const role = document.getElementById("user-role-select")?.value ?? "member";
  const disabled = document.getElementById("user-disabled")?.checked ?? false;
  const permissions =
    role === "admin"
      ? MENU_KEYS
      : [...document.querySelectorAll('#permission-grid input[type="checkbox"]:checked')].map(
          (checkbox) => checkbox.value,
        );
  const errorEl = document.getElementById("user-form-error");
  const button = document.getElementById("save-user");
  const fail = (message) => {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
  };
  if (errorEl) errorEl.hidden = true;
  if (!id && !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return fail("用户名需为 3-32 位字母、数字、下划线、点或短横线");
  }
  if (!id && password.length < 8) return fail("新用户密码至少需要 8 位");
  if (id && password && password.length < 8) return fail("新密码至少需要 8 位");
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> 保存中…`;
  }
  try {
    const body = { displayName, role, permissions, disabled };
    if (password) body.password = password;
    let data;
    if (id) {
      data = await api(`/api/users/${id}`, { method: "PATCH", body });
    } else {
      data = await api("/api/users", { method: "POST", body: { ...body, username } });
    }
    if (id && state.user?.id === id && data.user) {
      state.user.displayName = data.user.displayName;
      applySession();
    }
    document.getElementById("user-dialog")?.close();
    toast(id ? "用户已更新" : "用户已添加", "success");
    await refreshUsers();
  } catch (error) {
    fail(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "保存";
    }
  }
}

async function deleteUser(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  if (!window.confirm(`确定删除用户「${user.displayName}」？该账号将立即失去访问权限。`)) return;
  try {
    await api(`/api/users/${id}`, { method: "DELETE" });
    toast("用户已删除", "success");
    await refreshUsers();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderSettings() {
  setPage("设置", "设置");
  view.innerHTML = loadingView("正在读取设置…");
  const isAdmin = state.user?.role === "admin";
  const [settingsData, douyin, usersData] = await Promise.all([
    api("/api/settings"),
    api("/api/douyin/status").catch(() => null),
    isAdmin ? api("/api/users") : Promise.resolve({ users: [] }),
  ]);
  if (state.route.name !== "settings") return;
  const s = settingsData.settings;
  state.settings = s;
  state.douyin = douyin;
  state.users = usersData.users ?? [];
  updateModelPill();
  const voiceCatalog = await loadVoiceCatalog(false, s.tts.provider, s.tts.model);
  const redirectUri = s.douyin.effectiveRedirectUri;
  const videoChannels = s.videoGenChannels ?? [];
  const activeVideoChannel =
    videoChannels.find((item) => item.channel === s.videoGen.channel) ?? videoChannels[0];
  const videoModelOptions = activeVideoChannel?.models ?? [];
  const activeVideoModel =
    videoModelOptions.find((item) => item.id === s.videoGen.model) ?? videoModelOptions[0];
  const imageGenModels = s.imageGenModels ?? [];
  const activeImageModel = imageGenModels.find((item) => item.id === s.imageGen.model);
  const customImageModel =
    s.imageGen.model && !activeImageModel ? s.imageGen.model : "";

  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Settings</p>
      <h2>设置</h2>
      <p>配置脚本模型、配音、AI 画面与抖音开放平台。保存后对新任务生效，正在运行的任务使用创建时的配置。${isAdmin ? "管理员可在下方添加用户并分配菜单权限。" : ""}</p>
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
            ${numberField("script-segments", "分镜数量", s.script.maxSegments, { min: 1, max: 20 })}
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
          <div><div class="card-title">配音</div><div class="card-sub">Edge TTS 免费无需密钥；也支持 OpenAI 兼容、ElevenLabs 与阿里百炼（qwen-tts / qwen3-tts-flash / CosyVoice / MiniMax，含声音复刻音色）</div></div>
          <span class="pill ${s.tts.enabled ? "pill-soft" : "pill-brand"}">${s.tts.enabled ? esc(s.tts.provider) : "已关闭，画面模型出声"}</span>
        </div>
        <div class="card-body">
          ${switchField("tts-enabled", "启用配音模块", s.tts.enabled, "启用后按下面的供应商合成配音；关闭后不调用配音模型，改由 AI 画面模型根据分镜台词直接生成同期声（画面模型需支持音频，否则成片没有台词声）")}
          <div class="field-grid-3">
            <div class="field">
              <label for="tts-provider">供应商</label>
              <select class="select" id="tts-provider">
                ${options([["edge", "Edge TTS（免费）"], ["openai", "OpenAI 兼容 /audio/speech"], ["elevenlabs", "ElevenLabs（自然表演）"], ["bailian", "阿里百炼（qwen-tts / CosyVoice / MiniMax）"], ["silent", "静音占位"]], s.tts.provider)}
              </select>
            </div>
            <div class="field">
              <label for="tts-voice">音色</label>
              <input class="input" id="tts-voice" list="tts-voice-options" value="${attr(s.tts.voice)}" />
              <datalist id="tts-voice-options">
                ${voiceCatalog.voices.map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`).join("")}
              </datalist>
              <span class="hint" id="tts-voice-hint">${esc(voiceCatalog.hint)}</span>
            </div>
            ${numberField("tts-rate", "语速", s.tts.rate, { min: 0.5, max: 2, step: 0.1 })}
          </div>
          <div class="field-grid-3">
            <div class="field">
              <label for="tts-base-url">接口地址</label>
              <input class="input" id="tts-base-url" value="${attr(s.tts.baseUrl)}" placeholder="https://api.openai.com/v1" />
              <span class="hint">阿里百炼填 https://dashscope.aliyuncs.com、专属工作空间地址或完整接口地址（.../multimodal-generation/generation）均可</span>
            </div>
            <div class="field">
              <label for="tts-model">模型</label>
              <input class="input" id="tts-model" value="${attr(s.tts.model)}" placeholder="tts-1 / qwen-tts / qwen3-tts-flash / MiniMax/speech-2.8-hd" />
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
          <div><div class="card-title">AI 画面生成</div><div class="card-sub">选择模型渠道后只需填写 API Key，其余参数自动生成</div></div>
          <span class="pill ${s.videoGen.provider === "http" ? "pill-brand" : "pill-soft"}">${s.videoGen.provider === "http" ? (s.videoGen.apiKeySet ? "已启用" : "待填 API Key") : "未启用"}</span>
        </div>
        <div class="card-body">
          <div class="settings-note">${icon("info", 16)}<span><strong>选择渠道后只需要填 API Key</strong>：模型、接口地址、提交/查询路径、轮询与超时参数会按渠道自动生成。阿里百炼走 <code>wan3.0-video</code> 异步视频接口；One API Lumi 走 <code>Seedance 2.5 / 2.0</code> 的 <code>/api/v3/contents/generations/tasks</code> 任务接口。<strong>One API Lumi / AIRONGCE 只接受公网参考图</strong>：通过公网域名/IP 访问本控制台时会自动识别地址，把本地角色/道具图转成带令牌的只读链接；也可在下方手动填写公网素材地址。没有 Key 时任务会在本地预检阶段报错，不会发起付费请求；切换渠道后请换填对应平台的 Key。</span></div>
          <div class="field-grid-2">
            <div class="field">
              <label for="videogen-channel">模型渠道</label>
              <select class="select" id="videogen-channel">
                ${options(videoChannels.map((item) => [item.channel, item.label]), s.videoGen.channel)}
              </select>
              <span class="hint" id="videogen-channel-hint">${esc(activeVideoChannel?.description ?? "")}</span>
            </div>
            <div class="field">
              <label>自动生成参数</label>
              <span class="hint" id="videogen-auto-hint">选中渠道后地址、模型、路径等参数自动生成，只需要填写 API Key。</span>
            </div>
          </div>
          <div id="videogen-key-wrap" ${activeVideoChannel?.channel === "none" ? "hidden" : ""}>
            ${secretField("videogen-api-key", "API Key（只需填这一项）", { set: s.videoGen.apiKeySet, hint: s.videoGen.apiKeyHint }, "只填所选渠道的 API Key；其余参数由渠道自动生成，切换渠道后请换填对应平台的 Key")}
          </div>
          <div class="field-grid-3" id="videogen-auto-fields" ${activeVideoChannel?.fields ? "" : "hidden"}>
            <div class="field" id="videogen-model-select-wrap" ${videoModelOptions.length ? "" : "hidden"}>
              <label for="videogen-channel-model">模型（可切换）</label>
              <select class="select" id="videogen-channel-model">
                ${videoModelOptions.map((item) => `<option value="${attr(item.id)}" ${item.id === activeVideoModel?.id ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
              </select>
              <span class="hint" id="videogen-model-hint">${esc(activeVideoModel?.hint ?? "")}</span>
            </div>
            <div class="field" id="videogen-model-readonly-wrap" ${videoModelOptions.length ? "hidden" : ""}>
              <label>模型（自动）</label><input class="input" id="videogen-auto-model" readonly />
            </div>
            <div class="field"><label>接口地址（自动）</label><input class="input" id="videogen-auto-base-url" readonly /></div>
            <div class="field"><label>接口协议（自动）</label><input class="input" id="videogen-auto-protocol" readonly /></div>
            <div class="field"><label>提交路径（自动）</label><input class="input" id="videogen-auto-submit-path" readonly /></div>
            <div class="field"><label>查询路径（自动）</label><input class="input" id="videogen-auto-poll-path" readonly /></div>
            <div class="field"><label>轮询 / 超时（自动）</label><input class="input" id="videogen-auto-timing" readonly /></div>
          </div>
          <span class="hint" id="videogen-auto-result-hint"></span>
          <div class="field" id="videogen-public-base-wrap" ${activeVideoChannel?.referenceImagesSupported === false ? "" : "hidden"}>
            <label for="videogen-public-base-url">公网素材地址 <span class="optional">通常不用填</span></label>
            <input class="input" id="videogen-public-base-url" value="${attr(s.videoGen.publicBaseUrl ?? "")}" placeholder="https://video.example.com" />
            <span class="hint">One API Lumi / AIRONGCE 只能读取公网图片（AIRONGCE 必须是 HTTPS）。通过公网域名/IP 访问本控制台时会自动使用当前地址，一般不用填；填了则优先使用这里配置的地址。仅本机访问且留空时，含参考图的镜头会按纯文字生成。</span>
          </div>
          <div id="videogen-advanced" ${activeVideoChannel?.channel === "custom" ? "" : "hidden"}>
            <div class="field-grid-3">
              <div class="field">
                <label for="videogen-provider">供应商</label>
                <select class="select" id="videogen-provider">
                  ${options([["none", "不使用"], ["http", "HTTP 文生/图生视频接口"]], s.videoGen.provider)}
                </select>
              </div>
              <div class="field">
                <label for="videogen-model">模型</label>
                <input class="input" id="videogen-model" value="${attr(s.videoGen.model)}" placeholder="video-gen-1" />
              </div>
              <div class="field">
                <label for="videogen-edit-model">局部编辑模型</label>
                <input class="input" id="videogen-edit-model" value="${attr(s.videoGen.editModel)}" placeholder="wan2.7-videoedit" />
                <span class="hint">成片详情里的「局部修改」用这个模型；仅阿里百炼渠道支持。</span>
              </div>
              <div class="field">
                <label for="videogen-base-url">接口地址</label>
                <input class="input" id="videogen-base-url" value="${attr(s.videoGen.baseUrl)}" placeholder="https://api.example.com" />
              </div>
            </div>
            <div class="field-grid-3">
              <div class="field">
                <label for="videogen-submit-path">提交路径</label>
                <input class="input" id="videogen-submit-path" value="${attr(s.videoGen.submitPath)}" />
              </div>
              <div class="field">
                <label for="videogen-poll-path">查询路径模板</label>
                <input class="input" id="videogen-poll-path" value="${attr(s.videoGen.pollPath)}" />
              </div>
              <div class="field">
                <label for="videogen-protocol">接口协议</label>
                <select class="select" id="videogen-protocol">
                  ${options([
                    ["auto", "自动（按服务地址）"],
                    ["dashscope", "阿里百炼 DashScope"],
                    ["seedance", "One API Lumi Seedance"],
                    ["airongce", "AIRONGCE Seedance"],
                    ["generic", "通用 HTTP 契约"],
                  ], s.videoGen.protocol ?? "auto")}
                </select>
                <div class="field-hint">服务地址或提交路径是阿里百炼时默认按异步接口发送；One API Lumi Seedance 会用 <code>content[]</code>（文字 + 公网图片）提交，并轮询 <code>content.video_url</code>；AIRONGCE 用扁平的 <code>images</code>/<code>first_frame_url</code> 提交，完成后从 <code>/v1/videos/{id}/content</code> 下载。</div>
              </div>
            </div>
            <div class="field-grid-3">
              ${numberField("videogen-poll-interval", "轮询间隔（毫秒）", s.videoGen.pollIntervalMs, { min: 200, max: 60000, step: 100 })}
              ${numberField("videogen-timeout", "超时（毫秒）", s.videoGen.timeoutMs, { min: 5000, max: 1800000, step: 1000 })}
              ${numberField("videogen-clip-duration", "单段时长（秒）", s.videoGen.clipDurationSec, { min: 2, max: 60 })}
            </div>
            <div class="field">
              <label for="videogen-result-path">视频地址字段 <span class="optional">可选，留空自动识别</span></label>
              <input class="input" id="videogen-result-path" value="${attr(s.videoGen.resultPath ?? "")}" placeholder="例如 data.output.video_url" />
              <span class="hint">自动兼容 video_url / url / output / data.* 等常见字段；聚合平台结构特殊时再填点号路径，取不到会自动回退</span>
            </div>
          </div>
          ${switchField("videogen-fallback", "生成失败时回退素材库", s.videoGen.fallbackToMaterials)}
          <div class="test-generator">
            <div class="field-grid-2">
              <div class="field">
                <label for="videogen-test-prompt">测试描述 <span class="optional">留空使用默认</span></label>
                <textarea class="textarea" id="videogen-test-prompt" rows="2" maxlength="500" placeholder="例如：一只橘猫在窗台上看雨，电影感，近景"></textarea>
              </div>
              <div class="field">
                <label for="videogen-test-duration">测试时长</label>
                <select class="select" id="videogen-test-duration">
                  <option value="3">3 秒</option>
                  <option value="5" selected>5 秒</option>
                </select>
              </div>
            </div>
            <div class="test-row">
              <button class="btn btn-ghost btn-sm" type="button" data-test="videogen">生成测试视频</button>
              <span class="test-result" id="test-videogen-result">测试使用已保存的配置，会真实生成视频并可能消耗额度；未完成时会复用同一任务继续查询</span>
            </div>
            <div class="test-row test-task-row">
              <input class="input test-task-input" id="videogen-test-task" placeholder="已有任务 ID（可选）：只取回该任务的视频，不重新生成" />
              <button class="btn btn-ghost btn-sm" type="button" data-resume="videogen">取回视频</button>
            </div>
            <div id="test-videogen-preview"></div>
          </div>
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">AI 角色图生成</div><div class="card-sub">按外貌设定生成角色/道具参考图，也可以继续手动上传</div></div>
          <span class="pill ${s.imageGen.provider === "bailian" && s.imageGen.apiKeySet ? "pill-brand" : "pill-soft"}">${s.imageGen.provider === "bailian" ? (s.imageGen.apiKeySet ? "已启用" : "待填 Key") : "未启用"}</span>
        </div>
        <div class="card-body">
          <div class="settings-note">${icon("info", 16)}<span>默认接<strong>阿里百炼 Qwen-Image</strong>，可在「模型」中切换 3.0 / 2.1 / 2.0 各档，填同一个百炼 API Key 即可；尺寸、负向提示词和提示词改写已预置。接口地址固定走百炼，<strong>不会沿用上面的 AI 画面地址</strong>，避免把百炼 Key 发到聚合平台后报 401 Invalid token。</span></div>
          <div class="field-grid-3">
            <div class="field">
              <label for="imagegen-provider">供应商</label>
              <select class="select" id="imagegen-provider">
                ${options([["bailian", "阿里百炼（Qwen-Image）"], ["none", "不使用"]], s.imageGen.provider)}
              </select>
            </div>
            <div class="field">
              <label for="imagegen-model">模型（可切换）</label>
              <select class="select" id="imagegen-model">
                ${imageGenModels.map((item) => `<option value="${attr(item.id)}" ${item.id === activeImageModel?.id ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
                ${customImageModel ? `<option value="${attr(customImageModel)}" selected>${esc(customImageModel)}（自定义）</option>` : ""}
              </select>
              <span class="hint" id="imagegen-model-hint">${esc(activeImageModel?.hint ?? "自定义模型：沿用通用参数生成；百炼 Key 只能调用百炼地址。")}</span>
            </div>
            <div class="field">
              <label for="imagegen-size">输出尺寸</label>
              <input class="input" id="imagegen-size" value="${attr(s.imageGen.size)}" placeholder="1152*1536" />
              <span class="hint">宽*高，总像素 512×512 到 2048×2048</span>
            </div>
          </div>
          ${secretField("imagegen-api-key", "图像生成 API Key", { set: s.imageGen.apiKeySet, hint: s.imageGen.apiKeyHint })}
          <div class="field">
            <label for="imagegen-base-url">接口地址 <span class="optional">百炼 Key 保持默认即可</span></label>
            <input class="input" id="imagegen-base-url" value="${attr(s.imageGen.baseUrl)}" placeholder="https://dashscope.aliyuncs.com" />
            <span class="hint">留空使用阿里百炼默认地址；也可填业务空间专属域名（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com）。不要填 One API Lumi 等聚合平台地址，百炼 Key 在那边会报 401 Invalid token。</span>
          </div>
          <div class="field">
            <label for="imagegen-negative">负向提示词 <span class="optional">可选</span></label>
            <textarea class="textarea" id="imagegen-negative" rows="2" maxlength="1000">${esc(s.imageGen.negativePrompt)}</textarea>
            <span class="hint">预置了低画质、畸形手指、过度光滑等常见问题；留空表示不发送。Qwen-Image 2.1 系列不支持该参数，选择后会自动跳过。</span>
          </div>
          ${switchField("imagegen-prompt-extend", "自动改写提示词", s.imageGen.promptExtend)}
          <div class="field-grid-2">
            ${numberField("imagegen-timeout", "超时（毫秒）", s.imageGen.timeoutMs, { min: 10000, max: 600000, step: 1000 })}
          </div>
          <div class="test-row">
            <button class="btn btn-ghost btn-sm" type="button" id="imagegen-preset">填入百炼 Qwen-Image 默认值</button>
            <span class="hint" id="imagegen-preset-hint">会把供应商、模型、尺寸、负向提示词恢复成百炼推荐值；填入后点「保存设置」</span>
          </div>
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
          <div><div class="card-title">口型同步（对白）</div><div class="card-sub">分镜渲染后把人物口型对齐到台词音轨</div></div>
          <span class="pill ${s.lipsync.enabled && s.lipsync.provider === "dashscope" ? "pill-brand" : "pill-soft"}">${s.lipsync.enabled && s.lipsync.provider === "dashscope" ? "已启用" : "未启用"}</span>
        </div>
        <div class="card-body">
          ${switchField("lipsync-enabled", "启用口型同步（对白）", s.lipsync.enabled, "关闭后成片阶段不调用口型校验；开启则沿用下面的供应商与参数")}
          <div class="settings-note">${icon("info", 16)}<span>默认接<strong>阿里云百炼 VideoRetalk</strong>（<code>videoretalk</code>）：提交人物视频 + 人声音频，返回口型对齐的新视频。只支持<strong>华北 2（北京）</strong>地域，必须使用该地域的 API Key；视频/音频需 2–120 秒、视频边长 640–2048、画面是人物正面近景。程序会先把本地文件上传到百炼临时存储（48 小时有效），再提交异步任务并轮询，成片按秒计费（0.08 元/秒）。只在同时满足「对话模式 + 分镜有台词 + 出现角色」时才调用。</span></div>
          <div class="field-grid-3">
            <div class="field">
              <label for="lipsync-provider">供应商</label>
              <select class="select" id="lipsync-provider">
                ${options([["none", "不使用"], ["dashscope", "阿里百炼 VideoRetalk"]], s.lipsync.provider)}
              </select>
            </div>
            <div class="field">
              <label for="lipsync-model">模型</label>
              <input class="input" id="lipsync-model" value="${attr(s.lipsync.model)}" placeholder="videoretalk" />
            </div>
            <div class="field">
              <label for="lipsync-base-url">接口地址</label>
              <input class="input" id="lipsync-base-url" value="${attr(s.lipsync.baseUrl)}" placeholder="https://dashscope.aliyuncs.com" />
            </div>
          </div>
          ${secretField("lipsync-api-key", "百炼 API Key（北京地域）", { set: s.lipsync.apiKeySet, hint: s.lipsync.apiKeyHint })}
          <div class="field-grid-2">
            ${numberField("lipsync-poll-interval", "轮询间隔（毫秒）", s.lipsync.pollIntervalMs, { min: 1000, max: 60000, step: 1000 })}
            ${numberField("lipsync-timeout", "超时（毫秒）", s.lipsync.timeoutMs, { min: 30000, max: 3600000, step: 10000 })}
          </div>
          ${switchField("lipsync-fallback", "口型失败时保留未对口型片段", s.lipsync.fallbackToUnsynced)}
        </div>
      </section>

      <section class="card settings-card">
        <div class="card-head">
          <div><div class="card-title">抖音发布</div><div class="card-sub">个人号小程序投稿，或开放平台应用自动发布</div></div>
          <span class="pill ${douyin?.mode === "miniapp" ? (douyin?.publicBaseUrlSet ? "pill-warning" : "pill-soft") : douyin?.authorized ? "pill-success" : douyin?.configured ? "pill-warning" : "pill-soft"}">${douyin?.mode === "miniapp" ? (douyin?.publicBaseUrlSet ? "小程序待发布" : "待配公网地址") : douyin?.authorized ? "已授权" : douyin?.configured ? "待授权" : "未配置"}</span>
        </div>
        <div class="card-body">
          <div class="field">
            <label for="douyin-mode">接入方式</label>
            <select class="select" id="douyin-mode">
              <option value="miniapp" ${s.douyin.mode === "miniapp" ? "selected" : ""}>个人号小程序投稿（人工确认发布）</option>
              <option value="open-platform" ${s.douyin.mode !== "miniapp" ? "selected" : ""}>开放平台应用（企业/网站应用，自动发布）</option>
            </select>
          </div>
          <div class="settings-note" id="douyin-miniapp-note" ${s.douyin.mode === "miniapp" ? "" : "hidden"}>${icon("info", 16)}<span>个人号小程序投稿：在抖音开放平台创建个人主体小程序，申请「短视频自主挂载」并绑定有效粉丝超过 500 的普通抖音号。成片先下载到手机相册，再在小程序里选择视频、由抖音发布器确认发布；不需要 client_key / client_secret，也不是服务端静默发布。仓库 <span class="mono">miniapp/</span> 目录是配套小程序页面。</span></div>
          <div id="douyin-credentials-fields" ${s.douyin.mode === "miniapp" ? "hidden" : ""}>
            <div class="field-grid-2">
              <div class="field">
                <label for="douyin-client-key">client_key</label>
                <input class="input" id="douyin-client-key" value="${attr(s.douyin.clientKey)}" placeholder="开放平台应用的 client_key" />
              </div>
              <div class="field" id="douyin-scope-field">
                <label for="douyin-scope">scope</label>
                <input class="input" id="douyin-scope" value="${attr(s.douyin.scope)}" placeholder="user_info,video.create" />
              </div>
            </div>
            ${secretField("douyin-client-secret", "client_secret", { set: s.douyin.clientSecretSet, hint: s.douyin.clientSecretHint })}
          </div>
          <div id="douyin-open-platform-fields" ${s.douyin.mode === "miniapp" ? "hidden" : ""}>
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
          </div>
          <div class="test-row">
            <button class="btn btn-ghost btn-sm" type="button" data-test="douyin">测试发布配置</button>
            <span class="test-result" id="test-douyin-result">测试使用已保存的配置</span>
            ${s.douyin.mode !== "miniapp" && douyin?.configured ? `<button class="btn btn-ghost btn-sm" type="button" id="settings-connect-douyin">${icon("external", 15)} ${douyin.authorized ? "重新授权" : "授权抖音"}</button>` : ""}
            ${s.douyin.mode !== "miniapp" && douyin?.authorized ? `<button class="btn btn-danger btn-sm" type="button" id="settings-disconnect-douyin">断开连接</button>` : ""}
            <span class="hint">应用信息保存后生效</span>
          </div>
        </div>
      </section>

      ${isAdmin ? usersCardHtml() : ""}

      <div class="save-bar">
        <span class="save-state" id="save-state">修改后点击保存；新任务生效</span>
        <button class="btn btn-primary" id="save-settings" type="button">保存设置</button>
      </div>
    </div>`;

  const markDirty = (event) => {
    if (event?.target?.closest?.("#user-dialog")) return;
    if (event?.target?.closest?.(".test-generator")) return;
    const stateEl = document.getElementById("save-state");
    if (stateEl) stateEl.textContent = "有未保存的修改";
  };
  view.oninput = markDirty;
  view.onchange = markDirty;

  const refreshVoiceOptions = async () => {
    const provider = document.getElementById("tts-provider")?.value ?? s.tts.provider;
    const model = document.getElementById("tts-model")?.value ?? s.tts.model;
    const next = await loadVoiceCatalog(true, provider, model);
    const datalist = document.getElementById("tts-voice-options");
    if (datalist) {
      datalist.innerHTML = next.voices
        .map((item) => `<option value="${attr(item.value)}">${esc(item.label)}</option>`)
        .join("");
    }
    const hint = document.getElementById("tts-voice-hint");
    if (hint) hint.textContent = next.hint;
  };
  document.getElementById("tts-provider")?.addEventListener("change", () => void refreshVoiceOptions());
  document.getElementById("tts-model")?.addEventListener("change", () => void refreshVoiceOptions());
  document.getElementById("save-settings").addEventListener("click", () => {
    void saveSettings();
  });

  // 渠道切换：选中预设渠道后自动回填地址、模型、路径与轮询参数，用户只需要填 Key。
  const videoChannelSelect = document.getElementById("videogen-channel");
  const videoChannelHint = document.getElementById("videogen-channel-hint");
  const videoKeyWrap = document.getElementById("videogen-key-wrap");
  const videoAutoFields = document.getElementById("videogen-auto-fields");
  const videoAdvanced = document.getElementById("videogen-advanced");
  const videoModelSelect = document.getElementById("videogen-channel-model");
  const videoModelSelectWrap = document.getElementById("videogen-model-select-wrap");
  const videoModelReadonlyWrap = document.getElementById("videogen-model-readonly-wrap");
  const videoModelHint = document.getElementById("videogen-model-hint");
  const videoPublicBaseWrap = document.getElementById("videogen-public-base-wrap");
  const setVideoField = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  const videoField = (id) => document.getElementById(id)?.value ?? "";
  const updateVideoModelHint = (models) => {
    if (!videoModelHint) return;
    const current = models.find((item) => item.id === videoField("videogen-model"));
    videoModelHint.textContent = current?.hint ?? "";
  };
  const syncVideoChannel = (channel, resetModel = false) => {
    const option = videoChannels.find((item) => item.channel === channel);
    const fields = option?.fields;
    const models = option?.models ?? [];
    if (videoChannelHint) videoChannelHint.textContent = option?.description ?? "";
    if (videoKeyWrap) videoKeyWrap.hidden = channel === "none";
    if (videoAutoFields) videoAutoFields.hidden = !fields;
    if (videoAdvanced) videoAdvanced.hidden = channel !== "custom";
    if (videoPublicBaseWrap) videoPublicBaseWrap.hidden = option?.referenceImagesSupported !== false;
    if (fields) {
      setVideoField("videogen-provider", fields.provider);
      setVideoField("videogen-protocol", fields.protocol);
      setVideoField("videogen-base-url", fields.baseUrl);
      setVideoField("videogen-edit-model", fields.editModel);
      setVideoField("videogen-submit-path", fields.submitPath);
      setVideoField("videogen-poll-path", fields.pollPath);
      setVideoField("videogen-poll-interval", String(fields.pollIntervalMs));
      setVideoField("videogen-timeout", String(fields.timeoutMs));
      setVideoField("videogen-clip-duration", String(fields.clipDurationSec));
      setVideoField("videogen-result-path", fields.resultPath);
    } else if (channel === "none") {
      setVideoField("videogen-provider", "none");
    } else if (videoField("videogen-provider") === "none") {
      setVideoField("videogen-provider", "http");
    }
    if (models.length > 0) {
      const selectedId = resetModel
        ? fields?.model
        : models.find((item) => item.id === videoField("videogen-model"))?.id ?? fields?.model;
      const selected = models.find((item) => item.id === selectedId) ?? models[0];
      if (videoModelSelect) {
        videoModelSelect.innerHTML = models
          .map((item) => `<option value="${attr(item.id)}">${esc(item.label)}</option>`)
          .join("");
        videoModelSelect.value = selected.id;
      }
      setVideoField("videogen-model", selected.id);
      if (videoModelSelectWrap) videoModelSelectWrap.hidden = false;
      if (videoModelReadonlyWrap) videoModelReadonlyWrap.hidden = true;
      updateVideoModelHint(models);
    } else {
      if (videoModelSelectWrap) videoModelSelectWrap.hidden = true;
      if (videoModelReadonlyWrap) videoModelReadonlyWrap.hidden = false;
      if (fields) setVideoField("videogen-model", fields.model);
    }
    const autoValues = {
      "videogen-auto-model": videoField("videogen-model"),
      "videogen-auto-base-url": videoField("videogen-base-url"),
      "videogen-auto-protocol": videoField("videogen-protocol"),
      "videogen-auto-submit-path": videoField("videogen-submit-path"),
      "videogen-auto-poll-path": videoField("videogen-poll-path"),
      "videogen-auto-timing": `${videoField("videogen-poll-interval")} 毫秒 / ${videoField("videogen-timeout")} 毫秒`,
    };
    for (const [id, value] of Object.entries(autoValues)) {
      const el = document.getElementById(id);
      if (el) el.value = value;
    }
    const resultHint = document.getElementById("videogen-auto-result-hint");
    if (resultHint) {
      const resultPath = videoField("videogen-result-path");
      resultHint.textContent = `视频地址字段（自动）：${resultPath || "自动识别"}`;
    }
  };
  videoChannelSelect?.addEventListener("change", () => syncVideoChannel(videoChannelSelect.value, true));
  videoModelSelect?.addEventListener("change", () => {
    setVideoField("videogen-model", videoModelSelect.value);
    updateVideoModelHint(videoChannels.find((item) => item.channel === videoChannelSelect?.value)?.models ?? []);
  });
  syncVideoChannel(s.videoGen.channel);

  const imageModelSelect = document.getElementById("imagegen-model");
  const imageModelHint = document.getElementById("imagegen-model-hint");
  const updateImageModelHint = () => {
    if (!imageModelHint) return;
    const selected = imageGenModels.find((item) => item.id === imageModelSelect?.value);
    imageModelHint.textContent =
      selected?.hint ?? "自定义模型：沿用通用参数生成；百炼 Key 只能调用百炼地址。";
  };
  imageModelSelect?.addEventListener("change", updateImageModelHint);

  document.getElementById("imagegen-preset")?.addEventListener("click", () => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set("imagegen-provider", "bailian");
    set("imagegen-model", "qwen-image-2.0-pro");
    set("imagegen-base-url", "https://dashscope.aliyuncs.com");
    set("imagegen-size", "1152*1536");
    set("imagegen-negative", "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。");
    const extend = document.getElementById("imagegen-prompt-extend");
    if (extend) extend.checked = true;
    set("imagegen-timeout", "300000");
    updateImageModelHint();
    const hint = document.getElementById("imagegen-preset-hint");
    if (hint) hint.textContent = "已填入百炼 Qwen-Image 默认值（地址、模型、尺寸），点「保存设置」后即可在角色库生成";
  });

  for (const button of view.querySelectorAll("[data-test]")) {
    button.addEventListener("click", () => {
      void testProvider(button.dataset.test, button);
    });
  }
  for (const button of view.querySelectorAll("[data-resume]")) {
    button.addEventListener("click", () => {
      const input = document.getElementById("videogen-test-task");
      const taskId = (input?.value ?? "").trim();
      if (!taskId) {
        const result = document.getElementById("test-videogen-result");
        if (result) {
          result.textContent = "请先填写任务 ID";
          result.className = "test-result fail";
        }
        return;
      }
      void testProvider(button.dataset.resume, button, { resumeTaskId: taskId });
    });
  }
  const douyinModeSelect = document.getElementById("douyin-mode");
  const syncDouyinMode = () => {
    const miniapp = (douyinModeSelect?.value ?? "open-platform") === "miniapp";
    const note = document.getElementById("douyin-miniapp-note");
    const credentials = document.getElementById("douyin-credentials-fields");
    const openFields = document.getElementById("douyin-open-platform-fields");
    if (note) note.hidden = !miniapp;
    if (credentials) credentials.hidden = miniapp;
    if (openFields) openFields.hidden = miniapp;
    const connect = document.getElementById("settings-connect-douyin");
    const disconnect = document.getElementById("settings-disconnect-douyin");
    if (connect) connect.hidden = miniapp;
    if (disconnect) disconnect.hidden = miniapp;
  };
  douyinModeSelect?.addEventListener("change", syncDouyinMode);
  syncDouyinMode();
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
  if (isAdmin) bindUserManagement();
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
    enabled: checked("tts-enabled"),
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
    channel: value("videogen-channel"),
    provider: value("videogen-provider"),
    model: value("videogen-model").trim(),
    editModel: value("videogen-edit-model").trim() || "wan2.7-videoedit",
    baseUrl: value("videogen-base-url").trim(),
    submitPath: value("videogen-submit-path").trim(),
    pollPath: value("videogen-poll-path").trim(),
    protocol: value("videogen-protocol"),
    pollIntervalMs: number("videogen-poll-interval"),
    timeoutMs: number("videogen-timeout"),
    clipDurationSec: number("videogen-clip-duration"),
    resultPath: value("videogen-result-path").trim(),
    publicBaseUrl: value("videogen-public-base-url").trim(),
    fallbackToMaterials: checked("videogen-fallback"),
  };
  const videoGenKey = secret("videogen-api-key");
  if (videoGenKey !== undefined) videoGen.apiKey = videoGenKey;

  const imageGen = {
    provider: value("imagegen-provider"),
    model: value("imagegen-model").trim() || "qwen-image-2.0-pro",
    size: value("imagegen-size").trim() || "1152*1536",
    baseUrl: value("imagegen-base-url").trim(),
    negativePrompt: value("imagegen-negative").trim(),
    promptExtend: checked("imagegen-prompt-extend"),
    timeoutMs: number("imagegen-timeout"),
  };
  const imageGenKey = secret("imagegen-api-key");
  if (imageGenKey !== undefined) imageGen.apiKey = imageGenKey;

  const lipsyncEnabled = checked("lipsync-enabled");
  const lipsyncProvider = value("lipsync-provider");
  const lipsync = {
    enabled: lipsyncEnabled,
    // 总开关打开但供应商还是「不使用」时，直接切到唯一的云供应商，避免开关看似开了却没生效。
    provider: lipsyncEnabled && lipsyncProvider === "none" ? "dashscope" : lipsyncProvider,
    model: value("lipsync-model").trim(),
    baseUrl: value("lipsync-base-url").trim(),
    pollIntervalMs: number("lipsync-poll-interval"),
    timeoutMs: number("lipsync-timeout"),
    fallbackToUnsynced: checked("lipsync-fallback"),
  };
  const lipsyncKey = secret("lipsync-api-key");
  if (lipsyncKey !== undefined) lipsync.apiKey = lipsyncKey;

  const douyin = {
    mode: value("douyin-mode") || "open-platform",
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
    imageGen,
    lipsync,
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
    // 供应商/模型变了，角色库和创作页的音色下拉要重新按新模型拉取。
    voiceCatalogCache.clear();
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

/** 测试任务还没出片时自动继续查询：不重新提交，也不重复扣费。 */
function scheduleVideoTestResume(button) {
  stopVideoTestAuto();
  const elapsed = (Date.now() - videoTestAuto.startedAt) / 1000;
  if (elapsed > 15 * 60) return;
  videoTestAuto.timer = setTimeout(() => {
    videoTestAuto.timer = 0;
    if (!document.contains(button)) return;
    void testProvider("videogen", button, { resumeTaskId: videoTestAuto.taskId, auto: true });
  }, 5000);
}

async function testProvider(kind, button, options = {}) {
  const result = document.getElementById(`test-${kind}-result`);
  const preview = kind === "videogen" ? document.getElementById("test-videogen-preview") : null;
  button.disabled = true;
  if (result) {
    result.textContent = "测试中…";
    result.className = "test-result";
  }
  if (preview && !options.auto) preview.innerHTML = "";
  if (kind === "videogen" && !options.auto) stopVideoTestAuto();
  try {
    const body = { kind };
    if (kind === "videogen" && options.resumeTaskId) {
      body.resumeTaskId = options.resumeTaskId;
      body.durationSec = Number(document.getElementById("videogen-test-duration")?.value ?? 5);
      if (result) result.textContent = `正在取回任务 ${options.resumeTaskId} 的视频，不会重新生成…`;
    } else if (kind === "videogen") {
      const prompt = document.getElementById("videogen-test-prompt")?.value ?? "";
      const durationSec = Number(document.getElementById("videogen-test-duration")?.value ?? 5);
      body.prompt = prompt;
      body.durationSec = durationSec;
      videoTestAuto.startedAt = Date.now();
      const reusable =
        pendingVideoTest &&
        pendingVideoTest.taskId &&
        pendingVideoTest.prompt === prompt.trim() &&
        pendingVideoTest.durationSec === durationSec;
      if (reusable) {
        body.resumeTaskId = pendingVideoTest.taskId;
        if (result) {
          result.textContent = `继续查询上次已提交的任务（${pendingVideoTest.taskId}），不会重复提交…`;
        }
      } else {
        // 上一个任务还在生成时改提示词/时长会再提交一条新任务（再扣一次费），先确认。
        if (pendingVideoTest && pendingVideoTest.taskId) {
          const ok = window.confirm(
            `上一个任务 ${pendingVideoTest.taskId} 还在生成，重新提交会再生成一条视频并可能再次扣费。\n\n` +
              "只想取回旧任务：把提示词和时长改回原样再点测试。\n继续提交新任务吗？",
          );
          if (!ok) {
            if (result) {
              result.textContent = `已取消：没有提交新任务，${pendingVideoTest.taskId} 还可以继续等待。`;
            }
            stopVideoTestAuto();
            return;
          }
        }
        if (result) result.textContent = "生成中…（可能需要 1–2 分钟）";
      }
    }
    const data = await api("/api/settings/test", { method: "POST", body });
    if (result) {
      if (kind === "script") {
        result.textContent = `连接成功：${data.provider}，生成 ${data.segments} 个分镜`;
      } else if (kind === "tts") {
        result.textContent = `连接成功：${data.provider} / ${data.voice}，${Number(data.durationSec).toFixed(1)} 秒`;
      } else if (kind === "videogen") {
        // 已提交但还没出片：不要显示成“失败”，也不能让用户误以为需要重新提交。
        if (data.pending) {
          pendingVideoTest = data.taskId
            ? {
                taskId: data.taskId,
                prompt: String(data.prompt ?? "").trim(),
                durationSec: Number(data.durationSec),
              }
            : null;
          const taskInput = document.getElementById("videogen-test-task");
          if (taskInput && data.taskId) taskInput.value = data.taskId;
          button.textContent = data.taskId ? "继续等待这个任务" : "重新生成测试视频";
          if (data.taskId) {
            videoTestAuto.taskId = data.taskId;
            if (!videoTestAuto.startedAt) videoTestAuto.startedAt = Date.now();
            const waited = (Date.now() - videoTestAuto.startedAt) / 1000;
            const statusText = data.lastStatus ? `，平台状态 ${String(data.lastStatus).toUpperCase()}` : "";
            result.textContent = data.submitted
              ? `已提交，正在自动继续查询（已等待 ${formatWaited(waited)}${statusText}），不会重复提交或扣费。`
              : data.message;
            scheduleVideoTestResume(button);
          } else {
            videoTestAuto.startedAt = 0;
            result.textContent = data.message;
          }
        } else {
          pendingVideoTest = null;
          stopVideoTestAuto();
          videoTestAuto.startedAt = 0;
          button.textContent = "生成测试视频";
          result.textContent = data.reused
            ? `生成成功：${data.model}，${Number(data.durationSec).toFixed(1)} 秒（复用之前已提交的任务，未重复扣费）`
            : `生成成功：${data.model}，${Number(data.durationSec).toFixed(1)} 秒（本次只提交 1 次生成）`;
          if (preview && data.videoUrl) {
            preview.innerHTML = `<video class="test-video" controls playsinline preload="metadata" src="${attr(data.videoUrl)}"></video>`;
          }
        }
        result.className = data.pending ? "test-result warn" : "test-result ok";
        return;
      } else if (kind === "douyin") {
        result.textContent =
          data.mode === "miniapp"
            ? data.publicBaseUrlSet
              ? "小程序投稿已就绪：出片后可以生成手机下载二维码"
              : "小程序投稿已就绪；配置 https 公网地址后可生成下载二维码"
            : `连接成功：应用凭证有效，client_token 有效期 ${Number(data.expiresInSec) || 0} 秒`;
      } else {
        result.textContent = "连接成功";
      }
      result.className = "test-result ok";
    }
  } catch (error) {
    stopVideoTestAuto();
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
  // 预览编辑用文档级委托：预览区域会被重新渲染，绑在旧容器上的监听会丢。
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return;
    if (input.dataset.preview && input.closest("#preview-body")) updatePreviewFromInput(input);
  });
  window.addEventListener("hashchange", () => {
    if (state.user) void render();
  });
  window.addEventListener("va:unauthorized", () => {
    if (state.user) showAuth("login", "登录已过期，请重新登录");
  });
  document.getElementById("logout-btn")?.addEventListener("click", () => {
    void logout();
  });
  handleDouyinQuery();
  let session;
  try {
    session = await api("/api/auth/session");
  } catch (error) {
    showAuth("login", `无法读取登录状态：${error.message}`);
    return;
  }
  if (!session.authenticated) {
    showAuth(session.needsSetup ? "setup" : "login");
    return;
  }
  state.user = session.user;
  state.permissions = session.menus ?? [];
  await startApp();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
} else {
  void init();
}

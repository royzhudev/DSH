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
  createDialogue: false,
  createTopic: "",
  createStory: "",
  pollTimer: null,
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
    <div class="script-head">
      <h3>${esc(script.title)}</h3>
      <p>${esc(script.summary)}</p>
      <div class="script-meta">
        <span class="pill pill-soft">目标 ${esc(data.targetDurationSec)} 秒</span>
        <span class="pill pill-soft">${esc(script.segments.length)} 个分镜</span>
        ${(data.cast ?? []).length ? `<span class="pill pill-soft">${esc(data.cast.length)} 个角色/道具</span>` : ""}
      </div>
    </div>
    ${script.segments
      .map(
        (segment) => `<div class="script-segment">
          <span class="seg-index">${esc(segment.id)}</span>
          <div>
            ${
              (segment.lines ?? []).length
                ? `<ul class="seg-lines">${segment.lines
                    .map((line) => `<li><span class="seg-speaker">${esc(line.speaker)}</span>${esc(line.text)}</li>`)
                    .join("")}</ul>`
                : `<p class="seg-text">${esc(segment.narration)}</p>`
            }
            ${segment.scene || segment.shot ? `<p class="seg-shot">${[segment.scene, segment.shot].filter(Boolean).map((text) => esc(text)).join(" · ")}</p>` : ""}
            ${
              (segment.cast ?? []).length
                ? `<div class="seg-tags">${segment.cast.map((name) => `<span class="tag tag-brand">${esc(name)}</span>`).join("")}</div>`
                : ""
            }
            ${
              segment.keywords?.length
                ? `<div class="seg-tags">${segment.keywords.map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join("")}</div>`
                : ""
            }
          </div>
        </div>`,
      )
      .join("")}
    ${renderCreationReview(data.review)}
    <p class="fineprint">预览和正式生成会各自调用一次模型，分镜内容可能略有差异。</p>
  </div>`;
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
  const target = Number(settings.script.targetDurationSec) || 45;
  const durations = [...new Set([15, 30, 45, 60, target])].sort((a, b) => a - b);
  const segmentOptions = [...new Set([3, 4, 5, 6, Number(settings.script.maxSegments) || 6])].sort(
    (a, b) => a - b,
  );
  const videoGenReady = settings.videoGen.provider === "http";
  const castWithImages = cast.filter((asset) => asset.imageFile).length;

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
              <span class="hint">分镜写成“角色：台词”，每个角色用自己的音色；关闭则用第三人称旁白讲解。角色音色可在「角色与道具」里设置，未设置会自动分配。</span>
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
    targetDurationSec: Number(activeDuration?.dataset.value ?? 45),
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
    ...(values.castIds ? { castIds: values.castIds } : {}),
    ...(values.dialogue ? { dialogue: true } : {}),
  };
  if (values.story) body.story = values.story;
  if (values.voice) body.voice = values.voice;
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
  const cast = job.cast ?? [];
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
                <div class="material-meta">${formatDuration(segment.durationSec)}</div>
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

/* ---------------- cast ---------------- */

function castThumb(asset) {
  if (!asset.imageUrl) {
    return `<span class="cast-placeholder">${icon(asset.kind === "character" ? "users" : "box", 26)}</span>`;
  }
  const version = encodeURIComponent(asset.updatedAt ?? "");
  return `<img loading="lazy" src="${attr(asset.imageUrl)}?v=${version}" alt="${attr(asset.name)}" />`;
}

function castCardHtml(asset) {
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
    </div>
    <div class="material-foot">
      <div class="cast-actions">
        <button class="icon-btn" type="button" data-edit-cast="${attr(asset.id)}" title="编辑设定">${icon("pencil", 15)}</button>
        <button class="icon-btn" type="button" data-replace-cast="${attr(asset.id)}" title="${asset.imageFile ? "更换参考图" : "上传参考图"}">${icon("image", 15)}</button>
        <button class="icon-btn" type="button" data-delete-cast="${attr(asset.id)}" title="删除">${icon("trash", 15)}</button>
      </div>
      <span class="material-meta">${formatDate(asset.updatedAt)}</span>
    </div>
  </article>`;
}

function castUploadCardHtml() {
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
        <input class="input" id="cast-voice" list="cast-voice-options" placeholder="留空自动分配；例如 zh-CN-YunxiNeural" maxlength="60" />
        <datalist id="cast-voice-options">
          ${EDGE_VOICES.map(([value, label]) => `<option value="${attr(value)}">${esc(label)}</option>`).join("")}
        </datalist>
        <span class="hint">开启「人物对话」时，这个角色用该音色；留空时按名字自动分配，不同角色尽量不同音色</span>
      </div>
      <div class="dropzone" id="cast-dropzone">
        ${icon("upload", 26)}
        <strong id="cast-drop-title">点击或拖拽上传参考图</strong>
        <small id="cast-drop-hint">支持 jpg / png / webp，可选；没有参考图时只做文字一致性</small>
        <input type="file" id="cast-file-input" accept="image/*,.jpg,.jpeg,.png,.webp" />
      </div>
      <div class="actions">
        <button class="btn btn-primary" id="cast-add-btn" type="button" disabled>${icon("plus", 16)} 添加</button>
      </div>
    </div>
  </section>`;
}

function castDialogHtml() {
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
          <input class="input" id="cast-edit-voice" list="cast-edit-voice-options" maxlength="60" placeholder="留空自动分配" />
          <datalist id="cast-edit-voice-options">
            ${EDGE_VOICES.map(([value, label]) => `<option value="${attr(value)}">${esc(label)}</option>`).join("")}
          </datalist>
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

async function renderCast() {
  setPage("角色库", "角色与道具");
  view.innerHTML = loadingView("正在读取角色库…");
  const data = await api("/api/cast");
  if (state.route.name !== "cast") return;
  const cast = data.cast ?? [];
  state.cast = cast;
  view.innerHTML = `
    <section class="page-head">
      <p class="eyebrow">Cast & Props</p>
      <h2>角色与道具</h2>
      <p>给人物和关键物品建立设定与参考图。生成短剧时，同一角色/道具会复用同一套外观描述和参考图，保证跨镜头、甚至跨视频延续同一形象。</p>
    </section>
    ${castUploadCardHtml()}
    <div class="materials-toolbar mt-24">
      <span class="muted small">共 ${cast.length} 个设定${cast.filter((asset) => asset.imageFile).length ? ` · ${cast.filter((asset) => asset.imageFile).length} 个有参考图` : ""}</span>
      <a class="btn btn-ghost btn-sm" href="#/create">${icon("plus", 15)} 去创作</a>
    </div>
    ${
      cast.length
        ? `<div class="material-grid">${cast.map(castCardHtml).join("")}</div>`
        : emptyState("users", "还没有角色或道具", "添加人物或物品的参考图与外观设定，之后的分镜会保持同一形象。")
    }
    <input type="file" id="cast-image-input" accept="image/*,.jpg,.jpeg,.png,.webp" hidden />
    ${castDialogHtml()}`;

  const kindPicker = document.getElementById("cast-kind");
  const fileInput = document.getElementById("cast-file-input");
  const dropzone = document.getElementById("cast-dropzone");
  const addButton = document.getElementById("cast-add-btn");
  const dropTitle = document.getElementById("cast-drop-title");
  const dropHint = document.getElementById("cast-drop-hint");
  const nameInput = document.getElementById("cast-name");
  const descInput = document.getElementById("cast-desc");
  const imageInput = document.getElementById("cast-image-input");
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
  const redirectUri = s.douyin.effectiveRedirectUri;

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
          <div><div class="card-title">AI 画面生成</div><div class="card-sub">可选：文生视频 + 图生视频，有角色参考图时自动沿用同一形象</div></div>
          <span class="pill ${s.videoGen.provider === "http" ? "pill-brand" : "pill-soft"}">${s.videoGen.provider === "http" ? "已启用" : "未启用"}</span>
        </div>
        <div class="card-body">
          <div class="settings-note">${icon("info", 16)}<span>默认接<strong>阿里百炼</strong>的 Wan 视频模型（<code>wan3.0-video</code>），API Key 需要自己填写；没有 Key 时任务会在本地预检阶段报错，不会产生费用。百炼各接口对异步的要求不一样：video-synthesis <strong>必须带异步请求头</strong> <code>X-DashScope-Async: enable</code>（缺少时报 <code>does not support synchronous calls</code>），任务查询接口是同步的，<strong>不能</strong>带这个头（带上会报 <code>does not support asynchronous calls</code>），程序只在提交时添加；平台在两个方向都用 403 表态时还会自动切换一次并重试。返回 <code>output.task_id</code> 后查询 <code>/api/v1/tasks/{id}</code> 得到 <code>output.video_url</code>；万相 3.0 用 <code>parameters.resolution/ratio/duration</code>，图生视频首帧放 <code>input.media[type=first_frame]</code>。通用 HTTP 契约则提交 <code>{model, prompt, duration_sec, aspect_ratio}</code> 并返回 video_url 或任务 id，图生视频额外携带 <code>image</code> 与 <code>reference_images</code>；返回字段兼容嵌套与数组形式。</span></div>
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
              <label for="videogen-base-url">接口地址</label>
              <input class="input" id="videogen-base-url" value="${attr(s.videoGen.baseUrl)}" placeholder="https://api.example.com" />
            </div>
          </div>
          ${secretField("videogen-api-key", "API Key", { set: s.videoGen.apiKeySet, hint: s.videoGen.apiKeyHint })}
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
                  ["generic", "通用 HTTP 契约"],
                ], s.videoGen.protocol ?? "auto")}
              </select>
              <div class="field-hint">服务地址或提交路径是阿里百炼时默认按异步接口发送（带 X-DashScope-Async: enable）；平台说只支持同步时会自动去掉该头重试一次，不用自己处理</div>
            </div>
          </div>
          <div class="test-row">
            <button class="btn btn-ghost btn-sm" type="button" id="videogen-preset">一键填入百炼 Wan 3.0 默认值</button>
            <span class="hint" id="videogen-preset-hint">会把协议、地址、模型、路径恢复成阿里百炼的异步视频接口；填入后点「保存设置」再测试</span>
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
            <button class="btn btn-ghost btn-sm" type="button" data-test="douyin">测试应用配置</button>
            <span class="test-result" id="test-douyin-result">测试使用已保存的配置</span>
            ${douyin?.configured ? `<button class="btn btn-ghost btn-sm" type="button" id="settings-connect-douyin">${icon("external", 15)} ${douyin.authorized ? "重新授权" : "授权抖音"}</button>` : ""}
            ${douyin?.authorized ? `<button class="btn btn-danger btn-sm" type="button" id="settings-disconnect-douyin">断开连接</button>` : ""}
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

  document.getElementById("save-settings").addEventListener("click", () => {
    void saveSettings();
  });

  // 百炼接错地址/协议时最容易反复踩坑，给一个一键恢复默认值的入口。
  document.getElementById("videogen-preset")?.addEventListener("click", () => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set("videogen-provider", "http");
    set("videogen-protocol", "dashscope");
    set("videogen-base-url", "https://dashscope.aliyuncs.com");
    set("videogen-model", "wan3.0-video");
    set("videogen-submit-path", "/api/v1/services/aigc/video-generation/video-synthesis");
    set("videogen-poll-path", "/api/v1/tasks/{id}");
    set("videogen-poll-interval", "3000");
    set("videogen-timeout", "600000");
    set("videogen-result-path", "");
    const hint = document.getElementById("videogen-preset-hint");
    if (hint) hint.textContent = "已填入百炼 Wan 3.0 默认值，点「保存设置」后即可测试";
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
    protocol: value("videogen-protocol"),
    pollIntervalMs: number("videogen-poll-interval"),
    timeoutMs: number("videogen-timeout"),
    clipDurationSec: number("videogen-clip-duration"),
    resultPath: value("videogen-result-path").trim(),
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
        result.textContent = `连接成功：应用凭证有效，client_token 有效期 ${Number(data.expiresInSec) || 0} 秒`;
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

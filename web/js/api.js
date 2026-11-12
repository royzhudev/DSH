async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function notifyUnauthorized(path, response) {
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent("va:unauthorized"));
  }
}

export async function api(path, options = {}) {
  const { method = "GET", body, headers = {}, signal } = options;
  const init = { method, headers: { ...headers }, signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new Error(error instanceof Error ? `网络请求失败：${error.message}` : "网络请求失败");
  }
  const data = await parseResponse(response);
  if (!response.ok) {
    notifyUnauthorized(path, response);
    const message = data?.error?.message ?? data?.message ?? `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

export async function uploadMaterial(file, { title = "", tags = "" } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (title.trim()) form.append("title", title.trim());
  if (tags.trim()) form.append("tags", tags.trim());
  let response;
  try {
    response = await fetch("/api/materials", { method: "POST", body: form });
  } catch (error) {
    throw new Error(error instanceof Error ? `上传失败：${error.message}` : "上传失败");
  }
  const data = await parseResponse(response);
  if (!response.ok) {
    notifyUnauthorized("/api/materials", response);
    throw new Error(data?.error?.message ?? `上传失败（HTTP ${response.status}）`);
  }
  return data;
}

export async function uploadCast(file, { kind = "character", name = "", description = "" } = {}) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("name", name);
  form.append("description", description);
  if (file) form.append("file", file);
  return postForm("/api/cast", form, "添加失败");
}

export async function replaceCastImage(id, file) {
  const form = new FormData();
  form.append("file", file);
  return postForm(`/api/cast/${id}/image`, form, "上传参考图失败");
}

async function postForm(path, form, label) {
  let response;
  try {
    response = await fetch(path, { method: "POST", body: form });
  } catch (error) {
    throw new Error(error instanceof Error ? `${label}：${error.message}` : label);
  }
  const data = await parseResponse(response);
  if (!response.ok) {
    notifyUnauthorized(path, response);
    throw new Error(data?.error?.message ?? `${label}（HTTP ${response.status}）`);
  }
  return data;
}

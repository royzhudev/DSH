async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
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
    throw new Error(data?.error?.message ?? `上传失败（HTTP ${response.status}）`);
  }
  return data;
}

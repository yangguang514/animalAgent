async function parseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function request(path, options) {
  return fetch(path, options).then(parseJson);
}

export const chatApi = {
  list: () => request("/api/conversations"),
  create: () => request("/api/conversations", { method: "POST" }),
  get: (id) => request(`/api/conversations/${id}`),
  clear: (id) => request(`/api/conversations/${id}/clear`, { method: "POST" }),
  remove: (id) => request(`/api/conversations/${id}`, { method: "DELETE" }),
  listDocuments: () => request("/api/documents"),
  processDocument: (payload) =>
    request("/api/documents/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  uploadDocumentDirect: (file) =>
    request("/api/documents/direct", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name)
      },
      body: file
    }),
  removeDocument: (id) => request(`/api/documents/${id}`, { method: "DELETE" }),
  import: (payload) =>
    request("/api/conversations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
};

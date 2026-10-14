// HTTP client for the model-store service.
export function createStoreClient({ baseUrl, token }) {
  const url = (suffix = '') => `${baseUrl.replace(/\/+$/, '')}/api/v1/models${suffix}`;
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const timeout = () => AbortSignal.timeout(30_000);

  async function ok(response) {
    if (response.ok) return response;
    let detail = '';
    try {
      detail = (await response.json()).error ?? '';
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `Model store error (HTTP ${response.status})`);
  }

  return {
    async list() {
      return (await ok(await fetch(url(), { headers: auth, signal: timeout() }))).json();
    },
    async download(id) {
      const response = await ok(await fetch(url(`/${id}`), { headers: auth, signal: timeout() }));
      return Buffer.from(await response.arrayBuffer());
    },
    async create(name, content) {
      const response = await fetch(url(), {
        method: 'POST',
        headers: { ...auth, 'X-Model-Name': encodeURIComponent(name) },
        body: content,
        signal: timeout(),
      });
      return (await ok(response)).json();
    },
    async replace(id, content, name) {
      const response = await fetch(url(`/${id}`), {
        method: 'PUT',
        headers: { ...auth, ...(name ? { 'X-Model-Name': encodeURIComponent(name) } : {}) },
        body: content,
        signal: timeout(),
      });
      return (await ok(response)).json();
    },
  };
}

// Minimal Anthropic Messages API client (non-streaming, with retries).
const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createMessage({ apiKey, baseUrl, body, signal, timeoutMs = 120_000 }) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    });
    if (response.ok) return response.json();
    if (RETRYABLE.has(response.status) && attempt < 2) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    let detail = response.statusText;
    try {
      detail = (await response.json())?.error?.message ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(`Anthropic API error (${response.status}): ${detail}`);
  }
}

const AUTH_TOKEN_KEY = 'databricks-auth-token';
const SKIP_AUTH_RECOVERY_HEADER = 'X-Skip-Auth-Recovery';
const RELOAD_GUARD_KEY = 'databricks-auth-reload-at';
const RELOAD_MIN_INTERVAL_MS = 30_000;

const originalFetch = window.fetch.bind(window);

function recoverFromAuthExpiry(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
  const now = Date.now();
  if (now - last > RELOAD_MIN_INTERVAL_MS) {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
    window.location.reload();
  }
}

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  const isApi = url.startsWith('/api/');
  const skipRecovery = new Headers(init?.headers).has(SKIP_AUTH_RECOVERY_HEADER);

  if (isApi) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token) {
      const headers = new Headers(init?.headers);
      if (!headers.has('X-Forwarded-Access-Token')) {
        headers.set('X-Forwarded-Access-Token', token);
        init = { ...init, headers };
      }
    }
  }

  const response = await originalFetch(input, init);

  if (isApi && !skipRecovery) {
    if (response.status === 401) {
      recoverFromAuthExpiry();
    } else if (response.ok) {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
    }
  }

  return response;
};

export { AUTH_TOKEN_KEY, SKIP_AUTH_RECOVERY_HEADER };

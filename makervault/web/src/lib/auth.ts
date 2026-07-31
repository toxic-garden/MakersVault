const TOKEN_KEY = "makersvault_auth_token";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  return storage.getItem(TOKEN_KEY);
}

export function storeToken(token: string) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  const storage = getStorage();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
}

export function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init || {});
  const token = readToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export function appendTokenToUrl(url: string): string {
  const token = readToken();
  if (!token) return url;
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
}

/**
 * Decode the stored token's payload and return its expiry timestamp (in seconds).
 * Does not verify the signature; this is only for client-side UX decisions.
 * Returns null if there is no token or the payload cannot be parsed.
 */
export function readTokenExpiry(): number | null {
  const token = readToken();
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(json);
    if (typeof data?.exp === "number") return data.exp;
  } catch {
    // ignore malformed tokens
  }
  return null;
}

/** Return true if a stored token exists and its local expiry is in the past. */
export function isTokenLocallyExpired(): boolean {
  const exp = readTokenExpiry();
  if (!exp) return false;
  return Date.now() / 1000 >= exp;
}

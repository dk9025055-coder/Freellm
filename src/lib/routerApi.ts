import type {
  CustomEndpoint,
  RouterRuntimeSnapshot,
  VaultPayload,
} from '../../shared/types.ts';

function buildMasterHeaders(masterKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (masterKey && masterKey.trim()) {
    headers['X-Router-Master-Key'] = masterKey.trim();
    headers['Authorization'] = `Bearer ${masterKey.trim()}`;
  }
  return headers;
}

export async function fetchRouterState(): Promise<RouterRuntimeSnapshot> {
  const res = await fetch('/api/router/state');
  if (!res.ok) {
    throw new Error(`Failed to fetch router state (${res.status})`);
  }
  return res.json();
}

export async function syncVaultToServerRam(
  vault: VaultPayload,
  masterKey?: string
): Promise<{ ok: boolean; snapshot: RouterRuntimeSnapshot }> {
  const res = await fetch('/api/router/sync', {
    method: 'POST',
    headers: buildMasterHeaders(masterKey),
    body: JSON.stringify(vault),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.error || `Sync failed (${res.status})`);
  }
  return data;
}

export async function clearServerRam(
  masterKey?: string
): Promise<{ ok: boolean; snapshot: RouterRuntimeSnapshot }> {
  const res = await fetch('/api/router/clear', {
    method: 'POST',
    headers: buildMasterHeaders(masterKey),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.error || `Clear failed (${res.status})`);
  }
  return data;
}

export async function clearRouterCooldown(
  keyId?: string
): Promise<{ ok: boolean; snapshot: RouterRuntimeSnapshot }> {
  const res = await fetch('/api/router/cooldown/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId }),
  });
  return res.json();
}

export async function clearRouterLogs(): Promise<{
  ok: boolean;
  snapshot: RouterRuntimeSnapshot;
}> {
  const res = await fetch('/api/router/logs/clear', { method: 'POST' });
  return res.json();
}

export async function testProviderKeyLive(params: {
  providerId: string;
  apiKey: string;
  accountId?: string;
  modelId?: string;
  customEndpoint?: CustomEndpoint;
  masterKey?: string;
}): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
  modelUsed: string;
}> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.masterKey && params.masterKey.trim()) {
    headers['X-Router-Master-Key'] = params.masterKey.trim();
    headers['Authorization'] = `Bearer ${params.masterKey.trim()}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('/api/router/test-key', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs: 0,
        message: data?.error?.message || data?.message || `HTTP ${res.status}`,
        modelUsed: params.modelId || '',
      };
    }
    return data;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        status: 408,
        latencyMs: 30000,
        message: 'Test timed out after 30s',
        modelUsed: params.modelId || '',
      };
    }
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Network error',
      modelUsed: params.modelId || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

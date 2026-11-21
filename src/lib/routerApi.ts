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
}): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
  modelUsed: string;
}> {
  const res = await fetch('/api/router/test-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

import { BUILTIN_PROVIDERS, DEFAULT_ROUTING_PROFILES, getProviderById, mergeCustomModelsIntoProvider } from '../shared/providers.ts';
import type {
  CustomEndpoint,
  KeyUsageStats,
  ModelCapability,
  ProviderCatalogEntry,
  RouterLogEntry,
  RouterRuntimeSnapshot,
  RoutingProfile,
  StoredApiKey,
  VaultPayload,
} from '../shared/types.ts';

export interface ResolvedCandidate {
  keyId: string;
  keyLabel: string;
  apiKey: string;
  accountId?: string;
  provider: ProviderCatalogEntry;
  modelId: string;
  smartnessScore: number;
  speedScore: number;
  isServerEnvKey?: boolean;
}

interface InternalKeyMetrics {
  keyId: string;
  providerId: string;
  label: string;
  minuteTimestamps: number[];
  dayKey: string;
  rpd: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  failoversTriggered: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  emaLatencyMs: number;
  lastUsedAt?: number;
}

interface CooldownEntry {
  until: number;
  reason: string;
}

const COOLDOWN_DURATION_MS = 60_000; // 60-second cooldown on 429/5xx
const MAX_LOGS = 250;
const SERVER_GEMINI_KEY_ID = '__server_env_gemini__';

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

class InMemoryRouterState {
  private keys: StoredApiKey[] = [];
  private customEndpoints: CustomEndpoint[] = [];
  private customModels: Record<string, string[]> = {};
  private profiles: RoutingProfile[] = [...DEFAULT_ROUTING_PROFILES];
  private syncedAt: number | null = null;
  private source: RouterRuntimeSnapshot['source'] = 'empty';

  private metrics = new Map<string, InternalKeyMetrics>();
  private cooldowns = new Map<string, CooldownEntry>(); // key: `${keyId}::${modelId}` and also `${keyId}::*`
  private logs: RouterLogEntry[] = [];
  private roundRobinCursor = 0;

  constructor() {
    if (this.hasServerGeminiEnv()) {
      this.source = 'server-gemini-only';
    }
  }

  hasServerGeminiEnv(): boolean {
    const val = process.env.GEMINI_API_KEY?.trim();
    return Boolean(val && val !== 'MY_GEMINI_API_KEY');
  }

  isMasterKeyRequired(): boolean {
    return Boolean(process.env.ROUTER_MASTER_KEY?.trim());
  }

  verifyMasterKey(provided?: string): boolean {
    const expected = process.env.ROUTER_MASTER_KEY?.trim();
    if (!expected) return true;
    return Boolean(provided && provided.trim() === expected);
  }

  syncVault(payload: VaultPayload, source: 'browser-sync' | 'env-vault') {
    this.keys = (payload.keys || []).map((k) => ({ ...k }));
    this.customEndpoints = (payload.customEndpoints || []).map((c) => ({ ...c }));
    this.customModels =
      payload.customModels && typeof payload.customModels === 'object'
        ? { ...payload.customModels }
        : {};
    this.profiles =
      Array.isArray(payload.profiles) && payload.profiles.length > 0
        ? payload.profiles.map((p) => ({ ...p, hops: [...p.hops] }))
        : [...DEFAULT_ROUTING_PROFILES];
    this.syncedAt = Date.now();
    this.source = source;

    // Ensure metric records exist for synced keys
    for (const key of this.keys) {
      if (!this.metrics.has(key.id)) {
        this.metrics.set(key.id, this.createEmptyMetric(key.id, key.providerId, key.label));
      } else {
        const existing = this.metrics.get(key.id)!;
        existing.label = key.label;
        existing.providerId = key.providerId;
      }
    }
  }

  clearRam() {
    this.keys = [];
    this.customEndpoints = [];
    this.customModels = {};
    this.profiles = [...DEFAULT_ROUTING_PROFILES];
    this.syncedAt = null;
    this.cooldowns.clear();
    this.source = this.hasServerGeminiEnv() ? 'server-gemini-only' : 'empty';
  }

  clearLogs() {
    this.logs = [];
  }

  clearCooldown(keyId?: string) {
    if (!keyId) {
      this.cooldowns.clear();
      return;
    }
    for (const k of Array.from(this.cooldowns.keys())) {
      if (k.startsWith(`${keyId}::`)) {
        this.cooldowns.delete(k);
      }
    }
  }

  private createEmptyMetric(keyId: string, providerId: string, label: string): InternalKeyMetrics {
    return {
      keyId,
      providerId,
      label,
      minuteTimestamps: [],
      dayKey: utcDayKey(),
      rpd: 0,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      failoversTriggered: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      emaLatencyMs: 0,
    };
  }

  private getOrCreateMetric(keyId: string, providerId: string, label: string): InternalKeyMetrics {
    let m = this.metrics.get(keyId);
    if (!m) {
      m = this.createEmptyMetric(keyId, providerId, label);
      this.metrics.set(keyId, m);
    }
    const today = utcDayKey();
    if (m.dayKey !== today) {
      m.dayKey = today;
      m.rpd = 0;
    }
    const cutoff = Date.now() - 60_000;
    m.minuteTimestamps = m.minuteTimestamps.filter((ts) => ts >= cutoff);
    return m;
  }

  isCoolingDown(keyId: string, modelId: string): CooldownEntry | null {
    const now = Date.now();
    const specificKey = `${keyId}::${modelId}`;
    const specific = this.cooldowns.get(specificKey);
    if (specific) {
      if (specific.until > now) return specific;
      this.cooldowns.delete(specificKey);
    }
    const wildKey = `${keyId}::*`;
    const wild = this.cooldowns.get(wildKey);
    if (wild) {
      if (wild.until > now) return wild;
      this.cooldowns.delete(wildKey);
    }
    return null;
  }

  markCooldown(keyId: string, providerId: string, label: string, modelId: string, reason: string, status: number) {
    const until = Date.now() + COOLDOWN_DURATION_MS;
    this.cooldowns.set(`${keyId}::${modelId}`, { until, reason });
    // If 429 on key level, also cool down this key/model; for 429 rate-limit we cool down specific model first
    if (status === 429 && reason.toLowerCase().includes('quota')) {
      this.cooldowns.set(`${keyId}::*`, { until, reason });
    }
    const m = this.getOrCreateMetric(keyId, providerId, label);
    m.failoversTriggered += 1;
    m.failedRequests += 1;
    m.totalRequests += 1;
    m.minuteTimestamps.push(Date.now());
    m.rpd += 1;
    m.lastUsedAt = Date.now();
  }

  recordAttemptSuccess(
    keyId: string,
    providerId: string,
    label: string,
    latencyMs: number,
    promptTokens: number,
    completionTokens: number
  ) {
    const m = this.getOrCreateMetric(keyId, providerId, label);
    const now = Date.now();
    m.minuteTimestamps.push(now);
    m.rpd += 1;
    m.totalRequests += 1;
    m.successRequests += 1;
    m.promptTokens += promptTokens;
    m.completionTokens += completionTokens;
    m.totalTokens += promptTokens + completionTokens;
    m.emaLatencyMs = m.emaLatencyMs === 0 ? latencyMs : Math.round(m.emaLatencyMs * 0.7 + latencyMs * 0.3);
    m.lastUsedAt = now;
  }

  recordAttemptFailure(keyId: string, providerId: string, label: string) {
    const m = this.getOrCreateMetric(keyId, providerId, label);
    const now = Date.now();
    m.minuteTimestamps.push(now);
    m.rpd += 1;
    m.totalRequests += 1;
    m.failedRequests += 1;
    m.lastUsedAt = now;
  }

  addLog(entry: RouterLogEntry) {
    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.length = MAX_LOGS;
    }
  }

  getAllProviders(): ProviderCatalogEntry[] {
    const customs: ProviderCatalogEntry[] = this.customEndpoints.map((c) => ({
      id: c.id,
      name: c.name,
      adapter: c.adapter,
      baseUrl: c.baseUrl,
      tier: c.adapter === 'ollama' ? 'local' : 'custom',
      creditCardRequired: false,
      freeQuotaSummary: `Custom ${c.adapter.toUpperCase()} endpoint`,
      signupUrl: c.baseUrl,
      keyPlaceholder: 'Custom key',
      defaultRpmLimit: 60,
      defaultRpdLimit: 10000,
      extraHeaders: c.extraHeaders,
      isCustom: true,
      models: c.models.map((m) => ({
        id: m,
        label: m,
        capabilities: ['chat', 'coding', 'tools'],
        contextWindow: 128000,
        smartnessScore: 85,
        speedScore: 85,
      })),
    }));
    const merged = [...BUILTIN_PROVIDERS, ...customs].map((p) =>
      mergeCustomModelsIntoProvider(p, this.customModels)
    );
    return merged;
  }

  getProfiles(): RoutingProfile[] {
    return this.profiles;
  }

  private getActiveKeys(): StoredApiKey[] {
    const enabled = this.keys.filter((k) => k.enabled && k.apiKey.trim().length > 0);
    // Include server-managed Gemini channel if process.env.GEMINI_API_KEY is present
    // and user hasn't already provided a Gemini key (or as an automatic fallback!)
    if (this.hasServerGeminiEnv()) {
      const serverKey: StoredApiKey = {
        id: SERVER_GEMINI_KEY_ID,
        providerId: 'gemini',
        label: 'Server Gemini Channel',
        apiKey: process.env.GEMINI_API_KEY!.trim(),
        enabled: true,
        rpmLimit: 15,
        rpdLimit: 1500,
        createdAt: 0,
      };
      return [...enabled, serverKey];
    }
    return enabled;
  }

  /**
   * Lists all routable model IDs (routing profiles + provider/model pairs) for /v1/models
   */
  listExposedModels(): Array<{ id: string; owned_by: string; created: number }> {
    const now = Math.floor(Date.now() / 1000);
    const items: Array<{ id: string; owned_by: string; created: number }> = [
      { id: 'auto', owned_by: 'relaygate-router', created: now },
      { id: 'auto:fast', owned_by: 'relaygate-router', created: now },
      { id: 'auto:round-robin', owned_by: 'relaygate-router', created: now },
    ];

    for (const p of this.profiles) {
      items.push({ id: p.name, owned_by: 'relaygate-profile', created: now });
    }

    const activeProviderIds = new Set(this.getActiveKeys().map((k) => k.providerId));
    const allProviders = this.getAllProviders();

    for (const provider of allProviders) {
      if (activeProviderIds.has(provider.id)) {
        for (const m of provider.models) {
          items.push({
            id: `${provider.id}/${m.id}`,
            owned_by: provider.name,
            created: now,
          });
        }
      }
    }

    return items;
  }

  /**
   * Resolves ordered candidate list for a requested model/strategy and required capability.
   * Skips cooled-down keys unless ALL keys are in cooldown (then returns least-remaining cooldown as fallback notice).
   */
  resolveCandidates(
    requestedModel: string | undefined,
    requiredCapability: ModelCapability = 'chat'
  ): { candidates: ResolvedCandidate[]; skippedCooldowns: number } {
    const modelStr = (requestedModel || 'auto').trim();
    const activeKeys = this.getActiveKeys();
    const allProviders = this.getAllProviders();
    const providerMap = new Map(allProviders.map((p) => [p.id, p]));

    let rawCandidates: ResolvedCandidate[] = [];

    const pushProviderModelCandidates = (providerId: string, modelId: string) => {
      const provider = providerMap.get(providerId);
      if (!provider) return;
      const matchingKeys = activeKeys.filter((k) => k.providerId === providerId);
      if (matchingKeys.length === 0) return;

      const modelMeta = provider.models.find((m) => m.id === modelId);
      for (const k of matchingKeys) {
        rawCandidates.push({
          keyId: k.id,
          keyLabel: k.label,
          apiKey: k.apiKey,
          accountId: k.accountId,
          provider,
          modelId,
          smartnessScore: modelMeta?.smartnessScore ?? 85,
          speedScore: modelMeta?.speedScore ?? 85,
          isServerEnvKey: k.id === SERVER_GEMINI_KEY_ID,
        });
      }
    };

    // 1. Check custom named routing profiles (e.g. auto:coding, auto:vision)
    const matchedProfile = this.profiles.find(
      (p) => p.name.toLowerCase() === modelStr.toLowerCase()
    );
    if (matchedProfile) {
      for (const hop of matchedProfile.hops) {
        if (!hop.enabled) continue;
        pushProviderModelCandidates(hop.providerId, hop.modelId);
      }
      // Also append any other capable active keys as ultimate safety net
      if (rawCandidates.length === 0) {
        for (const k of activeKeys) {
          const provider = providerMap.get(k.providerId);
          if (!provider) continue;
          const capModel =
            provider.models.find((m) => m.capabilities.includes(requiredCapability)) ||
            provider.models[0];
          if (capModel) {
            pushProviderModelCandidates(provider.id, capModel.id);
          }
        }
      }
    } else if (
      modelStr === 'auto' ||
      modelStr === 'auto:smart' ||
      modelStr === 'auto:fast' ||
      modelStr === 'auto:round-robin'
    ) {
      // 2. Built-in smart routing strategies across all active keys
      for (const k of activeKeys) {
        const provider = providerMap.get(k.providerId);
        if (!provider) continue;
        const matchingModels = provider.models.filter((m) =>
          m.capabilities.includes(requiredCapability)
        );
        const candidatesForProvider =
          matchingModels.length > 0
            ? matchingModels
            : requiredCapability === 'chat'
              ? provider.models.slice(0, 1)
              : [];

        // Pick best model per provider for the requested strategy
        const sortedModels = [...candidatesForProvider].sort((a, b) =>
          modelStr === 'auto:fast'
            ? b.speedScore - a.speedScore
            : b.smartnessScore - a.smartnessScore
        );

        for (const m of sortedModels.slice(0, 2)) {
          rawCandidates.push({
            keyId: k.id,
            keyLabel: k.label,
            apiKey: k.apiKey,
            accountId: k.accountId,
            provider,
            modelId: m.id,
            smartnessScore: m.smartnessScore,
            speedScore: m.speedScore,
            isServerEnvKey: k.id === SERVER_GEMINI_KEY_ID,
          });
        }
      }

      if (modelStr === 'auto:fast') {
        rawCandidates.sort((a, b) => {
          const mA = this.metrics.get(a.keyId);
          const mB = this.metrics.get(b.keyId);
          const latA = mA && mA.emaLatencyMs > 0 ? mA.emaLatencyMs : (105 - a.speedScore) * 35;
          const latB = mB && mB.emaLatencyMs > 0 ? mB.emaLatencyMs : (105 - b.speedScore) * 35;
          return latA - latB;
        });
      } else if (modelStr === 'auto:round-robin') {
        if (rawCandidates.length > 1) {
          const shift = this.roundRobinCursor % rawCandidates.length;
          this.roundRobinCursor = (this.roundRobinCursor + 1) % 1_000_000;
          rawCandidates = [...rawCandidates.slice(shift), ...rawCandidates.slice(0, shift)];
        }
      } else {
        // Default `auto` (Smartest): sort by smartnessScore desc, preferring user keys before server fallback on tie
        rawCandidates.sort((a, b) => {
          if (b.smartnessScore !== a.smartnessScore) return b.smartnessScore - a.smartnessScore;
          if (a.isServerEnvKey !== b.isServerEnvKey) return a.isServerEnvKey ? 1 : -1;
          return b.speedScore - a.speedScore;
        });
      }
    } else if (modelStr.includes('/')) {
      // 3. Explicit provider/model syntax (careful: models like meta-llama/llama-3... also contain `/`)
      const firstSlash = modelStr.indexOf('/');
      const possibleProvider = modelStr.slice(0, firstSlash);
      const possibleModel = modelStr.slice(firstSlash + 1);

      if (providerMap.has(possibleProvider)) {
        pushProviderModelCandidates(possibleProvider, possibleModel);
      } else {
        // Search across providers whose model list matches exact modelStr
        for (const provider of allProviders) {
          if (provider.models.some((m) => m.id === modelStr)) {
            pushProviderModelCandidates(provider.id, modelStr);
          }
        }
      }
    } else {
      // 4. Bare model name (e.g. "gemini-4-hydrogen", "llama-3.3-70b-versatile", or Claude/GPT alias from CLI tools)
      for (const provider of allProviders) {
        if (provider.models.some((m) => m.id === modelStr)) {
          pushProviderModelCandidates(provider.id, modelStr);
        }
      }

      // If client passed an external model alias like "claude-3-7-sonnet" or "gpt-4o", fall back gracefully to `auto`!
      if (rawCandidates.length === 0) {
        return this.resolveCandidates('auto', requiredCapability);
      }
    }

    // Deduplicate identical (keyId, modelId) pairs while preserving order
    const seen = new Set<string>();
    const deduped: ResolvedCandidate[] = [];
    for (const c of rawCandidates) {
      const k = `${c.keyId}::${c.modelId}`;
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push(c);
      }
    }

    // Filter out cooled-down candidates
    const healthy: ResolvedCandidate[] = [];
    let skippedCooldowns = 0;
    for (const c of deduped) {
      if (this.isCoolingDown(c.keyId, c.modelId)) {
        skippedCooldowns += 1;
      } else {
        healthy.push(c);
      }
    }

    return { candidates: healthy, skippedCooldowns };
  }

  getSnapshot(): RouterRuntimeSnapshot {
    const now = Date.now();
    const activeKeys = this.getActiveKeys();
    const activeProviderIds = new Set(activeKeys.map((k) => k.providerId));

    const keyStats: KeyUsageStats[] = [];
    const includedKeyIds = new Set<string>();

    const buildStat = (keyId: string, providerId: string, label: string): KeyUsageStats => {
      const m = this.getOrCreateMetric(keyId, providerId, label);
      let cooldownUntil: number | null = null;
      let cooldownReason: string | undefined;

      for (const [ck, cd] of this.cooldowns.entries()) {
        if (ck.startsWith(`${keyId}::`) && cd.until > now) {
          if (!cooldownUntil || cd.until > cooldownUntil) {
            cooldownUntil = cd.until;
            cooldownReason = cd.reason;
          }
        }
      }

      return {
        keyId,
        providerId,
        label,
        rpm: m.minuteTimestamps.length,
        rpd: m.rpd,
        totalRequests: m.totalRequests,
        successRequests: m.successRequests,
        failedRequests: m.failedRequests,
        failoversTriggered: m.failoversTriggered,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        totalTokens: m.totalTokens,
        avgLatencyMs: m.emaLatencyMs,
        cooldownUntil,
        cooldownReason,
        lastUsedAt: m.lastUsedAt,
      };
    };

    for (const k of activeKeys) {
      includedKeyIds.add(k.id);
      keyStats.push(buildStat(k.id, k.providerId, k.label));
    }

    for (const [kId, m] of this.metrics.entries()) {
      if (!includedKeyIds.has(kId) && m.totalRequests > 0) {
        keyStats.push(buildStat(kId, m.providerId, m.label));
      }
    }

    let requests = 0;
    let successes = 0;
    let failures = 0;
    let failovers = 0;
    let totalTokens = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let activeCooldowns = 0;

    for (const s of keyStats) {
      requests += s.totalRequests;
      successes += s.successRequests;
      failures += s.failedRequests;
      failovers += s.failoversTriggered;
      totalTokens += s.totalTokens;
      if (s.avgLatencyMs > 0) {
        latencySum += s.avgLatencyMs;
        latencyCount += 1;
      }
      if (s.cooldownUntil && s.cooldownUntil > now) {
        activeCooldowns += 1;
      }
    }

    return {
      synced: this.syncedAt !== null || this.hasServerGeminiEnv(),
      syncedAt: this.syncedAt,
      source: this.source,
      masterKeyRequired: this.isMasterKeyRequired(),
      serverGeminiAvailable: this.hasServerGeminiEnv(),
      activeKeyCount: activeKeys.length,
      activeProviderCount: activeProviderIds.size,
      customEndpointCount: this.customEndpoints.length,
      profileCount: this.profiles.length,
      keyStats,
      recentLogs: this.logs.slice(0, 120),
      totals: {
        requests,
        successes,
        failures,
        failovers,
        totalTokens,
        avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
        activeCooldowns,
      },
    };
  }

  getProviderForTest(providerId: string): ProviderCatalogEntry | undefined {
    return getProviderById(providerId, this.customEndpoints, this.customModels);
  }

  getCustomModels(): Record<string, string[]> {
    return this.customModels;
  }
}

export const routerState = new InMemoryRouterState();

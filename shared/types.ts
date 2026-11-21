export type ProviderAdapter =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'cloudflare'
  | 'cohere'
  | 'ollama';

export type ModelCapability =
  | 'chat'
  | 'vision'
  | 'coding'
  | 'reasoning'
  | 'tools'
  | 'embeddings'
  | 'image';

export type ProviderTier =
  | 'permanent-free'
  | 'trial-credits'
  | 'keyless'
  | 'local'
  | 'custom';

export interface ProviderModel {
  id: string;
  label: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  smartnessScore: number; // 1-100 for `auto` routing
  speedScore: number; // 1-100 baseline for `auto:fast` prior
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  adapter: ProviderAdapter;
  baseUrl: string;
  tier: ProviderTier;
  creditCardRequired: boolean;
  freeQuotaSummary: string;
  signupUrl: string;
  keyPlaceholder: string;
  requiresAccountId?: boolean;
  defaultRpmLimit: number;
  defaultRpdLimit: number;
  extraHeaders?: Record<string, string>;
  models: ProviderModel[];
  isCore?: boolean; // Highlighted core 17 FreeLLMAPI providers
  isCustom?: boolean;
}

export interface StoredApiKey {
  id: string;
  providerId: string;
  label: string;
  apiKey: string;
  accountId?: string; // Used by Cloudflare Workers AI
  enabled: boolean;
  rpmLimit?: number;
  rpdLimit?: number;
  createdAt: number;
  lastTestedAt?: number;
  lastTestOk?: boolean;
  lastTestLatencyMs?: number;
  lastTestMessage?: string;
}

export interface CustomEndpoint {
  id: string;
  name: string;
  adapter: 'openai' | 'anthropic' | 'ollama';
  baseUrl: string;
  models: string[];
  extraHeaders?: Record<string, string>;
  createdAt: number;
}

export interface ChainHop {
  id: string;
  providerId: string;
  modelId: string;
  enabled: boolean;
}

export interface RoutingProfile {
  id: string;
  name: string; // e.g., "auto:coding", "auto:vision"
  description: string;
  strategy: 'ordered-chain' | 'smartest' | 'fastest' | 'round-robin';
  hops: ChainHop[];
  createdAt: number;
}

export interface VaultPayload {
  version: 1;
  updatedAt: number;
  keys: StoredApiKey[];
  customEndpoints: CustomEndpoint[];
  profiles: RoutingProfile[];
  defaultStrategy: string;
}

export interface EncryptedVaultEnvelope {
  format: 'relaygate-vault-v1';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64 (includes GCM auth tag)
  hasPin: boolean;
  updatedAt: number;
}

export interface KeyUsageStats {
  keyId: string;
  providerId: string;
  label: string;
  rpm: number;
  rpd: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  failoversTriggered: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  cooldownUntil: number | null; // epoch ms
  cooldownReason?: string;
  lastUsedAt?: number;
}

export interface RouterLogEntry {
  id: string;
  timestamp: number;
  surface:
    | '/v1/chat/completions'
    | '/v1/responses'
    | '/v1/completions'
    | '/v1/images/generations'
    | '/v1/embeddings'
    | '/v1/messages'
    | '/v1beta';
  requestedModel: string;
  routedProviderId: string;
  routedModelId: string;
  routedKeyLabel: string;
  routedVia: string;
  status: number;
  ok: boolean;
  stream: boolean;
  latencyMs: number;
  attempts: number;
  failovers: Array<{
    providerId: string;
    modelId: string;
    keyLabel: string;
    status: number;
    reason: string;
  }>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage?: string;
}

export interface RouterRuntimeSnapshot {
  synced: boolean;
  syncedAt: number | null;
  source: 'empty' | 'env-vault' | 'browser-sync' | 'server-gemini-only';
  masterKeyRequired: boolean;
  serverGeminiAvailable: boolean;
  activeKeyCount: number;
  activeProviderCount: number;
  customEndpointCount: number;
  profileCount: number;
  keyStats: KeyUsageStats[];
  recentLogs: RouterLogEntry[];
  totals: {
    requests: number;
    successes: number;
    failures: number;
    failovers: number;
    totalTokens: number;
    avgLatencyMs: number;
    activeCooldowns: number;
  };
}

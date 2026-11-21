import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  GripVertical,
  Plus,
  Terminal,
  Trash2,
} from 'lucide-react';
import { BUILTIN_PROVIDERS, getProviderById } from '../../shared/providers.ts';
import type {
  ChainHop,
  ProviderCatalogEntry,
  RouterRuntimeSnapshot,
  RoutingProfile,
  VaultPayload,
} from '../../shared/types.ts';

interface RoutingChainTabProps {
  vault: VaultPayload;
  runtime: RouterRuntimeSnapshot | null;
  onUpdateVault: (next: VaultPayload) => void;
  onJumpToVault: () => void;
}

type CliClientId = 'hermes' | 'opencode' | 'claude-code' | 'codex' | 'gemini-cli' | 'curl';

export const RoutingChainTab: React.FC<RoutingChainTabProps> = ({
  vault,
  runtime,
  onUpdateVault,
  onJumpToVault,
}) => {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    vault.profiles[0]?.id || ''
  );
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDesc, setNewProfileDesc] = useState('');
  const [showCreateProfile, setShowCreateProfile] = useState(false);

  const [addProviderId, setAddProviderId] = useState('gemini');
  const [addModelId, setAddModelId] = useState('gemini-4-hydrogen');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const [activeCli, setActiveCli] = useState<CliClientId>('claude-code');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const allProviders: ProviderCatalogEntry[] = useMemo(() => {
    const customEntries: ProviderCatalogEntry[] = vault.customEndpoints.map((c) => ({
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
    return [...BUILTIN_PROVIDERS, ...customEntries];
  }, [vault.customEndpoints]);

  const activeProfile: RoutingProfile | undefined =
    vault.profiles.find((p) => p.id === selectedProfileId) || vault.profiles[0];

  const activeProviderIds = useMemo(() => {
    const set = new Set(
      vault.keys.filter((k) => k.enabled && k.apiKey.trim()).map((k) => k.providerId)
    );
    if (runtime?.serverGeminiAvailable) {
      set.add('gemini');
    }
    return set;
  }, [vault.keys, runtime?.serverGeminiAvailable]);

  const selectedAddProvider = allProviders.find((p) => p.id === addProviderId) || allProviders[0];

  const handleSelectAddProvider = (pid: string) => {
    setAddProviderId(pid);
    const prov = allProviders.find((p) => p.id === pid);
    if (prov && prov.models.length > 0) {
      setAddModelId(prov.models[0].id);
    } else {
      setAddModelId('');
    }
  };

  const updateProfileHops = (profileId: string, hops: ChainHop[]) => {
    onUpdateVault({
      ...vault,
      profiles: vault.profiles.map((p) => (p.id === profileId ? { ...p, hops } : p)),
    });
  };

  const handleMoveHop = (index: number, direction: -1 | 1) => {
    if (!activeProfile) return;
    const target = index + direction;
    if (target < 0 || target >= activeProfile.hops.length) return;
    const next = [...activeProfile.hops];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    updateProfileHops(activeProfile.id, next);
  };

  const handleDropHop = (targetIndex: number) => {
    if (!activeProfile || dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...activeProfile.hops];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    updateProfileHops(activeProfile.id, next);
    setDragIndex(null);
  };

  const handleToggleHop = (hopId: string) => {
    if (!activeProfile) return;
    updateProfileHops(
      activeProfile.id,
      activeProfile.hops.map((h) => (h.id === hopId ? { ...h, enabled: !h.enabled } : h))
    );
  };

  const handleRemoveHop = (hopId: string) => {
    if (!activeProfile) return;
    updateProfileHops(
      activeProfile.id,
      activeProfile.hops.filter((h) => h.id !== hopId)
    );
  };

  const handleAddHop = () => {
    if (!activeProfile || !addProviderId || !addModelId.trim()) return;
    const nextHop: ChainHop = {
      id: `hop-${Date.now().toString(36)}`,
      providerId: addProviderId,
      modelId: addModelId.trim(),
      enabled: true,
    };
    updateProfileHops(activeProfile.id, [...activeProfile.hops, nextHop]);
  };

  const handleCreateProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newProfileName.trim().replace(/^auto:/i, '').toLowerCase().replace(/\s+/g, '-');
    if (!cleaned) return;
    const fullName = `auto:${cleaned}`;
    if (vault.profiles.some((p) => p.name.toLowerCase() === fullName)) return;

    const created: RoutingProfile = {
      id: `profile-${Date.now().toString(36)}`,
      name: fullName,
      description: newProfileDesc.trim() || 'Custom ordered fallback routing chain.',
      strategy: 'ordered-chain',
      hops: [
        {
          id: `hop-${Date.now().toString(36)}-1`,
          providerId: 'gemini',
          modelId: 'gemini-4-hydrogen',
          enabled: true,
        },
      ],
      createdAt: Date.now(),
    };
    onUpdateVault({
      ...vault,
      profiles: [...vault.profiles, created],
    });
    setSelectedProfileId(created.id);
    setNewProfileName('');
    setNewProfileDesc('');
    setShowCreateProfile(false);
  };

  const handleDeleteProfile = (id: string) => {
    if (vault.profiles.length <= 1) return;
    const remaining = vault.profiles.filter((p) => p.id !== id);
    onUpdateVault({ ...vault, profiles: remaining });
    if (selectedProfileId === id) {
      setSelectedProfileId(remaining[0]?.id || '');
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const authPlaceholder = runtime?.masterKeyRequired ? 'YOUR_ROUTER_MASTER_KEY' : 'relaygate-local';

  const cliSnippets: Record<CliClientId, { label: string; endpoint: string; snippet: string }> = {
    'claude-code': {
      label: 'Claude Code',
      endpoint: `${origin}/v1/messages`,
      snippet: `# Point Claude Code at RelayGate's Anthropic-compatible /v1/messages surface
export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="${authPlaceholder}"
export ANTHROPIC_MODEL="auto:coding"
claude`,
    },
    opencode: {
      label: 'OpenCode',
      endpoint: `${origin}/v1/chat/completions`,
      snippet: `// ~/.config/opencode/opencode.json
{
  "provider": {
    "relaygate": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "${origin}/v1",
        "apiKey": "${authPlaceholder}"
      },
      "models": {
        "auto": { "name": "RelayGate Smartest" },
        "auto:coding": { "name": "RelayGate Coding Chain" },
        "auto:fast": { "name": "RelayGate Fastest" }
      }
    }
  }
}`,
    },
    hermes: {
      label: 'Hermes Agent',
      endpoint: `${origin}/v1/chat/completions`,
      snippet: `# Configure Hermes Agent with RelayGate OpenAI-compatible routing
export OPENAI_BASE_URL="${origin}/v1"
export OPENAI_API_KEY="${authPlaceholder}"
export HERMES_MODEL="auto:coding"
hermes`,
    },
    codex: {
      label: 'Codex CLI',
      endpoint: `${origin}/v1/responses`,
      snippet: `# Codex CLI via OpenAI Responses API (/v1/responses)
export OPENAI_BASE_URL="${origin}/v1"
export OPENAI_API_KEY="${authPlaceholder}"
codex --model auto:coding`,
    },
    'gemini-cli': {
      label: 'Gemini CLI',
      endpoint: `${origin}/v1beta`,
      snippet: `# Gemini CLI via native Gemini-compatible /v1beta surface
export GOOGLE_GEMINI_BASE_URL="${origin}"
export GEMINI_API_KEY="${authPlaceholder}"
gemini --model auto`,
    },
    curl: {
      label: 'cURL',
      endpoint: `${origin}/v1/chat/completions`,
      snippet: `curl -i "${origin}/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${authPlaceholder}" \\
  -d '{
    "model": "auto:fast",
    "messages": [{"role": "user", "content": "Explain consistent hashing in 2 sentences."}]
  }'
# Check the X-Routed-Via response header to verify which provider served the request.`,
    },
  };

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1600);
  };

  const builtInStrategies = [
    {
      id: 'auto',
      title: 'auto (Smartest)',
      desc: 'Ranks active keys by model intelligence score, skipping cooled-down keys automatically.',
    },
    {
      id: 'auto:fast',
      title: 'auto:fast (Lowest Latency)',
      desc: 'Routes to the lowest rolling EMA latency provider (Cerebras, Groq, SambaNova, Gemini Flash).',
    },
    {
      id: 'auto:round-robin',
      title: 'auto:round-robin',
      desc: 'Distributes requests evenly across all healthy synced keys to stretch free daily quotas.',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Built-in Routing Strategies */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Built-in Routing Strategies
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Pass any strategy alias as the <code className="text-xs font-mono text-slate-700 dark:text-slate-300">model</code> parameter. Failed 429/5xx hops enter a 60s cooldown and fail over seamlessly.
            </p>
          </div>
          <button
            type="button"
            onClick={onJumpToVault}
            className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
          >
            Manage {vault.keys.length} Vault Keys
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {builtInStrategies.map((s) => {
            const isDefault = vault.defaultStrategy === s.id;
            return (
              <div
                key={s.id}
                className={`p-4 rounded-lg border transition-colors bg-white dark:bg-slate-900 ${
                  isDefault
                    ? 'border-blue-600 dark:border-blue-500'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <code className="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100">
                    {s.title}
                  </code>
                  <button
                    type="button"
                    onClick={() => onUpdateVault({ ...vault, defaultStrategy: s.id })}
                    className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      isDefault
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {isDefault ? 'Default' : 'Set Default'}
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  {s.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Custom Named Fallback Chains */}
      <section className="border-t border-slate-200 dark:border-slate-800 pt-8">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Custom Fallback-Chain Profiles
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Drag rows or use priority controls to define deterministic failover order for specialized workloads.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateProfile((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            New Profile
          </button>
        </div>

        {showCreateProfile && (
          <form
            onSubmit={handleCreateProfile}
            className="mb-5 p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 grid grid-cols-1 md:grid-cols-3 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Profile Alias (auto:name)
              </label>
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="e.g. summarize or agents"
                className="w-full px-3 py-2 text-sm font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Description
              </label>
              <input
                type="text"
                value={newProfileDesc}
                onChange={(e) => setNewProfileDesc(e.target.value)}
                placeholder="Fast models for background summaries"
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
              >
                Create Profile
              </button>
              <button
                type="button"
                onClick={() => setShowCreateProfile(false)}
                className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Profile Selector Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg mb-4 w-fit max-w-full overflow-x-auto">
          {vault.profiles.map((p) => {
            const active = activeProfile?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedProfileId(p.id)}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>

        {activeProfile && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100">
                    {activeProfile.name}
                  </code>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {activeProfile.hops.filter((h) => h.enabled).length} enabled hops
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {activeProfile.description}
                </p>
              </div>
              {vault.profiles.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleDeleteProfile(activeProfile.id)}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 px-2 py-1 rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Profile
                </button>
              )}
            </div>

            {/* Chain Table */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {activeProfile.hops.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  No hops configured yet. Add a provider and model below.
                </div>
              ) : (
                activeProfile.hops.map((hop, idx) => {
                  const prov = getProviderById(hop.providerId, vault.customEndpoints);
                  const hasActiveKey = activeProviderIds.has(hop.providerId);
                  return (
                    <div
                      key={hop.id}
                      draggable
                      onDragStart={() => setDragIndex(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleDropHop(idx)}
                      className={`px-4 py-3 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 transition-colors ${
                        dragIndex === idx
                          ? 'bg-blue-50/60 dark:bg-blue-950/30'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      } ${!hop.enabled ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <GripVertical
                          className="w-4 h-4 text-slate-400 cursor-grab shrink-0"
                          aria-hidden="true"
                        />
                        <span className="w-6 text-xs font-mono text-slate-400 tabular-nums shrink-0">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                              {prov?.name || hop.providerId}
                            </span>
                            <span className="text-slate-300 dark:text-slate-700">/</span>
                            <code className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate max-w-[260px] sm:max-w-[380px]">
                              {hop.modelId}
                            </code>
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                            <span
                              className={
                                hasActiveKey
                                  ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                                  : 'text-amber-700 dark:text-amber-400'
                              }
                            >
                              {hasActiveKey ? 'Key ready' : 'No key in vault'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{prov?.adapter.toUpperCase() || 'OPENAI'} adapter</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 ml-auto">
                        <button
                          type="button"
                          onClick={() => handleToggleHop(hop.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {hop.enabled ? 'Enabled' : 'Paused'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveHop(idx, -1)}
                          disabled={idx === 0}
                          aria-label="Move hop up"
                          className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-30 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveHop(idx, 1)}
                          disabled={idx === activeProfile.hops.length - 1}
                          aria-label="Move hop down"
                          className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-30 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveHop(hop.id)}
                          aria-label="Remove hop"
                          className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Add Hop Bar */}
            <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
              <select
                value={addProviderId}
                onChange={(e) => handleSelectAddProvider(e.target.value)}
                aria-label="Select provider"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                {allProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {activeProviderIds.has(p.id) ? '(Ready)' : ''}
                  </option>
                ))}
              </select>

              <select
                value={addModelId}
                onChange={(e) => setAddModelId(e.target.value)}
                aria-label="Select model"
                className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 flex-1 min-w-[200px]"
              >
                {(selectedAddProvider?.models || []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} — {m.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleAddHop}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Hop
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Multi-Surface Endpoints & CLI Quick-Connect */}
      <section className="border-t border-slate-200 dark:border-slate-800 pt-8">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Multi-Surface API Endpoints & Agent Quick-Connect
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Connect Hermes Agent, OpenCode, Claude Code, Codex CLI, or Gemini CLI directly to this router. Every response includes <code className="font-mono text-xs text-slate-700 dark:text-slate-300">X-Routed-Via</code>.
          </p>
        </div>

        {/* Surface Endpoint Reference Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {[
            { surface: 'OpenAI Chat / Tools', path: 'POST /v1/chat/completions' },
            { surface: 'OpenAI Responses / Codex', path: 'POST /v1/responses' },
            { surface: 'Anthropic / Claude Code', path: 'POST /v1/messages' },
            { surface: 'Gemini Native / CLI', path: 'POST /v1beta/models/:m:generateContent' },
            { surface: 'OpenAI Completions', path: 'POST /v1/completions' },
            { surface: 'Embeddings', path: 'POST /v1/embeddings' },
            { surface: 'Image Generations', path: 'POST /v1/images/generations' },
            { surface: 'Model Catalog', path: 'GET /v1/models' },
          ].map((ep) => (
            <div
              key={ep.path}
              className="px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg"
            >
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {ep.surface}
              </div>
              <code className="block text-xs font-mono text-slate-900 dark:text-slate-100 mt-1 truncate">
                {ep.path}
              </code>
            </div>
          ))}
        </div>

        {/* CLI Snippets */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 overflow-x-auto">
              {(Object.keys(cliSnippets) as CliClientId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveCli(id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeCli === id
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {cliSnippets[id].label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => copyText(activeCli, cliSnippets[activeCli].snippet)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0"
            >
              {copiedId === activeCli ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Config
                </>
              )}
            </button>
          </div>
          <div className="p-4 bg-slate-950 text-slate-100 overflow-x-auto">
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mb-2">
              <Terminal className="w-3.5 h-3.5" />
              <span>{cliSnippets[activeCli].endpoint}</span>
            </div>
            <pre className="text-xs font-mono leading-relaxed whitespace-pre">
              {cliSnippets[activeCli].snippet}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
};

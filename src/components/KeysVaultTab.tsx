import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  Unlock,
  Upload,
} from 'lucide-react';
import { BUILTIN_PROVIDERS, mergeProviderSettings } from '../../shared/providers.ts';
import type {
  CustomEndpoint,
  ProviderCatalogEntry,
  RouterRuntimeSnapshot,
  StoredApiKey,
  VaultPayload,
} from '../../shared/types.ts';
import { testProviderKeyLive } from '../lib/routerApi.ts';
import { encryptVaultPayload, importVaultBackupJson } from '../lib/vaultDb.ts';

interface KeysVaultTabProps {
  vault: VaultPayload;
  runtime: RouterRuntimeSnapshot | null;
  hasPin: boolean;
  activePin: string | null;
  masterKey: string;
  onMasterKeyChange: (val: string) => void;
  onUpdateVault: (next: VaultPayload) => void;
  onSetPin: (newPin: string | null) => Promise<void>;
  onLockNow: () => void;
  onSyncNow: (vaultOverride?: VaultPayload) => Promise<void>;
  onClearServerRam: () => Promise<void>;
  syncing: boolean;
}

type ProviderFilter =
  | 'all'
  | 'core'
  | 'permanent-free'
  | 'trial-credits'
  | 'keyless-local'
  | 'configured'
  | 'custom';

export const KeysVaultTab: React.FC<KeysVaultTabProps> = ({
  vault,
  runtime,
  hasPin,
  activePin,
  masterKey,
  onMasterKeyChange,
  onUpdateVault,
  onSetPin,
  onLockNow,
  onSyncNow,
  onClearServerRam,
  syncing,
}) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ProviderFilter>('all');
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>('gemini');

  // New key form state (scoped to expanded provider)
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [newAccountId, setNewAccountId] = useState('');
  const [revealedKeyIds, setRevealedKeyIds] = useState<Record<string, boolean>>({});
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);

  // Modals / Inline panels
  const [activePanel, setActivePanel] = useState<
    null | 'pin' | 'export' | 'import' | 'custom-endpoint' | 'manual-model'
  >(null);

  // PIN panel state
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [panelMsg, setPanelMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Export panel state
  const [exportPassphrase, setExportPassphrase] = useState(activePin || '');
  const [exportedEnvPreview, setExportedEnvPreview] = useState<string | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);

  // Import panel state
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importRawJson, setImportRawJson] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Custom Endpoint form state
  const [ceName, setCeName] = useState('');
  const [ceAdapter, setCeAdapter] = useState<'openai' | 'anthropic' | 'ollama'>('openai');
  const [ceBaseUrl, setCeBaseUrl] = useState('');
  const [ceModels, setCeModels] = useState('');
  const [ceApiKey, setCeApiKey] = useState('');

  // Manual model-add state
  const [mmProviderId, setMmProviderId] = useState('');
  const [mmModelId, setMmModelId] = useState('');

  // Custom endpoint model-edit state
  const [editingCustomModelsId, setEditingCustomModelsId] = useState<string | null>(null);
  const [editingCustomModelsValue, setEditingCustomModelsValue] = useState('');
  const [inlineModelInput, setInlineModelInput] = useState<Record<string, string>>({});

  const allProviders: ProviderCatalogEntry[] = useMemo(() => {
    const customs: ProviderCatalogEntry[] = vault.customEndpoints.map((c) => ({
      id: c.id,
      name: c.name,
      adapter: c.adapter,
      baseUrl: c.baseUrl,
      tier: c.adapter === 'ollama' ? 'local' : 'custom',
      creditCardRequired: false,
      freeQuotaSummary: `Custom ${c.adapter.toUpperCase()} endpoint · ${c.baseUrl}`,
      signupUrl: c.baseUrl,
      keyPlaceholder: c.adapter === 'ollama' ? 'ollama (optional)' : 'sk-...',
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
    return [...customs, ...BUILTIN_PROVIDERS].map((p) =>
      mergeProviderSettings(p, vault.customModels, vault.providerPriorities)
    );
  }, [vault.customEndpoints, vault.customModels]);

  const keysByProvider = useMemo(() => {
    const map = new Map<string, StoredApiKey[]>();
    for (const k of vault.keys) {
      const list = map.get(k.providerId) || [];
      list.push(k);
      map.set(k.providerId, list);
    }
    return map;
  }, [vault.keys]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProviders.filter((p) => {
      if (filter === 'core' && !p.isCore) return false;
      if (filter === 'permanent-free' && p.tier !== 'permanent-free') return false;
      if (filter === 'trial-credits' && p.tier !== 'trial-credits') return false;
      if (filter === 'keyless-local' && p.tier !== 'keyless' && p.tier !== 'local') return false;
      if (filter === 'custom' && !p.isCustom) return false;
      if (filter === 'configured') {
        const hasKeys = (keysByProvider.get(p.id)?.length || 0) > 0;
        const hasServerGemini = p.id === 'gemini' && runtime?.serverGeminiAvailable;
        if (!hasKeys && !hasServerGemini) return false;
      }

      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.freeQuotaSummary.toLowerCase().includes(q) ||
        p.models.some((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      );
    });
  }, [allProviders, filter, keysByProvider, runtime?.serverGeminiAvailable, search]);

  const handleAddKey = (provider: ProviderCatalogEntry) => {
    const rawKeys = newKeyValue
      .split(/[,\n]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (rawKeys.length === 0) return;
    const existingCount = (keysByProvider.get(provider.id) || []).length;
    const newKeyObjs: StoredApiKey[] = rawKeys.map((rawKey, i) => ({
      id: `key-${provider.id}-${Date.now().toString(36)}-${i}`,
      providerId: provider.id,
      label:
        rawKeys.length === 1 && newKeyLabel.trim()
          ? newKeyLabel.trim()
          : `${provider.name} #${existingCount + i + 1}`,
      apiKey: rawKey,
      accountId: provider.requiresAccountId ? newAccountId.trim() : undefined,
      enabled: true,
      rpmLimit: provider.defaultRpmLimit,
      rpdLimit: provider.defaultRpdLimit,
      createdAt: Date.now(),
    }));
    onUpdateVault({
      ...vault,
      keys: [...vault.keys, ...newKeyObjs],
    });
    setNewKeyLabel('');
    setNewKeyValue('');
    setNewAccountId('');
  };

  const handleToggleKey = (keyId: string) => {
    const next = {
      ...vault,
      keys: vault.keys.map((k) => (k.id === keyId ? { ...k, enabled: !k.enabled } : k)),
    };
    onUpdateVault(next);
    // Push the change to server RAM immediately so disabled keys stop being used.
    void onSyncNow(next);
  };

  const handleDeleteKey = (keyId: string) => {
    const next = {
      ...vault,
      keys: vault.keys.filter((k) => k.id !== keyId),
    };
    onUpdateVault(next);
    void onSyncNow(next);
  };

  const handleTestKey = async (key: StoredApiKey) => {
    setTestingKeyId(key.id);
    try {
      const customEp = vault.customEndpoints.find((c) => c.id === key.providerId);
      const provider = allProviders.find((p) => p.id === key.providerId);
      // Prefer manually added models (customModels) for the health check, then
      // fall back to the provider's first chat-capable built-in model.
      const manualModels = vault.customModels?.[key.providerId] || [];
      const modelId =
        manualModels[0] ||
        provider?.models.find((m) => m.capabilities.includes('chat'))?.id ||
        provider?.models[0]?.id;
      const res = await testProviderKeyLive({
        providerId: key.providerId,
        apiKey: key.apiKey,
        accountId: key.accountId,
        modelId,
        customEndpoint: customEp,
        masterKey,
      });
      onUpdateVault({
        ...vault,
        keys: vault.keys.map((k) =>
          k.id === key.id
            ? {
                ...k,
                lastTestedAt: Date.now(),
                lastTestOk: res.ok,
                lastTestLatencyMs: res.latencyMs,
                lastTestMessage: res.message,
              }
            : k
        ),
      });
    } catch (err) {
      onUpdateVault({
        ...vault,
        keys: vault.keys.map((k) =>
          k.id === key.id
            ? {
                ...k,
                lastTestedAt: Date.now(),
                lastTestOk: false,
                lastTestMessage: err instanceof Error ? err.message : 'Test request failed',
              }
            : k
        ),
      });
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleSavePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPanelMsg(null);
    if (pinInput.length < 4) {
      setPanelMsg({ type: 'err', text: 'PIN or passphrase must be at least 4 characters.' });
      return;
    }
    if (pinInput !== pinConfirm) {
      setPanelMsg({ type: 'err', text: 'PIN confirmation does not match.' });
      return;
    }
    await onSetPin(pinInput);
    setPinInput('');
    setPinConfirm('');
    setPanelMsg({ type: 'ok', text: 'Vault re-encrypted with AES-256-GCM using your PIN.' });
  };

  const handleRemovePin = async () => {
    await onSetPin(null);
    setPanelMsg({ type: 'ok', text: 'PIN lock removed. Vault remains AES-256-GCM encrypted with local device key.' });
  };

  const handleExportBackup = async (downloadFile: boolean) => {
    setPanelMsg(null);
    const pass = exportPassphrase.trim();
    if (pass.length < 4) {
      setPanelMsg({
        type: 'err',
        text: 'Enter a backup passphrase (min 4 chars) to encrypt the JSON export.',
      });
      return;
    }
    const envelope = await encryptVaultPayload(vault, pass, true);
    const json = JSON.stringify(envelope, null, 2);
    setExportedEnvPreview(JSON.stringify(envelope));

    if (downloadFile) {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `relaygate-vault-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setPanelMsg({ type: 'ok', text: 'Encrypted JSON vault backup downloaded.' });
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportRawJson(String(reader.result || ''));
    };
    reader.readAsText(file);
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPanelMsg(null);
    if (!importRawJson.trim()) {
      setPanelMsg({ type: 'err', text: 'Select a JSON backup file or paste the encrypted JSON envelope.' });
      return;
    }
    try {
      const imported = await importVaultBackupJson(
        importRawJson.trim(),
        importPassphrase.trim() || undefined
      );
      onUpdateVault(imported);
      setImportRawJson('');
      setImportPassphrase('');
      setPanelMsg({
        type: 'ok',
        text: `Imported ${imported.keys.length} key(s), ${imported.customEndpoints.length} custom endpoint(s), and ${imported.profiles.length} profile(s) into IndexedDB.`,
      });
    } catch (err) {
      setPanelMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to decrypt or parse backup JSON.',
      });
    }
  };

  const handleAddCustomEndpoint = (e: React.FormEvent) => {
    e.preventDefault();
    setPanelMsg(null);
    const name = ceName.trim();
    const baseUrl = ceBaseUrl.trim();
    const models = ceModels
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    if (!name || !baseUrl || models.length === 0) {
      setPanelMsg({
        type: 'err',
        text: 'Name, Base URL, and at least one comma-separated Model ID are required.',
      });
      return;
    }

    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
    const endpoint: CustomEndpoint = {
      id,
      name,
      adapter: ceAdapter,
      baseUrl,
      models,
      createdAt: Date.now(),
    };

    const nextKeys = [...vault.keys];
    const rawKeys = (ceApiKey.trim() || (ceAdapter === 'ollama' ? 'ollama' : ''))
      .split(/[,\n]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (rawKeys.length > 0) {
      rawKeys.forEach((rawKey, i) => {
        nextKeys.push({
          id: `key-${id}-${Date.now().toString(36)}-${i}`,
          providerId: id,
          label: rawKeys.length === 1 ? `${name} Primary` : `${name} #${i + 1}`,
          apiKey: rawKey,
          enabled: true,
          rpmLimit: 60,
          rpdLimit: 10000,
          createdAt: Date.now(),
        });
      });
    }

    onUpdateVault({
      ...vault,
      customEndpoints: [endpoint, ...vault.customEndpoints],
      keys: nextKeys,
    });
    setCeName('');
    setCeBaseUrl('');
    setCeModels('');
    setCeApiKey('');
    setExpandedProviderId(id);
    setActivePanel(null);
  };

  const handleDeleteCustomEndpoint = (endpointId: string) => {
    onUpdateVault({
      ...vault,
      customEndpoints: vault.customEndpoints.filter((c) => c.id !== endpointId),
      keys: vault.keys.filter((k) => k.providerId !== endpointId),
    });
  };

  const handleSaveCustomEndpointModels = (endpointId: string) => {
    const models = editingCustomModelsValue
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) {
      setPanelMsg({ type: 'err', text: 'At least one model ID is required.' });
      return;
    }
    onUpdateVault({
      ...vault,
      customEndpoints: vault.customEndpoints.map((c) =>
        c.id === endpointId ? { ...c, models } : c
      ),
    });
    setEditingCustomModelsId(null);
    setEditingCustomModelsValue('');
    setPanelMsg({ type: 'ok', text: `Updated models for endpoint.` });
  };

  const handleAddManualModel = (e: React.FormEvent) => {
    e.preventDefault();
    setPanelMsg(null);
    const providerId = mmProviderId.trim();
    const modelId = mmModelId.trim();
    if (!providerId || !modelId) {
      setPanelMsg({ type: 'err', text: 'Provider and Model ID are required.' });
      return;
    }
    const existing = vault.customModels?.[providerId] || [];
    if (existing.includes(modelId)) {
      setPanelMsg({ type: 'err', text: 'That model is already added for this provider.' });
      return;
    }
    const next = { ...(vault.customModels || {}) };
    next[providerId] = [...existing, modelId];
    onUpdateVault({ ...vault, customModels: next });
    setMmModelId('');
    setPanelMsg({ type: 'ok', text: `Added model "${modelId}" to ${providerId}.` });
  };

  const handleRemoveManualModel = (providerId: string, modelId: string) => {
    const next = { ...(vault.customModels || {}) };
    next[providerId] = (next[providerId] || []).filter((m) => m !== modelId);
    if (next[providerId].length === 0) delete next[providerId];
    onUpdateVault({ ...vault, customModels: next });
  };

  const tierLabel = (tier: ProviderCatalogEntry['tier']) => {
    switch (tier) {
      case 'permanent-free':
        return 'Permanent Free';
      case 'trial-credits':
        return 'Trial Credits';
      case 'keyless':
        return 'Keyless Free';
      case 'local':
        return 'Local';
      case 'custom':
        return 'Custom Endpoint';
    }
  };

  return (
    <div className="space-y-6">
      {/* Zero-Disk Vault Security & RAM Sync Bar */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                IndexedDB Local Vault & Express RAM Sync
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              AES-256-GCM encrypted in browser storage · Zero keys written to server disk ·{' '}
              <span className="tabular-nums font-medium text-slate-700 dark:text-slate-300">
                {vault.keys.filter((k) => k.enabled).length} local enabled key(s)
              </span>{' '}
              ·{' '}
              <span className="tabular-nums font-medium text-slate-700 dark:text-slate-300">
                {runtime?.activeKeyCount ?? 0} active in router RAM
              </span>
              {runtime?.serverGeminiAvailable && ' (includes server Gemini channel)'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onSyncNow()}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Vault to Active Router'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPanelMsg(null);
                setActivePanel(activePanel === 'custom-endpoint' ? null : 'custom-endpoint');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Server className="w-3.5 h-3.5" />
              Add Custom Provider
            </button>
            <button
              type="button"
              onClick={() => {
                setPanelMsg(null);
                if (!mmProviderId && allProviders.length) setMmProviderId(allProviders[0].id);
                setActivePanel(activePanel === 'manual-model' ? null : 'manual-model');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Manual Model
            </button>
          </div>
        </div>

        {/* Secondary Vault Action Strip */}
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPanelMsg(null);
                setActivePanel(activePanel === 'pin' ? null : 'pin');
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              {hasPin ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              {hasPin ? 'Change / Remove PIN' : 'Set Vault PIN'}
            </button>

            {hasPin && (
              <button
                type="button"
                onClick={onLockNow}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900/60 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-md whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" />
                Lock Vault Now
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setPanelMsg(null);
                setExportedEnvPreview(null);
                setActivePanel(activePanel === 'export' ? null : 'export');
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Export Encrypted JSON
            </button>

            <button
              type="button"
              onClick={() => {
                setPanelMsg(null);
                setActivePanel(activePanel === 'import' ? null : 'import');
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" />
              Import Backup
            </button>

            <button
              type="button"
              onClick={onClearServerRam}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Server RAM
            </button>
          </div>

          {/* Optional ROUTER_MASTER_KEY header input when configured */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="router-master-key"
              className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap"
            >
              Master Key{runtime?.masterKeyRequired ? ' (Required)' : ' (Optional)'}:
            </label>
            <input
              id="router-master-key"
              type="password"
              value={masterKey}
              onChange={(e) => onMasterKeyChange(e.target.value)}
              placeholder="ROUTER_MASTER_KEY"
              className="w-44 px-2.5 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="button"
              onClick={() => {
                const stored = localStorage.getItem('relaygate-master-key') || '';
                onMasterKeyChange(stored);
              }}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
              title="Reset to the saved default master key"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Inline Action Panels */}
        {activePanel === 'pin' && (
          <form
            onSubmit={handleSavePin}
            className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              {hasPin ? 'Update or Remove Vault Lock PIN' : 'Enable Optional Vault Lock PIN'}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="New PIN or passphrase (min 4 chars)"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <input
                type="password"
                value={pinConfirm}
                onChange={(e) => setPinConfirm(e.target.value)}
                placeholder="Confirm PIN"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
                >
                  Save PIN
                </button>
                {hasPin && (
                  <button
                    type="button"
                    onClick={handleRemovePin}
                    className="px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-md whitespace-nowrap"
                  >
                    Remove PIN
                  </button>
                )}
              </div>
            </div>
          </form>
        )}

        {activePanel === 'export' && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Export AES-256-GCM Encrypted Backup & Headless ROUTER_VAULT_JSON
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Use the same encrypted JSON output either to restore your browser IndexedDB or as the <code className="font-mono">ROUTER_VAULT_JSON</code> environment variable on Hugging Face Docker Spaces.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={exportPassphrase}
                onChange={(e) => setExportPassphrase(e.target.value)}
                placeholder="Encryption passphrase (min 4 chars)"
                className="w-64 px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => handleExportBackup(true)}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
              >
                Download .json Backup
              </button>
              <button
                type="button"
                onClick={() => handleExportBackup(false)}
                className="px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md whitespace-nowrap"
              >
                Generate Env String
              </button>
            </div>
            {exportedEnvPreview && (
              <div className="p-3 bg-slate-950 text-slate-200 rounded-md space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-slate-400">
                    ROUTER_VAULT_JSON (Single-line encrypted envelope)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(exportedEnvPreview);
                      setCopiedEnv(true);
                      setTimeout(() => setCopiedEnv(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    {copiedEnv ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedEnv ? 'Copied' : 'Copy Env Value'}
                  </button>
                </div>
                <pre className="text-[11px] font-mono break-all whitespace-pre-wrap max-h-24 overflow-y-auto text-slate-300">
                  {exportedEnvPreview}
                </pre>
              </div>
            )}
          </div>
        )}

        {activePanel === 'import' && (
          <form
            onSubmit={handleImportSubmit}
            className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Import Encrypted Vault Backup JSON
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportFile}
                className="text-xs text-slate-600 dark:text-slate-300"
              />
              <input
                type="password"
                value={importPassphrase}
                onChange={(e) => setImportPassphrase(e.target.value)}
                placeholder="Backup decryption passphrase"
                className="w-60 px-3 py-1.5 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
              >
                Decrypt & Restore
              </button>
            </div>
            <textarea
              rows={3}
              value={importRawJson}
              onChange={(e) => setImportRawJson(e.target.value)}
              placeholder='Or paste {"format":"relaygate-vault-v1", ...} JSON directly'
              className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </form>
        )}

        {activePanel === 'custom-endpoint' && (
          <form
            onSubmit={handleAddCustomEndpoint}
            className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Add Custom AI Provider (name, protocol, base URL, models, key)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <input
                type="text"
                value={ceName}
                onChange={(e) => setCeName(e.target.value)}
                placeholder="Endpoint Name (e.g. Home Mac Ollama)"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <select
                value={ceAdapter}
                onChange={(e) =>
                  setCeAdapter(e.target.value as 'openai' | 'anthropic' | 'ollama')
                }
                aria-label="Endpoint Protocol"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="openai">OpenAI-Compatible (/chat/completions)</option>
                <option value="anthropic">Anthropic-Compatible (/v1/messages)</option>
                <option value="ollama">Local Ollama (http://localhost:11434/v1)</option>
              </select>
              <input
                type="url"
                value={ceBaseUrl}
                onChange={(e) => setCeBaseUrl(e.target.value)}
                placeholder="Base URL (e.g. http://localhost:11434/v1)"
                className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              <input
                type="text"
                value={ceModels}
                onChange={(e) => setCeModels(e.target.value)}
                placeholder="Model IDs (comma-separated, e.g. qwen2.5:14b, llama3.2)"
                className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 sm:col-span-2"
              />
              <input
                type="password"
                value={ceApiKey}
                onChange={(e) => setCeApiKey(e.target.value)}
                placeholder="API Key(s) (comma/newline separated; optional for Ollama)"
                className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
              >
                Save Custom Endpoint
              </button>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {activePanel === 'manual-model' && (
          <form
            onSubmit={handleAddManualModel}
            className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Manually add a model ID to any provider
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                value={mmProviderId}
                onChange={(e) => setMmProviderId(e.target.value)}
                aria-label="Provider"
                className="px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {allProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={mmModelId}
                onChange={(e) => setMmModelId(e.target.value)}
                placeholder="Model ID (e.g. gpt-4o-2024-11-20, claude-3-7-sonnet)"
                className="px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
              >
                Add Model
              </button>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                className="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
              >
                Cancel
              </button>
            </div>
            {vault.customModels && Object.keys(vault.customModels).length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  Manually added models:
                </div>
                {Object.entries(vault.customModels).map(([pid, models]) =>
                  (models || []).length ? (
                    <div key={pid} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-mono text-slate-500">{pid}:</span>
                      {(models || []).map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-slate-100 dark:bg-slate-800 rounded-md"
                        >
                          {m}
                          <button
                            type="button"
                            onClick={() => handleRemoveManualModel(pid, m)}
                            className="text-slate-400 hover:text-red-600"
                            aria-label={`Remove ${m}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null
                )}
              </div>
            )}
          </form>
        )}

        {panelMsg && (
          <div
            className={`mt-3 text-xs px-3 py-2 rounded-md border ${
              panelMsg.type === 'ok'
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
            }`}
          >
            {panelMsg.text}
          </div>
        )}
      </section>

      {/* Search & Filter Directory Bar */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Free AI Key Providers Directory ({allProviders.length})
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              All major FreeLLMAPI providers pre-configured with signup links, free quota tiers, multi-key pools, and live key health checks.
            </p>
          </div>
          <div className="relative w-full md:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search providers or models..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
        </div>

        {/* Segmented Filter Buttons */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto w-fit max-w-full">
          {(
            [
              { id: 'all', label: `All (${allProviders.length})` },
              { id: 'core', label: 'Core 17' },
              { id: 'permanent-free', label: 'Permanent Free' },
              { id: 'trial-credits', label: 'Trial Credits' },
              { id: 'keyless-local', label: 'Keyless & Local' },
              { id: 'configured', label: 'Configured' },
              { id: 'custom', label: `Custom (${vault.customEndpoints.length})` },
            ] as Array<{ id: ProviderFilter; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === tab.id
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Provider List Table/Accordion */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden">
          {filteredProviders.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              No providers match your current search or filter.
            </div>
          ) : (
            filteredProviders.map((provider) => {
              const keys = keysByProvider.get(provider.id) || [];
              const enabledCount = keys.filter((k) => k.enabled).length;
              const isExpanded = expandedProviderId === provider.id;
              const hasServerGemini =
                provider.id === 'gemini' && runtime?.serverGeminiAvailable;

              return (
                <div key={provider.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      setExpandedProviderId(isExpanded ? null : provider.id)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedProviderId(isExpanded ? null : provider.id);
                      }
                    }}
                    className="px-4 py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="mt-0.5 text-slate-400 shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {provider.name}
                          </span>
                          <span className="text-xs text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {tierLabel(provider.tier)}
                          </span>
                          <span className="text-xs text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {provider.creditCardRequired ? 'Card required' : 'No card'}
                          </span>
                          <span className="text-xs text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                            {provider.models.length} models
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-2xl">
                          {provider.freeQuotaSummary}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 ml-auto">
                      <span
                        className={`text-xs font-medium tabular-nums ${
                          enabledCount > 0 || hasServerGemini
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {enabledCount > 0
                          ? `${enabledCount} key${enabledCount > 1 ? 's' : ''} active`
                          : hasServerGemini
                            ? 'Server env ready'
                            : '0 keys'}
                      </span>

                      {!provider.isCustom && (
                        <a
                          href={provider.signupUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                        >
                          Get Key
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}

                      {provider.isCustom && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCustomEndpoint(provider.id);
                          }}
                          className="text-xs text-slate-400 hover:text-red-600 dark:hover:text-red-400 p-1"
                          aria-label="Delete custom endpoint"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded Provider Multi-Key Pool & Model Catalog */}
                  {isExpanded && (
                    <div className="px-4 pb-5 pt-3 bg-slate-50/70 dark:bg-slate-950/40 border-t border-slate-100 dark:border-slate-800/80 space-y-4">
                      {/* Endpoint & Models Info */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>
                          Adapter:{' '}
                          <code className="font-mono text-slate-700 dark:text-slate-300">
                            {provider.adapter}
                          </code>
                        </span>
                        <span>
                          Base URL:{' '}
                          <code className="font-mono text-slate-700 dark:text-slate-300">
                            {provider.baseUrl}
                          </code>
                        </span>
                      </div>

                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-medium text-slate-700 dark:text-slate-300 mr-2">
                          Catalog Models:
                        </span>
                        {provider.isCustom && editingCustomModelsId === provider.id ? (
                          <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <input
                              type="text"
                              value={editingCustomModelsValue}
                              onChange={(e) => setEditingCustomModelsValue(e.target.value)}
                              placeholder="Model IDs (comma-separated)"
                              className="px-2 py-1 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-w-[260px]"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveCustomEndpointModels(provider.id)}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCustomModelsId(null);
                                setEditingCustomModelsValue('');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <span className="font-mono leading-relaxed">
                            {provider.models.map((m) => m.id).join('  ·  ')}
                            {provider.isCustom && (
                              <button
                                type="button"
                                onClick={() => {
                                  const ep = vault.customEndpoints.find((c) => c.id === provider.id);
                                  setEditingCustomModelsId(provider.id);
                                  setEditingCustomModelsValue((ep?.models || []).join(', '));
                                }}
                                className="ml-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                Edit models
                              </button>
                            )}
                          </span>
                        )}
                      </div>

                      {/* Priority (%) for this provider */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          Priority:
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={vault.providerPriorities?.[provider.id] ?? 50}
                          onChange={(e) => {
                            const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                            const next = { ...(vault.providerPriorities || {}) };
                            next[provider.id] = val;
                            onUpdateVault({ ...vault, providerPriorities: next });
                          }}
                          className="w-16 px-2 py-1 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                        <span className="text-xs text-slate-400">%</span>
                      </div>

                      {/* Inline add model for this provider */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="text"
                          value={inlineModelInput[provider.id] || ''}
                          onChange={(e) =>
                            setInlineModelInput((prev) => ({ ...prev, [provider.id]: e.target.value }))
                          }
                          placeholder={`Add a model ID to ${provider.name} (e.g. gemini-2.5-pro)`}
                          className="px-2 py-1 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-w-[220px]"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const mid = (inlineModelInput[provider.id] || '').trim();
                            if (!mid) return;
                            const existing = vault.customModels?.[provider.id] || [];
                            if (existing.includes(mid)) {
                              setPanelMsg({ type: 'err', text: 'That model is already added.' });
                              return;
                            }
                            const next = { ...(vault.customModels || {}) };
                            next[provider.id] = [...existing, mid];
                            onUpdateVault({ ...vault, customModels: next });
                            setInlineModelInput((prev) => ({ ...prev, [provider.id]: '' }));
                            setPanelMsg({ type: 'ok', text: `Added "${mid}" to ${provider.name}.` });
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                        >
                          Add Model
                        </button>
                      </div>

                      {/* Existing Keys */}
                      {hasServerGemini && (
                        <div className="px-3.5 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md flex items-center justify-between gap-3">
                          <div className="text-xs">
                            <span className="font-medium text-slate-900 dark:text-slate-100">
                              Server Gemini Channel
                            </span>
                            <span className="mx-1.5 text-slate-300 dark:text-slate-700">·</span>
                            <span className="text-emerald-700 dark:text-emerald-400">
                              Active automatically on server (gemini-4-hydrogen)
                            </span>
                          </div>
                          <span className="text-xs font-mono text-slate-400">
                            Server-Managed
                          </span>
                        </div>
                      )}

                      {keys.length > 0 && (
                        <div className="space-y-2">
                          {keys.map((k) => {
                            const revealed = Boolean(revealedKeyIds[k.id]);
                            const masked =
                              k.apiKey.length > 10
                                ? `${k.apiKey.slice(0, 6)}••••••${k.apiKey.slice(-4)}`
                                : '••••••••';

                            return (
                              <div
                                key={k.id}
                                className="px-3.5 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md flex flex-wrap items-center justify-between gap-3"
                              >
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <KeyRound className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                      {k.label}
                                    </span>
                                    <code className="text-xs font-mono text-slate-500 dark:text-slate-400">
                                      {revealed ? k.apiKey : masked}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setRevealedKeyIds((prev) => ({
                                          ...prev,
                                          [k.id]: !prev[k.id],
                                        }))
                                      }
                                      aria-label={revealed ? 'Hide key' : 'Reveal key'}
                                      className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                    >
                                      {revealed ? (
                                        <EyeOff className="w-3.5 h-3.5" />
                                      ) : (
                                        <Eye className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  </div>

                                  {k.accountId && (
                                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                      Account ID: {k.accountId}
                                    </div>
                                  )}

                                  {k.lastTestedAt && (
                                    <div
                                      className={`text-[11px] tabular-nums ${
                                        k.lastTestOk
                                          ? 'text-emerald-700 dark:text-emerald-400'
                                          : 'text-red-600 dark:text-red-400'
                                      }`}
                                    >
                                      {k.lastTestMessage}{' '}
                                      {typeof k.lastTestLatencyMs === 'number'
                                        ? `(${k.lastTestLatencyMs} ms)`
                                        : ''}
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                                  <button
                                    type="button"
                                    disabled={testingKeyId === k.id}
                                    onClick={() => handleTestKey(k)}
                                    className="px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-900 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-md whitespace-nowrap disabled:opacity-50"
                                  >
                                    {testingKeyId === k.id ? 'Testing...' : 'Test Key'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleKey(k.id)}
                                    className="px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
                                  >
                                    {k.enabled ? 'Enabled' : 'Disabled'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteKey(k.id)}
                                    aria-label="Delete API key"
                                    className="p-1.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add Key Form */}
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-1">
                        <input
                          type="text"
                          value={newKeyLabel}
                          onChange={(e) => setNewKeyLabel(e.target.value)}
                          placeholder={`Label (e.g. ${provider.name} #${keys.length + 1})`}
                          className="sm:col-span-3 px-3 py-2 text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                        <input
                          type="password"
                          value={newKeyValue}
                          onChange={(e) => setNewKeyValue(e.target.value)}
                          placeholder={provider.keyPlaceholder}
                          className={`${
                            provider.requiresAccountId ? 'sm:col-span-4' : 'sm:col-span-7'
                          } px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100`}
                        />
                        {provider.requiresAccountId && (
                          <input
                            type="text"
                            value={newAccountId}
                            onChange={(e) => setNewAccountId(e.target.value)}
                            placeholder="Cloudflare Account ID"
                            className="sm:col-span-3 px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => handleAddKey(provider)}
                          disabled={!newKeyValue.trim()}
                          className="sm:col-span-2 inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-blue-600 hover:bg-slate-800 dark:hover:bg-blue-700 disabled:opacity-40 rounded-md whitespace-nowrap"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add Key
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
};

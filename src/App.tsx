import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  GitBranch,
  KeyRound,
  Moon,
  RefreshCw,
  Sun,
  TerminalSquare,
} from 'lucide-react';
import type {
  KeyUsageStats,
  RouterLogEntry,
  RouterRuntimeSnapshot,
  VaultPayload,
} from '../shared/types.ts';
import { AnalyticsLogsTab } from './components/AnalyticsLogsTab.tsx';
import { KeysVaultTab } from './components/KeysVaultTab.tsx';
import { PlaygroundTab } from './components/PlaygroundTab.tsx';
import { RoutingChainTab } from './components/RoutingChainTab.tsx';
import { VaultLockScreen } from './components/VaultLockScreen.tsx';
import {
  clearRouterCooldown,
  clearRouterLogs,
  clearServerRam,
  fetchRouterState,
  syncVaultToServerRam,
} from './lib/routerApi.ts';
import {
  createEmptyVault,
  initializeVaultFromIndexedDb,
  loadUsageArchiveFromIndexedDb,
  persistVaultToIndexedDb,
  saveUsageArchiveToIndexedDb,
  unlockVaultWithPin,
} from './lib/vaultDb.ts';

type TabId = 'routing' | 'vault' | 'playground' | 'analytics';

const NAV_ITEMS: Array<{ id: TabId; label: string; shortLabel: string; icon: React.FC<{ className?: string }> }> = [
  { id: 'routing', label: 'Models & Routing', shortLabel: 'Routing', icon: GitBranch },
  { id: 'vault', label: 'Keys Vault', shortLabel: 'Vault', icon: KeyRound },
  { id: 'playground', label: 'Playground', shortLabel: 'Play', icon: TerminalSquare },
  { id: 'analytics', label: 'Analytics & Logs', shortLabel: 'Logs', icon: Activity },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('routing');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('relaygate-theme') === 'dark';
  });

  // Vault state (IndexedDB AES-GCM)
  const [initializing, setInitializing] = useState(true);
  const [locked, setLocked] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultPayload>(() => createEmptyVault());
  const [vaultDirty, setVaultDirty] = useState(false);
  const [masterKey, setMasterKey] = useState('');

  // Server RAM state + IndexedDB usage archive
  const [runtime, setRuntime] = useState<RouterRuntimeSnapshot | null>(null);
  const [archivedKeyStats, setArchivedKeyStats] = useState<KeyUsageStats[]>([]);
  const [archivedLogs, setArchivedLogs] = useState<RouterLogEntry[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Sync dark class onto <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('relaygate-theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('relaygate-theme', 'light');
    }
  }, [darkMode]);

  const refreshRuntime = useCallback(async () => {
    try {
      const snap = await fetchRouterState();
      setRuntime(snap);
      if (snap.keyStats.length > 0 || snap.recentLogs.length > 0) {
        saveUsageArchiveToIndexedDb(snap.keyStats, snap.recentLogs);
      }
    } catch {
      // ignore transient poll errors
    }
  }, []);

  // Boot vault from IndexedDB and fetch live RAM state
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [init, usage] = await Promise.all([
          initializeVaultFromIndexedDb(),
          loadUsageArchiveFromIndexedDb(),
        ]);
        if (!mounted) return;
        setHasPin(init.hasPin);
        setLocked(init.locked);
        if (init.vault) {
          setVault(init.vault);
        }
        if (usage) {
          setArchivedKeyStats(usage.keyStats || []);
          setArchivedLogs(usage.recentLogs || []);
        }
      } finally {
        if (mounted) setInitializing(false);
      }
      await refreshRuntime();
    })();
    return () => {
      mounted = false;
    };
  }, [refreshRuntime]);

  // Poll router telemetry every 5s when unlocked
  useEffect(() => {
    if (locked || initializing) return;
    const id = window.setInterval(refreshRuntime, 5000);
    return () => window.clearInterval(id);
  }, [locked, initializing, refreshRuntime]);

  const showNotice = (type: 'ok' | 'err', text: string) => {
    setBanner({ type, text });
    window.setTimeout(() => {
      setBanner((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  const handleUpdateVault = async (next: VaultPayload) => {
    setVault(next);
    setVaultDirty(true);
    try {
      await persistVaultToIndexedDb(next, activePin);
    } catch (err) {
      showNotice(
        'err',
        err instanceof Error ? err.message : 'Failed to save encrypted vault to IndexedDB'
      );
    }
  };

  const handleUnlock = async (pin: string) => {
    const decrypted = await unlockVaultWithPin(pin);
    setVault(decrypted);
    setActivePin(pin);
    setLocked(false);
  };

  const handleResetVault = async () => {
    const fresh = createEmptyVault();
    await persistVaultToIndexedDb(fresh, null);
    setVault(fresh);
    setHasPin(false);
    setActivePin(null);
    setLocked(false);
    showNotice('ok', 'Local IndexedDB vault wiped and re-initialized.');
  };

  const handleSetPin = async (newPin: string | null) => {
    await persistVaultToIndexedDb(vault, newPin);
    setActivePin(newPin);
    setHasPin(Boolean(newPin));
  };

  const handleLockNow = () => {
    if (!hasPin) return;
    setActivePin(null);
    setLocked(true);
  };

  const handleSyncNow = async (vaultOverride?: VaultPayload) => {
    const v = vaultOverride || vault;
    setSyncing(true);
    try {
      const res = await syncVaultToServerRam(v, masterKey);
      setRuntime(res.snapshot);
      setVaultDirty(false);
      showNotice(
        'ok',
        `Synced ${res.snapshot.activeKeyCount} active key(s) and ${res.snapshot.profileCount} routing profiles into Express RAM.`
      );
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : 'Failed to sync vault to RAM');
    } finally {
      setSyncing(false);
    }
  };

  const handleClearServerRam = async () => {
    try {
      const res = await clearServerRam(masterKey);
      setRuntime(res.snapshot);
      showNotice('ok', 'Cleared all synced keys from Express server RAM.');
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : 'Failed to clear server RAM');
    }
  };

  const handleClearCooldown = async (keyId?: string) => {
    const res = await clearRouterCooldown(keyId);
    setRuntime(res.snapshot);
    showNotice('ok', 'Cleared rate-limit cooldown timer(s).');
  };

  const handleClearLogs = async () => {
    const res = await clearRouterLogs();
    setRuntime(res.snapshot);
    setArchivedLogs([]);
    await saveUsageArchiveToIndexedDb(res.snapshot.keyStats, []);
  };

  if (initializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500 dark:text-slate-400">
        Initializing encrypted IndexedDB vault...
      </div>
    );
  }

  if (locked) {
    return <VaultLockScreen onUnlock={handleUnlock} onResetVault={handleResetVault} />;
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activeTab)!;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="h-14 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            RelayGate
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-xs">
          <div className="space-y-1 text-slate-500 dark:text-slate-400">
            <div className="font-medium text-slate-700 dark:text-slate-300">
              Zero-Disk Architecture
            </div>
            <div className="tabular-nums">
              {vault.keys.filter((k) => k.enabled).length} local keys ·{' '}
              {runtime?.activeKeyCount ?? 0} in RAM
            </div>
            <div>
              {hasPin ? 'AES-GCM · PIN Protected' : 'AES-GCM · Device Key'}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            {darkMode ? 'Light Appearance' : 'Dark Appearance'}
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary CTA on right */}
        <header className="sticky top-0 z-20 h-14 px-4 sm:px-6 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <span className="lg:hidden font-display text-sm font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
              RelayGate
            </span>
            <span className="lg:hidden text-slate-300 dark:text-slate-700">/</span>
            <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {activeNav.label}
            </h1>
            <span className="hidden md:inline text-xs text-slate-400">·</span>
            <span className="hidden md:inline text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
              {runtime?.activeKeyCount ?? 0} RAM key{(runtime?.activeKeyCount ?? 0) === 1 ? '' : 's'}
              {vaultDirty ? ' · Unsynced changes' : ''}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label="Toggle color theme"
              className="lg:hidden p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 rounded-md"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => handleSyncNow()}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Vault'}
            </button>
          </div>
        </header>

        {/* Feedback Toast Banner */}
        {banner && (
          <div className="px-4 sm:px-6 pt-4 max-w-6xl w-full mx-auto">
            <div
              className={`px-4 py-2.5 text-xs rounded-lg border ${
                banner.type === 'ok'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300'
                  : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
              }`}
            >
              {banner.text}
            </div>
          </div>
        )}

        {/* Active Tab Viewport */}
        <main className="flex-1 px-4 sm:px-6 py-6 pb-24 lg:pb-10 max-w-6xl w-full mx-auto">
          {activeTab === 'routing' && (
            <RoutingChainTab
              vault={vault}
              runtime={runtime}
              onUpdateVault={handleUpdateVault}
              onJumpToVault={() => setActiveTab('vault')}
            />
          )}

          {activeTab === 'vault' && (
            <KeysVaultTab
              vault={vault}
              runtime={runtime}
              hasPin={hasPin}
              activePin={activePin}
              masterKey={masterKey}
              onMasterKeyChange={setMasterKey}
              onUpdateVault={handleUpdateVault}
              onSetPin={handleSetPin}
              onLockNow={handleLockNow}
              onSyncNow={handleSyncNow}
              onClearServerRam={handleClearServerRam}
              syncing={syncing}
            />
          )}

          {activeTab === 'playground' && (
            <PlaygroundTab
              vault={vault}
              runtime={runtime}
              masterKey={masterKey}
              onRefreshRuntime={refreshRuntime}
            />
          )}

          {activeTab === 'analytics' && (
            <AnalyticsLogsTab
              runtime={runtime}
              archivedKeyStats={archivedKeyStats}
              archivedLogs={archivedLogs}
              onRefresh={refreshRuntime}
              onClearCooldown={handleClearCooldown}
              onClearLogs={handleClearLogs}
            />
          )}
        </main>
      </div>

      {/* Mobile Bottom Tab Bar (56px height, well within 15% mobile sticky cap) */}
      <nav
        aria-label="Primary mobile navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 grid grid-cols-4"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="whitespace-nowrap">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

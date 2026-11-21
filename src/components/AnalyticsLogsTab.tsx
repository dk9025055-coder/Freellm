import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  KeyUsageStats,
  RouterLogEntry,
  RouterRuntimeSnapshot,
} from '../../shared/types.ts';

interface AnalyticsLogsTabProps {
  runtime: RouterRuntimeSnapshot | null;
  archivedKeyStats: KeyUsageStats[];
  archivedLogs: RouterLogEntry[];
  onRefresh: () => Promise<void>;
  onClearCooldown: (keyId?: string) => Promise<void>;
  onClearLogs: () => Promise<void>;
}

type LogFilter = 'all' | 'ok' | 'error' | 'failover';

export const AnalyticsLogsTab: React.FC<AnalyticsLogsTabProps> = ({
  runtime,
  archivedKeyStats,
  archivedLogs,
  onRefresh,
  onClearCooldown,
  onClearLogs,
}) => {
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [logSearch, setLogSearch] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick every second for accurate 60s cooldown countdowns
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const keyStats = useMemo(() => {
    if (runtime && runtime.keyStats.length > 0) return runtime.keyStats;
    return archivedKeyStats;
  }, [runtime, archivedKeyStats]);

  const logs = useMemo(() => {
    if (runtime && runtime.recentLogs.length > 0) return runtime.recentLogs;
    return archivedLogs;
  }, [runtime, archivedLogs]);

  const totals = useMemo(() => {
    if (runtime && runtime.totals.requests > 0) return runtime.totals;
    let requests = 0;
    let successes = 0;
    let failures = 0;
    let failovers = 0;
    let totalTokens = 0;
    let latSum = 0;
    let latCount = 0;
    let activeCooldowns = 0;
    for (const s of keyStats) {
      requests += s.totalRequests;
      successes += s.successRequests;
      failures += s.failedRequests;
      failovers += s.failoversTriggered;
      totalTokens += s.totalTokens;
      if (s.avgLatencyMs > 0) {
        latSum += s.avgLatencyMs;
        latCount += 1;
      }
      if (s.cooldownUntil && s.cooldownUntil > nowMs) activeCooldowns += 1;
    }
    return {
      requests,
      successes,
      failures,
      failovers,
      totalTokens,
      avgLatencyMs: latCount > 0 ? Math.round(latSum / latCount) : 0,
      activeCooldowns,
    };
  }, [runtime, keyStats, nowMs]);

  const successRate =
    totals.requests > 0
      ? ((totals.successes / totals.requests) * 100).toFixed(1)
      : '—';

  const providerBreakdown = useMemo(() => {
    const map = new Map<string, { providerId: string; requests: number; tokens: number }>();
    for (const s of keyStats) {
      if (s.totalRequests === 0) continue;
      const prev = map.get(s.providerId) || {
        providerId: s.providerId,
        requests: 0,
        tokens: 0,
      };
      prev.requests += s.totalRequests;
      prev.tokens += s.totalTokens;
      map.set(s.providerId, prev);
    }
    return Array.from(map.values()).sort((a, b) => b.requests - a.requests);
  }, [keyStats]);

  const maxProviderRequests = providerBreakdown[0]?.requests || 1;

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (logFilter === 'ok' && !l.ok) return false;
      if (logFilter === 'error' && l.ok) return false;
      if (logFilter === 'failover' && l.failovers.length === 0) return false;
      if (!q) return true;
      return (
        l.routedVia.toLowerCase().includes(q) ||
        l.requestedModel.toLowerCase().includes(q) ||
        l.surface.toLowerCase().includes(q) ||
        (l.errorMessage || '').toLowerCase().includes(q)
      );
    });
  }, [logs, logFilter, logSearch]);

  const activeCooldownCount = keyStats.filter(
    (s) => s.cooldownUntil && s.cooldownUntil > nowMs
  ).length;

  return (
    <div className="space-y-8">
      {/* Summary KPI Row */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Total Routed Requests
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {totals.requests.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
            {totals.failovers} automatic failover{totals.failovers === 1 ? '' : 's'}
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Success Rate
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {successRate === '—' ? '—' : `${successRate}%`}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
            {totals.successes} OK · {totals.failures} failed
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Average Latency
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {totals.avgLatencyMs > 0 ? `${totals.avgLatencyMs} ms` : '—'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Rolling EMA across active keys
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Tokens & Cooldowns
          </div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {totals.totalTokens.toLocaleString()}
          </div>
          <div
            className={`text-xs mt-1 tabular-nums ${
              activeCooldownCount > 0
                ? 'text-amber-700 dark:text-amber-400 font-medium'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {activeCooldownCount} key{activeCooldownCount === 1 ? '' : 's'} in 60s cooldown
          </div>
        </div>
      </section>

      {/* Per-Key RPM / RPD / Token Usage & Cooldown Table */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Per-Key Rate Counters & 60s Cooldowns
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tracked in Express RAM and mirrored to browser IndexedDB. Keys returning 429 or 5xx enter a 60-second cooldown automatically.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activeCooldownCount > 0 && (
              <button
                type="button"
                onClick={() => onClearCooldown()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-md whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset All Cooldowns
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[720px]">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-4 font-medium">Key / Provider</th>
                <th className="py-2.5 px-3 font-medium text-right">RPM</th>
                <th className="py-2.5 px-3 font-medium text-right">RPD</th>
                <th className="py-2.5 px-3 font-medium text-right">Tokens</th>
                <th className="py-2.5 px-3 font-medium text-right">Avg Latency</th>
                <th className="py-2.5 px-3 font-medium text-right">Failovers</th>
                <th className="py-2.5 px-4 font-medium text-right">Health / Cooldown</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
              {keyStats.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center text-slate-500 dark:text-slate-400"
                  >
                    No keys synced to active router RAM yet. Add keys in Keys Vault and sync.
                  </td>
                </tr>
              ) : (
                keyStats.map((s) => {
                  const remainingSec =
                    s.cooldownUntil && s.cooldownUntil > nowMs
                      ? Math.ceil((s.cooldownUntil - nowMs) / 1000)
                      : 0;

                  return (
                    <tr
                      key={s.keyId}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {s.label}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {s.providerId}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                        {s.rpm}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                        {s.rpd}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                        {s.totalTokens.toLocaleString()}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {s.avgLatencyMs > 0 ? `${s.avgLatencyMs} ms` : '—'}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {s.failoversTriggered}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {remainingSec > 0 ? (
                          <div className="inline-flex items-center gap-2 justify-end">
                            <span className="font-mono text-amber-700 dark:text-amber-400 tabular-nums font-medium">
                              Cooldown {remainingSec}s
                            </span>
                            <button
                              type="button"
                              onClick={() => onClearCooldown(s.keyId)}
                              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              Clear
                            </button>
                          </div>
                        ) : (
                          <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                            Healthy
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Provider Distribution Bar Breakdown */}
      {providerBreakdown.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Provider Traffic Distribution
          </h3>
          <div className="space-y-2.5">
            {providerBreakdown.map((item) => {
              const pct = Math.max(4, Math.round((item.requests / maxProviderRequests) * 100));
              return (
                <div key={item.providerId} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                      {item.providerId}
                    </span>
                    <span className="font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                      {item.requests} req · {item.tokens.toLocaleString()} tokens
                    </span>
                  </div>
                  <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-blue-600 dark:bg-blue-500 rounded-sm transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Live Request Logs */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Live Request & Failover Logs
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any entry to inspect failover chain attempts and error diagnostics.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Filter logs..."
                className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'ok', label: '200 OK' },
                  { id: 'failover', label: 'Failovers' },
                  { id: 'error', label: 'Errors' },
                ] as Array<{ id: LogFilter; label: string }>
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setLogFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    logFilter === f.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {logs.length > 0 && (
              <button
                type="button"
                onClick={onClearLogs}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 border border-slate-200 dark:border-slate-700 rounded-md whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800/80 overflow-hidden">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              No requests logged yet. Send a test prompt from the Playground or connect an external CLI tool.
            </div>
          ) : (
            filteredLogs.map((log) => {
              const expanded = expandedLogId === log.id;
              return (
                <div key={log.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedLogId(expanded ? null : log.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedLogId(expanded ? null : log.id);
                      }
                    }}
                    className="px-4 py-3 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-slate-400 shrink-0">
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <span
                        className={`font-mono font-semibold tabular-nums shrink-0 ${
                          log.ok
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {log.status}
                      </span>
                      <code className="font-mono text-slate-500 dark:text-slate-400 shrink-0">
                        {log.surface}
                      </code>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono text-slate-900 dark:text-slate-100 truncate max-w-[260px] sm:max-w-[400px]">
                        {log.routedVia}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums shrink-0 ml-auto">
                      <span>req: {log.requestedModel}</span>
                      {log.failovers.length > 0 && (
                        <span className="text-amber-700 dark:text-amber-400 font-medium">
                          {log.failovers.length} failover{log.failovers.length > 1 ? 's' : ''}
                        </span>
                      )}
                      <span>{log.latencyMs} ms</span>
                      <span>{log.totalTokens} tok</span>
                      <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>

                  {expanded && (
                    <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-100 dark:border-slate-800/80 text-xs space-y-2 font-mono">
                      <div className="text-slate-600 dark:text-slate-300">
                        X-Routed-Via: <span className="text-slate-900 dark:text-slate-100">{log.routedVia}</span> · Mode: {log.stream ? 'SSE stream' : 'JSON'} · Attempts: {log.attempts} · Prompt/Completion tokens: {log.promptTokens}/{log.completionTokens}
                      </div>
                      {log.errorMessage && (
                        <div className="text-red-600 dark:text-red-400">
                          Error: {log.errorMessage}
                        </div>
                      )}
                      {log.failovers.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <div className="text-amber-700 dark:text-amber-400 font-semibold">
                            Failover Trace (60s cooldown triggered on 429/5xx):
                          </div>
                          {log.failovers.map((f, i) => (
                            <div
                              key={i}
                              className="text-[11px] text-slate-600 dark:text-slate-400 pl-3"
                            >
                              #{i + 1} {f.providerId}/{f.modelId} ({f.keyLabel}) → HTTP {f.status}: {f.reason}
                            </div>
                          ))}
                        </div>
                      )}
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

import React, { useState } from 'react';
import { Lock, KeyRound, AlertCircle } from 'lucide-react';

interface VaultLockScreenProps {
  onUnlock: (pin: string) => Promise<void>;
  onResetVault: () => Promise<void>;
}

export const VaultLockScreen: React.FC<VaultLockScreenProps> = ({
  onUnlock,
  onResetVault,
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onUnlock(pin.trim());
    } catch {
      setError('Incorrect PIN or passphrase. Decryption failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-200">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              RelayGate Vault Locked
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              AES-256-GCM encrypted in browser IndexedDB
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="vault-pin-input"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Vault PIN or Passphrase
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="vault-pin-input"
                type="password"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="Enter your PIN to decrypt local keys"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !pin.trim()}
            className="w-full py-2.5 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
          >
            {loading ? 'Decrypting Vault...' : 'Unlock Local Vault'}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
          {!confirmReset ? (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="text-xs text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors"
            >
              Forgot PIN? Erase local IndexedDB vault and start fresh
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-red-600 dark:text-red-400">
                This permanently wipes your local browser vault. Make sure you have an encrypted JSON backup first.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onResetVault}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md"
                >
                  Confirm Wipe Vault
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

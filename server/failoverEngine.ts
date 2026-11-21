import type { ModelCapability, RouterLogEntry } from '../shared/types.ts';
import {
  invokeChatNonStreaming,
  invokeChatStreaming,
  invokeEmbeddings,
  invokeImageGeneration,
  UpstreamHttpError,
  type CanonicalChatRequest,
  type CanonicalChatResult,
  type StreamChunk,
} from './adapters.ts';
import { routerState, type ResolvedCandidate } from './routerState.ts';

export interface FailoverTraceItem {
  providerId: string;
  modelId: string;
  keyLabel: string;
  status: number;
  reason: string;
}

export interface RoutedExecutionMeta {
  candidate: ResolvedCandidate;
  routedVia: string;
  latencyMs: number;
  attempts: number;
  failovers: FailoverTraceItem[];
}

export class NoHealthyProviderError extends Error {
  status: number;
  failovers: FailoverTraceItem[];
  skippedCooldowns: number;

  constructor(
    status: number,
    message: string,
    failovers: FailoverTraceItem[],
    skippedCooldowns: number
  ) {
    super(message);
    this.status = status;
    this.failovers = failovers;
    this.skippedCooldowns = skippedCooldowns;
  }
}

export function detectRequiredCapability(req: CanonicalChatRequest): ModelCapability {
  for (const msg of req.messages) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some((p) => p.type === 'image_url')) {
        return 'vision';
      }
    }
  }
  return 'chat';
}

export function formatRoutedVia(candidate: ResolvedCandidate): string {
  return `${candidate.provider.id}/${candidate.modelId} (${candidate.keyLabel})`;
}

export async function executeChatWithFailover(params: {
  surface: RouterLogEntry['surface'];
  req: CanonicalChatRequest;
}): Promise<{ result: CanonicalChatResult; meta: RoutedExecutionMeta }> {
  const capability = detectRequiredCapability(params.req);
  const { candidates, skippedCooldowns } = routerState.resolveCandidates(
    params.req.model,
    capability
  );

  if (candidates.length === 0) {
    const msg =
      skippedCooldowns > 0
        ? `All ${skippedCooldowns} matching key/model targets are in 60s rate-limit cooldown. Retry shortly or clear cooldowns in Analytics.`
        : `No active API keys synced for "${params.req.model || 'auto'}". Add a provider key in Keys Vault and click "Sync Vault to Active Router".`;
    throw new NoHealthyProviderError(503, msg, [], skippedCooldowns);
  }

  const failovers: FailoverTraceItem[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attemptStart = Date.now();
    try {
      const result = await invokeChatNonStreaming(candidate, params.req);
      const latencyMs = Date.now() - attemptStart;
      const routedVia = formatRoutedVia(candidate);

      routerState.recordAttemptSuccess(
        candidate.keyId,
        candidate.provider.id,
        candidate.keyLabel,
        latencyMs,
        result.usage.prompt_tokens,
        result.usage.completion_tokens
      );

      routerState.addLog({
        id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        surface: params.surface,
        requestedModel: params.req.model || 'auto',
        routedProviderId: candidate.provider.id,
        routedModelId: candidate.modelId,
        routedKeyLabel: candidate.keyLabel,
        routedVia,
        status: 200,
        ok: true,
        stream: false,
        latencyMs: Date.now() - overallStart,
        attempts: i + 1,
        failovers,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
      });

      return {
        result,
        meta: {
          candidate,
          routedVia,
          latencyMs: Date.now() - overallStart,
          attempts: i + 1,
          failovers,
        },
      };
    } catch (err) {
      const status = err instanceof UpstreamHttpError ? err.status : 502;
      const reason = err instanceof Error ? err.message : 'Upstream error';

      if (status === 429 || status >= 500 || status === 408) {
        routerState.markCooldown(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel,
          candidate.modelId,
          `HTTP ${status}: ${reason.slice(0, 120)}`,
          status
        );
      } else {
        routerState.recordAttemptFailure(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel
        );
      }

      failovers.push({
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
        keyLabel: candidate.keyLabel,
        status,
        reason: reason.slice(0, 160),
      });
    }
  }

  const last = failovers[failovers.length - 1];
  routerState.addLog({
    id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    surface: params.surface,
    requestedModel: params.req.model || 'auto',
    routedProviderId: last?.providerId || 'none',
    routedModelId: last?.modelId || 'none',
    routedKeyLabel: last?.keyLabel || 'none',
    routedVia: last ? `${last.providerId}/${last.modelId} (failed)` : 'none',
    status: last?.status || 503,
    ok: false,
    stream: false,
    latencyMs: Date.now() - overallStart,
    attempts: failovers.length,
    failovers,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    errorMessage: last?.reason || 'All providers in fallback chain failed',
  });

  throw new NoHealthyProviderError(
    last?.status || 503,
    `All ${failovers.length} candidate(s) failed. Last error (${last?.providerId}/${last?.modelId}): ${last?.reason}`,
    failovers,
    skippedCooldowns
  );
}

/**
 * Initiates a streaming request with pre-first-chunk failover!
 * Pulls the first chunk to confirm upstream is healthy (no 429/5xx) before committing HTTP headers.
 */
export async function startStreamWithFailover(params: {
  surface: RouterLogEntry['surface'];
  req: CanonicalChatRequest;
}): Promise<{
  firstChunk: StreamChunk | null;
  iterator: AsyncGenerator<StreamChunk>;
  meta: RoutedExecutionMeta;
  finalizeLog: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }, ok?: boolean, errMsg?: string) => void;
}> {
  const capability = detectRequiredCapability(params.req);
  const { candidates, skippedCooldowns } = routerState.resolveCandidates(
    params.req.model,
    capability
  );

  if (candidates.length === 0) {
    const msg =
      skippedCooldowns > 0
        ? `All ${skippedCooldowns} matching targets are in 60s cooldown.`
        : `No active API keys synced for "${params.req.model || 'auto'}".`;
    throw new NoHealthyProviderError(503, msg, [], skippedCooldowns);
  }

  const failovers: FailoverTraceItem[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attemptStart = Date.now();
    try {
      const iterator = invokeChatStreaming(candidate, params.req);
      const first = await iterator.next();
      const routedVia = formatRoutedVia(candidate);

      const meta: RoutedExecutionMeta = {
        candidate,
        routedVia,
        latencyMs: Date.now() - overallStart,
        attempts: i + 1,
        failovers,
      };

      const finalizeLog = (
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
        ok = true,
        errMsg?: string
      ) => {
        const totalLatency = Date.now() - attemptStart;
        if (ok) {
          routerState.recordAttemptSuccess(
            candidate.keyId,
            candidate.provider.id,
            candidate.keyLabel,
            totalLatency,
            usage.prompt_tokens,
            usage.completion_tokens
          );
        } else {
          routerState.recordAttemptFailure(
            candidate.keyId,
            candidate.provider.id,
            candidate.keyLabel
          );
        }

        routerState.addLog({
          id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          surface: params.surface,
          requestedModel: params.req.model || 'auto',
          routedProviderId: candidate.provider.id,
          routedModelId: candidate.modelId,
          routedKeyLabel: candidate.keyLabel,
          routedVia,
          status: ok ? 200 : 502,
          ok,
          stream: true,
          latencyMs: Date.now() - overallStart,
          attempts: i + 1,
          failovers,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          errorMessage: errMsg,
        });
      };

      return {
        firstChunk: first.done ? null : first.value,
        iterator,
        meta,
        finalizeLog,
      };
    } catch (err) {
      const status = err instanceof UpstreamHttpError ? err.status : 502;
      const reason = err instanceof Error ? err.message : 'Stream init failed';

      if (status === 429 || status >= 500 || status === 408) {
        routerState.markCooldown(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel,
          candidate.modelId,
          `HTTP ${status}: ${reason.slice(0, 120)}`,
          status
        );
      } else {
        routerState.recordAttemptFailure(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel
        );
      }

      failovers.push({
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
        keyLabel: candidate.keyLabel,
        status,
        reason: reason.slice(0, 160),
      });
    }
  }

  const last = failovers[failovers.length - 1];
  throw new NoHealthyProviderError(
    last?.status || 503,
    `All ${failovers.length} streaming candidate(s) failed. Last error (${last?.providerId}/${last?.modelId}): ${last?.reason}`,
    failovers,
    skippedCooldowns
  );
}

export async function executeEmbeddingsWithFailover(
  requestedModel: string | undefined,
  input: string | string[]
) {
  const { candidates, skippedCooldowns } = routerState.resolveCandidates(
    requestedModel || 'auto',
    'embeddings'
  );
  if (candidates.length === 0) {
    throw new NoHealthyProviderError(
      503,
      'No active embeddings-capable provider synced (add Google Gemini, Mistral, Cloudflare, Cohere, or SiliconFlow).',
      [],
      skippedCooldowns
    );
  }

  const failovers: FailoverTraceItem[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attemptStart = Date.now();
    try {
      const result = await invokeEmbeddings(candidate, input);
      const latencyMs = Date.now() - attemptStart;
      const routedVia = formatRoutedVia(candidate);

      routerState.recordAttemptSuccess(
        candidate.keyId,
        candidate.provider.id,
        candidate.keyLabel,
        latencyMs,
        result.usage.prompt_tokens,
        0
      );

      routerState.addLog({
        id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        surface: '/v1/embeddings',
        requestedModel: requestedModel || 'auto',
        routedProviderId: candidate.provider.id,
        routedModelId: candidate.modelId,
        routedKeyLabel: candidate.keyLabel,
        routedVia,
        status: 200,
        ok: true,
        stream: false,
        latencyMs: Date.now() - overallStart,
        attempts: i + 1,
        failovers,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: 0,
        totalTokens: result.usage.total_tokens,
      });

      return {
        result,
        meta: {
          candidate,
          routedVia,
          latencyMs: Date.now() - overallStart,
          attempts: i + 1,
          failovers,
        },
      };
    } catch (err) {
      const status = err instanceof UpstreamHttpError ? err.status : 502;
      const reason = err instanceof Error ? err.message : 'Embeddings error';
      if (status === 429 || status >= 500) {
        routerState.markCooldown(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel,
          candidate.modelId,
          `HTTP ${status}: ${reason.slice(0, 120)}`,
          status
        );
      }
      failovers.push({
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
        keyLabel: candidate.keyLabel,
        status,
        reason: reason.slice(0, 160),
      });
    }
  }

  const last = failovers[failovers.length - 1];
  throw new NoHealthyProviderError(
    last?.status || 503,
    `Embeddings failed across ${failovers.length} provider(s): ${last?.reason}`,
    failovers,
    skippedCooldowns
  );
}

export async function executeImagesWithFailover(
  requestedModel: string | undefined,
  prompt: string,
  size = '1024x1024'
) {
  const { candidates, skippedCooldowns } = routerState.resolveCandidates(
    requestedModel || 'auto',
    'image'
  );
  if (candidates.length === 0) {
    throw new NoHealthyProviderError(
      503,
      'No active image-generation provider synced (add Together AI FLUX.1-schnell-Free or Cloudflare Workers AI FLUX.1).',
      [],
      skippedCooldowns
    );
  }

  const failovers: FailoverTraceItem[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attemptStart = Date.now();
    try {
      const result = await invokeImageGeneration(candidate, prompt, size);
      const latencyMs = Date.now() - attemptStart;
      const routedVia = formatRoutedVia(candidate);

      routerState.recordAttemptSuccess(
        candidate.keyId,
        candidate.provider.id,
        candidate.keyLabel,
        latencyMs,
        0,
        0
      );

      routerState.addLog({
        id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        surface: '/v1/images/generations',
        requestedModel: requestedModel || 'auto',
        routedProviderId: candidate.provider.id,
        routedModelId: candidate.modelId,
        routedKeyLabel: candidate.keyLabel,
        routedVia,
        status: 200,
        ok: true,
        stream: false,
        latencyMs: Date.now() - overallStart,
        attempts: i + 1,
        failovers,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });

      return {
        result,
        meta: {
          candidate,
          routedVia,
          latencyMs: Date.now() - overallStart,
          attempts: i + 1,
          failovers,
        },
      };
    } catch (err) {
      const status = err instanceof UpstreamHttpError ? err.status : 502;
      const reason = err instanceof Error ? err.message : 'Image gen error';
      if (status === 429 || status >= 500) {
        routerState.markCooldown(
          candidate.keyId,
          candidate.provider.id,
          candidate.keyLabel,
          candidate.modelId,
          `HTTP ${status}: ${reason.slice(0, 120)}`,
          status
        );
      }
      failovers.push({
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
        keyLabel: candidate.keyLabel,
        status,
        reason: reason.slice(0, 160),
      });
    }
  }

  const last = failovers[failovers.length - 1];
  throw new NoHealthyProviderError(
    last?.status || 503,
    `Image generation failed across ${failovers.length} provider(s): ${last?.reason}`,
    failovers,
    skippedCooldowns
  );
}

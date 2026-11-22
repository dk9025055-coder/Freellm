import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProviderById } from './shared/providers.ts';
import type { VaultPayload } from './shared/types.ts';
import {
  testProviderKey,
  type CanonicalChatRequest,
  type CanonicalContentPart,
  type CanonicalMessage,
  type CanonicalTool,
} from './server/adapters.ts';
import {
  executeChatWithFailover,
  executeEmbeddingsWithFailover,
  executeImagesWithFailover,
  NoHealthyProviderError,
  startStreamWithFailover,
  type RoutedExecutionMeta,
} from './server/failoverEngine.ts';
import { routerState } from './server/routerState.ts';
import { parseStartupVaultJson } from './server/vaultCrypto.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hydrate RAM vault on startup from ROUTER_VAULT_JSON if configured (zero-disk headless mode)
if (process.env.ROUTER_VAULT_JSON?.trim()) {
  const passphrase =
    process.env.ROUTER_VAULT_PASSPHRASE?.trim() || process.env.ROUTER_MASTER_KEY?.trim();
  const parsed = parseStartupVaultJson(process.env.ROUTER_VAULT_JSON.trim(), passphrase);
  if (parsed) {
    routerState.syncVault(parsed, 'env-vault');
    console.log(
      `[RelayGate] Loaded ${parsed.keys.length} key(s) into RAM from ROUTER_VAULT_JSON.`
    );
  }
}

const app = express();
app.use(express.json({ limit: '25mb' }));

// CORS with exposed X-Routed-Via headers for browser clients, CLIs, and agents
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Router-Master-Key, x-api-key, anthropic-version, x-goog-api-key'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Routed-Via, X-Router-Latency-Ms, X-Router-Attempts, X-Router-Failovers'
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function extractAuthToken(req: Request): string | undefined {
  const masterHeader = req.headers['x-router-master-key'];
  if (typeof masterHeader === 'string' && masterHeader.trim()) {
    return masterHeader.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }
  const xGoogKey = req.headers['x-goog-api-key'];
  if (typeof xGoogKey === 'string' && xGoogKey.trim()) {
    return xGoogKey.trim();
  }
  if (typeof req.query.key === 'string' && req.query.key.trim()) {
    return req.query.key.trim();
  }
  return undefined;
}

function requireMasterKeyIfSet(req: Request, res: Response, next: NextFunction) {
  if (!routerState.isMasterKeyRequired()) {
    next();
    return;
  }
  const token = extractAuthToken(req);
  if (!routerState.verifyMasterKey(token)) {
    res.status(401).json({
      error: {
        message:
          'Invalid or missing ROUTER_MASTER_KEY. Pass it via Authorization: Bearer <key> or X-Router-Master-Key header.',
        type: 'authentication_error',
      },
    });
    return;
  }
  next();
}

function applyRoutingHeaders(res: Response, meta: RoutedExecutionMeta) {
  res.setHeader('X-Routed-Via', meta.routedVia);
  res.setHeader('X-Router-Latency-Ms', String(meta.latencyMs));
  res.setHeader('X-Router-Attempts', String(meta.attempts));
  res.setHeader('X-Router-Failovers', String(meta.failovers.length));
}

function handleRouterError(res: Response, err: unknown) {
  if (err instanceof NoHealthyProviderError) {
    res.status(err.status).json({
      error: {
        message: err.message,
        type: 'router_failover_exhausted',
        failovers: err.failovers,
        skipped_cooldowns: err.skippedCooldowns,
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected router error';
  res.status(500).json({ error: { message, type: 'router_error' } });
}

// ============================================================================
// CONTROL PLANE & VAULT RAM SYNC ENDPOINTS
// ============================================================================

app.get('/api/health', (_req: Request, res: Response) => {
  const snap = routerState.getSnapshot();
  res.json({
    ok: true,
    synced: snap.synced,
    activeKeys: snap.activeKeyCount,
    activeProviders: snap.activeProviderCount,
    serverGeminiAvailable: snap.serverGeminiAvailable,
    masterKeyRequired: snap.masterKeyRequired,
  });
});

app.get('/api/router/state', (_req: Request, res: Response) => {
  res.json(routerState.getSnapshot());
});

app.post('/api/router/sync', requireMasterKeyIfSet, (req: Request, res: Response) => {
  const body = req.body as Partial<VaultPayload>;
  if (!body || !Array.isArray(body.keys)) {
    res.status(400).json({ error: 'Invalid vault payload: expected keys array.' });
    return;
  }
  routerState.syncVault(
    {
      version: 1,
      updatedAt: body.updatedAt || Date.now(),
      keys: body.keys,
      customEndpoints: Array.isArray(body.customEndpoints) ? body.customEndpoints : [],
      customModels:
        body.customModels && typeof body.customModels === 'object' ? body.customModels : {},
      providerPriorities:
        body.providerPriorities && typeof body.providerPriorities === 'object' ? body.providerPriorities : {},
      profiles: Array.isArray(body.profiles) ? body.profiles : [],
      defaultStrategy: body.defaultStrategy || 'auto',
    },
    'browser-sync'
  );
  res.json({
    ok: true,
    snapshot: routerState.getSnapshot(),
  });
});

app.post('/api/router/clear', requireMasterKeyIfSet, (_req: Request, res: Response) => {
  routerState.clearRam();
  res.json({ ok: true, snapshot: routerState.getSnapshot() });
});

app.post('/api/router/cooldown/clear', (req: Request, res: Response) => {
  const keyId = typeof req.body?.keyId === 'string' ? req.body.keyId : undefined;
  routerState.clearCooldown(keyId);
  res.json({ ok: true, snapshot: routerState.getSnapshot() });
});

app.post('/api/router/logs/clear', (_req: Request, res: Response) => {
  routerState.clearLogs();
  res.json({ ok: true, snapshot: routerState.getSnapshot() });
});

app.post('/api/router/test-key', async (req: Request, res: Response) => {
  try {
    const { providerId, apiKey, accountId, modelId, customEndpoint } = req.body as {
      providerId: string;
      apiKey: string;
      accountId?: string;
      modelId?: string;
      customEndpoint?: {
        id: string;
        name: string;
        adapter: 'openai' | 'anthropic' | 'ollama';
        baseUrl: string;
        models: string[];
        extraHeaders?: Record<string, string>;
      };
    };

    const provider =
      routerState.getProviderForTest(providerId) ||
      getProviderById(providerId, customEndpoint ? [customEndpoint] : [], routerState.getCustomModels?.());

    if (!provider) {
      res.status(400).json({ ok: false, message: `Unknown provider "${providerId}"` });
      return;
    }

    const result = await testProviderKey({
      provider,
      apiKey: apiKey || '',
      accountId,
      modelId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: 500,
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Health check failed',
    });
  }
});

// ============================================================================
// 1. OPENAI-COMPATIBLE SURFACES (/v1/*)
// ============================================================================

app.get('/v1/models', requireMasterKeyIfSet, (_req: Request, res: Response) => {
  const data = routerState.listExposedModels().map((m) => ({
    id: m.id,
    object: 'model',
    created: m.created,
    owned_by: m.owned_by,
  }));
  res.json({ object: 'list', data });
});

app.post('/v1/chat/completions', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const body = req.body as CanonicalChatRequest;
    const chatReq: CanonicalChatRequest = {
      model: body.model || 'auto',
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: Boolean(body.stream),
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: body.tools,
      tool_choice: body.tool_choice,
    };

    if (chatReq.stream) {
      const { firstChunk, iterator, meta, finalizeLog } = await startStreamWithFailover({
        surface: '/v1/chat/completions',
        req: chatReq,
      });

      applyRoutingHeaders(res, meta);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const streamId = `chatcmpl-${Date.now().toString(36)}`;
      const created = Math.floor(Date.now() / 1000);
      const modelOut = `${meta.candidate.provider.id}/${meta.candidate.modelId}`;
      let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      const emitChunk = (chunk: { text?: string; toolCalls?: unknown; finishReason?: string }) => {
        const delta: Record<string, unknown> = {};
        if (chunk.text) delta.content = chunk.text;
        if (chunk.toolCalls) delta.tool_calls = chunk.toolCalls;
        const payload = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: modelOut,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: chunk.finishReason || null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        if (firstChunk) {
          if (firstChunk.usage) finalUsage = firstChunk.usage;
          emitChunk(firstChunk);
        }
        for await (const chunk of iterator) {
          if (chunk.usage) finalUsage = chunk.usage;
          if (chunk.text || chunk.toolCalls || chunk.finishReason) {
            emitChunk(chunk);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
        finalizeLog(finalUsage, true);
      } catch (streamErr) {
        finalizeLog(
          finalUsage,
          false,
          streamErr instanceof Error ? streamErr.message : 'Stream interrupted'
        );
        res.write(`data: ${JSON.stringify({ error: { message: 'Stream interrupted' } })}\n\n`);
        res.end();
      }
      return;
    }

    const { result, meta } = await executeChatWithFailover({
      surface: '/v1/chat/completions',
      req: chatReq,
    });
    applyRoutingHeaders(res, meta);
    res.json({
      id: result.id,
      object: 'chat.completion',
      created: result.created,
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: result.usage,
      routed_via: meta.routedVia,
    });
  } catch (err) {
    handleRouterError(res, err);
  }
});

// OpenAI Responses API (/v1/responses) for Codex CLI & modern OpenAI SDKs
app.post('/v1/responses', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const { model, input, instructions, stream, max_output_tokens, tools } = req.body as {
      model?: string;
      input?: string | Array<{ role?: string; content?: string | CanonicalContentPart[] }>;
      instructions?: string;
      stream?: boolean;
      max_output_tokens?: number;
      tools?: CanonicalTool[];
    };

    const messages: CanonicalMessage[] = [];
    if (instructions) {
      messages.push({ role: 'system', content: instructions });
    }
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        messages.push({
          role: (item.role as CanonicalMessage['role']) || 'user',
          content: item.content ?? '',
        });
      }
    }

    const chatReq: CanonicalChatRequest = {
      model: model || 'auto',
      messages,
      stream: Boolean(stream),
      max_tokens: max_output_tokens,
      tools,
    };

    if (stream) {
      const { firstChunk, iterator, meta, finalizeLog } = await startStreamWithFailover({
        surface: '/v1/responses',
        req: chatReq,
      });
      applyRoutingHeaders(res, meta);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');

      const respId = `resp_${Date.now().toString(36)}`;
      let fullText = '';
      let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      const emitDelta = (text: string) => {
        fullText += text;
        res.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: 'response.output_text.delta',
            response_id: respId,
            delta: text,
          })}\n\n`
        );
      };

      try {
        if (firstChunk?.text) emitDelta(firstChunk.text);
        if (firstChunk?.usage) finalUsage = firstChunk.usage;
        for await (const chunk of iterator) {
          if (chunk.text) emitDelta(chunk.text);
          if (chunk.usage) finalUsage = chunk.usage;
        }
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: respId,
              object: 'response',
              status: 'completed',
              model: `${meta.candidate.provider.id}/${meta.candidate.modelId}`,
              output_text: fullText,
              usage: {
                input_tokens: finalUsage.prompt_tokens,
                output_tokens: finalUsage.completion_tokens,
                total_tokens: finalUsage.total_tokens,
              },
            },
          })}\n\n`
        );
        res.end();
        finalizeLog(finalUsage, true);
      } catch (e) {
        finalizeLog(finalUsage, false, e instanceof Error ? e.message : 'Stream error');
        res.end();
      }
      return;
    }

    const { result, meta } = await executeChatWithFailover({
      surface: '/v1/responses',
      req: chatReq,
    });
    applyRoutingHeaders(res, meta);
    res.json({
      id: `resp_${Date.now().toString(36)}`,
      object: 'response',
      created_at: result.created,
      status: 'completed',
      model: result.model,
      output_text: result.content,
      output: [
        {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: result.content }],
        },
      ],
      usage: {
        input_tokens: result.usage.prompt_tokens,
        output_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens,
      },
    });
  } catch (err) {
    handleRouterError(res, err);
  }
});

// Legacy OpenAI Completions (/v1/completions)
app.post('/v1/completions', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const { model, prompt, max_tokens, temperature, stream } = req.body as {
      model?: string;
      prompt?: string | string[];
      max_tokens?: number;
      temperature?: number;
      stream?: boolean;
    };
    const promptText = Array.isArray(prompt) ? prompt.join('\n') : prompt || '';
    const chatReq: CanonicalChatRequest = {
      model: model || 'auto',
      messages: [{ role: 'user', content: promptText }],
      max_tokens,
      temperature,
      stream: Boolean(stream),
    };

    const { result, meta } = await executeChatWithFailover({
      surface: '/v1/completions',
      req: chatReq,
    });
    applyRoutingHeaders(res, meta);
    res.json({
      id: `cmpl-${Date.now().toString(36)}`,
      object: 'text_completion',
      created: result.created,
      model: result.model,
      choices: [
        {
          text: result.content,
          index: 0,
          finish_reason: result.finishReason,
        },
      ],
      usage: result.usage,
    });
  } catch (err) {
    handleRouterError(res, err);
  }
});

// OpenAI Embeddings (/v1/embeddings)
app.post('/v1/embeddings', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const { model, input } = req.body as { model?: string; input?: string | string[] };
    if (!input) {
      res.status(400).json({ error: { message: 'Missing "input" field.' } });
      return;
    }
    const { result, meta } = await executeEmbeddingsWithFailover(model, input);
    applyRoutingHeaders(res, meta);
    res.json(result);
  } catch (err) {
    handleRouterError(res, err);
  }
});

// OpenAI Images Generations (/v1/images/generations)
app.post('/v1/images/generations', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const { model, prompt, size } = req.body as {
      model?: string;
      prompt?: string;
      size?: string;
    };
    if (!prompt) {
      res.status(400).json({ error: { message: 'Missing "prompt" field.' } });
      return;
    }
    const { result, meta } = await executeImagesWithFailover(model, prompt, size);
    applyRoutingHeaders(res, meta);
    res.json(result);
  } catch (err) {
    handleRouterError(res, err);
  }
});

// ============================================================================
// 2. ANTHROPIC-COMPATIBLE SURFACE (/v1/messages) — Claude Code / Hermes Agent
// ============================================================================

app.post('/v1/messages', requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      model?: string;
      system?: string | Array<{ type: string; text?: string }>;
      messages?: Array<{
        role: 'user' | 'assistant';
        content:
          | string
          | Array<{
              type: string;
              text?: string;
              source?: { type: string; media_type: string; data: string };
              id?: string;
              name?: string;
              input?: unknown;
              tool_use_id?: string;
              content?: string;
            }>;
      }>;
      tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
      max_tokens?: number;
      temperature?: number;
      stream?: boolean;
    };

    const messages: CanonicalMessage[] = [];
    if (typeof body.system === 'string' && body.system) {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const sysTxt = body.system
        .map((s) => s.text || '')
        .filter(Boolean)
        .join('\n');
      if (sysTxt) messages.push({ role: 'system', content: sysTxt });
    }

    for (const m of body.messages || []) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        const parts: CanonicalContentPart[] = [];
        for (const block of m.content) {
          if (block.type === 'text' && block.text) {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image' && block.source?.data) {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          } else if (block.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
            });
          }
        }
        if (parts.length > 0) {
          messages.push({ role: m.role, content: parts });
        }
      }
    }

    const canonicalTools: CanonicalTool[] | undefined = body.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const chatReq: CanonicalChatRequest = {
      model: body.model || 'auto',
      messages,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature,
      tools: canonicalTools,
      stream: Boolean(body.stream),
    };

    if (chatReq.stream) {
      const { firstChunk, iterator, meta, finalizeLog } = await startStreamWithFailover({
        surface: '/v1/messages',
        req: chatReq,
      });
      applyRoutingHeaders(res, meta);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');

      const msgId = `msg_${Date.now().toString(36)}`;
      const modelOut = `${meta.candidate.provider.id}/${meta.candidate.modelId}`;
      let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: modelOut,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`
      );
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`
      );

      const emitText = (txt: string) => {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: txt },
          })}\n\n`
        );
      };

      try {
        if (firstChunk?.text) emitText(firstChunk.text);
        if (firstChunk?.usage) finalUsage = firstChunk.usage;
        for await (const chunk of iterator) {
          if (chunk.text) emitText(chunk.text);
          if (chunk.usage) finalUsage = chunk.usage;
        }
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0,
          })}\n\n`
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: finalUsage.completion_tokens },
          })}\n\n`
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        finalizeLog(finalUsage, true);
      } catch (e) {
        finalizeLog(finalUsage, false, e instanceof Error ? e.message : 'Anthropic stream failed');
        res.end();
      }
      return;
    }

    const { result, meta } = await executeChatWithFailover({
      surface: '/v1/messages',
      req: chatReq,
    });
    applyRoutingHeaders(res, meta);

    const contentBlocks: Array<Record<string, unknown>> = [];
    if (result.content) {
      contentBlocks.push({ type: 'text', text: result.content });
    }
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsedInput = { raw: tc.function.arguments };
        }
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        });
      }
    }

    res.json({
      id: `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
      stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: result.usage.prompt_tokens,
        output_tokens: result.usage.completion_tokens,
      },
    });
  } catch (err) {
    handleRouterError(res, err);
  }
});

// ============================================================================
// 3. GEMINI-COMPATIBLE SURFACE (/v1beta/*) — Gemini CLI & Google SDK Clients
// ============================================================================

app.get('/v1beta/models', requireMasterKeyIfSet, (_req: Request, res: Response) => {
  const models = routerState.listExposedModels().map((m) => ({
    name: `models/${m.id}`,
    displayName: m.id,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  }));
  res.json({ models });
});

app.post(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/, requireMasterKeyIfSet, async (req: Request, res: Response) => {
  try {
    const requestedModel = decodeURIComponent(req.params[0] || 'auto');
    const action = req.params[1];
    const isStream = action === 'streamGenerateContent';

    const body = req.body as {
      systemInstruction?: { parts?: Array<{ text?: string }> };
      contents?: Array<{
        role?: string;
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType: string; data: string };
        }>;
      }>;
      generationConfig?: { maxOutputTokens?: number; temperature?: number };
    };

    const messages: CanonicalMessage[] = [];
    if (body.systemInstruction?.parts?.length) {
      const sys = body.systemInstruction.parts
        .map((p) => p.text || '')
        .filter(Boolean)
        .join('\n');
      if (sys) messages.push({ role: 'system', content: sys });
    }

    for (const c of body.contents || []) {
      const parts: CanonicalContentPart[] = [];
      for (const p of c.parts || []) {
        if (p.text) parts.push({ type: 'text', text: p.text });
        if (p.inlineData?.data) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}`,
            },
          });
        }
      }
      if (parts.length > 0) {
        messages.push({
          role: c.role === 'model' ? 'assistant' : 'user',
          content: parts,
        });
      }
    }

    const chatReq: CanonicalChatRequest = {
      model: requestedModel,
      messages,
      max_tokens: body.generationConfig?.maxOutputTokens,
      temperature: body.generationConfig?.temperature,
      stream: isStream,
    };

    if (isStream) {
      const { firstChunk, iterator, meta, finalizeLog } = await startStreamWithFailover({
        surface: '/v1beta',
        req: chatReq,
      });
      applyRoutingHeaders(res, meta);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');

      let finalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const emitGeminiChunk = (text: string, finishReason?: string) => {
        const chunkPayload = {
          candidates: [
            {
              content: { role: 'model', parts: [{ text }] },
              ...(finishReason ? { finishReason: 'STOP' } : {}),
            },
          ],
          modelVersion: `${meta.candidate.provider.id}/${meta.candidate.modelId}`,
        };
        res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
      };

      try {
        if (firstChunk?.text) emitGeminiChunk(firstChunk.text);
        if (firstChunk?.usage) finalUsage = firstChunk.usage;
        for await (const chunk of iterator) {
          if (chunk.usage) finalUsage = chunk.usage;
          if (chunk.text || chunk.finishReason) {
            emitGeminiChunk(chunk.text || '', chunk.finishReason);
          }
        }
        res.end();
        finalizeLog(finalUsage, true);
      } catch (e) {
        finalizeLog(finalUsage, false, e instanceof Error ? e.message : 'Gemini stream failed');
        res.end();
      }
      return;
    }

    const { result, meta } = await executeChatWithFailover({
      surface: '/v1beta',
      req: chatReq,
    });
    applyRoutingHeaders(res, meta);
    res.json({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: result.content }],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: result.usage.prompt_tokens,
        candidatesTokenCount: result.usage.completion_tokens,
        totalTokenCount: result.usage.total_tokens,
      },
      modelVersion: result.model,
    });
  } catch (err) {
    handleRouterError(res, err);
  }
});

// ============================================================================
// FRONTEND SERVING (Vite dev middleware in dev, dist/ static in production)
// ============================================================================

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[RelayGate] Personal AI API Router listening on http://0.0.0.0:${port}`);
  });
}

if (!process.env.ROUTER_MASTER_KEY?.trim()) {
  console.warn(
    '[RelayGate] ROUTER_MASTER_KEY is not set — /api/router/sync, /api/router/clear and /v1/* endpoints are UNPROTECTED. Set ROUTER_MASTER_KEY before deploying to production.'
  );
}

startServer();

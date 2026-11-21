import { GoogleGenAI, Type } from '@google/genai';
import type { ProviderCatalogEntry } from '../shared/types.ts';
import type { ResolvedCandidate } from './routerState.ts';

export interface CanonicalContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface CanonicalToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | CanonicalContentPart[] | null;
  tool_calls?: CanonicalToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface CanonicalTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CanonicalChatRequest {
  model: string;
  messages: CanonicalMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: CanonicalTool[];
  tool_choice?: unknown;
}

export interface CanonicalChatResult {
  id: string;
  created: number;
  model: string;
  content: string;
  toolCalls?: CanonicalToolCall[];
  finishReason: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  text?: string;
  toolCalls?: CanonicalToolCall[];
  finishReason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class UpstreamHttpError extends Error {
  status: number;
  retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500 || status === 408;
  }
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractTextFromContent(content: CanonicalMessage['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n');
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function convertJsonSchemaToGemini(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const typeMap: Record<string, string> = {
    string: Type.STRING,
    number: Type.NUMBER,
    integer: Type.INTEGER,
    boolean: Type.BOOLEAN,
    array: Type.ARRAY,
    object: Type.OBJECT,
  };
  const out: Record<string, unknown> = {};
  if (typeof schema.type === 'string' && typeMap[schema.type.toLowerCase()]) {
    out.type = typeMap[schema.type.toLowerCase()];
  }
  if (typeof schema.description === 'string') {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[k] = convertJsonSchemaToGemini(v as Record<string, unknown>);
    }
    if (Object.keys(props).length > 0) {
      out.properties = props;
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    out.items = convertJsonSchemaToGemini(schema.items as Record<string, unknown>);
  }
  if (Array.isArray(schema.required)) {
    out.required = schema.required;
  }
  return out;
}

async function buildGeminiParams(candidate: ResolvedCandidate, req: CanonicalChatRequest) {
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const txt = extractTextFromContent(msg.content);
      if (txt) systemParts.push(txt);
      continue;
    }

    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: msg.name || 'tool_output',
              response: { result: extractTextFromContent(msg.content) },
            },
          },
        ],
      });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === 'text' && p.text) {
          parts.push({ text: p.text });
        } else if (p.type === 'image_url' && p.image_url?.url) {
          const parsed = parseDataUrl(p.image_url.url);
          if (parsed) {
            parts.push({
              inlineData: {
                mimeType: parsed.mimeType,
                data: parsed.data,
              },
            });
          } else {
            // Fetch remote URL as base64 if needed
            try {
              const imgRes = await fetch(p.image_url.url);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
                parts.push({
                  inlineData: { mimeType, data: buf.toString('base64') },
                });
              }
            } catch {
              parts.push({ text: `[Image URL: ${p.image_url.url}]` });
            }
          }
        }
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsedArgs = { raw: tc.function.arguments };
        }
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: parsedArgs,
          },
        });
      }
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }

  const config: Record<string, unknown> = {};
  if (systemParts.length > 0) {
    config.systemInstruction = systemParts.join('\n\n');
  }
  // Avoid deprecated sampling params (temperature, topP, topK) for gemini-4-* series
  const isGemini4 = candidate.modelId.startsWith('gemini-4');
  if (!isGemini4 && typeof req.temperature === 'number') {
    config.temperature = req.temperature;
  }
  if (!isGemini4 && typeof req.max_tokens === 'number' && req.max_tokens > 0) {
    config.maxOutputTokens = req.max_tokens;
  }

  if (req.tools && req.tools.length > 0) {
    config.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: convertJsonSchemaToGemini(t.function.parameters),
        })),
      },
    ];
  }

  return {
    model: candidate.modelId,
    contents: contents.length > 0 ? contents : 'Hello',
    config: Object.keys(config).length > 0 ? config : undefined,
  };
}

function classifyGeminiError(err: unknown): UpstreamHttpError {
  const anyErr = err as { status?: number; code?: number; message?: string };
  const msg = anyErr?.message || String(err);
  let status = typeof anyErr?.status === 'number' ? anyErr.status : 500;
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) status = 429;
  else if (msg.includes('401') || msg.includes('API_KEY_INVALID')) status = 401;
  else if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) status = 403;
  else if (msg.includes('404') || msg.includes('NOT_FOUND')) status = 404;
  else if (msg.includes('503') || msg.includes('UNAVAILABLE')) status = 503;
  return new UpstreamHttpError(status, msg);
}

function resolveOpenAiEndpoint(candidate: ResolvedCandidate, pathSuffix: string): string {
  if (candidate.provider.adapter === 'cloudflare') {
    const accountId = candidate.accountId?.trim();
    if (!accountId) {
      throw new UpstreamHttpError(
        400,
        'Cloudflare Workers AI requires an Account ID stored alongside the API token.'
      );
    }
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1${pathSuffix}`;
  }
  const base = candidate.provider.baseUrl.replace(/\/+$/, '');
  return `${base}${pathSuffix}`;
}

function buildAuthHeaders(candidate: ResolvedCandidate): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(candidate.provider.extraHeaders || {}),
  };
  if (candidate.provider.adapter === 'anthropic') {
    headers['x-api-key'] = candidate.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (candidate.apiKey && candidate.provider.id !== 'pollinations') {
    headers['Authorization'] = `Bearer ${candidate.apiKey}`;
  }
  return headers;
}

export async function invokeChatNonStreaming(
  candidate: ResolvedCandidate,
  req: CanonicalChatRequest
): Promise<CanonicalChatResult> {
  const id = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  if (candidate.provider.adapter === 'gemini') {
    try {
      const ai = createGeminiClient(candidate.apiKey);
      const params = await buildGeminiParams(candidate, req);
      const res = await ai.models.generateContent(params);

      const toolCalls: CanonicalToolCall[] = [];
      if (res.functionCalls && res.functionCalls.length > 0) {
        for (let i = 0; i < res.functionCalls.length; i++) {
          const fc = res.functionCalls[i];
          toolCalls.push({
            id: fc.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: fc.name || 'unknown',
              arguments: JSON.stringify(fc.args ?? {}),
            },
          });
        }
      }

      const usage = res.usageMetadata;
      const promptTokens = usage?.promptTokenCount ?? 0;
      const completionTokens = usage?.candidatesTokenCount ?? 0;

      return {
        id,
        created,
        model: `${candidate.provider.id}/${candidate.modelId}`,
        content: res.text ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: usage?.totalTokenCount ?? promptTokens + completionTokens,
        },
      };
    } catch (err) {
      throw classifyGeminiError(err);
    }
  }

  if (candidate.provider.adapter === 'anthropic') {
    const base = candidate.provider.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const systemText = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => extractTextFromContent(m.content))
      .join('\n\n');

    const anthropicMessages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: extractTextFromContent(m.content),
      }));

    const body: Record<string, unknown> = {
      model: candidate.modelId,
      max_tokens: req.max_tokens || 2048,
      messages: anthropicMessages,
    };
    if (systemText) body.system = systemText;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeaders(candidate),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new UpstreamHttpError(res.status, errText.slice(0, 400));
    }

    const data = (await res.json()) as {
      id?: string;
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCalls: CanonicalToolCall[] = [];
    for (const block of data.content || []) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
      if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const pt = data.usage?.input_tokens ?? 0;
    const ct = data.usage?.output_tokens ?? 0;

    return {
      id: data.id || id,
      created,
      model: `${candidate.provider.id}/${candidate.modelId}`,
      content: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    };
  }

  // OpenAI-compatible (and Cloudflare OpenAI-compat, Cohere compat, Ollama)
  const url = resolveOpenAiEndpoint(candidate, '/chat/completions');
  const body: Record<string, unknown> = {
    model: candidate.modelId,
    messages: req.messages,
    stream: false,
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.max_tokens === 'number' && req.max_tokens > 0) body.max_tokens = req.max_tokens;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(candidate),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new UpstreamHttpError(res.status, errText.slice(0, 400));
  }

  const data = (await res.json()) as {
    id?: string;
    created?: number;
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: CanonicalToolCall[] };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const firstChoice = data.choices?.[0];
  const pt = data.usage?.prompt_tokens ?? 0;
  const ct = data.usage?.completion_tokens ?? 0;

  return {
    id: data.id || id,
    created: data.created || created,
    model: `${candidate.provider.id}/${candidate.modelId}`,
    content: firstChoice?.message?.content ?? '',
    toolCalls: firstChoice?.message?.tool_calls,
    finishReason: firstChoice?.finish_reason || 'stop',
    usage: {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: data.usage?.total_tokens ?? pt + ct,
    },
  };
}

/**
 * Async generator yielding normalized StreamChunks from any upstream adapter.
 * Throws UpstreamHttpError BEFORE yielding first chunk on 429/5xx so failover works seamlessly!
 */
export async function* invokeChatStreaming(
  candidate: ResolvedCandidate,
  req: CanonicalChatRequest
): AsyncGenerator<StreamChunk> {
  if (candidate.provider.adapter === 'gemini') {
    try {
      const ai = createGeminiClient(candidate.apiKey);
      const params = await buildGeminiParams(candidate, req);
      const stream = await ai.models.generateContentStream(params);

      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
          completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens;
        }
        const toolCalls: CanonicalToolCall[] = [];
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          for (let i = 0; i < chunk.functionCalls.length; i++) {
            const fc = chunk.functionCalls[i];
            toolCalls.push({
              id: fc.id || `call_${Date.now()}_${i}`,
              type: 'function',
              function: {
                name: fc.name || 'unknown',
                arguments: JSON.stringify(fc.args ?? {}),
              },
            });
          }
        }
        if (chunk.text || toolCalls.length > 0) {
          yield {
            text: chunk.text || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
        }
      }

      yield {
        finishReason: 'stop',
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
      return;
    } catch (err) {
      throw classifyGeminiError(err);
    }
  }

  if (candidate.provider.adapter === 'anthropic') {
    const base = candidate.provider.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const systemText = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => extractTextFromContent(m.content))
      .join('\n\n');

    const body: Record<string, unknown> = {
      model: candidate.modelId,
      max_tokens: req.max_tokens || 2048,
      stream: true,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: extractTextFromContent(m.content),
        })),
    };
    if (systemText) body.system = systemText;

    const res = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeaders(candidate),
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      throw new UpstreamHttpError(res.status, errText.slice(0, 400));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pt = 0;
    let ct = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            yield { text: evt.delta.text };
          } else if (evt.type === 'message_start' && evt.message?.usage) {
            pt = evt.message.usage.input_tokens ?? pt;
          } else if (evt.type === 'message_delta' && evt.usage) {
            ct = evt.usage.output_tokens ?? ct;
          }
        } catch {
          // ignore non-JSON keepalives
        }
      }
    }
    yield {
      finishReason: 'stop',
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    };
    return;
  }

  // OpenAI-compatible SSE streaming
  const url = resolveOpenAiEndpoint(candidate, '/chat/completions');
  const body: Record<string, unknown> = {
    model: candidate.modelId,
    messages: req.messages,
    stream: true,
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.max_tokens === 'number' && req.max_tokens > 0) body.max_tokens = req.max_tokens;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(candidate),
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new UpstreamHttpError(res.status, errText.slice(0, 400));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta;
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }
        if (delta?.content || delta?.tool_calls) {
          yield {
            text: delta.content || undefined,
            toolCalls: delta.tool_calls || undefined,
          };
        }
      } catch {
        // skip partial/comment lines
      }
    }
  }

  yield {
    finishReason: 'stop',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export async function invokeEmbeddings(
  candidate: ResolvedCandidate,
  input: string | string[]
): Promise<{
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}> {
  const inputs = Array.isArray(input) ? input : [input];

  if (candidate.provider.adapter === 'gemini') {
    try {
      const ai = createGeminiClient(candidate.apiKey);
      const data: Array<{ object: 'embedding'; index: number; embedding: number[] }> = [];
      for (let i = 0; i < inputs.length; i++) {
        const res = await ai.models.embedContent({
          model: candidate.modelId,
          contents: inputs[i],
        });
        const values = res.embeddings?.[0]?.values || [];
        data.push({ object: 'embedding', index: i, embedding: values });
      }
      return {
        object: 'list',
        data,
        model: `${candidate.provider.id}/${candidate.modelId}`,
        usage: { prompt_tokens: inputs.join(' ').split(/\s+/).length, total_tokens: inputs.join(' ').split(/\s+/).length },
      };
    } catch (err) {
      throw classifyGeminiError(err);
    }
  }

  const url = resolveOpenAiEndpoint(candidate, '/embeddings');
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(candidate),
    body: JSON.stringify({ model: candidate.modelId, input }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new UpstreamHttpError(res.status, errText.slice(0, 400));
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding: number[]; index?: number }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };

  return {
    object: 'list',
    data: (json.data || []).map((d, i) => ({
      object: 'embedding',
      index: d.index ?? i,
      embedding: d.embedding || [],
    })),
    model: `${candidate.provider.id}/${candidate.modelId}`,
    usage: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      total_tokens: json.usage?.total_tokens ?? 0,
    },
  };
}

export async function invokeImageGeneration(
  candidate: ResolvedCandidate,
  prompt: string,
  size = '1024x1024'
): Promise<{
  created: number;
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}> {
  const created = Math.floor(Date.now() / 1000);

  if (candidate.provider.adapter === 'cloudflare') {
    const accountId = candidate.accountId?.trim();
    if (!accountId) {
      throw new UpstreamHttpError(400, 'Cloudflare Account ID is required.');
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${candidate.modelId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${candidate.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new UpstreamHttpError(res.status, errText.slice(0, 400));
    }
    const json = (await res.json()) as { result?: { image?: string } };
    if (json.result?.image) {
      return { created, data: [{ b64_json: json.result.image, revised_prompt: prompt }] };
    }
    throw new UpstreamHttpError(502, 'Unexpected Cloudflare image response.');
  }

  const url = resolveOpenAiEndpoint(candidate, '/images/generations');
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(candidate),
    body: JSON.stringify({
      model: candidate.modelId,
      prompt,
      size,
      n: 1,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new UpstreamHttpError(res.status, errText.slice(0, 400));
  }
  const json = (await res.json()) as {
    created?: number;
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  };
  return {
    created: json.created || created,
    data: json.data || [],
  };
}

/**
 * Live "Test Key" health check making a real minimal request to the upstream provider.
 */
export async function testProviderKey(params: {
  provider: ProviderCatalogEntry;
  apiKey: string;
  accountId?: string;
  modelId?: string;
}): Promise<{ ok: boolean; status: number; latencyMs: number; message: string; modelUsed: string }> {
  const started = Date.now();
  const chatModel =
    params.modelId ||
    params.provider.models.find((m) => m.capabilities.includes('chat'))?.id ||
    params.provider.models[0]?.id ||
    'default';

  const candidate: ResolvedCandidate = {
    keyId: 'test',
    keyLabel: 'Health Check',
    apiKey: params.apiKey,
    accountId: params.accountId,
    provider: params.provider,
    modelId: chatModel,
    smartnessScore: 80,
    speedScore: 80,
  };

  try {
    const result = await invokeChatNonStreaming(candidate, {
      model: chatModel,
      messages: [{ role: 'user', content: 'Reply with OK' }],
      max_tokens: 16,
    });
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      status: 200,
      latencyMs,
      message: `Healthy · Responded "${result.content.trim().slice(0, 48) || 'OK'}"`,
      modelUsed: chatModel,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof UpstreamHttpError) {
      return {
        ok: false,
        status: err.status,
        latencyMs,
        message: `HTTP ${err.status}: ${err.message.slice(0, 180)}`,
        modelUsed: chatModel,
      };
    }
    return {
      ok: false,
      status: 500,
      latencyMs,
      message: err instanceof Error ? err.message.slice(0, 180) : 'Connection failed',
      modelUsed: chatModel,
    };
  }
}

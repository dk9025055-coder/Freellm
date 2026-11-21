import React, { useMemo, useRef, useState } from 'react';
import {
  FileText,
  Image as ImageIcon,
  Play,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { BUILTIN_PROVIDERS } from '../../shared/providers.ts';
import type { RouterRuntimeSnapshot, VaultPayload } from '../../shared/types.ts';

interface PlaygroundTabProps {
  vault: VaultPayload;
  runtime: RouterRuntimeSnapshot | null;
  masterKey: string;
  onRefreshRuntime: () => Promise<void>;
}

type PlaygroundSurface =
  | '/v1/chat/completions'
  | '/v1/messages'
  | '/v1beta'
  | '/v1/responses'
  | '/v1/embeddings'
  | '/v1/images/generations';

interface AttachmentItem {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachmentItem[];
  routedVia?: string;
  latencyMs?: string;
  attempts?: string;
  failovers?: string;
  status?: number;
  surface?: PlaygroundSurface;
  imageUrl?: string;
  rawHeaders?: Record<string, string>;
}

export const PlaygroundTab: React.FC<PlaygroundTabProps> = ({
  vault,
  runtime,
  masterKey,
  onRefreshRuntime,
}) => {
  const [surface, setSurface] = useState<PlaygroundSurface>('/v1/chat/completions');
  const [selectedModel, setSelectedModel] = useState<string>(vault.defaultStrategy || 'auto');
  const [streamEnabled, setStreamEnabled] = useState<boolean>(true);
  const [includeSampleTool, setIncludeSampleTool] = useState<boolean>(false);
  const [systemPrompt, setSystemPrompt] = useState<string>(
    'You are a concise, accurate engineering assistant.'
  );
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [running, setRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastHeaders, setLastHeaders] = useState<Record<string, string> | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textFileInputRef = useRef<HTMLInputElement | null>(null);

  const modelOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: 'auto', label: 'auto (Smartest)' },
      { value: 'auto:fast', label: 'auto:fast (Lowest Latency)' },
      { value: 'auto:round-robin', label: 'auto:round-robin' },
    ];
    for (const p of vault.profiles) {
      opts.push({ value: p.name, label: `${p.name} (Profile)` });
    }

    const activePids = new Set(
      vault.keys.filter((k) => k.enabled).map((k) => k.providerId)
    );
    if (runtime?.serverGeminiAvailable) activePids.add('gemini');

    for (const prov of BUILTIN_PROVIDERS) {
      if (activePids.has(prov.id)) {
        for (const m of prov.models) {
          opts.push({ value: `${prov.id}/${m.id}`, label: `${prov.name} — ${m.id}` });
        }
      }
    }
    for (const ce of vault.customEndpoints) {
      for (const m of ce.models) {
        opts.push({ value: `${ce.id}/${m}`, label: `${ce.name} — ${m}` });
      }
    }
    return opts;
  }, [vault.profiles, vault.keys, vault.customEndpoints, runtime?.serverGeminiAvailable]);

  const handleAttachImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachments((prev) => [
        ...prev,
        {
          id: `att-${Date.now()}`,
          name: file.name,
          kind: 'image',
          mimeType: file.type || 'image/png',
          dataUrl: String(reader.result || ''),
        },
      ]);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleAttachTextFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachments((prev) => [
        ...prev,
        {
          id: `att-${Date.now()}`,
          name: file.name,
          kind: 'text',
          mimeType: file.type || 'text/plain',
          textContent: String(reader.result || '').slice(0, 40_000),
        },
      ]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const stopRequest = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const promptText = input.trim();
    if (!promptText && attachments.length === 0) return;

    setErrorMsg(null);
    setRunning(true);

    const currentAttachments = [...attachments];
    const textFileBlocks = currentAttachments
      .filter((a) => a.kind === 'text' && a.textContent)
      .map((a) => `--- File: ${a.name} ---\n${a.textContent}\n--- End File ---`)
      .join('\n\n');

    const fullUserText = [promptText, textFileBlocks].filter(Boolean).join('\n\n');
    const imageAttachments = currentAttachments.filter((a) => a.kind === 'image' && a.dataUrl);

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: promptText || '(Attached file)',
      attachments: currentAttachments,
      surface,
    };

    const assistantTurnId = `a-${Date.now() + 1}`;
    const placeholderAssistant: ChatTurn = {
      id: assistantTurnId,
      role: 'assistant',
      content: '',
      surface,
    };

    setTurns((prev) => [...prev, userTurn, placeholderAssistant]);
    setInput('');
    setAttachments([]);

    const controller = new AbortController();
    abortRef.current = controller;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (masterKey.trim()) {
      headers['Authorization'] = `Bearer ${masterKey.trim()}`;
      headers['X-Router-Master-Key'] = masterKey.trim();
    }

    const extractRoutingMeta = (res: Response) => {
      const hObj: Record<string, string> = {};
      for (const k of [
        'x-routed-via',
        'x-router-latency-ms',
        'x-router-attempts',
        'x-router-failovers',
        'content-type',
      ]) {
        const val = res.headers.get(k);
        if (val) hObj[k] = val;
      }
      setLastHeaders(hObj);
      return {
        routedVia: res.headers.get('x-routed-via') || undefined,
        latencyMs: res.headers.get('x-router-latency-ms') || undefined,
        attempts: res.headers.get('x-router-attempts') || undefined,
        failovers: res.headers.get('x-router-failovers') || undefined,
        status: res.status,
        rawHeaders: hObj,
      };
    };

    const updateAssistant = (patch: Partial<ChatTurn>) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurnId ? { ...t, ...patch } : t))
      );
    };

    try {
      const sampleTools = includeSampleTool
        ? [
            {
              type: 'function',
              function: {
                name: 'get_provider_quota',
                description: 'Look up current free-tier quota status for an AI provider',
                parameters: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string', description: 'Provider name e.g. groq or gemini' },
                  },
                  required: ['provider'],
                },
              },
            },
          ]
        : undefined;

      // 1. Embeddings surface
      if (surface === '/v1/embeddings') {
        const res = await fetch('/v1/embeddings', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ model: selectedModel, input: fullUserText }),
        });
        const meta = extractRoutingMeta(res);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        const vec = data?.data?.[0]?.embedding || [];
        updateAssistant({
          ...meta,
          content: `Generated embedding vector (${vec.length} dimensions).\nFirst 8 values: [${vec
            .slice(0, 8)
            .map((n: number) => n.toFixed(5))
            .join(', ')} ...]`,
        });
        await onRefreshRuntime();
        return;
      }

      // 2. Images generation surface
      if (surface === '/v1/images/generations') {
        const res = await fetch('/v1/images/generations', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ model: selectedModel, prompt: fullUserText }),
        });
        const meta = extractRoutingMeta(res);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        const item = data?.data?.[0];
        const imgUrl = item?.url
          ? item.url
          : item?.b64_json
            ? `data:image/png;base64,${item.b64_json}`
            : undefined;
        updateAssistant({
          ...meta,
          content: item?.revised_prompt || 'Image generated successfully.',
          imageUrl: imgUrl,
        });
        await onRefreshRuntime();
        return;
      }

      // 3. Anthropic /v1/messages surface
      if (surface === '/v1/messages') {
        const contentBlocks: Array<Record<string, unknown>> = [
          { type: 'text', text: fullUserText },
        ];
        for (const img of imageAttachments) {
          const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            });
          }
        }
        const res = await fetch('/v1/messages', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: selectedModel,
            system: systemPrompt || undefined,
            max_tokens: 2048,
            stream: streamEnabled,
            messages: [{ role: 'user', content: contentBlocks }],
            tools: includeSampleTool
              ? [
                  {
                    name: 'get_provider_quota',
                    description: 'Look up current free-tier quota status for an AI provider',
                    input_schema: {
                      type: 'object',
                      properties: { provider: { type: 'string' } },
                      required: ['provider'],
                    },
                  },
                ]
              : undefined,
          }),
        });
        const meta = extractRoutingMeta(res);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.error?.message || `HTTP ${res.status}`);
        }

        if (streamEnabled && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let acc = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const l of lines) {
              if (!l.startsWith('data:')) continue;
              try {
                const evt = JSON.parse(l.slice(5).trim());
                if (evt.type === 'content_block_delta' && evt.delta?.text) {
                  acc += evt.delta.text;
                  updateAssistant({ ...meta, content: acc });
                }
              } catch {
                // skip
              }
            }
          }
        } else {
          const data = await res.json();
          const text = (data.content || [])
            .map((b: { type: string; text?: string; name?: string; input?: unknown }) =>
              b.type === 'text'
                ? b.text
                : `[tool_use: ${b.name}(${JSON.stringify(b.input)})]`
            )
            .join('\n');
          updateAssistant({ ...meta, content: text });
        }
        await onRefreshRuntime();
        return;
      }

      // 4. Gemini /v1beta surface
      if (surface === '/v1beta') {
        const parts: Array<Record<string, unknown>> = [{ text: fullUserText }];
        for (const img of imageAttachments) {
          const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
        const action = streamEnabled ? 'streamGenerateContent' : 'generateContent';
        const url = `/v1beta/models/${encodeURIComponent(selectedModel)}:${action}`;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
            contents: [{ role: 'user', parts }],
          }),
        });
        const meta = extractRoutingMeta(res);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.error?.message || `HTTP ${res.status}`);
        }
        if (streamEnabled && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let acc = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const l of lines) {
              if (!l.startsWith('data:')) continue;
              try {
                const evt = JSON.parse(l.slice(5).trim());
                const piece = evt?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (piece) {
                  acc += piece;
                  updateAssistant({ ...meta, content: acc });
                }
              } catch {
                // skip
              }
            }
          }
        } else {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          updateAssistant({ ...meta, content: text });
        }
        await onRefreshRuntime();
        return;
      }

      // 5. OpenAI /v1/responses surface
      if (surface === '/v1/responses') {
        const res = await fetch('/v1/responses', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: selectedModel,
            instructions: systemPrompt || undefined,
            input: fullUserText,
            stream: streamEnabled,
          }),
        });
        const meta = extractRoutingMeta(res);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.error?.message || `HTTP ${res.status}`);
        }
        if (streamEnabled && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let acc = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const l of lines) {
              if (!l.startsWith('data:')) continue;
              try {
                const evt = JSON.parse(l.slice(5).trim());
                if (evt.type === 'response.output_text.delta' && evt.delta) {
                  acc += evt.delta;
                  updateAssistant({ ...meta, content: acc });
                }
              } catch {
                // skip
              }
            }
          }
        } else {
          const data = await res.json();
          updateAssistant({ ...meta, content: data.output_text || '' });
        }
        await onRefreshRuntime();
        return;
      }

      // 6. Default OpenAI /v1/chat/completions surface
      const userContent =
        imageAttachments.length > 0
          ? [
              { type: 'text', text: fullUserText },
              ...imageAttachments.map((img) => ({
                type: 'image_url',
                image_url: { url: img.dataUrl! },
              })),
            ]
          : fullUserText;

      const messages: Array<Record<string, unknown>> = [];
      if (systemPrompt.trim()) {
        messages.push({ role: 'system', content: systemPrompt.trim() });
      }
      messages.push({ role: 'user', content: userContent });

      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedModel,
          messages,
          stream: streamEnabled,
          tools: sampleTools,
        }),
      });
      const meta = extractRoutingMeta(res);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `HTTP ${res.status}`);
      }

      if (streamEnabled && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let acc = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const l of lines) {
            const trimmed = l.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              const delta = evt?.choices?.[0]?.delta;
              if (delta?.content) {
                acc += delta.content;
                updateAssistant({ ...meta, content: acc });
              }
              if (delta?.tool_calls) {
                acc += `\n[tool_call] ${JSON.stringify(delta.tool_calls)}`;
                updateAssistant({ ...meta, content: acc });
              }
            } catch {
              // skip
            }
          }
        }
      } else {
        const data = await res.json();
        const msg = data?.choices?.[0]?.message;
        let out = msg?.content || '';
        if (msg?.tool_calls?.length) {
          out += `${out ? '\n\n' : ''}Tool Calls:\n${JSON.stringify(msg.tool_calls, null, 2)}`;
        }
        updateAssistant({ ...meta, content: out });
      }
      await onRefreshRuntime();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : 'Request failed';
        setErrorMsg(msg);
        updateAssistant({ content: `Error: ${msg}`, status: 500 });
      }
    } finally {
      setRunning(false);
    }
  };

  const surfaces: Array<{ id: PlaygroundSurface; label: string }> = [
    { id: '/v1/chat/completions', label: 'OpenAI Chat' },
    { id: '/v1/messages', label: 'Anthropic Messages' },
    { id: '/v1beta', label: 'Gemini v1beta' },
    { id: '/v1/responses', label: 'OpenAI Responses' },
    { id: '/v1/embeddings', label: 'Embeddings' },
    { id: '/v1/images/generations', label: 'Images' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Main Interactive Playground Column */}
      <div className="lg:col-span-8 space-y-4">
        {/* Surface & Model Toolbar */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
            {surfaces.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSurface(s.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  surface === s.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[200px]">
              <label className="sr-only" htmlFor="pg-model-select">
                Target model or routing strategy
              </label>
              <select
                id="pg-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {surface !== '/v1/embeddings' && surface !== '/v1/images/generations' && (
              <>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={streamEnabled}
                    onChange={(e) => setStreamEnabled(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Stream SSE
                </label>
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={includeSampleTool}
                    onChange={(e) => setIncludeSampleTool(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <Wrench className="w-3.5 h-3.5 text-slate-400" />
                  Test Tool Call
                </label>
              </>
            )}

            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTurns([]);
                  setLastHeaders(null);
                  setErrorMsg(null);
                }}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Conversation / Output Stream */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg min-h-[340px] max-h-[520px] overflow-y-auto p-4 space-y-4">
          {turns.length === 0 ? (
            <div className="h-[300px] flex flex-col items-center justify-center text-center px-4">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Test live routing across {surface}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md">
                Send text, upload an image for vision routing, or attach a code/text file. Inspect the exact <code className="font-mono">X-Routed-Via</code> header and failover count in real time.
              </p>
            </div>
          ) : (
            turns.map((t) => (
              <div
                key={t.id}
                className={`p-3.5 rounded-lg border ${
                  t.role === 'user'
                    ? 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 ml-6'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 mr-6'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {t.role === 'user' ? 'Request' : 'Routed Response'}
                    {t.surface ? ` · ${t.surface}` : ''}
                  </span>
                  {t.routedVia && (
                    <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400 tabular-nums">
                      X-Routed-Via: {t.routedVia}
                      {t.latencyMs ? ` · ${t.latencyMs}ms` : ''}
                      {t.failovers && Number(t.failovers) > 0
                        ? ` · ${t.failovers} failover(s)`
                        : ''}
                    </span>
                  )}
                </div>

                {t.attachments && t.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {t.attachments.map((att) =>
                      att.kind === 'image' && att.dataUrl ? (
                        <img
                          key={att.id}
                          src={att.dataUrl}
                          alt={att.name}
                          className="h-20 w-auto rounded border border-slate-200 dark:border-slate-700 object-cover"
                        />
                      ) : (
                        <span
                          key={att.id}
                          className="text-xs font-mono text-slate-600 dark:text-slate-300"
                        >
                          Attached file: {att.name}
                        </span>
                      )
                    )}
                  </div>
                )}

                <div className="text-sm text-slate-900 dark:text-slate-100 whitespace-pre-wrap leading-relaxed break-words">
                  {t.content || (running && t.role === 'assistant' ? 'Streaming response...' : '')}
                </div>

                {t.imageUrl && (
                  <div className="mt-3">
                    <img
                      src={t.imageUrl}
                      alt="Generated output"
                      className="max-w-full max-h-80 rounded-md border border-slate-200 dark:border-slate-700"
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Composer with Image & Text File Upload */}
        <form
          onSubmit={handleSend}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2.5"
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded"
                >
                  {att.kind === 'image' ? (
                    <ImageIcon className="w-3.5 h-3.5 text-blue-600" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-slate-500" />
                  )}
                  <span className="truncate max-w-[160px]">{att.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="text-slate-400 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSend();
              }
            }}
            placeholder={
              surface === '/v1/embeddings'
                ? 'Enter text to embed via /v1/embeddings...'
                : surface === '/v1/images/generations'
                  ? 'Describe an image to generate via /v1/images/generations...'
                  : 'Enter a prompt (Ctrl/Cmd + Enter to send)...'
            }
            className="w-full text-sm bg-transparent text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none resize-none"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={handleAttachImage}
                className="hidden"
              />
              <input
                ref={textFileInputRef}
                type="file"
                accept=".txt,.md,.json,.ts,.tsx,.js,.py,.csv,.yaml,.yml,.log,.html,.css"
                onChange={handleAttachTextFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                Attach Image
              </button>
              <button
                type="button"
                onClick={() => textFileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5" />
                Attach Text/Code File
              </button>
            </div>

            {running ? (
              <button
                type="button"
                onClick={stopRequest}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                Send Request
              </button>
            )}
          </div>
        </form>

        {errorMsg && (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Right Inspector Column */}
      <div className="lg:col-span-4 space-y-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            System Instruction
          </h3>
          <textarea
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="w-full px-3 py-2 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            Last Response Headers
          </h3>
          {lastHeaders ? (
            <div className="space-y-2 font-mono text-xs">
              {Object.entries(lastHeaders).map(([k, v]) => (
                <div
                  key={k}
                  className="pb-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0 last:pb-0"
                >
                  <div className="text-[11px] text-slate-400">{k}</div>
                  <div className="text-slate-900 dark:text-slate-100 break-all mt-0.5">
                    {v}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Send a request to inspect live <code className="font-mono">X-Routed-Via</code>, latency, and failover attempt headers.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

# RelayGate — Personal AI API Router

Zero-disk personal AI API router. Stores API keys in an AES-GCM encrypted IndexedDB vault in the browser, syncs them into server RAM, and exposes an OpenAI / Anthropic / Gemini-compatible gateway with automatic 429/5xx failover across 29+ free-tier providers.

## Quick start

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env
# edit .env — at minimum set GEMINI_API_KEY (optional) and ROUTER_MASTER_KEY

# 3. dev (server + Vite HMR)
npm run dev
# open http://localhost:3000

# 4. production
npm run build
NODE_ENV=production npm start
```

## Scripts

| script | purpose |
|---|---|
| `npm run dev` | Run `server.ts` with tsx (Vite middleware in dev) |
| `npm run build` | Vite production build into `dist/` |
| `npm run lint` | `tsc --noEmit` type check |
| `npm run preview` | Vite preview server |

## Environment variables

See `.env.example`. Key ones:

- `PORT` — listen port (default `3000`; `7860` on Hugging Face Spaces)
- `GEMINI_API_KEY` — optional server-side Gemini channel (exposed as a virtual key)
- `ROUTER_MASTER_KEY` — protects `/api/router/sync`, `/api/router/clear` and `/v1/*`
- `ROUTER_VAULT_JSON` (+ `ROUTER_VAULT_PASSPHRASE`) — headless zero-disk boot from an exported vault envelope
- `APP_URL` — public URL where the router is hosted

## Endpoints

Control plane: `/api/health`, `/api/router/state`, `/api/router/sync`, `/api/router/clear`, `/api/router/test-key`, `/api/router/logs/clear`.

OpenAI-compatible: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/completions`, `POST /v1/embeddings`, `POST /v1/images/generations`, `GET /v1/models`.

Anthropic-compatible: `POST /v1/messages`.

Gemini-compatible: `GET /v1beta/models`, `POST /v1beta/models/{model}:{generateContent|streamGenerateContent}`.

## Security

By default `ROUTER_MASTER_KEY` is unset and the protected endpoints are open. **Always set `ROUTER_MASTER_KEY` before deploying**; the server logs a warning on startup when it is missing. Pass it via `Authorization: Bearer <key>` or `X-Router-Master-Key`.

## Docker

```bash
docker build -t relaygate .
docker run -p 7860:7860 --env-file .env relaygate
```

The image is configured for Hugging Face Docker Spaces (port 7860, non-root UID 1000).

## Deploy

### Hugging Face Spaces (Docker)
1. Create a Space with **SDK: Docker**.
2. Push this repo (the included `Dockerfile` listens on `0.0.0.0:7860` as UID 1000, as HF requires).
3. Set `ROUTER_MASTER_KEY` (and optionally `GEMINI_API_KEY`) in Space **Variables/Secrets**.
4. The app is served at the Space URL; keys stay in the browser vault.

### Render
- This repo ships `render.yaml` (Render Blueprint). In Render: **New → Blueprint**, point at this repo, then fill in the secret env vars (`ROUTER_MASTER_KEY`, `GEMINI_API_KEY`, …) in the dashboard.
- Render sets `PORT` automatically; the server reads `process.env.PORT`, so no port config is needed.
- Health check: `/api/health`.
- Free tier sleeps after ~15 min of inactivity (cold start on next request). Set `ROUTER_VAULT_JSON` (+ passphrase) if you want keys available immediately after a restart without browser sync.

## License

See `LICENSE`.
# Production Dockerfile configured for Hugging Face Docker Spaces (Port 7860)
# and Render. Uses the `node` user (UID 1000) shipped with node:22-slim
# instead of creating a new one, since UID 1000 already exists there.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY . .
RUN npm run build && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=7860
ENV HOST=0.0.0.0

EXPOSE 7860

CMD ["npx", "tsx", "server.ts"]

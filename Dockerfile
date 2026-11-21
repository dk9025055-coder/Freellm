# Production Dockerfile configured for Hugging Face Docker Spaces (Port 7860)
FROM node:22-slim

# Hugging Face Spaces runs containers as non-root UID 1000
RUN useradd -m -u 1000 user
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY . .
RUN npm run build && chown -R user:user /app

USER user

ENV NODE_ENV=production
ENV PORT=7860
ENV HOST=0.0.0.0

EXPOSE 7860

CMD ["npx", "tsx", "server.ts"]

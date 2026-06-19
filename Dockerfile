# CANON prototype — Node + built-in node:sqlite (no native deps)
FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# Persisted shared canon lives here — mount a volume at /data in prod.
ENV DB_PATH=/data/craft-cache.db
ENV PORT=8080
EXPOSE 8080

# GEMINI_API_KEY must be provided as a secret at runtime.
CMD ["node", "server.js"]

# syntax=docker/dockerfile:1
# Atlas x402 API — portable container (pure Node, no native build deps).
FROM node:20-alpine
WORKDIR /app

# Install only production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source.
COPY server.js payment.js ./

ENV NODE_ENV=production
# Hosts inject PORT; default to 8080 for local parity.
ENV PORT=8080
EXPOSE 8080

# No secrets are baked in. PAY_TO can be overridden at deploy time:
#   -e PAY_TO=0x....   (defaults to the Atlas wallet in server.js)
# The service holds NO private key — the x402 facilitator settles on-chain.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]

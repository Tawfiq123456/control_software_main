# ── Backend: Node.js + serialport ──────────────────────────────
FROM node:20-slim

# serialport native addon build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libudev-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4000

CMD ["node", "index.js"]

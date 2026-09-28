FROM node:26-slim

# docker CLI only — talks to DOCKER_HOST (point it at a docker-socket-proxy,
# never the raw socket: see README "Security").
RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV PORT=8000
EXPOSE 8000
USER node
CMD ["node", "src/index.js"]

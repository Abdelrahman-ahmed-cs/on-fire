# On Fire: one container = Node web app (public port) + On Fire's Python server (127.0.0.1:8001).
# Build context = the folder made by deploy\stage.cmd (not this folder).

# ---- 1. build the web client ----
FROM node:26-bookworm-slim AS web
WORKDIR /srv/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build && npm prune --omit=dev

# ---- 2. runtime: Python 3.12 + the Node binary from stage 1 (both Debian bookworm) ----
FROM python:3.12-slim-bookworm
COPY --from=web /usr/local/bin/node /usr/local/bin/node
WORKDIR /srv
COPY onfire/requirements-server.txt onfire/requirements-server.txt
RUN pip install --no-cache-dir -r onfire/requirements-server.txt

# big data first (changes rarely), code last (changes often)
COPY data/ data/
COPY onfire/ onfire/
COPY --from=web /srv/web web/

ENV NODE_ENV=production \
    PORT=8080 \
    ONFIRE_DATA=/srv/data \
    ONFIRE_DIR=/srv/onfire \
    ONFIRE_PYTHON=/usr/local/bin/python \
    PYTHONUNBUFFERED=1
EXPOSE 8080
WORKDIR /srv/web
# FIRMS_MAP_KEY comes from the hosting platform as a secret, never from a file in the image.
CMD ["node", "server/index.js"]

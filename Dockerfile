FROM node:26-alpine

WORKDIR /app

# bash is the agent's shell; the rest are utilities the agent may use on the files in /app/data
RUN apk add --no-cache \
    bash \
    curl \
    ca-certificates \
    coreutils \
    findutils \
    grep \
    jq \
    file \
    python3 \
    py3-pip \
    py3-pillow \
    imagemagick

COPY build ./build
COPY public ./public
COPY assets ./assets
COPY package.json .
COPY package-lock.json .

RUN npm install --omit=dev --ignore-scripts --verbose

ENV NODE_ENV=production \
    PORT=10050 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    DB_PATH=/app/storage/agent-runtime.sqlite

RUN mkdir -p /app/data /app/storage

VOLUME ["/app/storage"]

EXPOSE 10050

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:10050/api/v1/health || exit 1

CMD ["node", "./build/index.js"]

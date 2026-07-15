FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRUST_PROXY=1 \
    DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]

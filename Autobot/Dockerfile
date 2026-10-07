FROM node:22.23.3-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY runner/validate.py ./runner/validate.py
COPY dist ./dist
EXPOSE 3000
CMD ["node", "server/index.js"]

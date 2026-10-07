# Agent worker. Build context: the repository root.
FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@11.0.9
COPY . .
RUN pnpm install --frozen-lockfile --filter @authority/agent...
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@authority/agent", "start"]

# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store-chatbot,target=/pnpm/store pnpm fetch --frozen-lockfile
RUN --mount=type=cache,id=pnpm-store-chatbot,target=/pnpm/store pnpm install --frozen-lockfile --offline --no-optional

FROM deps AS builder
COPY . .
RUN pnpm run build && pnpm prune --prod

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3008

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
        && chown -R appuser:appgroup /app

USER appuser
EXPOSE 3008

CMD ["node", "dist/server.js"]
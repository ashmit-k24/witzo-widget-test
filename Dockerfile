FROM node:20-alpine AS builder

WORKDIR /app

# Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files first to leverage Docker cache for installs
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including dev) for build
RUN pnpm install --frozen-lockfile --no-optional

# Copy the rest of the source
COPY . .

# Build TypeScript -> dist
RUN pnpm run build

# Remove dev dependencies so node_modules only contains production deps
RUN pnpm prune --prod

# Final runtime image
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Enable corepack for pnpm in runtime image too
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy compiled output and production deps from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

# Do NOT copy .env into the image — pass runtime config via --env-file or environment vars
# Create non-root user for improved security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
        && chown -R appuser:appgroup /app

USER appuser

# App listens on PORT (see src/config/env.ts)
ENV PORT=3008

EXPOSE ${PORT}

# HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
#         CMD node -e "const http=require('http');const p=process.env.PORT||3008;http.get({host:'127.0.0.1',port:p,path:'/health'},res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1));"

CMD ["node", "dist/server.js"]
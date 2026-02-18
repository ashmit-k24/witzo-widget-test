FROM node:20-bullseye-slim AS builder

WORKDIR /app

# Copy package files first to leverage Docker cache for installs
COPY package*.json ./

# Install all dependencies (including dev) for build
RUN npm install --no-audit --no-fund

# Copy the rest of the source
COPY . .

# Build TypeScript -> dist
RUN npm run build

# Remove dev dependencies so node_modules only contains production deps
RUN npm prune --production

# Final runtime image
FROM node:20-bullseye-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy compiled output and production deps from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Do NOT copy .env into the image — pass runtime config via --env-file or environment vars
# Create non-root user for improved security
RUN useradd --create-home --shell /bin/bash appuser \
        && chown -R appuser:appuser /app

USER appuser

# Use APP_PORT if provided, fallback to 3008
ENV APP_PORT=3008

EXPOSE ${APP_PORT}

# HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
#         CMD node -e "const http=require('http');const p=process.env.APP_PORT||3008;http.get({host:'127.0.0.1',port:p,path:'/health'},res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1));"

# Start the compiled server via entrypoint that validates env vars
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 sushi \
  && mkdir -p /app/data \
  && chown -R sushi:nodejs /app/data

COPY --from=builder --chown=sushi:nodejs /app/package.json ./package.json
COPY --from=builder --chown=sushi:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=sushi:nodejs /app/.next ./.next
COPY --from=builder --chown=sushi:nodejs /app/src ./src
COPY --from=builder --chown=sushi:nodejs /app/server.ts ./server.ts
COPY --from=builder --chown=sushi:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=sushi:nodejs /app/tsconfig.json ./tsconfig.json

USER sushi
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/system/capabilities >/dev/null || exit 1

CMD ["npm", "start"]

# Mirrors CosmicGuidance/Dockerfile's stage layout and hardening choices
# (alpine base, dumb-init PID 1, non-root runtime user) for operational
# consistency across the two services, minus the Vite client build this
# service has none of.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
RUN apk add --no-cache dumb-init && apk upgrade --no-cache

ENV NODE_ENV=production \
    PORT=8081

WORKDIR /app

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder   /app/dist         ./dist
COPY --chown=node:node --from=builder   /app/datasets     ./datasets
COPY --chown=node:node --from=builder   /app/migrations   ./migrations
COPY --chown=node:node --from=builder   /app/config       ./config
COPY --chown=node:node --from=builder   ["/app/docs/LLM PLAN", "/app/docs/LLM PLAN"]
COPY --chown=node:node --from=builder   /app/admin-dashboard ./admin-dashboard

USER node

EXPOSE 8081

# Private service: this image must always be deployed with
# --no-allow-unauthenticated and an explicit IAM invoker binding — see
# docs/gcp-deployment.md. Never make this Cloud Run service public.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

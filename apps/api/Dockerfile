# Build from the repo root: docker compose build api
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @hoymiles/api --filter @hoymiles/web
COPY apps/api apps/api
COPY apps/web apps/web
RUN cd apps/api && pnpm exec prisma generate && pnpm build
# The API serves the built web app itself (Lite-build foundation).
RUN cd apps/web && pnpm build && cp -r dist ../api/public

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]

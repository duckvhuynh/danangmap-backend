# syntax=docker/dockerfile:1.7
FROM node:22.18.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json jest.config.cjs ./
COPY apps ./apps
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build

FROM build AS test
ENV NODE_ENV=test
CMD ["npm", "test"]

FROM node:22.18.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 danangmap && useradd --system --uid 10001 --gid danangmap --home /app danangmap
COPY --from=production-dependencies --chown=danangmap:danangmap /app/node_modules ./node_modules
COPY --from=build --chown=danangmap:danangmap /app/dist ./dist
COPY --from=build --chown=danangmap:danangmap /app/package.json ./package.json
USER danangmap
EXPOSE 4000
CMD ["node", "dist/apps/api/src/main.js"]

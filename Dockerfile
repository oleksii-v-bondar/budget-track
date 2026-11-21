# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
# The web app (dist/web, the PWA) and the server bundle (dist/server).
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Warsaw \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/server/main.js"]

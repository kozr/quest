FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 APPLE_ROOT_CERTS_DIR=/app/certificates
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/certificates && chown -R node:node /app/certificates
COPY --from=build /app/dist ./dist
COPY web ./web
USER node
EXPOSE 4317
CMD ["node", "dist/server.js"]

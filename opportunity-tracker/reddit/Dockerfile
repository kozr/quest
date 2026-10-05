FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY reddit/*.mjs ./reddit/
USER node
ENV PORT=8081 BIND_ADDRESS=0.0.0.0
CMD ["node", "reddit/bridge.mjs"]

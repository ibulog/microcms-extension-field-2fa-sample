FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 PORT=3000
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/dist/public ./dist/public
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]

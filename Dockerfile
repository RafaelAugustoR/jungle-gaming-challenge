FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN bun run build

FROM build AS test
COPY tests ./tests
CMD ["bun", "test"]

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/src/bootstrap/main.js"]

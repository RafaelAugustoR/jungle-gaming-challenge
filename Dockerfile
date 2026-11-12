FROM oven/bun:1.3.14 AS base
WORKDIR /app
COPY package.json bun.lock ./

FROM base AS test
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY frontend ./frontend
RUN bun scripts/build-frontend.ts
COPY tests ./tests
CMD ["bun", "test"]

FROM base AS runtime
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY frontend ./frontend
RUN bun scripts/build-frontend.ts
USER bun
EXPOSE 3000
CMD ["bun", "src/bootstrap/main.ts"]

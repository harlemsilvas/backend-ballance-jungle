FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM build AS validation
COPY tests ./tests
COPY scripts ./scripts
COPY reports ./reports
COPY docs/benchmarks ./docs/benchmarks
COPY Dockerfile compose.yaml ./
CMD ["bun", "test", "tests/unit", "tests/integration"]

FROM validation AS swagger
RUN cd scripts/swagger && bun install --frozen-lockfile --production --ignore-scripts
USER bun
CMD ["bun", "scripts/swagger/main.ts"]

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
USER bun
CMD ["bun", "dist/bootstrap/main.js"]

ARG BUILD_IMAGE=node:24-bookworm-slim
ARG RUNTIME_IMAGE=node:24-bookworm-slim
FROM --platform=$BUILDPLATFORM ${BUILD_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY test/ ./test/
COPY scripts/licenses.mjs ./scripts/licenses.mjs
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm test && node scripts/licenses.mjs

FROM ${RUNTIME_IMAGE}
ARG APP_VERSION=0.0.0
LABEL org.opencontainers.image.title="Git Docs" \
      org.opencontainers.image.description="GitLab GitHub Gitee Markdown portal with external data directory" \
      org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
# 全部配置都有默认值，直接运行即可。下面这些只在需要时修改，
# 声明出来是为了让启动界面能列出可配置项。
ENV NODE_ENV=production \
    GIT_DOCS_HOME=/app \
    GIT_DOCS_DATA=/data \
    GIT_DOCS_INTERVAL_MINUTES=10 \
    GIT_DOCS_ADMIN_PASSWORD= \
    GIT_DOCS_AI_TOKEN= \
    GIT_DOCS_HOOK_TOKEN=
COPY --from=build /build/dist/app.cjs ./app.cjs
COPY --from=build /build/dist/licenses/ ./licenses/
COPY --from=build /build/dist/vendor/ ./dist/vendor/
COPY --from=build /build/public/ ./public/
COPY docker/entry.cjs ./entry.cjs
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/repos',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "entry.cjs"]
CMD ["serve"]

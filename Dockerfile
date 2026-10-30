# Production image (Render, Fly, Railway or any container host). `flisk up` does not use this file: locally, Flisk
# builds its own image from services/app/web/service.json.
FROM oven/bun:1.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY services/app/web/package.json ./
RUN bun install --production
COPY services/app/web/src ./src
COPY services/app/web/public ./public
COPY services/app/web/tsconfig.json ./
# The portal keeps users, hashed API keys and usage in DATA_DIR. Mount a volume there to keep them across deploys.
RUN mkdir -p /data && chown bun /data
USER bun
ENV PORT=10000 DATA_DIR=/data
EXPOSE 10000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "src/index.ts"]

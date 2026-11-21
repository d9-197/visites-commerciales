# Image du back + application web. Non construite dans l'environnement de développement (pas de démon Docker) :
# les étapes ont été rejouées à la main (voir docs/TEST_TELEPHONE.md), pas l'image elle-même.
FROM node:22-slim AS web
WORKDIR /app
COPY packages packages
COPY mobile mobile
RUN cd mobile && npm ci --no-audit --no-fund && npx expo export --platform web --output-dir dist-web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY packages/sync-core/package.json packages/sync-core/
RUN npm ci --omit=dev --no-audit --no-fund
COPY server server
COPY packages packages
COPY db db
COPY --from=web /app/mobile/dist-web mobile/dist-web
EXPOSE 3000
CMD ["sh", "-c", "if [ \"$SEED_DEMO\" = 1 ]; then npx tsx server/scripts/seed.ts; fi; exec npx tsx server/src/index.ts"]

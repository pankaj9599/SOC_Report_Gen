# ---------- Build ----------
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/
RUN npm install --legacy-peer-deps

COPY src ./src
COPY app.ts ./
RUN npm run build
RUN npx prisma generate

# ---------- Runtime ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache dumb-init

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install --production --legacy-peer-deps
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
 CMD node -e "require('http').get('http://localhost:5000/health',r=>{if(r.statusCode!==200)process.exit(1)})"

ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/app.js"]

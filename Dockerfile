FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
LABEL org.opencontainers.image.source="https://github.com/harunarsy/HOPINOPS"
LABEL org.opencontainers.image.description="HOPIN Stock Operations local demo"
LABEL org.opencontainers.image.licenses="UNLICENSED"

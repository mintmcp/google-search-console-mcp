FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && \
    npm cache clean --force
EXPOSE 8000
CMD ["node", "dist/server.js"]

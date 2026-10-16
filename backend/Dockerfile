FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY catalog.json ./catalog.json
EXPOSE 3000
CMD ["node", "src/main.js"]

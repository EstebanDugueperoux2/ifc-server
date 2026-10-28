FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
COPY providers/ ./providers/
ENV PORT=8082 WORK_DIR=/tmp/ifc-assistant
USER node
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8082/api/v1/health || exit 1
CMD ["node", "server.mjs"]

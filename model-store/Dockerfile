FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV PORT=8081 DATA_DIR=/data
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8081/api/v1/health || exit 1
CMD ["node", "server.mjs"]

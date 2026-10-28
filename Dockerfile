# Example multi-stage Dockerfile for the ifc-lite Rust (Axum) server.
# Adjust the package name, binary name and port to match your fork.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p ifc-lite-server   # adjust: package name

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 app
COPY --from=build /src/target/release/ifc-lite-server /usr/local/bin/ifc-lite-server  # adjust: binary name
USER app
ENV PORT=3001
EXPOSE 3001
# Cache/storage directory: Cloud Run mounts the GCS bucket at /data.
# Set the server's own env var or flag for this (check your fork's README).
CMD ["ifc-lite-server"]
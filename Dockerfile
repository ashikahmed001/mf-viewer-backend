FROM node:20-slim

# Install Litestream
ARG LITESTREAM_VERSION=0.3.13
RUN apt-get update && apt-get install -y wget ca-certificates python3 make g++ && \
    wget -qO /tmp/litestream.tar.gz \
      https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz && \
    tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && \
    rm /tmp/litestream.tar.gz && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app + config
COPY . .

# Create data directory for SQLite volume
RUN mkdir -p /data

EXPOSE 4000

# Litestream wraps the Node process:
# - On start: restores latest backup from R2 if DB doesn't exist
# - While running: continuously replicates WAL changes to R2
# - On shutdown: final sync before exit
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]

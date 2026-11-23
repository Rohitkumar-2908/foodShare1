FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TRUST_PROXY=1
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
# Run as an unprivileged user (principle of least privilege)
RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/data && chown -R app:app /app/data
USER app
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]

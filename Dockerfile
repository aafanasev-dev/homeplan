# One container: the Node server serves the static editor and the JSON API.
# No npm dependencies — node:sqlite and node:crypto are built in.
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY index.html invite.html style.css ./
COPY js ./js
COPY server ./server
COPY add_user.sh /usr/local/bin/add_user.sh
RUN chmod +x /usr/local/bin/add_user.sh && mkdir -p /data && chown -R node:node /data

VOLUME ["/data"]
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]

# Imagen única para los dos nodos: cambia solo el comportamiento por variables de entorno.
FROM node:22-alpine

WORKDIR /app

# Primero solo los archivos de dependencias: Docker reutiliza esta capa en caché
# mientras package.json y package-lock.json no cambien.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Luego el código de la aplicación
COPY server.js client.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000

# Solo documenta el puerto; se publica en docker-compose.yml
EXPOSE 3000

# Docker marca el contenedor como "healthy" cuando /health responde
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Sin privilegios de administrador
USER node

CMD ["node", "server.js"]

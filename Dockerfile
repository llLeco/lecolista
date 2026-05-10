# LecoLista — PWA estática servida por nginx
# Multi-arch: roda nativamente em ARM64 (Raspberry Pi 4)
FROM nginx:1.27-alpine

# Configuração custom (MIME, gzip, headers PWA, cache)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Conteúdo estático
WORKDIR /usr/share/nginx/html
COPY index.html app.js styles.css sw.js manifest.json canvas.html ./
COPY icon.svg icon-180.png icon-192.png icon-512.png apple-touch-icon.png ./
COPY robots.txt sitemap.xml ./
COPY vendor ./vendor

# Cache busting: injeta timestamp de build no <script src="app.js"> e <link rel=stylesheet>.
# Cloudflare cacheia agressivo o app.js/styles.css (sobrescreve Cache-Control com 14400),
# mas a URL muda a cada deploy, então cliente sempre busca o novo binário.
ARG BUILD_VERSION
RUN BV="${BUILD_VERSION:-$(date +%s)}" && \
    sed -i "s|href=\"styles.css\"|href=\"styles.css?v=${BV}\"|; s|src=\"app.js\"|src=\"app.js?v=${BV}\"|" index.html && \
    echo "BUILD_VERSION=${BV}" > /usr/share/nginx/html/.build && \
    grep -E "styles.css|app.js" index.html | head -2

# Healthcheck simples
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost/ > /dev/null || exit 1

EXPOSE 80

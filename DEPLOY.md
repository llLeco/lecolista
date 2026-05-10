# Deploy — LecoLista

Roda como container Docker atrás do Traefik (Coolify) num Raspberry Pi 4, exposto
via Cloudflare Tunnel em <https://lista.devbyle.co>.

```
Cliente → Cloudflare (TLS edge) → Tunnel (HTTPS, noTLSVerify)
       → Traefik (coolify-proxy) → roteia por Host header
       → lecolista container (nginx:alpine + estáticos)
```

## Status atual

| Camada | Estado |
|---|---|
| Repo | <https://github.com/llLeco/lecolista> (público) |
| Build | Docker via Coolify (`docker-compose.coolify.yml`) |
| Pi | Raspberry Pi 4 · ARM64 · Debian 12 |
| Container | `app-schn53nbgjm7ykgp78q1ok66-...` (gerenciado pelo Coolify, app ID 6) |
| DNS | `lista.devbyle.co` → Cloudflare → tunnel `18099925-…` |
| TLS | Cloudflare edge (Let's Encrypt no Traefik fica como fallback) |
| CI | GitHub Actions valida sintaxe + build ARM64 a cada push |

## Atualizar o app (com webhook configurado)

```bash
# Da máquina dev — depois do passo 1 abaixo:
git push origin main
# → GitHub webhook → Coolify → rebuild → deploy (sem downtime)
```

Sem webhook ainda: depois do push, ir no Coolify UI → app → **Deploy**.

## ⚠️ Passos manuais pendentes

### 1. Webhook GitHub → Coolify (auto-deploy)

Pré-requisito: Coolify acessível pela internet. Hoje só responde em
`http://raspberrypi.local:8000` (rede local). Adicione ao Cloudflare Tunnel:

a. **Cloudflare ZeroTrust → Networks → Tunnels → Configure → Public Hostnames → Add**

```
Subdomain:  coolify
Domain:     devbyle.co
Type:       HTTP
URL:        localhost:8000
HTTP Host Header: (vazio — o Coolify tem domínio próprio configurável depois)
```

(Opcional, mas recomendado: limitar acesso via Cloudflare Access — proteja
`coolify.devbyle.co` com Google SSO).

b. **No Coolify UI da aplicação `lecolista`**:
- Aba **Webhooks** → copia o "Webhook Endpoint" (algo como
  `https://coolify.devbyle.co/api/v1/deploy?uuid=schn…&force=false`)

c. **GitHub repo settings**: <https://github.com/llLeco/lecolista/settings/hooks>
- **Add webhook**
- Payload URL: `<URL copiada do Coolify>`
- Content type: `application/json`
- SSL: Enable
- Events: **Just the push event**
- Active: ✓

### 2. Cloudflare — HSTS + Security Headers

Em <https://dash.cloudflare.com> → `devbyle.co` → **SSL/TLS → Edge Certificates**:

- **Always Use HTTPS**: ON
- **Min TLS Version**: TLS 1.2
- **HSTS**: Enable
  - Max-Age: 6 months
  - Include subdomains: ON
  - No-Sniff Header: ON

Em **Rules → Transform Rules → Modify Response Header** → criar regra:

```
When incoming requests match: Hostname equals "lista.devbyle.co"

Then:
  Set static header:
    X-Frame-Options = SAMEORIGIN
    X-Content-Type-Options = nosniff
    Referrer-Policy = strict-origin-when-cross-origin
    Permissions-Policy = camera=(self), microphone=(self), geolocation=(), interest-cohort=()
```

(Esses headers já estão no `nginx.conf` mas Cloudflare costuma stripar — explicitar
nas Transform Rules garante.)

### 3. Cache Rules — invalidação de HTML

Em **Rules → Cache Rules** → criar regra:

```
When incoming requests match:
  (http.request.uri.path eq "/" or http.request.uri.path eq "/index.html"
   or http.request.uri.path eq "/sw.js")

Then:
  Cache Eligibility: Bypass cache
```

E uma segunda regra pra extender cache de assets versionados:

```
When incoming requests match:
  (http.request.uri.path matches ".*\\.(css|js)$"
   and not http.request.uri.path eq "/sw.js")

Then:
  Cache Eligibility: Eligible for cache
  Edge TTL: 5 minutes
  Browser TTL: 5 minutes
```

### 4. Uptime monitoring (UptimeRobot, grátis)

<https://uptimerobot.com> → New Monitor:
- Type: HTTP(s)
- URL: `https://lista.devbyle.co/healthz`
- Interval: 5 min
- Alerts: seu email / Slack / Telegram

### 5. Backup Coolify (no Pi)

Já existe em `scripts/backup-coolify.sh`. Instalar como cron:

```bash
ssh pi@raspberrypi.local
sudo install -m 755 /home/pi/lecolista/scripts/backup-coolify.sh /usr/local/bin/coolify-backup
sudo crontab -l 2>/dev/null | { cat; echo "0 3 * * *  /usr/local/bin/coolify-backup >> /var/log/coolify-backup.log 2>&1"; } | sudo crontab -
# Roda já agora pra testar:
sudo /usr/local/bin/coolify-backup
ls -lh /home/pi/backups/coolify/
```

Faz backup de:
- Postgres do Coolify (apps, deploys, settings)
- `/data/coolify` (proxy config, ssl, ssh keys)

Retenção: 14 dias. Restore: `pg_restore` + extrair tar.

### 6. (Opcional) Sentry pra error tracking

<https://sentry.io> conta free (5k events/mês). Adicionar no `index.html`:

```html
<script src="https://browser.sentry-cdn.com/<v>/bundle.min.js"></script>
<script>Sentry.init({ dsn: 'https://<your-dsn>@sentry.io/<id>' });</script>
```

(Hoje erros JS morrem no console do cliente — você não vê.)

## Estrutura de arquivos

| Arquivo | Papel |
|---|---|
| `index.html`, `app.js`, `styles.css` | App PWA |
| `sw.js` | Service Worker · **bumpe `CACHE = 'v…'` a cada release** |
| `manifest.json` | PWA manifest |
| `icon.svg`, `icon-{180,192,512}.png`, `apple-touch-icon.png` | Ícones |
| `robots.txt`, `sitemap.xml` | SEO básico |
| `vendor/zxing.min.js` | ZXing local (fallback iOS) |
| `Dockerfile`, `nginx.conf` | Build do container |
| `docker-compose.yml` | Para deploy manual standalone |
| `docker-compose.coolify.yml` | Para deploy via Coolify (sem labels Traefik) |
| `scripts/backup-coolify.sh` | Backup diário do Coolify |
| `.github/workflows/ci.yml` | CI no GitHub |

## Comandos comuns

```bash
# Logs do container (no Pi)
ssh pi@raspberrypi.local "sudo docker ps --filter label=coolify.applicationId=6 -q | xargs sudo docker logs --tail 50"

# Logs do Traefik
ssh pi@raspberrypi.local "sudo docker logs --tail 30 coolify-proxy 2>&1 | grep -i lecolista"

# Force redeploy via Coolify UI: clicar "Restart" ou "Deploy"

# Cache purge no Cloudflare (após mudança grande):
# Dashboard → devbyle.co → Caching → Configuration → Purge Everything
```

## Atualização de SW (cache busting)

A cada release que muda `app.js` ou `styles.css`:
1. Bumpe `CACHE = 'lecolista-vN'` em `sw.js`
2. Commit + push
3. CI builda
4. Coolify deploya
5. SW novo detecta versão diferente, faz reload do cache
6. Cloudflare Cache Rules já estão configuradas pra bypass `/`, `/index.html`, `/sw.js`

## Healthcheck e portas internas

- `GET /healthz` → `200 ok` (sem log)
- `EXPOSE 80` — Traefik atinge via rede `coolify`
- Sem portas publicadas no host (só Traefik fica em 80/443)

## Service Worker e PWA

- `/sw.js` servido com `Cache-Control: no-cache, no-store, must-revalidate`
- `Service-Worker-Allowed: /` (escopo raiz)
- Manifest em `/manifest.json` com `start_url: ./`
- iOS: install via Safari → Compartilhar → Adicionar à Tela de Início (usa `apple-touch-icon.png`)
- Android: install prompt via `beforeinstallprompt` (botão no menu ⋮ "Instalar app")

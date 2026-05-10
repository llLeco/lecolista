# Deploy — LecoLista

Roda como container Docker atrás do Traefik (Coolify) num Raspberry Pi 4, exposto
via Cloudflare Tunnel em `https://lista.devbyle.co`.

```
Cliente → Cloudflare (TLS edge) → Tunnel → Pi:80 (HTTP)
       → coolify-proxy (Traefik) → roteia por Host header
       → lecolista container (nginx:alpine + estáticos)
```

## Setup atual (Raspberry Pi)

- **Caminho**: `/home/pi/lecolista` (clone deste repo)
- **Rede Docker**: `coolify` (a mesma do `coolify-proxy` Traefik)
- **Container**: `lecolista` (nginx-alpine, 76 MB, ARM64)
- **Routing**: labels Traefik no `docker-compose.yml`
  - HTTP `lista.devbyle.co` → middleware `lecolista-redir` → HTTPS 308
  - HTTPS `lista.devbyle.co` → service `lecolista` (porta 80 interna)

## Comandos no Pi

```bash
# Status
ssh pi@raspberrypi.local "cd /home/pi/lecolista && sudo docker compose ps"

# Logs (últimas 50 linhas)
ssh pi@raspberrypi.local "sudo docker logs --tail 50 lecolista"

# Logs do Traefik (rotas, certificados)
ssh pi@raspberrypi.local "sudo docker logs --tail 30 coolify-proxy 2>&1 | grep -i lecolista"

# Restart sem rebuild
ssh pi@raspberrypi.local "cd /home/pi/lecolista && sudo docker compose restart"
```

## Atualizar o app (deploy)

```bash
# Da máquina dev:
git push origin main

# No Pi (manual até montar webhook no Coolify):
ssh pi@raspberrypi.local "cd /home/pi/lecolista && git pull && sudo docker compose up -d --build"
```

## Cloudflare Tunnel — adicionar `lista.devbyle.co`

Tunnel já existe (token-based, ID `18099925-f239-4fd5-b3a8-0ede922ca469`).
Para expor um novo hostname:

1. Acesse <https://one.dash.cloudflare.com>
2. **Networks → Tunnels**, clique no tunnel ativo
3. **Configure → Public Hostnames → + Add a public hostname**
4. Preencha:
   ```
   Subdomain:  lista
   Domain:     devbyle.co
   Path:       (vazio)
   Type:       HTTP
   URL:        localhost:80
   ```
5. Em **Additional application settings → HTTP Settings**:
   ```
   HTTP Host Header:  lista.devbyle.co
   ```
   (sem isso, Traefik recebe `Host: localhost` e cai no 404 default)
6. Save

Cloudflare cria o DNS automaticamente. Em ~30s:

```bash
curl -I https://lista.devbyle.co/healthz   # → 200 OK
```

## Coolify (opcional — UI de gestão + auto-deploy)

Hoje o app roda direto via `docker compose`. Para migrar pro Coolify e ganhar
auto-deploy por webhook a cada `git push`:

### 1. Parar o deploy manual no Pi

```bash
ssh pi@raspberrypi.local "cd /home/pi/lecolista && sudo docker compose down"
```

### 2. Criar a app no Coolify UI

`http://raspberrypi.local:8000`

- **+ New Resource → Public Repository**
- **Repository URL**: `https://github.com/llLeco/lecolista`
- **Branch**: `main`
- **Build Pack**: Docker Compose
- **Custom Docker Compose File**: `docker-compose.yml` (default)
- **Base Directory**: `/`

### 3. Configurar domínio

Em **Configuration → Domains**:
- `https://lista.devbyle.co`

Coolify aplica suas próprias labels Traefik (use o compose como está). O cert
Let's Encrypt vai resolver quando o DNS apontar.

### 4. Webhook automático

Em **Configuration → Webhooks** o Coolify gera uma URL. Adiciona em:

`https://github.com/llLeco/lecolista/settings/hooks`

→ Payload URL = URL do Coolify, Content type = `application/json`,
events = `Just the push event`.

Pronto: cada `git push origin main` redeploya automaticamente.

## Healthcheck e portas internas

- `GET /healthz` → `200 ok` (não logado, baixo custo)
- `EXPOSE 80` — Traefik atinge via rede `coolify` (`http://lecolista/`)
- Sem portas publicadas no host (só Traefik fica em 80/443)

## Service Worker e PWA

- `/sw.js` servido com `Cache-Control: no-cache, no-store, must-revalidate`
- `Service-Worker-Allowed: /` (escopo raiz)
- Manifest em `/manifest.json` com `start_url: ./` (funciona instalado)

Cuidado ao atualizar: o SW antigo pode ficar cacheado no cliente. O CACHE
versionado em `sw.js` (`lecolista-vN`) força refresh — bumpe a versão a cada
deploy que muda assets.

# LecoLista

Lista de compras inteligente para a família — funciona offline, com voz, câmera, IA preditiva e estoque doméstico.

## Como rodar

A LecoLista é uma PWA em HTML/CSS/JS sem build. Para rodar localmente:

```bash
# na pasta lecolista/
python3 -m http.server 8080
# ou
npx serve -l 8080
```

Depois abra **http://localhost:8080** no navegador. Em iPad/iPhone, abra o mesmo IP local pelo Safari, toque em "Compartilhar → Adicionar à tela inicial" e o app vira ícone na home.

> Não abra `index.html` direto pelo `file://` — IndexedDB e Service Worker não funcionam nesse contexto na maioria dos navegadores.

## Arquivos

- `index.html` — shell do app (entry point)
- `app.js` — toda a lógica (DB, estado, voz, câmera, IA, vistas, modais)
- `styles.css` — design system + UI do app
- `sw.js` — service worker (cache offline)
- `manifest.json` — manifesto PWA
- `icon.svg` — ícone do app
- `canvas.html` — design canvas hi-fi original (referência)

## Funcionalidades

### Lista
- Adicionar por **voz** (Web Speech API · pt-BR), **texto** (com parser inteligente: "2 leites e 1 kg de arroz" vira 2 itens), **código de barras** (BarcodeDetector + Open Food Facts) e **histórico**
- Marcar como comprado (atualiza estoque automaticamente)
- Editar / remover / filtrar / buscar
- Agrupado por setor (Hortifruti, Laticínios, Padaria, Mercearia, Açougue, Congelados, Bebidas, Higiene, Pet, Bebê, Outros) com classificação automática

### Estoque
- Cadência de cada produto (de quantos em quantos dias é comprado)
- Estoque atual em %
- Previsão de quando acaba

### Recorrentes
- Itens que você compra com frequência fixa
- Adicionar à lista com 1 clique

### Sugestões IA
- "X acaba amanhã"
- "Y — esquecido?" (cadência vencida)
- "Z está acabando" (estoque < 40%)
- Recorrentes pendentes

### Família
- Múltiplos membros (avatares com inicial e cor única)
- Cada item registra quem adicionou e quem comprou
- Trocar de usuário com 1 clique

### Exportar / Compartilhar
- WhatsApp, Email (`navigator.share`)
- Copiar lista (texto formatado por setor)
- Imprimir (PDF)
- TXT, CSV, JSON (backup completo)

### Buscar online
- Mercado Livre, Amazon, Google Shopping, iFood — abre query da lista atual em nova aba

### Offline-first
- Tudo é salvo em **IndexedDB** local
- **Service Worker** faz cache do app shell
- **BroadcastChannel** sincroniza entre abas/janelas no mesmo dispositivo
- Sincronização entre dispositivos diferentes precisa de backend (próximo passo)

## Stack

100% web, zero dependências:
- Web Speech API (reconhecimento de voz pt-BR)
- BarcodeDetector API (com fallback para entrada manual)
- Open Food Facts API (lookup de produto pelo código de barras)
- IndexedDB (storage offline)
- Service Worker (cache, modo avião)
- BroadcastChannel (sync entre abas)
- Web Share API (compartilhar lista)

## Próximos passos sugeridos

1. **Backend de sincronização** entre dispositivos (NestJS + WebSocket sugerido pelo briefing)
2. **Notificações push** quando algo acaba ("leite acaba amanhã")
3. **Modo Receita** — receber receita, calcular ingredientes faltantes, adicionar
4. **Comparação de preços** entre supermercados via APIs reais
5. **Voz contínua** com wake-word ("LecoLista, adiciona leite")
6. **Reconhecimento de produto por imagem** (Vision API)
7. **Integração Alexa / HomePod** para adicionar por voz no ambiente

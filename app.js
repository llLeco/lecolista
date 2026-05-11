/* =============================================================
 * HSH Mercado · App funcional, offline-first, em Português (pt-BR)
 * (id interno técnico: "lecolista" — mantido em paths, BroadcastChannel, debug surface)
 *
 * Camadas:
 *   1. Helpers (DOM, datas, escape, debounce)
 *   2. Setores (NLP-lite para classificar itens em "Hortifruti", "Laticínios"...)
 *   3. Parser de fala/texto ("Adicionar 2 leites e pão" → itens)
 *   4. IndexedDB wrapper (offline-first)
 *   5. Seed inicial (família, itens, estoque, recorrentes)
 *   6. State store + BroadcastChannel (sync entre abas)
 *   7. Operações de domínio (CRUD)
 *   8. IA preditiva (cadência + previsão de fim)
 *   9. Voz (Web Speech API · pt-BR)
 *  10. Câmera + Barcode (BarcodeDetector + Open Food Facts)
 *  11. Toast / Export / Share / Busca externa
 *  12. Render helpers (avatar, ícones, badges)
 *  13. Vistas (Lista, Estoque, Recorrentes, Sugestões, Família)
 *  14. Sheets (Adicionar, Editar, Voz, Câmera, Exportar, Buscar)
 *  15. Event delegation + init
 * ============================================================= */

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 1. Helpers
  // ────────────────────────────────────────────────────────────
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const now = () => Date.now();
  const days = (n) => n * 86_400_000;
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const fmtPt = (ts, opt) => new Intl.DateTimeFormat('pt-BR', opt).format(ts);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // Comprime imagem do usuário pra economizar espaço no IndexedDB (~100 KB no JPEG)
  async function compressImage(file, maxW = 720, quality = 0.72) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      // fallback antigo (img + canvas) p/ Safari sem createImageBitmap
      return new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(file);
      });
    }
    const ratio = Math.min(1, maxW / bitmap.width);
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);
    const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (canvas.convertToBlob) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    }
    return canvas.toDataURL('image/jpeg', quality);
  }

  // ────────────────────────────────────────────────────────────
  // 2. Setores (classificação)
  // ────────────────────────────────────────────────────────────
  const AISLES = [
    { id: 'hortifruti', label: 'Hortifruti', words: ['banana','maçã','maca','laranja','uva','tomate','alface','rúcula','rucula','batata','cebola','alho','limão','limao','manga','mamão','mamao','melão','melao','melancia','abacate','pepino','cenoura','beterraba','rabanete','agrião','agriao','espinafre','couve','brócolis','brocolis','couve-flor','milho','pimentão','pimentao','salsa','cebolinha','manjericão','manjericao','coentro','hortelã','hortela','frutas','legumes','verduras','morango','abacaxi','abóbora','abobora','chuchu','quiabo','jiló','jilo','vagem'] },
    { id: 'laticinios', label: 'Laticínios', words: ['leite','iogurte','queijo','requeijão','requeijao','manteiga','margarina','creme','nata','danone','muçarela','mussarela','prato','minas','cottage','cream cheese','ricota','parmesão','parmesao','provolone','catupiry','coalhada'] },
    { id: 'padaria', label: 'Padaria', words: ['pão','pao','baguete','focaccia','sourdough','croissant','panettone','bolo','torta','rosca','broa','biscoito','bolacha','wafer','torrada','sonho','brigadeiro','beijinho'] },
    { id: 'mercearia', label: 'Mercearia', words: ['arroz','feijão','feijao','macarrão','macarrao','massa','farinha','açúcar','acucar','sal','azeite','óleo','oleo','vinagre','molho','extrato','aveia','grão','grao','lentilha','grão-de-bico','milho','ervilha','atum','sardinha','enlatado','café','cafe','chá','cha','achocolatado','nescau','toddy','geleia','mel','azeitona','tempero','caldo','farofa','tapioca','fubá','fuba'] },
    { id: 'acougue', label: 'Açougue', words: ['carne','frango','peito','coxa','sobrecoxa','asa','filé','file','alcatra','contrafilé','contrafile','picanha','linguiça','linguica','salsicha','bacon','presunto','peixe','salmão','salmao','tilápia','tilapia','camarão','camarao','ovos','ovo','costela','patinho','músculo','musculo','cupim'] },
    { id: 'congelados', label: 'Congelados', words: ['congelado','sorvete','pizza congelada','lasanha','hambúrguer','hamburguer','nuggets','batata frita','polpa','açaí','acai'] },
    { id: 'bebidas', label: 'Bebidas', words: ['água','agua','refrigerante','coca','guaraná','guarana','suco','cerveja','vinho','whisky','vodka','gin','energético','energetico','isotônico','isotonico','chá gelado','cha gelado','chimarrão','chimarrao','espumante'] },
    { id: 'higiene', label: 'Higiene & Limpeza', words: ['sabão','sabao','detergente','amaciante','desinfetante','água sanitária','agua sanitaria','álcool','alcool','sabonete','shampoo','condicionador','pasta de dente','escova','desodorante','papel higiênico','papel higienico','lenço','lenco','fralda','absorvente','esponja','bombril','vassoura','rodo','panos','luva','saco lixo','saco de lixo'] },
    { id: 'pet', label: 'Pet', words: ['ração','racao','areia gato','petisco','sachê pet','sache pet','antipulgas','tapete higiênico','tapete higienico'] },
    { id: 'bebe', label: 'Bebê', words: ['fórmula bebê','formula bebe','papinha','lenço umedecido','lenco umedecido','fralda bebê','fralda bebe'] },
  ];
  const AISLE_LABELS = { ...Object.fromEntries(AISLES.map((a) => [a.id, a.label])), outros: 'Outros' };

  function classifyAisle(name) {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return 'outros';
    // Escolhe match mais longo (resolve casos como "fralda bebê" entre "fralda"=higiene e "fralda bebê"=bebê)
    let bestId = null, bestLen = 0;
    for (const a of AISLES) {
      for (const w of a.words) {
        if (n.includes(w) && w.length > bestLen) { bestId = a.id; bestLen = w.length; }
      }
    }
    return bestId || 'outros';
  }

  // ────────────────────────────────────────────────────────────
  // 3. Parser ("Adicionar 2 leites e pão" → itens)
  // ────────────────────────────────────────────────────────────
  const CMD_RE = /^(adicione|adicionar|adiciona|adicionando|colocar|coloca|comprar|compra|preciso de|precisamos de|preciso|me lembre de|lembrar de|lembrar|inclui|incluir|adicionar à lista|adicionar a lista|botar|por)\s+/i;
  const PRE_RE = /^(de|do|da|dos|das|para|pra)\s+/i;
  const QTY_NUM = /^(\d+(?:[.,]\d+)?)\s*(kg|kilos?|gramas?|g|litros?|l|ml|un|und|unidade|unidades|pacote|pacotes|caixa|caixas|garrafa|garrafas|lata|latas|dúzia|duzia|dúzias|duzias|cartela|saco|sacos|barra|barras|fatia|fatias|copo|copos|maço|maco|bandeja|bandejas)?\s+(.+)$/i;
  const QTY_WORD = /^(uma|um|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|meia|meio)\s+(.+)$/i;
  const NUM_WORD = { uma: 1, um: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, meia: 0.5, meio: 0.5 };
  // "(meia) dúzia de X" multiplica por 12. Trata também "dúzia"/"duzia" no início do nome.
  const DOZEN_RE = /^(dúzias?|duzias?)\s+(de|dos?|das?)\s+(.+)$/i;

  function parseInput(raw) {
    if (!raw) return [];
    let text = String(raw).trim().replace(/\s+/g, ' ').replace(CMD_RE, '');
    text = text.replace(/\.$/, '').replace(/\s+e\s+também\s+/gi, ', ').replace(/\s+também\s+/gi, ', ').replace(/\s+e\s+/gi, ', ').replace(/\s+mais\s+/gi, ', ');
    // Vírgula só separa itens se vier seguida de espaço (preserva vírgula decimal "1,5 L")
    const parts = text.split(/\s*,\s+|\s*;\s*|\s*\+\s*|\s*&\s*/).map((s) => s.trim()).filter(Boolean);
    return parts.map(parsePart).filter(Boolean);
  }

  function parsePart(s) {
    if (!s) return null;
    const trimmed = s.replace(PRE_RE, '').trim();
    let m = trimmed.match(QTY_NUM);
    if (m) {
      const num = m[1].replace(',', '.');
      const unit = (m[2] || 'un').toLowerCase()
        .replace(/^kilos?$/, 'kg').replace(/^gramas?$/, 'g')
        .replace(/^l$|^litros?$/, 'L').replace(/^unidades?$/, 'un').replace(/^und$/, 'un')
        .replace(/^dúzias?$|^duzias?$/, 'dz');
      // Fix: remover "de/do/da" sobrando depois da extração de quantidade
      let name = m[3].trim().replace(PRE_RE, '').trim();
      return { name: cap(name), qty: `${num} ${unit}` };
    }
    m = trimmed.match(QTY_WORD);
    if (m) {
      let num = NUM_WORD[m[1].toLowerCase()] || 1;
      let rest = m[2].trim();
      // Fix: "(meia|uma) dúzia de X" → multiplica por 12 e usa X como nome
      const dz = rest.match(DOZEN_RE);
      if (dz) {
        num = num * 12;
        rest = dz[3];
      }
      rest = rest.replace(PRE_RE, '').trim();
      return { name: cap(rest), qty: `${num} un` };
    }
    // "dúzia de X" sem número antes (assume 1 dúzia = 12)
    const dz = trimmed.match(DOZEN_RE);
    if (dz) return { name: cap(dz[3].replace(PRE_RE, '').trim()), qty: '12 un' };
    return { name: cap(trimmed), qty: '1 un' };
  }

  // ────────────────────────────────────────────────────────────
  // 4. IndexedDB
  // ────────────────────────────────────────────────────────────
  const DB = 'lecolista';
  const VER = 3;
  const STORES = ['items', 'inventory', 'recurring', 'family', 'history', 'meta', 'prices', 'outbox'];
  let _dbP = null;

  function getDB() {
    if (_dbP) return _dbP;
    _dbP = new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return _dbP;
  }

  const dbAll = (s) => getDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction(s, 'readonly').objectStore(s).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
  const dbPut = (s, v) => getDB().then((db) => new Promise((res, rej) => {
    const t = db.transaction(s, 'readwrite');
    t.objectStore(s).put(v);
    t.oncomplete = () => res(v);
    t.onerror = () => rej(t.error);
  }));
  const dbDel = (s, id) => getDB().then((db) => new Promise((res, rej) => {
    const t = db.transaction(s, 'readwrite');
    t.objectStore(s).delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
  const dbClear = (s) => getDB().then((db) => new Promise((res, rej) => {
    const t = db.transaction(s, 'readwrite');
    t.objectStore(s).clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
  const dbGet = (s, id) => getDB().then((db) => new Promise((res, rej) => {
    const r = db.transaction(s, 'readonly').objectStore(s).get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  }));

  // ────────────────────────────────────────────────────────────
  // 5. Seed inicial
  // ────────────────────────────────────────────────────────────
  const FAM_DEFAULTS = [
    { id: 'm', name: 'Mara', c1: '#d9b478', c2: '#b88e51' },
    { id: 'l', name: 'Léo',  c1: '#9bbfa7', c2: '#739a82' },
    { id: 'a', name: 'Anya', c1: '#deae9a', c2: '#b48473' },
    { id: 'k', name: 'Kai',  c1: '#b4abc8', c2: '#8e85ad' },
  ];
  const SEED_ITEMS = [
    { name: 'Leite integral',  qty: '2 L',     by: 'k', ai: 'previsto', note: 'acaba amanhã' },
    { name: 'Café em grãos',   qty: '500 g',   by: 'a', ai: '+18% no mês' },
    { name: 'Banana',          qty: '6 un',    by: 'm', ai: 'a cada 5 dias' },
    { name: 'Detergente',      qty: '1 un',    by: 'a', ai: 'esquecido?' },
    { name: 'Azeite',          qty: '1 L',     by: 'm', note: '12% restante' },
    { name: 'Abacate',         qty: '3 un',    by: 'l' },
    { name: 'Iogurte grego',   qty: '500 g',   by: 'a' },
    { name: 'Macarrão',        qty: '2 un',    by: 'l' },
    { name: 'Esponja',         qty: '4 un',    by: 'm' },
    { name: 'Espinafre',       qty: '1 maço',  by: 'a', done: true },
    { name: 'Manteiga',        qty: '1 un',    by: 'm', done: true },
  ];
  const SEED_INV = [
    { name: 'Leite integral', stock: 0.15, unit: 'L',   cadenceDays: 5,  lastBought: now() - days(4) },
    { name: 'Café em grãos',  stock: 0.20, unit: 'g',   cadenceDays: 14, lastBought: now() - days(12) },
    { name: 'Arroz',          stock: 0.45, unit: 'kg',  cadenceDays: 30, lastBought: now() - days(18) },
    { name: 'Feijão',         stock: 0.60, unit: 'kg',  cadenceDays: 30, lastBought: now() - days(12) },
    { name: 'Azeite',         stock: 0.12, unit: 'L',   cadenceDays: 30, lastBought: now() - days(28) },
    { name: 'Detergente',     stock: 0.05, unit: 'un',  cadenceDays: 21, lastBought: now() - days(27) },
    { name: 'Sabão em pó',    stock: 0.55, unit: 'kg',  cadenceDays: 30, lastBought: now() - days(14) },
    { name: 'Banana',         stock: 0.30, unit: 'un',  cadenceDays: 5,  lastBought: now() - days(4) },
    { name: 'Pão de forma',   stock: 0.40, unit: 'un',  cadenceDays: 7,  lastBought: now() - days(5) },
    { name: 'Ovos',           stock: 0.70, unit: 'un',  cadenceDays: 10, lastBought: now() - days(6) },
  ];
  const SEED_REC = [
    { name: 'Leite integral', qty: '2 L',  cadenceDays: 5, day: 'qua', enabled: true },
    { name: 'Pão de forma',   qty: '1 un', cadenceDays: 7, day: 'qui', enabled: true },
    { name: 'Banana',         qty: '6 un', cadenceDays: 5, day: 'qua', enabled: true },
    { name: 'Ovos',           qty: '12 un', cadenceDays: 10, day: 'sex', enabled: false },
  ];

  // Seed só roda em modo demo (flag passada em URL: ?demo=1).
  // Por padrão, primeiro acesso vê tela de onboarding (sem família = vazio).
  async function seedDemo() {
    for (const f of FAM_DEFAULTS) await dbPut('family', { ...f, createdAt: now() });
    for (const i of SEED_ITEMS) {
      await dbPut('items', {
        id: uid(), name: i.name, qty: i.qty, aisle: classifyAisle(i.name),
        by: i.by, done: !!i.done, ai: i.ai || null, note: i.note || null,
        addedAt: now() - Math.floor(Math.random() * 5) * 86400e3,
        checkedAt: i.done ? now() - 86400e3 : null,
      });
    }
    for (const i of SEED_INV) await dbPut('inventory', { id: uid(), ...i });
    for (const r of SEED_REC) await dbPut('recurring', { id: uid(), ...r });
  }

  // ────────────────────────────────────────────────────────────
  // 6. State store + BroadcastChannel
  // ────────────────────────────────────────────────────────────
  const state = {
    view: 'lista',         // lista | estoque | recorrentes | sugestoes | familia | shopping
    items: [], inventory: [], recurring: [], family: [], history: [],
    prices: {},            // { 'leite integral': { id, name, price, source, link, fetchedAt } }
    currentUser: 'm',
    search: '',
    showSug: false,
    showDone: false,
    sheet: null,
    sheetData: null,
    voice: { listening: false, transcript: '', interim: '' },
    toast: null,
    undo: null,            // { msg, fn: async () => void, expiresAt }
    acFocus: false,        // se a addbar está focada (mostra autocomplete)
    canInstall: false,     // PWA install prompt disponível
    theme: 'auto',         // 'auto' | 'light' | 'dark'
    notifPerm: typeof Notification !== 'undefined' ? Notification.permission : 'default',
    online: navigator.onLine,
    // Sync multi-device
    sync: {
      spaceId: null,       // se null, modo solo (sem servidor)
      spaceCode: null,
      spaceName: null,
      lastPull: 0,         // timestamp do último cursor de pull (ms server time)
      status: 'idle',      // 'idle' | 'syncing' | 'error' | 'offline'
      lastSyncAt: 0,
      lastError: null,
      queueLen: 0,         // operações na fila offline aguardando push
    },
  };

  let _renderTimer = null;
  function setState(patch) {
    Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(render, 16);
  }

  let channel = null;
  if ('BroadcastChannel' in self) {
    channel = new BroadcastChannel('lecolista');
    channel.addEventListener('message', (e) => { if (e.data?.type === 'data-change') loadAll(); });
  }
  const broadcast = () => channel && channel.postMessage({ type: 'data-change', t: now() });

  async function loadAll() {
    const [items, inventory, recurring, family, history, prices] = await Promise.all([
      dbAll('items'), dbAll('inventory'), dbAll('recurring'),
      dbAll('family'), dbAll('history'), dbAll('prices'),
    ]);
    const priceMap = {};
    for (const p of prices) priceMap[p.id] = p;
    setState({ items, inventory, recurring, family, history, prices: priceMap });
  }

  // ────────────────────────────────────────────────────────────
  // 7. Operações de domínio
  // ────────────────────────────────────────────────────────────
  // ── Auto-fetch de preço via API (mesma origem, /api/v1/price)
  // Roda em background — não bloqueia o addItem. Atualiza chip quando responde.
  async function autoFetchPrice(name) {
    if (!name) return;
    // Já tem preço salvo? não busca de novo
    if (getPrice(name)) return;
    try {
      const r = await fetch(`/api/v1/price?q=${encodeURIComponent(name)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) return;
      const j = await r.json();
      if (j.found && typeof j.price === 'number' && j.price > 0) {
        await setPrice(name, j.price, { source: j.source || 'auto', link: j.link || null });
      }
    } catch (e) {
      // silent — API offline ou indisponível, segue sem preço
    }
  }

  async function addItem(name, qty, opts = {}) {
    if (!name || !name.trim()) return;
    const item = {
      id: uid(),
      name: cap(name.trim()),
      qty: qty || '1 un',
      aisle: opts.aisle || classifyAisle(name),
      by: opts.by || state.currentUser,
      done: false,
      ai: opts.ai || null,
      note: opts.note || null,
      addedAt: now(),
      checkedAt: null,
      updated_at: now(),
    };
    await dbPut('items', item);
    await syncItems(item);
    const hist = { id: uid(), name: item.name, qty: item.qty, byId: item.by, t: now(), action: 'added', updated_at: now() };
    await dbPut('history', hist);
    await syncHistory(hist);
    await loadAll();
    broadcast();
    toast(`Adicionado: ${item.name}`);
    autoFetchPrice(item.name); // dispara em background
    return item;
  }

  async function addItems(parsed) {
    if (!parsed?.length) return;
    const added = [];
    for (const p of parsed) {
      const name = cap(p.name);
      const item = {
        id: uid(), name, qty: p.qty || '1 un',
        aisle: classifyAisle(p.name),
        by: state.currentUser,
        done: false, ai: null, note: null,
        addedAt: now(), checkedAt: null, updated_at: now(),
      };
      await dbPut('items', item);
      await syncItems(item);
      const hist = { id: uid(), name, qty: p.qty || '1 un', byId: state.currentUser, t: now(), action: 'added', updated_at: now() };
      await dbPut('history', hist);
      await syncHistory(hist);
      added.push(name);
    }
    await loadAll();
    broadcast();
    toast(`${parsed.length} ${parsed.length === 1 ? 'item adicionado' : 'itens adicionados'}`);
    if (added.length === 1) autoFetchPrice(added[0]);
    else autoFetchPricesBatch(added);
  }

  async function autoFetchPricesBatch(names) {
    const unknown = names.filter((n) => !getPrice(n));
    if (!unknown.length) return;
    try {
      const r = await fetch('/api/v1/price/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ queries: unknown.slice(0, 25) }),
      });
      if (!r.ok) return;
      const j = await r.json();
      for (const [normName, res] of Object.entries(j.results || {})) {
        if (res.found && typeof res.price === 'number' && res.price > 0) {
          // Acha o nome original (com cap) que bate o query normalizado
          const original = names.find((n) => n.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() === normName) || normName;
          await setPrice(original, res.price, { source: res.source || 'auto', link: res.link || null });
        }
      }
    } catch (e) { /* silent */ }
  }

  async function toggleItem(id) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    const wasDone = !!it.done;
    const next = { ...it, done: !wasDone, checkedAt: !wasDone ? now() : null, updated_at: now() };
    await dbPut('items', next);
    await syncItems(next);
    let invSnap = null;
    if (next.done) {
      const inv = state.inventory.find((i) => i.name.toLowerCase() === next.name.toLowerCase());
      if (inv) {
        invSnap = { ...inv };
        const updInv = { ...inv, stock: 1.0, lastBought: now(), updated_at: now() };
        await dbPut('inventory', updInv);
        await syncInventory(updInv);
      }
      const hist = { id: uid(), name: next.name, qty: next.qty, byId: state.currentUser, t: now(), action: 'bought', updated_at: now() };
      await dbPut('history', hist);
      await syncHistory(hist);
    }
    await loadAll();
    broadcast();
    if (next.done && !wasDone) {
      pushUndo(`Comprado: ${next.name}`, async () => {
        await dbPut('items', { ...it });
        if (invSnap) await dbPut('inventory', invSnap);
        await loadAll();
        broadcast();
      });
    }
  }

  async function removeItem(id) {
    const original = state.items.find((x) => x.id === id);
    if (!original) return;
    await dbDel('items', id);
    await syncItems({ id, ...original }, true); // propaga delete
    await loadAll();
    broadcast();
    pushUndo(`Removido: ${original.name}`, async () => {
      const restored = { ...original, updated_at: now() };
      await dbPut('items', restored);
      await syncItems(restored);
      await loadAll();
      broadcast();
    });
  }
  async function updateItem(id, patch) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    const next = { ...it, ...patch, updated_at: now() };
    if (patch.name) next.aisle = classifyAisle(patch.name);
    await dbPut('items', next);
    await syncItems(next);
    await loadAll();
    broadcast();
  }

  async function clearChecked() {
    const checked = state.items.filter((x) => x.done);
    if (!checked.length) return;
    for (const it of checked) {
      await dbDel('items', it.id);
      await syncItems(it, true);
    }
    await loadAll();
    broadcast();
    pushUndo(`${checked.length} ${checked.length === 1 ? 'comprado removido' : 'comprados removidos'}`, async () => {
      for (const it of checked) {
        const restored = { ...it, updated_at: now() };
        await dbPut('items', restored);
        await syncItems(restored);
      }
      await loadAll();
      broadcast();
    });
  }

  // PIN: hash SHA-256 simples (não é proteção real — só evita criança trocar de usuário)
  async function hashPin(pin) {
    if (!pin || !String(pin).trim()) return null;
    const enc = new TextEncoder().encode('lecolista:' + String(pin).trim());
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  async function verifyPin(memberId, pin) {
    const f = state.family.find((x) => x.id === memberId);
    if (!f) return false;
    if (!f.pinHash) return true;
    return (await hashPin(pin)) === f.pinHash;
  }

  async function addFamily(name, pin = null) {
    if (!name?.trim()) return null;
    const palettes = [
      ['#d9b478','#b88e51'], ['#9bbfa7','#739a82'], ['#deae9a','#b48473'], ['#b4abc8','#8e85ad'],
      ['#a8c4d4','#779eb3'], ['#e0c4a8','#b08a6b'], ['#c8b894','#9e8a64'], ['#c5a9c1','#9b7f97'],
    ];
    const idx = state.family.length % palettes.length;
    let id = name.toLowerCase().replace(/[^a-zà-ú]/gi,'').slice(0,2);
    if (!id || state.family.some((f) => f.id === id)) id = uid().slice(0,3);
    const pinHash = await hashPin(pin);
    const member = { id, name: cap(name.trim()), c1: palettes[idx][0], c2: palettes[idx][1], pinHash, createdAt: now(), updated_at: now() };
    await dbPut('family', member);
    await syncFamily(member);
    await loadAll();
    broadcast();
    return member;
  }

  async function updateFamilyPin(memberId, newPin) {
    const f = state.family.find((x) => x.id === memberId);
    if (!f) return;
    const pinHash = await hashPin(newPin);
    const next = { ...f, pinHash, updated_at: now() };
    await dbPut('family', next);
    await syncFamily(next);
    await loadAll();
    broadcast();
  }

  async function wipeAll() {
    for (const s of STORES) await dbClear(s);
    await loadAll();
    broadcast();
    setState({
      view: 'lista', sheet: null, sheetData: null, search: '',
      showSug: false, showDone: false, currentUser: null,
      voice: { listening: false, transcript: '', interim: '' },
    });
  }

  async function removeFamily(id) {
    const original = state.family.find((f) => f.id === id);
    if (!original) return;
    await dbDel('family', id);
    await syncFamily(original, true);
    await loadAll();
    if (!state.family.find((f) => f.id === state.currentUser) && state.family.length) {
      setState({ currentUser: state.family[0].id });
    }
    broadcast();
    pushUndo(`Removido: ${original.name}`, async () => {
      const restored = { ...original, updated_at: now() };
      await dbPut('family', restored);
      await syncFamily(restored);
      await loadAll();
      broadcast();
    });
  }

  async function updateInv(id, patch) {
    const inv = state.inventory.find((x) => x.id === id);
    if (!inv) return;
    const next = { ...inv, ...patch, updated_at: now() };
    await dbPut('inventory', next);
    await syncInventory(next);
    await loadAll();
    broadcast();
  }

  async function addInv({ name, stock = 1, unit = 'un', cadenceDays = 14 }) {
    if (!name?.trim()) return;
    const inv = { id: uid(), name: cap(name.trim()), stock, unit, cadenceDays, lastBought: now(), updated_at: now() };
    await dbPut('inventory', inv);
    await syncInventory(inv);
    await loadAll();
    broadcast();
  }

  async function removeInv(id) {
    const original = state.inventory.find((x) => x.id === id);
    if (!original) return;
    await dbDel('inventory', id);
    await syncInventory(original, true);
    await loadAll();
    broadcast();
    pushUndo(`Removido do estoque: ${original.name}`, async () => {
      const restored = { ...original, updated_at: now() };
      await dbPut('inventory', restored);
      await syncInventory(restored);
      await loadAll(); broadcast();
    });
  }

  async function toggleRec(id) {
    const r = state.recurring.find((x) => x.id === id);
    if (!r) return;
    const next = { ...r, enabled: !r.enabled, updated_at: now() };
    await dbPut('recurring', next);
    await syncRecurring(next);
    await loadAll();
    broadcast();
  }

  async function addRec({ name, qty, cadenceDays }) {
    if (!name?.trim()) return;
    const rec = { id: uid(), name: cap(name.trim()), qty: qty || '1 un', cadenceDays: cadenceDays || 7, day: 'qua', enabled: true, updated_at: now() };
    await dbPut('recurring', rec);
    await syncRecurring(rec);
    await loadAll();
    broadcast();
  }

  async function removeRec(id) {
    const original = state.recurring.find((x) => x.id === id);
    if (!original) return;
    await dbDel('recurring', id);
    await syncRecurring(original, true);
    await loadAll();
    broadcast();
    pushUndo(`Rotina removida: ${original.name}`, async () => {
      const restored = { ...original, updated_at: now() };
      await dbPut('recurring', restored);
      await syncRecurring(restored);
      await loadAll(); broadcast();
    });
  }

    async function applyRecToList(rec) {
    await addItem(rec.name, rec.qty, { ai: 'recorrente' });
  }

  // ── Preços ─────────────────────────────────────────────
  function priceKey(name) { return String(name || '').toLowerCase().trim(); }

  function getPrice(name) {
    return state.prices[priceKey(name)] || null;
  }

  async function setPrice(name, price, opts = {}) {
    const id = priceKey(name);
    if (!id) return;
    const rec = {
      id, name: cap(String(name).trim()),
      price: Number(price),
      source: opts.source || 'manual',
      link: opts.link || null,
      currency: 'BRL',
      fetchedAt: now(),
      updated_at: now(),
    };
    await dbPut('prices', rec);
    await syncPrices(rec);
    await loadAll();
    broadcast();
  }

  async function clearPrice(name) {
    const id = priceKey(name);
    const original = state.prices[id];
    await dbDel('prices', id);
    if (original) await syncPrices(original, true);
    await loadAll();
    broadcast();
  }

  function fmtBRL(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(n);
  }

  function parseQtyNum(qtyStr) {
    if (!qtyStr) return 1;
    const m = String(qtyStr).match(/(\d+(?:[.,]\d+)?)/);
    return m ? parseFloat(m[1].replace(',', '.')) : 1;
  }

  function listTotal() {
    let total = 0, count = 0;
    for (const it of state.items.filter((i) => !i.done)) {
      const p = getPrice(it.name);
      if (p && !isNaN(p.price)) {
        total += p.price * parseQtyNum(it.qty);
        count++;
      }
    }
    return { total, count };
  }

  function sourceLabel(s) {
    return s === 'ml' ? 'Mercado Livre' : s === 'amazon' ? 'Amazon' : s === 'google' ? 'Google Shopping' : 'Manual';
  }

  // ════════════════════════════════════════════════════════════
  // SYNC MULTI-DEVICE
  // ════════════════════════════════════════════════════════════
  // Cada record local que sincroniza tem updated_at + opcional deleted_at.
  // Mudanças vão pra "outbox" (fila de push). Loop tenta enviar a cada 3s
  // se houver itens. Pull roda a cada 10s + após cada push bem-sucedido.
  // ════════════════════════════════════════════════════════════

  const SYNC_KINDS = ['items', 'family', 'inventory', 'recurring', 'prices', 'history'];

  async function loadSyncMeta() {
    const m = await dbGet('meta', 'sync').catch(() => null);
    if (m) {
      state.sync = { ...state.sync, spaceId: m.spaceId, spaceCode: m.spaceCode, spaceName: m.spaceName, lastPull: m.lastPull || 0 };
    }
    await refreshOutboxCount();
  }
  async function saveSyncMeta() {
    await dbPut('meta', {
      id: 'sync',
      spaceId: state.sync.spaceId,
      spaceCode: state.sync.spaceCode,
      spaceName: state.sync.spaceName,
      lastPull: state.sync.lastPull,
    });
  }

  // Outbox: store dedicado pra registros pendentes de push.
  async function queuePush(kind, record, isDelete = false) {
    if (!state.sync.spaceId) return; // modo solo: ignora
    const outboxId = `${kind}:${record.id}`;
    await dbPut('outbox', {
      id: outboxId,
      kind,
      record_id: record.id,
      data: record,
      updated_at: record.updated_at || now(),
      deleted_at: isDelete ? (record.deleted_at || now()) : null,
      queued_at: now(),
    });
    refreshOutboxCount();
    schedulePush();
  }
  async function refreshOutboxCount() {
    const all = await dbAll('outbox').catch(() => []);
    state.sync.queueLen = all.length;
  }

  let _pushTimer = null;
  function schedulePush(delayMs = 400) {
    if (!state.sync.spaceId) return;
    if (_pushTimer) return;
    _pushTimer = setTimeout(async () => {
      _pushTimer = null;
      await flushOutbox();
    }, delayMs);
  }

  async function flushOutbox() {
    if (!state.sync.spaceId) return;
    if (!state.online) return;
    const pending = await dbAll('outbox').catch(() => []);
    if (!pending.length) return;
    setState({ sync: { ...state.sync, status: 'syncing' } });
    const batch = pending.slice(0, 200);
    const records = batch.map((p) => ({
      kind: p.kind,
      id: p.record_id,
      data: p.deleted_at ? null : p.data,
      updated_at: p.updated_at,
      deleted_at: p.deleted_at || null,
    }));
    try {
      const r = await fetch(`/api/v1/spaces/${state.sync.spaceId}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      // remove da outbox
      for (const p of batch) await dbDel('outbox', p.id);
      await refreshOutboxCount();
      setState({ sync: { ...state.sync, status: 'idle', lastSyncAt: now(), lastError: null } });
      // Trigger pull pra pegar mudanças de outros devices
      schedulePull(100);
      // Se ainda tem fila, processa próximo lote
      if (pending.length > batch.length) schedulePush(100);
    } catch (e) {
      setState({ sync: { ...state.sync, status: 'error', lastError: String(e.message || e) } });
      // tenta de novo em 10s
      setTimeout(() => schedulePush(0), 10000);
    }
  }

  let _pullTimer = null;
  function schedulePull(delayMs = 10000) {
    if (!state.sync.spaceId) return;
    if (_pullTimer) clearTimeout(_pullTimer);
    _pullTimer = setTimeout(async () => {
      _pullTimer = null;
      await pullChanges();
      schedulePull(); // re-arma pra rodar de novo
    }, delayMs);
  }

  async function pullChanges() {
    if (!state.sync.spaceId || !state.online) return;
    try {
      const since = state.sync.lastPull || 0;
      const r = await fetch(`/api/v1/spaces/${state.sync.spaceId}/pull?since=${since}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.records && j.records.length) {
        // Aplica cada record no IDB local
        for (const rec of j.records) {
          if (!SYNC_KINDS.includes(rec.kind)) continue;
          if (rec.deleted_at) {
            // Soft delete remoto: apaga local
            await dbDel(rec.kind, rec.id).catch(() => {});
          } else if (rec.data) {
            // Last-write-wins: só sobrescreve se updated_at remoto for >= local
            const local = await dbGet(rec.kind, rec.id).catch(() => null);
            if (!local || (rec.updated_at >= (local.updated_at || 0))) {
              const recordData = rec.kind === 'prices'
                ? rec.data  // prices usa nome como id
                : { ...rec.data, updated_at: rec.updated_at };
              await dbPut(rec.kind, recordData);
            }
          }
        }
        // Recarrega state em memória
        await loadAll();
      }
      state.sync.lastPull = j.cursor || j.server_now || now();
      await saveSyncMeta();
      setState({ sync: { ...state.sync, lastSyncAt: now(), status: 'idle', lastError: null } });
    } catch (e) {
      setState({ sync: { ...state.sync, status: 'error', lastError: String(e.message || e) } });
    }
  }

  // Cria grupo no servidor + ativa sync local
  async function syncCreateSpace(name, pin) {
    const r = await fetch('/api/v1/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: pin || undefined }),
    });
    if (!r.ok) throw new Error('Falha ao criar grupo (HTTP ' + r.status + ')');
    const j = await r.json();
    state.sync.spaceId = j.id;
    state.sync.spaceCode = j.code;
    state.sync.spaceName = j.name || null;
    state.sync.lastPull = 0;
    await saveSyncMeta();
    // Faz initial push de TUDO que já existe local (família, items, etc.)
    await pushAllLocal();
    schedulePull();
    return j;
  }

  // Entra em grupo existente
  async function syncJoinSpace(code, pin) {
    const r = await fetch('/api/v1/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, pin: pin || undefined }),
    });
    if (r.status === 401) throw new Error('PIN do grupo incorreto');
    if (r.status === 404) throw new Error('Grupo não encontrado');
    if (!r.ok) throw new Error('Falha ao entrar (HTTP ' + r.status + ')');
    const j = await r.json();
    state.sync.spaceId = j.id;
    state.sync.spaceCode = j.code;
    state.sync.spaceName = j.name || null;
    state.sync.lastPull = 0;
    await saveSyncMeta();
    // Initial pull pra trazer todo o estado do grupo
    await pullChanges();
    schedulePull();
    return j;
  }

  // Push inicial: manda tudo o que já existe local pro servidor (após criar grupo)
  async function pushAllLocal() {
    for (const kind of SYNC_KINDS) {
      const all = await dbAll(kind).catch(() => []);
      for (const rec of all) {
        // Garante que tem updated_at
        if (!rec.updated_at) {
          rec.updated_at = now();
          await dbPut(kind, rec);
        }
        await queuePush(kind, rec);
      }
    }
    schedulePush(0);
  }

  // Sai do grupo (mantém dados locais)
  async function syncLeaveSpace() {
    if (_pullTimer) clearTimeout(_pullTimer);
    if (_pushTimer) clearTimeout(_pushTimer);
    _pullTimer = _pushTimer = null;
    state.sync = { spaceId: null, spaceCode: null, spaceName: null, lastPull: 0, status: 'idle', lastSyncAt: 0, lastError: null, queueLen: 0 };
    await saveSyncMeta();
    // Limpa outbox
    const all = await dbAll('outbox').catch(() => []);
    for (const p of all) await dbDel('outbox', p.id);
  }

  // Helper pra adicionar updated_at + queuePush em mutações
  function withSync(kind) {
    return async (record, isDelete = false) => {
      const stamped = isDelete
        ? { ...record, deleted_at: now() }
        : { ...record, updated_at: now() };
      await queuePush(kind, stamped, isDelete);
    };
  }
  const syncItems     = withSync('items');
  const syncFamily    = withSync('family');
  const syncInventory = withSync('inventory');
  const syncRecurring = withSync('recurring');
  const syncPrices    = withSync('prices');
  const syncHistory   = withSync('history');

  // ── Autocomplete (sugestões enquanto digita) ─────────────────
  function getAutocomplete(q) {
    if (!q) return [];
    const needle = q.toLowerCase().trim();
    if (needle.length < 1) return [];
    const onListLower = new Set(state.items.filter((i) => !i.done).map((i) => i.name.toLowerCase()));
    const seen = new Set();
    const out = [];

    // 1. Histórico (mais frequentes primeiro)
    const freq = {};
    for (const h of state.history) {
      const n = (h.name || '').toLowerCase();
      if (!n) continue;
      freq[n] = (freq[n] || 0) + 1;
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([n]) => n);

    const tryAdd = (name, source, qty) => {
      const k = name.toLowerCase();
      if (seen.has(k)) return;
      if (onListLower.has(k)) return;          // já está na lista pendente
      if (!k.includes(needle)) return;          // não bate com a busca
      seen.add(k);
      out.push({ name, source, qty: qty || '1 un' });
    };

    // recorrentes batem primeiro (intenção mais clara)
    for (const r of state.recurring) tryAdd(r.name, 'Rotina', r.qty);
    // estoque
    for (const inv of state.inventory) tryAdd(inv.name, 'Estoque', `1 ${inv.unit || 'un'}`);
    // histórico
    for (const n of sorted) {
      const last = state.history.find((h) => (h.name || '').toLowerCase() === n);
      tryAdd(cap(n), 'Histórico', last?.qty);
    }
    return out.slice(0, 6);
  }

  // ────────────────────────────────────────────────────────────
  // 8. IA preditiva
  // ────────────────────────────────────────────────────────────
  function predict(inv) {
    // Estimativa simples: dias até acabar = stock × cadência
    const cadence = inv.cadenceDays || 14;
    const daysToEmpty = Math.max(0, (inv.stock || 0) * cadence);
    const daysSince = (now() - (inv.lastBought || now())) / 86400e3;
    return { daysToEmpty: +daysToEmpty.toFixed(1), daysSince: +daysSince.toFixed(1), cadence };
  }

  function getSuggestions() {
    const out = [];
    const onListLower = new Set(state.items.filter((i) => !i.done).map((i) => i.name.toLowerCase()));

    for (const inv of state.inventory) {
      const { daysToEmpty, daysSince } = predict(inv);
      const onList = onListLower.has(inv.name.toLowerCase());

      if (!onList) {
        if (daysToEmpty < 0.6) {
          out.push({ kind: 'previsto', priority: 4,
            title: `${inv.name} acaba ${daysToEmpty < 0.2 ? 'hoje' : 'amanhã'}`,
            sub: `Estoque: ${Math.round(inv.stock * 100)}% · cadência ${inv.cadenceDays} dias`,
            inv });
        } else if (daysToEmpty < 2) {
          out.push({ kind: 'previsto', priority: 3,
            title: `${inv.name} acaba em ${Math.ceil(daysToEmpty)} dias`,
            sub: `Estoque baixo (${Math.round(inv.stock * 100)}%)`,
            inv });
        } else if (daysToEmpty < 4 && inv.stock < 0.4) {
          out.push({ kind: 'baixo', priority: 2,
            title: `${inv.name} está acabando`,
            sub: `${Math.round(inv.stock * 100)}% restante`,
            inv });
        }
        if (daysSince > inv.cadenceDays * 1.15) {
          out.push({ kind: 'esquecido', priority: 2,
            title: `${inv.name} — esquecido?`,
            sub: `Última compra há ${Math.floor(daysSince)} dias · cadência ${inv.cadenceDays}`,
            inv });
        }
      }
    }

    // Recorrentes ativos cujo dia chegou
    for (const r of state.recurring) {
      if (!r.enabled) continue;
      if (onListLower.has(r.name.toLowerCase())) continue;
      out.push({ kind: 'recorrente', priority: 1,
        title: `${r.name} — recorrente`,
        sub: `A cada ${r.cadenceDays} dias`,
        rec: r });
    }

    // Histórico recente (últimos comprados que não estão no estoque ainda)
    const historicNames = [...new Set(state.history.filter((h) => h.action === 'bought').map((h) => h.name))];
    for (const n of historicNames.slice(0, 3)) {
      if (onListLower.has(n.toLowerCase())) continue;
      if (out.some((o) => (o.inv?.name || o.rec?.name)?.toLowerCase() === n.toLowerCase())) continue;
      // Don't push too many
    }

    out.sort((a, b) => b.priority - a.priority);
    return out;
  }

  // ────────────────────────────────────────────────────────────
  // 9. Voz (Web Speech API)
  // ────────────────────────────────────────────────────────────
  let _rec = null;
  function getRecognition() {
    if (_rec) return _rec;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'pt-BR';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      let final = '', interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t + ' '; else interim += t;
      }
      setState({ voice: { ...state.voice, transcript: (state.voice.transcript + ' ' + final).trim(), interim } });
    };
    r.onerror = (e) => {
      setState({ voice: { ...state.voice, listening: false } });
      if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Erro de voz: ${e.error}`);
    };
    r.onend = () => setState({ voice: { ...state.voice, listening: false } });
    _rec = r;
    return r;
  }

  function startVoice() {
    const r = getRecognition();
    if (!r) { toast('Voz não suportada neste navegador'); return; }
    setState({ voice: { listening: true, transcript: '', interim: '' } });
    try { r.start(); } catch (e) { /* já ativo */ }
  }
  function stopVoice() { try { _rec && _rec.stop(); } catch (e) {} setState({ voice: { ...state.voice, listening: false } }); }

  // ────────────────────────────────────────────────────────────
  // 10. Câmera + Barcode
  // ────────────────────────────────────────────────────────────
  let _stream = null;
  let _scanning = false;
  let _detector = null;
  let _zxingControls = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }

  async function startCamera(videoEl, onCode) {
    try {
      _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      videoEl.srcObject = _stream;
      videoEl.setAttribute('playsinline', '');
      videoEl.muted = true;
      await videoEl.play();
      _scanning = true;

      // 1) BarcodeDetector nativo (Chrome/Edge desktop e Android)
      if ('BarcodeDetector' in window) {
        try {
          _detector = new BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code'] });
        } catch (e) { _detector = null; }
        if (_detector) {
          const tick = async () => {
            if (!_scanning || !_stream) return;
            try {
              const codes = await _detector.detect(videoEl);
              if (codes && codes.length) { _scanning = false; onCode(codes[0].rawValue); return; }
            } catch (e) {}
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          return true;
        }
      }

      // 2) Fallback ZXing (Safari iOS, Firefox, etc.) — vendor local + fallback CDN
      try {
        try {
          await loadScript('./vendor/zxing.min.js');
        } catch (_) {
          await loadScript('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
        }
        if (!window.ZXing) throw new Error('ZXing não disponível');
        const reader = new window.ZXing.BrowserMultiFormatReader();
        // Já temos o stream; ZXing usa o videoEl direto
        _zxingControls = await reader.decodeFromVideoElement(videoEl, (result, err) => {
          if (!_scanning) return;
          if (result) {
            _scanning = false;
            try { _zxingControls?.stop?.(); } catch {}
            try { reader.reset(); } catch {}
            onCode(result.getText());
          }
        });
        return true;
      } catch (e) {
        console.warn('ZXing fallback falhou', e);
        toast('Detecção de código não disponível neste navegador. Use a entrada de texto.');
        return false;
      }
    } catch (e) {
      console.error('camera', e);
      toast('Não foi possível acessar a câmera. Verifique permissões.');
      return false;
    }
  }

  function stopCamera() {
    _scanning = false;
    try { _zxingControls?.stop?.(); } catch {}
    _zxingControls = null;
    if (_stream) _stream.getTracks().forEach((t) => t.stop());
    _stream = null;
    _detector = null;
  }

  // ── Receipt OCR (Tesseract.js · pt) ─────────────────────────
  let _ocrBusy = false;
  async function ocrReceipt(file, onProgress) {
    if (_ocrBusy) return null;
    _ocrBusy = true;
    try {
      await loadScript('https://unpkg.com/tesseract.js@5.0.5/dist/tesseract.min.js');
      if (!window.Tesseract) throw new Error('Tesseract não carregou');
      const { data } = await window.Tesseract.recognize(file, 'por', {
        logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(Math.round((m.progress || 0) * 100)); },
      });
      return data.text || '';
    } catch (e) {
      console.error('OCR', e);
      toast('Não foi possível ler o cupom. Tente uma foto melhor.');
      return null;
    } finally { _ocrBusy = false; }
  }

  // Heurística: extrai linhas que parecem itens (descrição + número)
  function parseReceiptText(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items = [];
    const seen = new Set();
    // Padrões comuns: "DESCRIÇÃO ... 12,90" ou "DESC X 2,50 7,90" ou "DESC R$ 12,90"
    const priceRe = /(\d{1,4}[.,]\d{2})\s*$/;
    const skipRe = /^(total|subtotal|descon|cnpj|cpf|cupom|fiscal|nfc|sat|chave|serie|operador|caixa|data|hora|trib|aprox|qtd|vl\s|item|descrição|código)/i;
    for (const line of lines) {
      if (line.length < 4) continue;
      if (skipRe.test(line)) continue;
      const m = line.match(priceRe);
      if (!m) continue;
      let desc = line.slice(0, line.lastIndexOf(m[0])).trim();
      // remove "X 2,50" multiplicador isolado no fim
      desc = desc.replace(/\s+x\s+\d+[.,]?\d*\s*$/i, '');
      desc = desc.replace(/\s+\d{1,3}([.,]\d{2,3})?\s*$/g, '');
      desc = desc.replace(/^\d+\s+/, ''); // numero do item
      desc = desc.replace(/\s+/g, ' ').trim();
      if (desc.length < 3) continue;
      const k = desc.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      items.push({ name: cap(desc.toLowerCase()), qty: '1 un', price: isNaN(price) ? null : price });
      if (items.length >= 30) break;
    }
    return items;
  }

  async function lookupBarcode(code) {
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_pt,brands,quantity,generic_name`);
      const j = await r.json();
      if (j.status === 1 && j.product) {
        const p = j.product;
        const name = p.product_name_pt || p.product_name || p.generic_name || '';
        const brand = (p.brands || '').split(',')[0].trim();
        return { name: name || `Item ${code}`, brand, qty: p.quantity || '1 un', code };
      }
    } catch (e) { /* offline ou indisponível */ }
    return { name: `Item ${code}`, brand: '', qty: '1 un', code };
  }

  // ────────────────────────────────────────────────────────────
  // 11. Toast / Export / Buscar
  // ────────────────────────────────────────────────────────────
  let _toastT = null;
  function toast(msg) {
    setState({ toast: msg });
    clearTimeout(_toastT);
    _toastT = setTimeout(() => setState({ toast: null }), 2400);
  }

  // ── Desfazer (undo) ──────────────────────────────────────────
  let _undoT = null;
  function pushUndo(msg, fn) {
    setState({ undo: { msg, fn, expiresAt: now() + 5000 } });
    clearTimeout(_undoT);
    _undoT = setTimeout(() => setState({ undo: null }), 5000);
  }
  async function doUndo() {
    if (!state.undo?.fn) return;
    const fn = state.undo.fn;
    clearTimeout(_undoT);
    setState({ undo: null });
    try { await fn(); toast('Desfeito'); } catch (e) { toast('Não foi possível desfazer'); }
  }

  function listAsText() {
    const pendentes = state.items.filter((i) => !i.done);
    const groups = groupByAisle(pendentes);
    const today = fmtPt(now(), { day: '2-digit', month: 'long', year: 'numeric' });
    const { total, count } = listTotal();
    let out = `HSH Mercado — ${today}\n`;
    out += `${pendentes.length} ${pendentes.length === 1 ? 'item' : 'itens'} pendentes`;
    if (count) out += ` · estimativa ${fmtBRL(total)}`;
    out += '\n\n';
    for (const [aid, list] of Object.entries(groups)) {
      out += `▸ ${(AISLE_LABELS[aid] || 'Outros').toUpperCase()}\n`;
      for (const i of list) {
        const p = getPrice(i.name);
        out += `   • ${i.name} — ${i.qty}`;
        if (p) out += `  (${fmtBRL(p.price)})`;
        out += '\n';
      }
      out += '\n';
    }
    if (count) out += `Total estimado: ${fmtBRL(total)} (${count}/${pendentes.length} com preço)\n`;
    return out;
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportJSON() {
    const data = {
      version: 2,
      items: state.items, inventory: state.inventory, recurring: state.recurring,
      family: state.family, prices: Object.values(state.prices), history: state.history,
      exportedAt: now(),
    };
    download(`lecolista-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('Exportado em JSON');
  }

  async function importJSON(file, mode = 'merge') {
    let data;
    try {
      const txt = await file.text();
      data = JSON.parse(txt);
    } catch (e) {
      toast('Arquivo inválido — JSON mal-formado');
      return;
    }
    const fields = ['items', 'inventory', 'recurring', 'family', 'history', 'prices'];
    if (!fields.some((f) => Array.isArray(data[f]))) {
      toast('Arquivo não parece um backup do HSH Mercado');
      return;
    }

    if (mode === 'replace') {
      for (const s of STORES) await dbClear(s);
    }

    let counts = { items: 0, inventory: 0, recurring: 0, family: 0, history: 0, prices: 0 };
    for (const f of fields) {
      const arr = Array.isArray(data[f]) ? data[f] : [];
      for (const it of arr) {
        if (!it || !it.id) continue;
        await dbPut(f, it);
        counts[f]++;
      }
    }
    await loadAll();
    broadcast();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    toast(`Backup ${mode === 'replace' ? 'restaurado' : 'mesclado'}: ${total} registros`);
  }
  function exportCSV() {
    const head = 'Nome,Quantidade,Setor,Quem,Comprado,Preço (R$),Subtotal (R$)\n';
    const rows = state.items.map((i) => {
      const p = getPrice(i.name);
      const sub = p ? (p.price * parseQtyNum(i.qty)).toFixed(2) : '';
      return `"${i.name}","${i.qty}","${AISLE_LABELS[i.aisle] || 'Outros'}","${memberName(i.by)}","${i.done ? 'sim' : 'não'}","${p ? p.price.toFixed(2) : ''}","${sub}"`;
    }).join('\n');
    download(`lecolista-${new Date().toISOString().slice(0,10)}.csv`, head + rows, 'text/csv');
    toast('Exportado em CSV');
  }
  function exportTXT() {
    download(`lecolista-${new Date().toISOString().slice(0,10)}.txt`, listAsText(), 'text/plain');
    toast('Exportado em TXT');
  }
  function copyList() {
    const t = listAsText();
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Lista copiada!'));
    else { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Lista copiada!'); }
  }
  function shareList() {
    const t = listAsText();
    if (navigator.share) navigator.share({ title: 'Lista · HSH Mercado', text: t }).catch(()=>{});
    else copyList();
  }
  function printList() { window.print(); }

  // ── Tema (claro / escuro / auto) ────────────────────────────
  async function loadTheme() {
    const meta = await dbGet('meta', 'theme').catch(() => null);
    const t = meta?.value || 'auto';
    state.theme = t;
    applyTheme(t);
  }
  function applyTheme(t) {
    const effective = t === 'auto'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
    document.documentElement.dataset.theme = effective;
  }
  async function toggleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.theme) + 1) % order.length];
    await dbPut('meta', { id: 'theme', value: next });
    setState({ theme: next });
    applyTheme(next);
    toast(`Tema: ${next === 'auto' ? 'automático' : next === 'dark' ? 'escuro' : 'claro'}`);
  }
  // Quando o sistema muda (e tema é auto)
  if (matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'auto') applyTheme('auto');
    });
  }

  // ── Notificações locais ─────────────────────────────────────
  async function enableNotifs() {
    if (typeof Notification === 'undefined') { toast('Notificações não suportadas neste navegador'); return false; }
    const p = await Notification.requestPermission();
    setState({ notifPerm: p });
    if (p === 'granted') {
      toast('Notificações ativadas');
      // Notifica imediatamente sobre sugestões IA, se houver
      checkAndNotify();
      return true;
    } else {
      toast('Permissão recusada');
      return false;
    }
  }

  function showNotif(title, body, opts = {}) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body, icon: 'icon.svg', badge: 'icon.svg', tag: opts.tag || 'lecolista', silent: !!opts.silent,
        data: opts.data || {},
      });
    } catch (e) { /* ignore */ }
  }

  function checkAndNotify() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const sug = getSuggestions();
    const urgentes = sug.filter((s) => s.priority >= 3);
    if (urgentes.length) {
      const first = urgentes[0];
      const extras = urgentes.length - 1;
      showNotif(
        first.title,
        extras > 0 ? `${first.sub || ''}${first.sub ? ' · ' : ''}+${extras} ${extras === 1 ? 'sugestão' : 'sugestões'}` : (first.sub || ''),
        { tag: 'sug-urgente' }
      );
    }
  }

  function searchExternal(prov, q) {
    const enc = encodeURIComponent(q);
    const urls = {
      ml: `https://lista.mercadolivre.com.br/${enc}`,
      amazon: `https://www.amazon.com.br/s?k=${enc}`,
      google: `https://www.google.com/search?tbm=shop&q=${enc}`,
      ifood: `https://www.ifood.com.br/busca?q=${enc}`,
    };
    if (urls[prov]) window.open(urls[prov], '_blank', 'noopener');
  }

  // ────────────────────────────────────────────────────────────
  // 12. Render helpers
  // ────────────────────────────────────────────────────────────
  function memberName(id) { const f = state.family.find((x) => x.id === id); return f ? f.name : '—'; }

  function avatar(byId, size = 22) {
    const f = state.family.find((x) => x.id === byId) || { name: '?', c1: '#bbb', c2: '#888' };
    const fs = Math.round(size * 0.46);
    return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${fs}px;background:linear-gradient(135deg, ${f.c1}, ${f.c2})">${escape(f.name.charAt(0).toUpperCase())}</span>`;
  }
  function avatarStack(ids, size = 24) {
    const overlap = Math.round(size * 0.32);
    return `<span class="avatar-stack" style="display:inline-flex">${ids.slice(0, 5).map((id, i) => `<span style="margin-left:${i ? -overlap : 0}px">${avatar(id, size)}</span>`).join('')}</span>`;
  }
  function icon(name, size = 18, opts = {}) {
    const sw = opts.sw || 1.6;
    const stroke = opts.stroke || 'currentColor';
    const fill = opts.fill || 'none';
    return `<span class="icon" style="display:inline-flex"><svg width="${size}" height="${size}" stroke="${stroke}" fill="${fill}" stroke-width="${sw}"><use href="#ic-${name}"/></svg></span>`;
  }
  function thumb(label = '', size = 40) {
    const cls = size <= 22 ? 'thumb thumb--xs' : size <= 36 ? 'thumb thumb--sm' : 'thumb';
    return `<span class="${cls}">${size > 22 ? escape(label) : ''}</span>`;
  }
  const tag = (label, ai) => `<span class="tag${ai ? ' tag--ai' : ''}">${escape(label)}</span>`;
  const aiBadge = (text) => `<span class="ai-badge">${icon('sparkle', 11, { fill: 'currentColor', stroke: 'none' })}<span>${escape(text)}</span></span>`;

  function groupByAisle(items) {
    const groups = {};
    const order = AISLES.map((a) => a.id).concat(['outros']);
    for (const id of order) groups[id] = [];
    for (const it of items) {
      const id = it.aisle || 'outros';
      if (!groups[id]) groups[id] = [];
      groups[id].push(it);
    }
    for (const k of Object.keys(groups)) if (!groups[k].length) delete groups[k];
    return groups;
  }

  function fmtRel(ts) {
    if (!ts) return '—';
    const d = (now() - ts) / 86400e3;
    if (d < 0.04) return 'agora';
    if (d < 0.5) return `há ${Math.round(d * 24)}h`;
    if (d < 1) return 'hoje';
    if (d < 2) return 'ontem';
    if (d < 7) return `há ${Math.floor(d)} dias`;
    return fmtPt(ts, { day: '2-digit', month: 'short' });
  }

  // ────────────────────────────────────────────────────────────
  // 13. Vistas
  // ────────────────────────────────────────────────────────────

  function viewLista() {
    const q = state.search.toLowerCase();
    const matches = (i) => !q || i.name.toLowerCase().includes(q);

    const pendentes = state.items.filter((i) => !i.done && matches(i));
    const comprados = state.items.filter((i) => i.done && matches(i));

    const groups = groupByAisle(pendentes);
    const suggestions = getSuggestions();
    const me = state.family.find((f) => f.id === state.currentUser);
    const todayStr = cap(fmtPt(now(), { weekday: 'long' })) + ', ' + fmtPt(now(), { day: 'numeric', month: 'long' });

    const renderRow = (item, isDone = false) => {
      const p = getPrice(item.name);
      const subtotal = p ? p.price * parseQtyNum(item.qty) : null;
      const priceChip = p
        ? `<button class="row__price" data-act="open-price" data-id="${item.id}" title="Atualizar preço">
             <span class="row__price-amt">${fmtBRL(p.price)}</span>
             ${parseQtyNum(item.qty) > 1 ? `<span class="row__price-sub">= ${fmtBRL(subtotal)}</span>` : ''}
           </button>`
        : `<button class="row__price row__price--empty" data-act="open-price" data-id="${item.id}" title="Buscar preço de referência">R$ ?</button>`;

      const bodyInner = `
        <span class="row__body-inner">
          <span class="row__name">${escape(item.name)}</span>
          ${item.ai ? `<span class="row__hint">${icon('sparkle', 10, { fill: 'currentColor', stroke: 'none' })}<span>${escape(item.ai)}</span></span>` : ''}
          ${item.note ? `<span class="row__note">${escape(item.note)}</span>` : ''}
        </span>
      `;
      return `
      <li class="row${isDone ? ' row--done' : ''}" data-id="${item.id}">
        <button class="row__check ${isDone ? 'row__check--on' : ''}" data-act="toggle" data-id="${item.id}" aria-label="${isDone ? 'Desmarcar' : 'Marcar como comprado'}">
          <svg width="13" height="13" stroke="#fff" stroke-width="2.6" fill="none"><use href="#ic-check"/></svg>
        </button>
        <button class="row__body${item.photo ? ' row__body--photo' : ''}" data-act="edit" data-id="${item.id}">
          ${item.photo ? `<img class="row__photo" src="${item.photo}" alt="" loading="lazy" />` : ''}
          ${bodyInner}
        </button>
        ${priceChip}
        <span class="row__qty">${escape(item.qty)}</span>
        ${avatar(item.by, 18)}
      </li>
    `;
    };

    return `
      <header class="hdr">
        <div class="hdr__left">
          <div>
            <h1 class="hdr__title">HSH Mercado<span class="hdr__dot">.</span></h1>
            <p class="hdr__sub">${todayStr} · ${pendentes.length === 0 ? 'tudo comprado' : `${pendentes.length} ${pendentes.length === 1 ? 'pendente' : 'pendentes'}`}</p>
          </div>
        </div>
        <div class="hdr__right">
          ${state.sync.spaceId ? `
            <button class="hdr__sync hdr__sync--${state.sync.status === 'syncing' ? 'sync' : state.sync.status === 'error' ? 'err' : state.online ? 'ok' : 'off'}"
              data-act="open-group" title="${state.sync.spaceCode} · ${state.sync.status === 'syncing' ? 'sincronizando' : state.online ? 'sincronizado' : 'offline'}">
              <span class="hdr__sync-dot"></span>
            </button>
          ` : ''}
          ${me
            ? `<button class="hdr__user" data-act="open-family" title="Trocar de usuário · ${escape(me.name)}">${avatar(state.currentUser, 32)}</button>`
            : `<button class="btn btn--ghost btn--sm" data-act="open-family">Entrar</button>`}
          <button class="hdr__more" data-act="open-menu" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>
          </button>
        </div>
      </header>

      <div class="addbar-wrap">
        <form class="addbar" data-form="quickadd">
          <button type="button" class="addbar__plus" data-act="open-add" aria-label="Adicionar com mais opções">${icon('plus', 16, { sw: 2 })}</button>
          <input type="text" class="addbar__input" name="text" placeholder="Adicionar item ou buscar…" value="${escape(state.search)}" data-input="quickadd" autocomplete="off" />
          ${state.search ? `<button type="button" class="addbar__clear" data-act="clear-search" aria-label="Limpar busca">${icon('x', 14)}</button>` : ''}
          <button type="button" class="addbar__btn" data-act="open-add-tab" data-tab="voz" aria-label="Adicionar por voz">${icon('mic', 16, { fill: 'currentColor', stroke: 'currentColor' })}</button>
          <button type="button" class="addbar__btn" data-act="open-add-tab" data-tab="camera" aria-label="Ler código de barras">${icon('camera', 16)}</button>
        </form>
        ${(() => {
          if (!state.acFocus || !state.search) return '';
          const sugs = getAutocomplete(state.search);
          if (!sugs.length) return '';
          return `
            <ul class="ac" role="listbox">
              ${sugs.map((s) => `
                <li>
                  <button class="ac__item" data-act="ac-pick" data-name="${escape(s.name)}" data-qty="${escape(s.qty)}">
                    <span class="ac__name">${escape(s.name)}</span>
                    <span class="ac__qty">${escape(s.qty)}</span>
                    <span class="ac__src">${escape(s.source)}</span>
                  </button>
                </li>
              `).join('')}
            </ul>
          `;
        })()}
      </div>

      ${suggestions.length ? `
      <button class="sug-chip ${state.showSug ? 'sug-chip--open' : ''}" data-act="toggle-sug" type="button">
        ${icon('sparkle', 13, { fill: 'currentColor', stroke: 'none' })}
        <span>${suggestions.length} ${suggestions.length === 1 ? 'sugestão' : 'sugestões'} da IA</span>
        ${icon('chevron-d', 13)}
      </button>
      ${state.showSug ? `
      <ul class="sug-list">
        ${suggestions.slice(0, 6).map((p) => `
          <li class="sug-item">
            <div class="sug-item__body">
              <span class="sug-item__title">${escape(p.title)}</span>
              ${p.sub ? `<span class="sug-item__sub">${escape(p.sub)}</span>` : ''}
            </div>
            <button class="sug-item__add" data-act="add-suggestion" data-name="${escape(p.inv?.name || p.rec?.name)}" data-qty="${escape(p.inv ? `1 ${p.inv.unit}` : (p.rec?.qty || '1 un'))}" data-ai="${escape(p.kind)}">${icon('plus', 13)}<span>Adicionar</span></button>
          </li>
        `).join('')}
      </ul>` : ''}
      ` : ''}

      ${Object.keys(groups).length ? `
        <div class="lst">
          ${Object.entries(groups).map(([aid, list]) => `
            <section class="grp">
              <h2 class="grp__h">
                <span>${AISLE_LABELS[aid] || 'Outros'}</span>
                <span class="grp__c">${list.length}</span>
              </h2>
              <ul class="grp__items">
                ${list.map((it) => renderRow(it, false)).join('')}
              </ul>
            </section>
          `).join('')}
        </div>
      ` : `
        <div class="empty-mini">
          <p class="empty-mini__t">${state.search ? 'Nada encontrado' : pendentes.length === 0 && state.items.length ? 'Tudo comprado ✓' : 'Lista vazia'}</p>
          <p class="empty-mini__s">${state.search ? 'Tente outra busca' : 'Use o + acima ou fale com o microfone'}</p>
        </div>
      `}

      ${(() => {
        const { total, count } = listTotal();
        const totalPend = pendentes.length;
        const semPreco = totalPend - count;
        if (totalPend === 0) return '';
        return `
        <footer class="totalbar">
          <div class="totalbar__main">
            <span class="totalbar__label">Estimativa da lista</span>
            <span class="totalbar__amount">${count ? fmtBRL(total) : '—'}</span>
          </div>
          <div class="totalbar__meta">
            ${count ? `<span>${count} de ${totalPend} com preço</span>` : `<span>Nenhum preço definido ainda</span>`}
            ${semPreco > 0 ? `<button class="link-btn" data-act="search-all-prices">Buscar ${semPreco} faltantes →</button>` : ''}
          </div>
        </footer>
        `;
      })()}

      ${comprados.length ? `
        <section class="grp grp--done">
          <button class="grp__toggle" data-act="toggle-done" type="button">
            <span class="grp__h grp__h--done">
              <span>Comprados</span>
              <span class="grp__c">${comprados.length}</span>
            </span>
            <span class="grp__chev ${state.showDone ? 'grp__chev--open' : ''}">${icon('chevron-d', 14)}</span>
          </button>
          ${state.showDone ? `
            <ul class="grp__items">
              ${comprados.map((it) => renderRow(it, true)).join('')}
            </ul>
            <button class="link-btn grp__clear" data-act="clear-checked">Limpar ${comprados.length} ${comprados.length === 1 ? 'comprado' : 'comprados'}</button>
          ` : ''}
        </section>
      ` : ''}
    `;
  }

  function subHeader(title, sub, action = '') {
    return `
      <header class="hdr hdr--sub">
        <div class="hdr__left">
          <button class="hdr__back" data-act="view" data-val="lista" aria-label="Voltar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div>
            <h1 class="hdr__title hdr__title--sub">${title}<span class="hdr__dot">.</span></h1>
            ${sub ? `<p class="hdr__sub">${sub}</p>` : ''}
          </div>
        </div>
        <div class="hdr__right">${action}</div>
      </header>
    `;
  }

  function viewEstoque() {
    const sorted = [...state.inventory].sort((a, b) => a.stock - b.stock);
    return subHeader(
      'Estoque',
      `${state.inventory.length} produtos · IA estima quando cada um acaba`,
      `<button class="btn btn--primary btn--sm" data-act="open-inv-add">${icon('plus', 14, { sw: 2 })}<span>Cadastrar</span></button>`
    ) + `

      <div class="stock-grid">
        ${sorted.map((inv) => {
          const { daysToEmpty, daysSince } = predict(inv);
          const pct = Math.round(inv.stock * 100);
          const tone = pct < 20 ? 'crit' : pct < 50 ? 'warn' : 'ok';
          return `
            <article class="stock-card stock-card--${tone}">
              <header class="stock-card__head">
                <div>
                  <h3 class="stock-card__name">${escape(inv.name)}</h3>
                  <p class="stock-card__meta">Última compra ${fmtRel(inv.lastBought)} · cadência ${inv.cadenceDays}d</p>
                </div>
                <button class="icon-btn" data-act="open-inv-edit" data-id="${inv.id}" aria-label="Editar">${icon('sliders', 15)}</button>
              </header>
              <div class="stock-bar"><div class="stock-bar__fill" style="width:${pct}%"></div></div>
              <footer class="stock-card__foot">
                <span class="stock-pct">${pct}%</span>
                <span class="stock-eta">${
                  daysToEmpty < 0.5 ? 'acaba hoje'
                  : daysToEmpty < 1.5 ? 'acaba amanhã'
                  : `~${Math.ceil(daysToEmpty)} dias`
                }</span>
                <button class="btn btn--ai btn--sm" data-act="add-from-inv" data-name="${escape(inv.name)}" data-qty="1 ${escape(inv.unit || 'un')}">${icon('plus', 12)}<span>Lista</span></button>
              </footer>
            </article>
          `;
        }).join('')}
        ${!state.inventory.length ? `<div class="empty"><p class="empty__title">Sem produtos</p><p class="empty__sub">Cadastre os produtos que você acompanha em casa</p></div>` : ''}
      </div>
    `;
  }

  function viewRecorrentes() {
    return subHeader(
      'Recorrentes',
      `${state.recurring.filter(r=>r.enabled).length} ativos · ${state.recurring.length} cadastrados`,
      `<button class="btn btn--primary btn--sm" data-act="open-rec-add">${icon('plus', 14, { sw: 2 })}<span>Novo</span></button>`
    ) + `

      <div class="rec-list">
        ${state.recurring.map((r) => `
          <article class="rec-row ${r.enabled ? '' : 'rec-row--off'}">
            <button class="check ${r.enabled ? 'check--done' : ''}" data-act="toggle-rec" data-id="${r.id}" aria-label="${r.enabled ? 'Pausar' : 'Ativar'}">
              <svg class="check__mark" width="15" height="15" stroke="#fff" stroke-width="2.4" fill="none"><use href="#ic-check"/></svg>
            </button>
            <div class="rec-row__body">
              <div class="rec-row__name">${escape(r.name)}</div>
              <div class="rec-row__meta">${escape(r.qty)} · a cada ${r.cadenceDays} dias</div>
            </div>
            <button class="btn btn--ai btn--sm" data-act="apply-rec" data-id="${r.id}">${icon('plus', 12)}<span>Adicionar agora</span></button>
            <button class="icon-btn" data-act="remove-rec" data-id="${r.id}" aria-label="Remover">${icon('x', 14)}</button>
          </article>
        `).join('')}
        ${!state.recurring.length ? `<div class="empty"><p class="empty__title">Sem rotinas</p><p class="empty__sub">Cadastre o que vocês compram com frequência</p></div>` : ''}
      </div>
    `;
  }

  function viewSugestoes() {
    const list = getSuggestions();
    return subHeader(
      'Sugestões IA',
      `${list.length} ${list.length === 1 ? 'sugestão' : 'sugestões'} · cadência + previsão de fim`
    ) + `

      <div class="sug-grid">
        ${list.length ? list.map((p, i) => `
          <article class="sug-card sug-card--${p.kind}">
            <header class="sug-card__head">
              ${icon('sparkle', 14, { fill: 'currentColor', stroke: 'none' })}
              ${tag(p.kind === 'previsto' ? 'Previsão' : p.kind === 'esquecido' ? 'Esquecido' : p.kind === 'recorrente' ? 'Recorrente' : 'Estoque baixo', true)}
            </header>
            <h3 class="sug-card__title">${escape(p.title)}</h3>
            <p class="sug-card__body">${escape(p.sub || '')}</p>
            <footer class="sug-card__foot">
              <button class="btn btn--ai btn--sm" data-act="add-suggestion" data-name="${escape(p.inv?.name || p.rec?.name)}" data-qty="${escape(p.inv ? `1 ${p.inv.unit}` : (p.rec?.qty || '1 un'))}" data-ai="${escape(p.kind)}">${icon('plus', 12)}<span>Adicionar</span></button>
              <button class="btn btn--ghost btn--sm" data-act="search-online" data-q="${escape(p.inv?.name || p.rec?.name)}">${icon('search', 12)}<span>Buscar</span></button>
            </footer>
          </article>
        `).join('') : `<div class="empty"><p class="empty__title">Tudo em dia</p><p class="empty__sub">A IA não viu nada urgente no momento. Bom trabalho!</p></div>`}
      </div>
    `;
  }

  // ── Receitas (offline) ───────────────────────────────────────
  const RECIPES = [
    { id: 'feijoada', name: 'Feijoada', emoji: '🫘', servings: 6, ingredients: [
      { name: 'Feijão preto', qty: '500 g' },
      { name: 'Linguiça calabresa', qty: '300 g' },
      { name: 'Bacon', qty: '200 g' },
      { name: 'Costela de porco', qty: '500 g' },
      { name: 'Cebola', qty: '2 un' },
      { name: 'Alho', qty: '4 dentes' },
      { name: 'Folha de louro', qty: '2 un' },
      { name: 'Arroz branco', qty: '500 g' },
      { name: 'Couve', qty: '1 maço' },
      { name: 'Laranja', qty: '4 un' },
    ]},
    { id: 'lasanha', name: 'Lasanha à bolonhesa', emoji: '🍝', servings: 6, ingredients: [
      { name: 'Massa de lasanha', qty: '500 g' },
      { name: 'Carne moída', qty: '500 g' },
      { name: 'Molho de tomate', qty: '500 g' },
      { name: 'Mussarela', qty: '300 g' },
      { name: 'Presunto', qty: '300 g' },
      { name: 'Cebola', qty: '1 un' },
      { name: 'Alho', qty: '3 dentes' },
      { name: 'Manjericão', qty: '1 maço' },
      { name: 'Parmesão ralado', qty: '100 g' },
    ]},
    { id: 'tacos', name: 'Tacos mexicanos', emoji: '🌮', servings: 4, ingredients: [
      { name: 'Tortilhas de milho', qty: '12 un' },
      { name: 'Carne moída', qty: '500 g' },
      { name: 'Queijo cheddar', qty: '200 g' },
      { name: 'Tomate', qty: '4 un' },
      { name: 'Cebola roxa', qty: '1 un' },
      { name: 'Limão', qty: '2 un' },
      { name: 'Coentro', qty: '1 maço' },
      { name: 'Pimenta jalapeño', qty: '2 un' },
      { name: 'Creme azedo', qty: '200 g' },
    ]},
    { id: 'estrogonofe', name: 'Estrogonofe de frango', emoji: '🍗', servings: 4, ingredients: [
      { name: 'Peito de frango', qty: '600 g' },
      { name: 'Creme de leite', qty: '200 g' },
      { name: 'Extrato de tomate', qty: '100 g' },
      { name: 'Cebola', qty: '1 un' },
      { name: 'Alho', qty: '2 dentes' },
      { name: 'Champignon', qty: '200 g' },
      { name: 'Mostarda', qty: '1 colher' },
      { name: 'Arroz branco', qty: '500 g' },
      { name: 'Batata palha', qty: '100 g' },
    ]},
    { id: 'salada-caesar', name: 'Salada Caesar', emoji: '🥗', servings: 2, ingredients: [
      { name: 'Alface americana', qty: '1 un' },
      { name: 'Peito de frango', qty: '300 g' },
      { name: 'Pão de forma', qty: '4 fatias' },
      { name: 'Parmesão ralado', qty: '50 g' },
      { name: 'Limão', qty: '1 un' },
      { name: 'Mostarda dijon', qty: '1 colher' },
      { name: 'Anchovas', qty: '4 un' },
      { name: 'Alho', qty: '2 dentes' },
    ]},
    { id: 'omelete', name: 'Omelete simples', emoji: '🍳', servings: 1, ingredients: [
      { name: 'Ovos', qty: '3 un' },
      { name: 'Queijo', qty: '50 g' },
      { name: 'Cebolinha', qty: '1 maço' },
      { name: 'Manteiga', qty: '20 g' },
    ]},
    { id: 'cafe-manha', name: 'Café da manhã da família', emoji: '☕', servings: 4, ingredients: [
      { name: 'Pão francês', qty: '8 un' },
      { name: 'Manteiga', qty: '200 g' },
      { name: 'Queijo branco', qty: '300 g' },
      { name: 'Presunto', qty: '200 g' },
      { name: 'Frutas', qty: '500 g' },
      { name: 'Café', qty: '500 g' },
      { name: 'Leite', qty: '2 L' },
      { name: 'Suco de laranja', qty: '1 L' },
    ]},
    { id: 'churrasco', name: 'Churrasco de família', emoji: '🥩', servings: 6, ingredients: [
      { name: 'Picanha', qty: '1.5 kg' },
      { name: 'Linguiça toscana', qty: '500 g' },
      { name: 'Sal grosso', qty: '500 g' },
      { name: 'Carvão', qty: '5 kg' },
      { name: 'Pão de alho', qty: '1 un' },
      { name: 'Cerveja', qty: '12 un' },
      { name: 'Refrigerante', qty: '2 L' },
      { name: 'Maionese', qty: '500 g' },
      { name: 'Vinagrete', qty: '500 g' },
    ]},
  ];

  function recipeMissing(recipe) {
    const stockNames = new Set(state.inventory.filter((i) => i.stock > 0.4).map((i) => i.name.toLowerCase()));
    const onListNames = new Set(state.items.filter((i) => !i.done).map((i) => i.name.toLowerCase()));
    return recipe.ingredients.filter((ing) => {
      const k = ing.name.toLowerCase();
      return !stockNames.has(k) && !onListNames.has(k);
    });
  }

  function sheetRecipes() {
    const sel = state.sheetData?.recipeId;
    const recipe = sel ? RECIPES.find((r) => r.id === sel) : null;

    if (recipe) {
      const missing = recipeMissing(recipe);
      const have = recipe.ingredients.length - missing.length;
      return sheetShell(`${recipe.emoji} ${recipe.name}`, `
        <div class="recipe-meta">
          <span class="status-pill">${recipe.servings} ${recipe.servings === 1 ? 'porção' : 'porções'}</span>
          <span class="status-pill ${missing.length === 0 ? 'status-pill--ok' : ''}">${have} de ${recipe.ingredients.length} no estoque</span>
        </div>
        <ul class="recipe-list">
          ${recipe.ingredients.map((ing) => {
            const k = ing.name.toLowerCase();
            const inStock = state.inventory.some((i) => i.name.toLowerCase() === k && i.stock > 0.4);
            const onList = state.items.some((i) => !i.done && i.name.toLowerCase() === k);
            const status = inStock ? 'estoque' : onList ? 'lista' : 'falta';
            return `
              <li class="recipe-item recipe-item--${status}">
                <span class="recipe-item__name">${escape(ing.name)}</span>
                <span class="recipe-item__qty">${escape(ing.qty)}</span>
                <span class="recipe-item__status">${status === 'estoque' ? '✓ tem' : status === 'lista' ? '↗ na lista' : '+ falta'}</span>
              </li>
            `;
          }).join('')}
        </ul>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="open-recipes">← Outras receitas</button>
          ${missing.length ? `<button type="button" class="btn btn--ai btn--lg" data-act="recipe-add" data-id="${recipe.id}">${icon('plus', 14)}<span>Adicionar ${missing.length} ${missing.length === 1 ? 'item' : 'itens'} à lista</span></button>` : `<span class="status-pill status-pill--ok">Tudo pronto ✓</span>`}
        </div>
      `);
    }

    return sheetShell('Receitas', `
      <p style="color:var(--ink-3);font-size:13.5px;margin:0 0 14px">Escolha uma receita. O HSH Mercado checa o estoque e adiciona o que falta na lista.</p>
      <div class="recipe-grid">
        ${RECIPES.map((r) => {
          const missing = recipeMissing(r);
          const have = r.ingredients.length - missing.length;
          return `
            <button class="recipe-card" data-act="open-recipe" data-id="${r.id}">
              <span class="recipe-card__emoji">${r.emoji}</span>
              <span class="recipe-card__t">${escape(r.name)}</span>
              <span class="recipe-card__s">${have}/${r.ingredients.length} no estoque · ${missing.length} ${missing.length === 1 ? 'falta' : 'faltam'}</span>
            </button>
          `;
        }).join('')}
      </div>
    `);
  }

  // ── Modo compras (full-screen, focado em riscar itens) ───────
  let _wakeLock = null;
  async function startShopping() {
    setState({ view: 'shopping' });
    try {
      if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* fallback silencioso */ }
    window.scrollTo(0, 0);
  }
  async function stopShopping() {
    setState({ view: 'lista' });
    try { await _wakeLock?.release?.(); } catch {} _wakeLock = null;
  }
  document.addEventListener('visibilitychange', async () => {
    if (state.view === 'shopping' && document.visibilityState === 'visible' && !_wakeLock && 'wakeLock' in navigator) {
      try { _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  });

  function viewShopping() {
    const pendentes = state.items.filter((i) => !i.done);
    const groups = groupByAisle(pendentes);
    const comprados = state.items.filter((i) => i.done);
    const total = state.items.length;
    const { total: estimativa, count: comPreco } = listTotal();

    return `
      <div class="shop">
        <header class="shop__hd">
          <button class="shop__back" data-act="exit-shopping" aria-label="Sair do modo compras">
            ${icon('x', 22, { sw: 1.8 })}
          </button>
          <div class="shop__title">
            <span class="shop__count">${pendentes.length}</span>
            <span class="shop__lbl">${pendentes.length === 1 ? 'restante' : 'restantes'}</span>
          </div>
          ${comPreco ? `<div class="shop__est">${fmtBRL(estimativa)}</div>` : ''}
        </header>

        ${pendentes.length === 0 ? `
          <div class="shop__done">
            <h2>Tudo na sacola ✓</h2>
            <p>${total} ${total === 1 ? 'item comprado' : 'itens comprados'}.</p>
            <button class="btn btn--ai btn--lg" data-act="exit-shopping">Sair</button>
          </div>
        ` : Object.entries(groups).map(([aid, list]) => `
          <section class="shop__grp">
            <h2 class="shop__h">${AISLE_LABELS[aid] || 'Outros'}</h2>
            ${list.map((it) => {
              const p = getPrice(it.name);
              return `
              <button class="shop__row" data-act="toggle" data-id="${it.id}">
                <span class="shop__check"></span>
                ${it.photo ? `<img class="shop__photo" src="${it.photo}" alt="" />` : ''}
                <span class="shop__row-body">
                  <span class="shop__row-name">${escape(it.name)}</span>
                  <span class="shop__row-meta">${escape(it.qty)}${p ? ` · ${fmtBRL(p.price)}` : ''}</span>
                </span>
              </button>
            `;}).join('')}
          </section>
        `).join('')}

        ${comprados.length ? `
          <details class="shop__bought">
            <summary>${comprados.length} ${comprados.length === 1 ? 'comprado' : 'comprados'}</summary>
            ${comprados.map((it) => `
              <button class="shop__row shop__row--done" data-act="toggle" data-id="${it.id}">
                <span class="shop__check shop__check--on">${icon('check', 16, { stroke: '#fff', sw: 2.6 })}</span>
                <span class="shop__row-body">
                  <span class="shop__row-name">${escape(it.name)}</span>
                  <span class="shop__row-meta">${escape(it.qty)}</span>
                </span>
              </button>
            `).join('')}
          </details>
        ` : ''}
      </div>
    `;
  }

  function viewFamilia() {
    return subHeader(
      'Família',
      `${state.family.length} ${state.family.length === 1 ? 'pessoa' : 'pessoas'} · cada item registra quem adicionou`,
      `<button class="btn btn--primary btn--sm" data-act="open-fam-add">${icon('plus', 14, { sw: 2 })}<span>Nova</span></button>`
    ) + `

      <div class="fam-grid">
        ${state.family.map((f) => `
          <article class="fam-card ${state.currentUser === f.id ? 'fam-card--current' : ''}">
            <span class="avatar" style="width:64px;height:64px;font-size:30px;background:linear-gradient(135deg, ${f.c1}, ${f.c2})">${escape(f.name.charAt(0).toUpperCase())}</span>
            <div class="fam-card__body">
              <h3 class="fam-card__name">${escape(f.name)}</h3>
              <p class="fam-card__meta">${state.items.filter(i=>i.by===f.id).length} itens · ${state.history.filter(h=>h.byId===f.id && h.action==='bought').length} comprados</p>
            </div>
            <div class="fam-card__actions">
              ${state.currentUser !== f.id
                ? `<button class="btn btn--ghost btn--sm" data-act="select-user" data-id="${f.id}">${f.pinHash ? '🔒 Entrar' : 'Sou eu'}</button>`
                : `<span class="tag tag--ai">você</span>`}
              <button class="icon-btn" data-act="set-pin" data-id="${f.id}" aria-label="${f.pinHash ? 'Trocar PIN' : 'Definir PIN'}" title="${f.pinHash ? 'Trocar PIN' : 'Definir PIN'}">${f.pinHash ? '🔒' : '🔓'}</button>
              ${state.family.length > 1 ? `<button class="icon-btn" data-act="remove-fam" data-id="${f.id}" aria-label="Remover">${icon('x', 14)}</button>` : ''}
            </div>
          </article>
        `).join('')}
      </div>

      <section class="card" style="padding:18px;margin-top:18px">
        <h3 style="font-family:var(--font-display);font-size:24px;margin:0 0 8px">Sobre o app</h3>
        <p style="color:var(--ink-2);margin:0 0 12px;line-height:1.5">
          O HSH Mercado funciona <strong>offline</strong>: tudo o que você adiciona fica salvo no dispositivo e
          sincroniza entre as abas abertas pelo BroadcastChannel. Para sincronizar entre dispositivos diferentes,
          é preciso conectar a uma conta na nuvem (próximo passo).
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <span class="status-pill ${state.online ? 'status-pill--ok' : 'status-pill--off'}">${state.online ? '● Online' : '◌ Offline'}</span>
          <span class="status-pill">${state.items.length} itens · ${state.inventory.length} estoque</span>
          <span class="status-pill">${state.history.length} no histórico</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn--ghost btn--sm" data-act="export-json">${icon('arrow-r', 12)}<span>Backup (JSON)</span></button>
          <button class="btn btn--ghost btn--sm" data-act="wipe-all">${icon('x', 12)}<span>Limpar tudo</span></button>
          <a class="btn btn--ghost btn--sm" href="canvas.html" target="_blank" rel="noopener">${icon('chevron', 12)}<span>Ver design canvas</span></a>
        </div>
      </section>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 14. Sheets (modais)
  // ────────────────────────────────────────────────────────────
  function sheetAdd() {
    const tab = state.sheetData?.tab || 'voz';
    const presets = ['Leite', 'Pão', 'Banana', 'Ovos', 'Café', 'Arroz', 'Feijão', 'Detergente', 'Sabonete', 'Iogurte', 'Cebola', 'Tomate'];
    return sheetShell('Adicionar item', `
      <nav class="sheet-tabs">
        <button class="sheet-tab ${tab==='voz'?'sheet-tab--active':''}" data-act="add-tab" data-tab="voz">${icon('mic', 14, { fill: 'currentColor', stroke: 'currentColor' })}<span>Voz</span></button>
        <button class="sheet-tab ${tab==='texto'?'sheet-tab--active':''}" data-act="add-tab" data-tab="texto">${icon('plus', 14)}<span>Texto</span></button>
        <button class="sheet-tab ${tab==='camera'?'sheet-tab--active':''}" data-act="add-tab" data-tab="camera">${icon('barcode', 14)}<span>Código</span></button>
        <button class="sheet-tab ${tab==='cupom'?'sheet-tab--active':''}" data-act="add-tab" data-tab="cupom">${icon('receipt', 14)}<span>Cupom</span></button>
        <button class="sheet-tab ${tab==='rapido'?'sheet-tab--active':''}" data-act="add-tab" data-tab="rapido">${icon('routines', 14)}<span>Rápido</span></button>
      </nav>

      ${tab === 'voz' ? `
        <div class="add-voice">
          <div class="mic-hero ${state.voice.listening ? 'mic-hero--active' : ''}" style="width:140px;height:140px">
            <div class="mic-hero__ring-outer"></div>
            <div class="mic-hero__ring"></div>
            <div class="mic-hero__core">
              <svg width="53" height="53" stroke="#fff" stroke-width="1.4" fill="#fff"><use href="#ic-mic"/></svg>
            </div>
          </div>
          <div class="voice-state">
            ${state.voice.listening ? tag('● Ouvindo · toque para parar', true) : tag('Toque para falar')}
          </div>
          <button class="btn btn--ai btn--lg" data-act="voice-toggle">
            ${state.voice.listening ? `${icon('x', 14)}<span>Parar</span>` : `${icon('mic', 14, { fill: 'currentColor', stroke: 'currentColor' })}<span>Começar a falar</span>`}
          </button>
          <p class="voice-hint">Diga "adicionar leite, pão e 2 kg de arroz" — a IA separa em itens.</p>
          <div class="heard">
            <span class="tag">Ouvido</span>
            <p class="heard__quote">${state.voice.transcript || state.voice.interim ? escape(state.voice.transcript) + (state.voice.interim ? ` <em style="color:var(--ink-3)">${escape(state.voice.interim)}</em>` : '') : '<span style="color:var(--ink-4)">Aguardando você falar...</span>'}</p>
          </div>
          ${state.voice.transcript ? (() => {
            const parsed = parseInput(state.voice.transcript);
            return `<div class="parsed-card">
              <header class="parsed-card__head">
                <span class="parsed-card__head-left">
                  ${icon('sparkle', 14, { fill: 'currentColor', stroke: 'none' })}
                  ${tag(`Detectados · ${parsed.length} ${parsed.length === 1 ? 'item' : 'itens'}`, true)}
                </span>
                <button class="link-btn" data-act="voice-clear">Limpar</button>
              </header>
              <div class="parsed-chips">
                ${parsed.map((p) => `<span class="chip"><span class="chip__name">${escape(p.name)}</span><span class="chip__qty">${escape(p.qty)}</span>${icon('sparkle', 11, { fill: 'currentColor', stroke: 'none' })}</span>`).join('')}
              </div>
              <footer class="parsed-card__foot">
                <button class="btn btn--ai btn--lg" data-act="voice-confirm" data-payload="${escape(JSON.stringify(parsed))}">
                  ${icon('check', 14)}<span>Adicionar todos (${parsed.length})</span>
                </button>
              </footer>
            </div>`;
          })() : ''}
        </div>
      ` : tab === 'texto' ? `
        <form class="add-form" data-form="text">
          <label class="field">
            <span class="field__label">Item</span>
            <input class="field__input" name="text" placeholder="Ex.: 2 leites, 1 kg de arroz, banana" autofocus required />
          </label>
          <p class="field__hint">Separe vários itens com vírgula ou “e”. A IA detecta quantidade e categoria.</p>
          <div class="form-actions">
            <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
            <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Adicionar</span></button>
          </div>
        </form>
      ` : tab === 'camera' ? `
        <div class="add-camera">
          <div class="cam-stage">
            <video id="cam-video" autoplay playsinline muted></video>
            <div class="cam-overlay">
              <div class="cam-frame"></div>
              <div class="cam-line"></div>
            </div>
          </div>
          <p class="voice-hint">Aponte para o código de barras. Reconhecemos EAN-13, UPC e QR. ${'BarcodeDetector' in window ? '' : '<br>(Usando ZXing — pode demorar mais.)'}</p>
          <div class="form-actions">
            <button type="button" class="btn btn--ghost" data-act="close-sheet">Fechar</button>
            <button type="button" class="btn btn--ghost" data-act="cam-manual">Não tenho código → digitar</button>
          </div>
        </div>
      ` : tab === 'cupom' ? (() => {
        const ocr = state.sheetData?.ocr || {};
        const items = ocr.items || [];
        return `
        <div class="add-receipt">
          ${!ocr.imageUrl && !ocr.busy ? `
            <label class="receipt-drop">
              ${icon('receipt', 28)}
              <span class="receipt-drop__t">Tirar foto / escolher</span>
              <span class="receipt-drop__s">Funciona com cupom fiscal, nota, foto da geladeira</span>
              <input type="file" accept="image/*" capture="environment" data-input="receipt-file" hidden />
            </label>
          ` : ''}
          ${ocr.imageUrl ? `<img class="receipt-preview" src="${ocr.imageUrl}" alt="Cupom" />` : ''}
          ${ocr.busy ? `
            <div class="receipt-progress">
              <div class="receipt-progress__bar"><div class="receipt-progress__fill" style="width:${ocr.progress || 0}%"></div></div>
              <span>Lendo cupom… ${ocr.progress || 0}%</span>
            </div>
          ` : ''}
          ${items.length ? `
            <p class="voice-hint">${items.length} ${items.length === 1 ? 'item detectado' : 'itens detectados'}. Desmarque o que não quiser.</p>
            <ul class="receipt-items">
              ${items.map((it, idx) => `
                <li class="receipt-item">
                  <input type="checkbox" id="rcpt-${idx}" data-act="receipt-toggle" data-idx="${idx}" ${it.skip ? '' : 'checked'} />
                  <label for="rcpt-${idx}">
                    <span class="receipt-item__name">${escape(it.name)}</span>
                    ${it.price ? `<span class="receipt-item__price">${fmtBRL(it.price)}</span>` : ''}
                  </label>
                </li>
              `).join('')}
            </ul>
            <div class="form-actions">
              <button type="button" class="btn btn--ghost" data-act="receipt-reset">Recomeçar</button>
              <button type="button" class="btn btn--ai btn--lg" data-act="receipt-confirm">${icon('check', 14)}<span>Adicionar ${items.filter((it) => !it.skip).length} itens</span></button>
            </div>
          ` : (ocr.imageUrl && !ocr.busy && !items.length ? `
            <p class="voice-hint">Não consegui ler nenhum item. Tente uma foto mais nítida.</p>
            <div class="form-actions"><button type="button" class="btn btn--ghost" data-act="receipt-reset">Recomeçar</button></div>
          ` : '')}
        </div>
        `;
      })() : `
        <div class="add-quick">
          <p class="voice-hint" style="margin:0 0 12px">Itens que costumam aparecer na sua casa.</p>
          <div class="presets">
            ${presets.map((p) => `<button class="preset" data-act="add-preset" data-name="${escape(p)}">${escape(p)}</button>`).join('')}
          </div>
          <hr class="hr" style="margin:16px 0" />
          <h4 style="margin:0 0 8px;font-family:var(--font-display);font-size:20px">Histórico recente</h4>
          <div class="presets">
            ${[...new Set(state.history.filter(h=>h.action==='added').slice(-30).map(h=>h.name))].slice(0, 18).map((n) => `<button class="preset" data-act="add-preset" data-name="${escape(n)}">${escape(n)}</button>`).join('') || '<p style="color:var(--ink-3);font-size:13px">Nenhum item recente ainda.</p>'}
          </div>
        </div>
      `}
    `);
  }

  function sheetEdit() {
    const id = state.sheetData?.id;
    const it = state.items.find((x) => x.id === id);
    if (!it) return sheetShell('Item não encontrado', '<p>Esse item já foi removido.</p>');
    return sheetShell('Editar item', `
      <form class="add-form" data-form="edit" data-id="${it.id}">
        <div class="edit-photo-row">
          ${it.photo ? `
            <img class="edit-photo" src="${it.photo}" alt="${escape(it.name)}" />
            <div class="edit-photo-actions">
              <label class="btn btn--ghost btn--sm">
                ${icon('image', 13)}<span>Trocar</span>
                <input type="file" accept="image/*" capture="environment" data-input="item-photo" data-id="${it.id}" hidden />
              </label>
              <button type="button" class="btn btn--ghost btn--sm" data-act="remove-photo" data-id="${it.id}">${icon('x', 13)}<span>Remover foto</span></button>
            </div>
          ` : `
            <label class="edit-photo-empty">
              ${icon('image', 22)}
              <span>Adicionar foto</span>
              <input type="file" accept="image/*" capture="environment" data-input="item-photo" data-id="${it.id}" hidden />
            </label>
          `}
        </div>
        <label class="field"><span class="field__label">Nome</span>
          <input class="field__input" name="name" value="${escape(it.name)}" required />
        </label>
        <label class="field"><span class="field__label">Quantidade</span>
          <input class="field__input" name="qty" value="${escape(it.qty)}" />
        </label>
        <label class="field"><span class="field__label">Setor</span>
          <select class="field__input" name="aisle">
            ${Object.entries(AISLE_LABELS).map(([id, label]) => `<option value="${id}" ${it.aisle === id ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span class="field__label">Quem adicionou</span>
          <select class="field__input" name="by">
            ${state.family.map((f) => `<option value="${f.id}" ${it.by === f.id ? 'selected' : ''}>${escape(f.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span class="field__label">Observação</span>
          <input class="field__input" name="note" value="${escape(it.note || '')}" placeholder="Opcional" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="remove-item" data-id="${it.id}">${icon('x', 13)}<span>Remover</span></button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('check', 13)}<span>Salvar</span></button>
        </div>
      </form>
    `);
  }

  function sheetExport() {
    return sheetShell('Exportar &amp; Compartilhar', `
      <div class="export-grid">
        <button class="export-card" data-act="export-share">${icon('arrow-r', 22)}<span class="export-card__t">Compartilhar</span><span class="export-card__s">WhatsApp, e-mail, etc.</span></button>
        <button class="export-card" data-act="export-copy">${icon('plus', 22)}<span class="export-card__t">Copiar lista</span><span class="export-card__s">Texto formatado</span></button>
        <button class="export-card" data-act="export-print">${icon('receipt', 22)}<span class="export-card__t">Imprimir</span><span class="export-card__s">PDF / papel</span></button>
        <button class="export-card" data-act="export-txt">${icon('receipt', 22)}<span class="export-card__t">.TXT</span><span class="export-card__s">Texto puro</span></button>
        <button class="export-card" data-act="export-csv">${icon('inventory', 22)}<span class="export-card__t">.CSV</span><span class="export-card__s">Planilha</span></button>
        <button class="export-card" data-act="export-json">${icon('inventory', 22)}<span class="export-card__t">.JSON</span><span class="export-card__s">Backup completo</span></button>
      </div>

      <div class="export-section">
        <h4>Buscar online</h4>
        <p style="color:var(--ink-3);font-size:13px;margin:0 0 10px">Abre os itens da lista nos buscadores em uma nova aba.</p>
        <div class="export-grid export-grid--small">
          <button class="export-card" data-act="search-list" data-prov="ml">Mercado Livre</button>
          <button class="export-card" data-act="search-list" data-prov="amazon">Amazon</button>
          <button class="export-card" data-act="search-list" data-prov="google">Google Shopping</button>
          <button class="export-card" data-act="search-list" data-prov="ifood">iFood</button>
        </div>
      </div>

      <pre class="export-preview">${escape(listAsText())}</pre>
    `);
  }

  function sheetFamily() {
    return sheetShell('Quem é você?', `
      <div class="user-grid">
        ${state.family.map((f) => `
          <button class="user-tile ${state.currentUser === f.id ? 'user-tile--active' : ''}" data-act="select-user" data-id="${f.id}">
            <span class="avatar" style="width:48px;height:48px;font-size:22px;background:linear-gradient(135deg, ${f.c1}, ${f.c2})">${escape(f.name.charAt(0).toUpperCase())}</span>
            <span class="user-tile__name">${escape(f.name)}${f.pinHash ? ' 🔒' : ''}</span>
          </button>
        `).join('')}
      </div>
      <form data-form="add-family" class="add-form" style="margin-top:18px">
        <label class="field"><span class="field__label">Adicionar nova pessoa</span>
          <input class="field__input" name="name" placeholder="Nome" />
        </label>
        <label class="field"><span class="field__label">PIN (4 dígitos · opcional)</span>
          <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Adicionar</span></button>
        </div>
      </form>
    `);
  }

  function sheetPin() {
    const id = state.sheetData?.targetId;
    const f = state.family.find((x) => x.id === id);
    if (!f) return sheetShell('—', '');
    return sheetShell(`${f.name} · PIN`, `
      <div class="pin-screen">
        <span class="avatar" style="width:72px;height:72px;font-size:32px;background:linear-gradient(135deg, ${f.c1}, ${f.c2})">${escape(f.name.charAt(0).toUpperCase())}</span>
        <p style="text-align:center;color:var(--ink-2);margin:14px 0 6px">Digite o PIN de <strong>${escape(f.name)}</strong>:</p>
        <form data-form="pin-verify" data-id="${f.id}" class="add-form">
          <input class="field__input pin-input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autofocus autocomplete="off" placeholder="—" style="font-size:32px;text-align:center;letter-spacing:0.4em;font-family:var(--font-mono)" />
          ${state.sheetData?.error ? `<p style="color:var(--warn);font-size:13px;text-align:center;margin:0">PIN incorreto · tenta de novo</p>` : ''}
          <div class="form-actions">
            <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
            <button type="submit" class="btn btn--ai btn--lg">${icon('check', 14)}<span>Entrar</span></button>
          </div>
        </form>
      </div>
    `);
  }

  function sheetGroup() {
    const s = state.sync;
    if (s.spaceId) {
      // Tem grupo ativo — mostra code, status, opção de sair
      return sheetShell('Grupo da família', `
        <div class="group-current">
          <span class="tag tag--ai">Código de convite</span>
          <div class="group-code">${escape(s.spaceCode || '?')}</div>
          <p style="color:var(--ink-3);font-size:13px;margin:8px 0 16px">
            Compartilhe esse código com a família. Quem entrar vê e modifica a mesma lista,
            estoque, recorrentes e preços. Sync automático.
          </p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn--ghost btn--sm" data-act="copy-code" data-code="${escape(s.spaceCode || '')}">${icon('plus', 13)}<span>Copiar código</span></button>
            <button class="btn btn--ghost btn--sm" data-act="sync-pull-now">${icon('arrow-r', 13)}<span>Sincronizar agora</span></button>
          </div>
        </div>

        <div class="group-status">
          <div class="group-status__row">
            <span class="group-status__label">Estado</span>
            <span class="group-status__val">${
              s.status === 'syncing' ? '🔄 sincronizando…'
              : s.status === 'error'   ? '⚠️ ' + escape(s.lastError || 'erro')
              : state.online            ? '✅ sincronizado'
                                        : '◌ offline'
            }</span>
          </div>
          <div class="group-status__row">
            <span class="group-status__label">Último sync</span>
            <span class="group-status__val">${s.lastSyncAt ? fmtRel(s.lastSyncAt) : 'nunca'}</span>
          </div>
          <div class="group-status__row">
            <span class="group-status__label">Fila offline</span>
            <span class="group-status__val">${s.queueLen} ${s.queueLen === 1 ? 'mudança' : 'mudanças'} pendentes</span>
          </div>
        </div>

        <div class="form-actions" style="margin-top:18px">
          <button type="button" class="btn btn--ghost" data-act="leave-group">${icon('x', 13)}<span>Sair do grupo (mantém dados local)</span></button>
        </div>
      `);
    }
    // Sem grupo — opção criar / entrar
    return sheetShell('Grupo da família', `
      <p style="color:var(--ink-2);font-size:14px;margin:0 0 18px;line-height:1.5">
        Crie um grupo pra sincronizar lista, estoque, perfis e preços entre todos
        os dispositivos da família em tempo real.
      </p>

      <form data-form="create-group" class="add-form">
        <span class="field__label">Criar novo grupo</span>
        <label class="field"><span class="field__label">Nome do grupo</span>
          <input class="field__input" name="name" required placeholder="Ex.: Casa Lemos" />
        </label>
        <label class="field"><span class="field__label">PIN do grupo (4 dígitos · opcional)</span>
          <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
          <span class="field__hint">Quem entrar precisa digitar esse PIN. Sem PIN, basta o código.</span>
        </label>
        <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Criar grupo</span></button>
      </form>

      <div class="form-divider">ou</div>

      <form data-form="join-group" class="add-form">
        <span class="field__label">Entrar em grupo existente</span>
        <label class="field"><span class="field__label">Código de convite</span>
          <input class="field__input" name="code" required placeholder="ABCD-1234" autocomplete="off" maxlength="9" />
        </label>
        <label class="field"><span class="field__label">PIN do grupo (se tiver)</span>
          <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
        </label>
        <button type="submit" class="btn btn--ghost btn--lg">${icon('arrow-r', 14)}<span>Entrar</span></button>
      </form>
    `);
  }

  function sheetEditPin() {
    const id = state.sheetData?.id;
    const f = state.family.find((x) => x.id === id);
    if (!f) return sheetShell('—', '');
    return sheetShell(`${f.pinHash ? 'Trocar' : 'Definir'} PIN · ${f.name}`, `
      <p style="color:var(--ink-2);font-size:14px;margin:0 0 14px">
        ${f.pinHash
          ? 'Digite o PIN atual e o novo. Pra remover o PIN, deixe o novo em branco.'
          : 'PIN protege a troca pra esse perfil (útil em dispositivo compartilhado).'}
      </p>
      <form data-form="edit-pin" data-id="${f.id}" class="add-form">
        ${f.pinHash ? `
          <label class="field"><span class="field__label">PIN atual</span>
            <input class="field__input" name="oldPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required />
          </label>
        ` : ''}
        <label class="field"><span class="field__label">Novo PIN (4 dígitos · vazio = remover)</span>
          <input class="field__input" name="newPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('check', 14)}<span>Salvar</span></button>
        </div>
      </form>
    `);
  }

  function sheetInventoryEdit() {
    const id = state.sheetData?.id;
    const inv = state.inventory.find((x) => x.id === id);
    if (!inv) return sheetShell('—', '');
    return sheetShell(`Editar estoque · ${inv.name}`, `
      <form data-form="edit-inv" data-id="${inv.id}" class="add-form">
        <label class="field"><span class="field__label">Estoque atual (0–100%)</span>
          <input class="field__input" type="range" name="stock" min="0" max="100" value="${Math.round(inv.stock * 100)}" />
          <output style="color:var(--ink-3);font-size:13px" data-bind="stock-out">${Math.round(inv.stock * 100)}%</output>
        </label>
        <label class="field"><span class="field__label">Cadência (dias entre compras)</span>
          <input class="field__input" type="number" name="cadenceDays" min="1" max="365" value="${inv.cadenceDays}" />
        </label>
        <label class="field"><span class="field__label">Unidade</span>
          <input class="field__input" name="unit" value="${escape(inv.unit || 'un')}" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="remove-inv" data-id="${inv.id}">${icon('x', 13)}<span>Remover</span></button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('check', 13)}<span>Salvar</span></button>
        </div>
      </form>
    `);
  }

  function sheetInventoryAdd() {
    return sheetShell('Cadastrar produto no estoque', `
      <form data-form="add-inv" class="add-form">
        <label class="field"><span class="field__label">Nome</span>
          <input class="field__input" name="name" required autofocus />
        </label>
        <label class="field"><span class="field__label">Estoque inicial (%)</span>
          <input class="field__input" type="number" name="stock" min="0" max="100" value="100" />
        </label>
        <label class="field"><span class="field__label">Unidade</span>
          <input class="field__input" name="unit" value="un" />
        </label>
        <label class="field"><span class="field__label">Cadência (dias)</span>
          <input class="field__input" type="number" name="cadenceDays" min="1" value="14" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Cadastrar</span></button>
        </div>
      </form>
    `);
  }

  function sheetRecAdd() {
    return sheetShell('Nova rotina recorrente', `
      <form data-form="add-rec" class="add-form">
        <label class="field"><span class="field__label">Nome</span>
          <input class="field__input" name="name" required autofocus />
        </label>
        <label class="field"><span class="field__label">Quantidade</span>
          <input class="field__input" name="qty" placeholder="Ex.: 2 L" value="1 un" />
        </label>
        <label class="field"><span class="field__label">A cada (dias)</span>
          <input class="field__input" type="number" name="cadenceDays" min="1" value="7" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Criar</span></button>
        </div>
      </form>
    `);
  }

  function sheetFamAdd() {
    return sheetShell('Nova pessoa na família', `
      <form data-form="add-family" class="add-form">
        <label class="field"><span class="field__label">Nome</span>
          <input class="field__input" name="name" required autofocus />
        </label>
        <label class="field"><span class="field__label">PIN (4 dígitos · opcional)</span>
          <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
          <span class="field__hint">Útil em dispositivo compartilhado (iPad da cozinha). Sem PIN, troca livre.</span>
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>
          <button type="submit" class="btn btn--ai btn--lg">${icon('plus', 14)}<span>Adicionar</span></button>
        </div>
      </form>
    `);
  }

  // ── Tela de boas-vindas (sem perfis cadastrados) ─────────────
  function viewWelcome() {
    const hasFamily = state.family.length > 0;
    const hasGroup = !!state.sync.spaceId;
    return `
      <div class="welcome">
        <div class="welcome__brand">
          <h1 class="welcome__title">HSH Mercado<span class="welcome__dot">.</span></h1>
        </div>
        <p class="welcome__lead">${hasFamily
          ? 'Quem está usando agora?'
          : 'Lista de compras da família — sincroniza entre dispositivos, voz, câmera, estoque, IA preditiva.'}</p>

        ${!hasFamily && !hasGroup ? `
          <div class="welcome__join">
            <span class="welcome__join-or">Já tem grupo? Entre com o código:</span>
            <form class="welcome__join-form" data-form="join-group">
              <input class="field__input welcome__code-input" name="code" placeholder="ABCD-1234" maxlength="9" autocomplete="off" />
              <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="PIN" style="width:90px" />
              <button type="submit" class="btn btn--ghost">Entrar</button>
            </form>
          </div>
        ` : ''}

        ${hasFamily ? `
          <div class="welcome__profiles">
            ${state.family.map((f) => `
              <button class="profile-tile" data-act="select-user" data-id="${f.id}">
                <span class="avatar profile-tile__avatar" style="background:linear-gradient(135deg, ${f.c1}, ${f.c2})">${escape(f.name.charAt(0).toUpperCase())}</span>
                <span class="profile-tile__body">
                  <span class="profile-tile__name">${escape(f.name)}</span>
                  <span class="profile-tile__meta">${f.pinHash ? '🔒 PIN protegido' : 'Entrar'}</span>
                </span>
                ${icon('chevron', 14)}
              </button>
            `).join('')}
          </div>

          <details class="welcome__new">
            <summary>+ Adicionar nova pessoa</summary>
            <form class="welcome__form" data-form="onboard" style="margin-top:12px">
              <label class="field">
                <span class="field__label">Nome</span>
                <input class="field__input welcome__input" name="name" required autocomplete="given-name" placeholder="Nome da nova pessoa" />
              </label>
              <label class="field">
                <span class="field__label">PIN (4 dígitos · opcional)</span>
                <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
              </label>
              <button type="submit" class="btn btn--ai btn--lg welcome__cta">${icon('plus', 16, { sw: 2 })}<span>Criar e entrar</span></button>
            </form>
          </details>
        ` : `
          <form class="welcome__form" data-form="onboard">
            <label class="field">
              <span class="field__label">Como vamos te chamar?</span>
              <input class="field__input welcome__input" name="name" required autofocus autocomplete="given-name" placeholder="Seu nome" />
            </label>
            <label class="field">
              <span class="field__label">PIN (4 dígitos · opcional)</span>
              <input class="field__input" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="—" />
              <span class="field__hint">Em dispositivo compartilhado (iPad da cozinha), o PIN evita troca acidental de perfil. Pula se for celular pessoal.</span>
            </label>
            <button type="submit" class="btn btn--ai btn--lg welcome__cta">${icon('arrow-r', 16, { sw: 2 })}<span>Começar</span></button>
          </form>

          <div class="welcome__alt">
            <button class="link-btn" data-act="load-demo">Carregar dados de exemplo →</button>
          </div>
        `}
      </div>
    `;
  }

  function sheetPrice() {
    const id = state.sheetData?.id;
    const it = state.items.find((x) => x.id === id);
    if (!it) return sheetShell('—', '<p>Item não encontrado.</p>');
    const p = getPrice(it.name);
    const enc = encodeURIComponent(it.name);
    const subtotal = p ? p.price * parseQtyNum(it.qty) : null;

    return sheetShell(`Preço · ${escape(it.name)}`, `
      ${p ? `
        <div class="price-current">
          <div class="price-current__row">
            <span class="price-current__label">Preço de referência</span>
            <span class="price-current__amount">${fmtBRL(p.price)}</span>
          </div>
          ${parseQtyNum(it.qty) > 1 ? `
            <div class="price-current__row">
              <span class="price-current__label">${escape(it.qty)} ×</span>
              <span class="price-current__sub">= ${fmtBRL(subtotal)}</span>
            </div>
          ` : ''}
          <div class="price-current__meta">
            <span class="status-pill">${escape(sourceLabel(p.source))}</span>
            <span style="font-size:12px;color:var(--ink-3)">salvo ${fmtRel(p.fetchedAt)}</span>
            ${p.link ? `<a class="link-btn" href="${escape(p.link)}" target="_blank" rel="noopener">Ver oferta original →</a>` : ''}
          </div>
        </div>
      ` : `
        <div class="price-empty">
          <p style="margin:0;color:var(--ink-2);font-size:14px;line-height:1.5">
            Sem preço definido para <strong>${escape(it.name)}</strong>.
            Use os links abaixo pra ver preços atuais ou digite manualmente.
          </p>
        </div>
      `}

      <section class="price-section">
        <h4 class="price-section__h">Buscar preço atual</h4>
        <div class="price-search-grid">
          <a class="price-search price-search--ml" href="https://lista.mercadolivre.com.br/${enc}" target="_blank" rel="noopener">
            <span class="price-search__brand">ML</span>
            <span>Mercado Livre</span>
          </a>
          <a class="price-search price-search--amz" href="https://www.amazon.com.br/s?k=${enc}" target="_blank" rel="noopener">
            <span class="price-search__brand">a</span>
            <span>Amazon</span>
          </a>
          <a class="price-search price-search--g" href="https://www.google.com/search?tbm=shop&q=${enc}" target="_blank" rel="noopener">
            <span class="price-search__brand">G</span>
            <span>Google Shopping</span>
          </a>
          <a class="price-search" href="https://www.zoom.com.br/search?q=${enc}" target="_blank" rel="noopener">
            <span class="price-search__brand">Z</span>
            <span>Zoom</span>
          </a>
        </div>
        <p class="price-hint">Os links abrem em outra aba. Volte aqui e cole o preço encontrado.</p>
      </section>

      <form class="add-form price-form" data-form="set-price" data-id="${it.id}">
        <h4 class="price-section__h">${p ? 'Atualizar' : 'Definir'} preço de referência</h4>
        <div class="price-input-row">
          <span class="price-input-prefix">R$</span>
          <input class="field__input price-input" type="text" inputmode="decimal" name="price"
                 placeholder="0,00"
                 value="${p ? p.price.toFixed(2).replace('.', ',') : ''}" autofocus />
          <select class="field__input price-source" name="source">
            <option value="manual" ${(!p || p.source === 'manual') ? 'selected' : ''}>Manual</option>
            <option value="ml"     ${p?.source === 'ml' ? 'selected' : ''}>Mercado Livre</option>
            <option value="amazon" ${p?.source === 'amazon' ? 'selected' : ''}>Amazon</option>
            <option value="google" ${p?.source === 'google' ? 'selected' : ''}>Google Shopping</option>
          </select>
        </div>
        <input type="hidden" name="name" value="${escape(it.name)}" />
        <p class="field__hint">A estimativa total da lista usa este preço × ${escape(it.qty)}.</p>
        <div class="form-actions">
          ${p ? `<button type="button" class="btn btn--ghost" data-act="clear-price" data-name="${escape(it.name)}">${icon('x', 13)}<span>Remover preço</span></button>` : `<button type="button" class="btn btn--ghost" data-act="close-sheet">Cancelar</button>`}
          <button type="submit" class="btn btn--ai btn--lg">${icon('check', 13)}<span>Salvar</span></button>
        </div>
      </form>
    `);
  }

  function sheetMenu() {
    const sugCount = getSuggestions().length;
    const recAtivos = state.recurring.filter((r) => r.enabled).length;
    const lowStock = state.inventory.filter((i) => i.stock < 0.3).length;

    const item = (act, val, ico, t, sub, badge) => `
      <button class="menu-item" data-act="${act}" ${val ? `data-val="${val}"` : ''}>
        <span class="menu-item__ic">${icon(ico, 18, ico === 'sparkle' ? { fill: 'currentColor', stroke: 'none' } : undefined)}</span>
        <span class="menu-item__body">
          <span class="menu-item__t">${t}</span>
          ${sub ? `<span class="menu-item__s">${sub}</span>` : ''}
        </span>
        ${badge ? `<span class="menu-item__badge">${badge}</span>` : ''}
        ${icon('chevron', 14)}
      </button>
    `;

    const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    return sheetShell('Mais', `
      <div class="menu-list">
        ${item('start-shopping', null, 'bag',       'Modo compras',       'Tela cheia com botões grandes')}
        ${item('view', 'estoque',     'inventory', 'Estoque da casa',   `${state.inventory.length} produtos · IA preditiva`, lowStock ? `${lowStock} baixos` : '')}
        ${item('view', 'recorrentes', 'routines',  'Recorrentes',       `${recAtivos} ${recAtivos === 1 ? 'ativo' : 'ativos'}`)}
        ${item('view', 'sugestoes',   'sparkle',   'Sugestões da IA',   sugCount ? `${sugCount} agora` : 'Tudo em dia', sugCount ? '✨' : '')}
        ${item('open-recipes', null, 'routines',  'Receitas',           'Adicionar ingredientes faltantes')}
        ${item('view', 'familia',     'voice',     'Família',           `${state.family.length} ${state.family.length === 1 ? 'pessoa' : 'pessoas'}`)}
      </div>

      <div class="menu-list" style="margin-top:14px">
        ${item('open-group', null, 'voice', state.sync.spaceId ? `Grupo · ${escape(state.sync.spaceCode || '')}` : 'Conectar grupo da família',
          state.sync.spaceId
            ? (state.sync.status === 'syncing' ? '🔄 sincronizando…' : state.online ? `✅ ${state.sync.queueLen ? state.sync.queueLen + ' pendentes' : 'em sincronia'}` : '◌ offline')
            : 'Sincronizar entre dispositivos')}
        ${item('toggle-theme',   null, 'sun',     `Tema ${state.theme === 'dark' ? 'escuro' : state.theme === 'light' ? 'claro' : 'automático'}`, 'Toque para alternar')}
        ${state.notifPerm !== 'granted' ? item('enable-notifs', null, 'sparkle', 'Ativar notificações', 'Avisar quando algo acabar') : item('test-notif', null, 'sparkle', 'Notificações ativadas ✓', 'Tocar pra testar')}
        ${!isStandalone && state.canInstall ? item('install-pwa', null, 'arrow-r', 'Instalar app', 'Adiciona à tela de início') : ''}
        ${!isStandalone && !state.canInstall ? item('install-pwa', null, 'arrow-r', 'Instalar app', 'Como instalar no seu navegador') : ''}
      </div>

      <div class="menu-list" style="margin-top:14px">
        ${item('open-export', null, 'arrow-r', 'Exportar / Compartilhar', 'WhatsApp · PDF · CSV · JSON')}
        ${item('open-import', null, 'inventory', 'Importar backup', 'Restaurar de outro dispositivo (.json)')}
        ${item('print-list',  null, 'receipt', 'Imprimir lista',          'Versão limpa pra papel ou PDF')}
      </div>

      <div class="menu-list" style="margin-top:14px">
        ${item('wipe-all', null, 'x', 'Apagar tudo', 'Volta pra tela de boas-vindas — sem volta')}
      </div>

      <div class="menu-foot">
        <span class="status-pill ${state.online ? 'status-pill--ok' : 'status-pill--off'}">${state.online ? '● Online' : '◌ Offline'}</span>
        <a class="link-btn" href="canvas.html" target="_blank" rel="noopener">Ver design canvas →</a>
      </div>
    `);
  }

  function sheetShell(title, body) {
    return `
      <div class="sheet-backdrop" data-act="close-sheet"></div>
      <div class="sheet-modal" role="dialog" aria-modal="true" aria-label="${escape(title)}">
        <header class="sheet-modal__head">
          <h2 class="sheet-modal__title">${title}</h2>
          <button class="icon-btn icon-btn--ghost" data-act="close-sheet" aria-label="Fechar">${icon('x', 14, { sw: 1.7 })}</button>
        </header>
        <div class="sheet-modal__body">${body}</div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 15. Render principal + delegação de eventos
  // ────────────────────────────────────────────────────────────
  function render() {
    const root = $('#app');
    if (!root) return;

    // Restore scroll/focus
    const focus = document.activeElement?.dataset?.input;
    const sel = focus ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;

    // Welcome / Login:
    //   - family vazio → form criar primeiro perfil
    //   - family populado mas sem currentUser válido → lista de perfis pra escolher
    const validUser = state.currentUser && state.family.some((f) => f.id === state.currentUser);
    if (state.family.length === 0 || !validUser) {
      root.innerHTML = `<main class="page">${viewWelcome()}</main>`;
      renderToast();
      const inp = root.querySelector('input[name="name"]');
      if (inp && state.family.length === 0) inp.focus();
      return;
    }

    const view =
      state.view === 'estoque' ? viewEstoque() :
      state.view === 'recorrentes' ? viewRecorrentes() :
      state.view === 'sugestoes' ? viewSugestoes() :
      state.view === 'familia' ? viewFamilia() :
      state.view === 'shopping' ? viewShopping() :
      viewLista();

    const sheet =
      state.sheet === 'add' ? sheetAdd() :
      state.sheet === 'edit' ? sheetEdit() :
      state.sheet === 'export' ? sheetExport() :
      state.sheet === 'family' ? sheetFamily() :
      state.sheet === 'menu' ? sheetMenu() :
      state.sheet === 'price' ? sheetPrice() :
      state.sheet === 'recipes' ? sheetRecipes() :
      state.sheet === 'pin' ? sheetPin() :
      state.sheet === 'edit-pin' ? sheetEditPin() :
      state.sheet === 'group' ? sheetGroup() :
      state.sheet === 'inventory-edit' ? sheetInventoryEdit() :
      state.sheet === 'inventory-add' ? sheetInventoryAdd() :
      state.sheet === 'rec-add' ? sheetRecAdd() :
      state.sheet === 'fam-add' ? sheetFamAdd() :
      '';

    root.innerHTML = `<main class="page">${view}</main>${sheet ? `<div class="sheet-root">${sheet}</div>` : ''}`;

    renderToast();

    // restaurar foco
    if (focus) {
      const el = root.querySelector(`[data-input="${focus}"]`);
      if (el) {
        el.focus();
        try { if (sel) el.setSelectionRange(sel.start, sel.end); } catch (e) {}
      }
    }

    // setup câmera se necessário (reanexa stream existente em re-renders)
    if (state.sheet === 'add' && state.sheetData?.tab === 'camera') {
      const v = root.querySelector('#cam-video');
      if (v) {
        if (_stream) {
          v.srcObject = _stream;
          v.play().catch(() => {});
        } else {
          startCamera(v, async (code) => {
            const found = await lookupBarcode(code);
            stopCamera();
            await addItem(found.name + (found.brand ? ` · ${found.brand}` : ''), found.qty);
            setState({ sheet: null, sheetData: null });
          });
        }
      }
    }
  }

  // Toast renderizado fora do #app pra evitar flicker em re-renders
  let _lastToast = null;
  let _lastUndoMsg = null;
  function renderToast() {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const undoMsg = state.undo?.msg || null;
    if (state.toast === _lastToast && undoMsg === _lastUndoMsg) return;
    _lastToast = state.toast;
    _lastUndoMsg = undoMsg;
    if (state.undo) {
      host.innerHTML = `<div class="toast toast--undo" role="status">
        <span>${escape(state.undo.msg)}</span>
        <button class="toast__undo" data-act="undo">Desfazer</button>
      </div>`;
    } else if (state.toast) {
      host.innerHTML = `<div class="toast" role="status">${escape(state.toast)}</div>`;
    } else {
      host.innerHTML = '';
    }
  }

  // ── Event delegation ──
  document.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    const val = target.dataset.val;
    const id = target.dataset.id;

    switch (act) {
      case 'view':         setState({ view: val, sheet: null }); window.scrollTo(0, 0); break;
      case 'toggle':       await toggleItem(id); break;
      case 'toggle-sug':   setState({ showSug: !state.showSug }); break;
      case 'toggle-done':  setState({ showDone: !state.showDone }); break;
      case 'open-menu':    setState({ sheet: 'menu' }); break;
      case 'clear-search': setState({ search: '' }); break;
      case 'open-add-tab': setState({ sheet: 'add', sheetData: { tab: target.dataset.tab } }); break;
      case 'print-list':   setState({ sheet: null }); setTimeout(() => printList(), 100); break;
      case 'undo':         await doUndo(); break;
      case 'install-pwa':  await promptInstall(); break;
      case 'enable-notifs': await enableNotifs(); break;
      case 'test-notif':    showNotif('HSH Mercado funcionando', 'As notificações estão ativadas.'); break;
      case 'toggle-theme':  await toggleTheme(); break;
      case 'start-shopping': setState({ sheet: null }); await startShopping(); break;
      case 'exit-shopping':  await stopShopping(); break;
      case 'open-recipes':   setState({ sheet: 'recipes', sheetData: null }); break;
      case 'open-recipe':    setState({ sheet: 'recipes', sheetData: { recipeId: id } }); break;
      case 'recipe-add': {
        const r = RECIPES.find((x) => x.id === id);
        if (!r) break;
        const missing = recipeMissing(r);
        if (!missing.length) { toast('Tudo pronto'); break; }
        for (const ing of missing) await addItem(ing.name, ing.qty);
        setState({ sheet: null, sheetData: null });
        toast(`${missing.length} ${missing.length === 1 ? 'item adicionado' : 'itens adicionados'}`);
        break;
      }
      case 'open-import': {
        // dispara input file invisível
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'application/json,.json';
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          const mode = confirm('Substituir TUDO pelo backup?\n\nOK = substituir\nCancelar = mesclar (mantém o que existe)') ? 'replace' : 'merge';
          await importJSON(f, mode);
          setState({ sheet: null });
        };
        input.click();
        break;
      }
      case 'ac-pick': {
        await addItem(target.dataset.name, target.dataset.qty || '1 un');
        const inp = $('.addbar__input');
        if (inp) inp.value = '';
        setState({ search: '', acFocus: false });
        break;
      }
      case 'open-price':   setState({ sheet: 'price', sheetData: { id } }); break;
      case 'clear-price':  await clearPrice(target.dataset.name); setState({ sheet: null, sheetData: null }); toast('Preço removido'); break;
      case 'search-all-prices': {
        const semPreco = state.items.filter((i) => !i.done && !getPrice(i.name));
        if (!semPreco.length) { toast('Todos com preço já'); break; }
        toast(`Buscando ${semPreco.length} preços…`);
        await autoFetchPricesBatch(semPreco.map((i) => i.name));
        const aindaSem = state.items.filter((i) => !i.done && !getPrice(i.name)).length;
        const novos = semPreco.length - aindaSem;
        toast(novos > 0 ? `${novos} preços encontrados` : 'Nenhum preço encontrado');
        break;
      }
      case 'edit':         setState({ sheet: 'edit', sheetData: { id } }); break;
      case 'remove-item':  await removeItem(id); setState({ sheet: null }); break;
      case 'remove-photo': await updateItem(id, { photo: null }); break;
      case 'row-menu':     setState({ sheet: 'edit', sheetData: { id } }); break;
      case 'clear-checked':await clearChecked(); break;

      case 'open-add':     setState({ sheet: 'add', sheetData: { tab: 'voz' } }); break;
      case 'open-export':  setState({ sheet: 'export' }); break;
      case 'open-family':  setState({ sheet: 'family' }); break;
      case 'open-fam-add': setState({ sheet: 'fam-add' }); break;
      case 'open-inv-add': setState({ sheet: 'inventory-add' }); break;
      case 'open-inv-edit':setState({ sheet: 'inventory-edit', sheetData: { id } }); break;
      case 'open-rec-add': setState({ sheet: 'rec-add' }); break;
      case 'close-sheet':  if (state.sheet === 'add' && state.sheetData?.tab === 'camera') stopCamera(); if (state.voice.listening) stopVoice(); setState({ sheet: null, sheetData: null, voice: { listening: false, transcript: '', interim: '' } }); break;

      case 'add-tab':      if (state.sheetData?.tab === 'camera' && target.dataset.tab !== 'camera') stopCamera(); if (state.voice.listening && target.dataset.tab !== 'voz') stopVoice(); setState({ sheetData: { ...state.sheetData, tab: target.dataset.tab } }); break;

      case 'voice-toggle': state.voice.listening ? stopVoice() : startVoice(); break;
      case 'voice-clear':  setState({ voice: { listening: false, transcript: '', interim: '' } }); break;
      case 'voice-confirm':{
        const parsed = JSON.parse(target.dataset.payload);
        await addItems(parsed);
        if (state.voice.listening) stopVoice();
        setState({ sheet: null, sheetData: null, voice: { listening: false, transcript: '', interim: '' } });
        break;
      }
      case 'cam-manual':   stopCamera(); setState({ sheetData: { ...state.sheetData, tab: 'texto' } }); break;
      case 'receipt-toggle': {
        const idx = parseInt(target.dataset.idx, 10);
        const items = (state.sheetData?.ocr?.items || []).map((it, i) => i === idx ? { ...it, skip: !it.skip } : it);
        setState({ sheetData: { ...state.sheetData, ocr: { ...state.sheetData.ocr, items } } });
        break;
      }
      case 'receipt-reset': {
        const url = state.sheetData?.ocr?.imageUrl;
        if (url) try { URL.revokeObjectURL(url); } catch {}
        setState({ sheetData: { ...state.sheetData, ocr: null } });
        break;
      }
      case 'receipt-confirm': {
        const items = (state.sheetData?.ocr?.items || []).filter((it) => !it.skip);
        if (!items.length) { toast('Nada selecionado'); break; }
        for (const it of items) {
          await addItem(it.name, it.qty || '1 un');
          if (it.price && !isNaN(it.price)) await setPrice(it.name, it.price, { source: 'manual' });
        }
        const url = state.sheetData?.ocr?.imageUrl;
        if (url) try { URL.revokeObjectURL(url); } catch {}
        toast(`${items.length} ${items.length === 1 ? 'item adicionado' : 'itens adicionados'}`);
        setState({ sheet: null, sheetData: null });
        break;
      }
      case 'add-preset':   await addItem(target.dataset.name, '1 un'); break;
      case 'add-suggestion': await addItem(target.dataset.name, target.dataset.qty, { ai: target.dataset.ai }); break;
      case 'add-from-inv': await addItem(target.dataset.name, target.dataset.qty); break;

      case 'set-user':     setState({ currentUser: id, sheet: null }); break;
      case 'remove-fam':   await removeFamily(id); break;

      case 'apply-rec': {
        const r = state.recurring.find((x) => x.id === id);
        if (r) { await applyRecToList(r); setState({ view: 'lista' }); }
        break;
      }
      case 'toggle-rec':   await toggleRec(id); break;
      case 'remove-rec':   await removeRec(id); break;
      case 'remove-inv':   await removeInv(id); setState({ sheet: null }); break;

      case 'export-share': shareList(); break;
      case 'export-copy':  copyList(); break;
      case 'export-print': printList(); break;
      case 'export-txt':   exportTXT(); break;
      case 'export-csv':   exportCSV(); break;
      case 'export-json':  exportJSON(); break;
      case 'search-list': {
        const q = state.items.filter((i) => !i.done).slice(0, 5).map((i) => i.name).join(' ');
        searchExternal(target.dataset.prov, q || 'mercado');
        break;
      }
      case 'search-online': searchExternal('ml', target.dataset.q); break;
      case 'search-aisle': {
        const aid = target.dataset.aisle;
        const q = state.items.filter((i) => !i.done && i.aisle === aid).map((i) => i.name).join(' ');
        searchExternal('ml', q || AISLE_LABELS[aid]);
        break;
      }
      case 'wipe-all':
        if (confirm('Apagar TODOS os dados (lista, estoque, família, histórico, preços)?\n\nNão há volta. Vai voltar para a tela de boas-vindas.')) {
          await wipeAll();
          toast('Tudo limpo · começar do zero');
        }
        break;
      case 'load-demo':
        if (confirm('Carregar dados de exemplo (4 pessoas, lista, estoque)? Útil só pra testar.')) {
          await seedDemo(); await loadAll();
          if (!state.currentUser && state.family.length) setState({ currentUser: state.family[0].id });
          toast('Dados de exemplo carregados');
        }
        break;
      case 'select-user': {
        // Trocar de usuário — pede PIN se o perfil tem um
        const f = state.family.find((x) => x.id === id);
        if (!f) break;
        if (f.pinHash) {
          setState({ sheet: 'pin', sheetData: { targetId: id } });
        } else {
          setState({ currentUser: id, sheet: null });
          toast(`Você é ${f.name}`);
        }
        break;
      }
      case 'open-group':   setState({ sheet: 'group' }); break;
      case 'sync-pull-now': await pullChanges(); await flushOutbox(); toast('Sincronizado'); break;
      case 'copy-code': {
        const code = target.dataset.code;
        if (navigator.clipboard && code) {
          navigator.clipboard.writeText(code).then(() => toast(`Copiado: ${code}`));
        } else toast(code || '');
        break;
      }
      case 'leave-group':
        if (confirm('Sair do grupo? Os dados locais ficam intactos, mas você não recebe mais updates.')) {
          await syncLeaveSpace();
          toast('Saiu do grupo');
          setState({ sheet: null });
        }
        break;
      case 'set-pin': {
        // Abrir sheet pra setar/trocar PIN do perfil
        setState({ sheet: 'edit-pin', sheetData: { id } });
        break;
      }
    }
  });

  // Submit forms
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());

    switch (form.dataset.form) {
      case 'text': {
        const parsed = parseInput(data.text);
        if (parsed.length === 1) await addItem(parsed[0].name, parsed[0].qty);
        else if (parsed.length > 1) await addItems(parsed);
        else await addItem(data.text, '1 un');
        setState({ sheet: null, sheetData: null });
        break;
      }
      case 'quickadd': {
        const txt = (data.text || '').trim();
        if (!txt) break;
        const parsed = parseInput(txt);
        if (parsed.length === 1) await addItem(parsed[0].name, parsed[0].qty);
        else if (parsed.length > 1) await addItems(parsed);
        else await addItem(txt, '1 un');
        form.querySelector('input[name="text"]').value = '';
        setState({ search: '' });
        break;
      }
      case 'edit': {
        await updateItem(form.dataset.id, { name: data.name, qty: data.qty, aisle: data.aisle, by: data.by, note: data.note || null });
        setState({ sheet: null, sheetData: null });
        toast('Item salvo');
        break;
      }
      case 'add-family': {
        const pin = (data.pin || '').trim();
        if (pin && !/^\d{4}$/.test(pin)) { toast('PIN precisa ter 4 dígitos'); break; }
        await addFamily(data.name, pin || null);
        setState({ sheet: null });
        break;
      }
      case 'onboard': {
        const pin = (data.pin || '').trim();
        if (pin && !/^\d{4}$/.test(pin)) { toast('PIN precisa ter 4 dígitos'); break; }
        const m = await addFamily(data.name, pin || null);
        if (m) {
          setState({ currentUser: m.id });
          toast(`Bem-vindo, ${m.name}! 👋`);
        }
        break;
      }
      case 'pin-verify': {
        const targetId = form.dataset.id;
        const ok = await verifyPin(targetId, data.pin);
        if (ok) {
          const f = state.family.find((x) => x.id === targetId);
          setState({ currentUser: targetId, sheet: null, sheetData: null });
          toast(`Você é ${f.name}`);
        } else {
          setState({ sheetData: { ...state.sheetData, error: true } });
        }
        break;
      }
      case 'edit-pin': {
        const memberId = form.dataset.id;
        const f = state.family.find((x) => x.id === memberId);
        if (!f) break;
        const oldPin = (data.oldPin || '').trim();
        const newPin = (data.newPin || '').trim();
        if (f.pinHash && !(await verifyPin(memberId, oldPin))) {
          toast('PIN atual incorreto');
          break;
        }
        if (newPin && !/^\d{4}$/.test(newPin)) {
          toast('Novo PIN precisa ter 4 dígitos');
          break;
        }
        await updateFamilyPin(memberId, newPin || null);
        setState({ sheet: null, sheetData: null });
        toast(newPin ? `PIN atualizado` : `PIN removido`);
        break;
      }
      case 'add-inv':      await addInv({ name: data.name, stock: (Number(data.stock) || 100) / 100, unit: data.unit, cadenceDays: Number(data.cadenceDays) || 14 }); setState({ sheet: null }); break;
      case 'edit-inv':     await updateInv(form.dataset.id, { stock: (Number(data.stock) || 0) / 100, cadenceDays: Number(data.cadenceDays) || 14, unit: data.unit }); setState({ sheet: null }); break;
      case 'add-rec':      await addRec({ name: data.name, qty: data.qty, cadenceDays: Number(data.cadenceDays) || 7 }); setState({ sheet: null }); break;
      case 'set-price': {
        const num = parseFloat(String(data.price || '').replace(/\./g, '').replace(',', '.'));
        if (isNaN(num) || num < 0) { toast('Preço inválido'); break; }
        await setPrice(data.name, num, { source: data.source || 'manual' });
        setState({ sheet: null, sheetData: null });
        toast(`Preço salvo: ${fmtBRL(num)}`);
        break;
      }
      case 'create-group': {
        try {
          const j = await syncCreateSpace(data.name?.trim() || null, data.pin?.trim() || null);
          toast(`Grupo criado · código ${j.code}`);
          setState({ sheet: 'group' }); // mostra o code pra copiar
        } catch (e) { toast(String(e.message || e)); }
        break;
      }
      case 'join-group': {
        const code = String(data.code || '').toUpperCase().trim();
        if (!code) { toast('Código obrigatório'); break; }
        try {
          const j = await syncJoinSpace(code, data.pin?.trim() || null);
          toast(`Conectado · ${j.name || j.code}`);
          // Após pull inicial, currentUser pode ficar inválido se a família veio do servidor
          await loadAll();
          if (state.family.length && !state.family.some((f) => f.id === state.currentUser)) {
            setState({ currentUser: state.family[0].id });
          }
          setState({ sheet: null, sheetData: null });
        } catch (e) { toast(String(e.message || e)); }
        break;
      }
    }
  });

  // Live inputs (search/quickadd, range, file uploads)
  const onSearchInput = debounce((v) => setState({ search: v }), 180);
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t?.dataset?.input === 'receipt-file') {
      const f = t.files?.[0]; if (!f) return;
      const imageUrl = URL.createObjectURL(f);
      setState({ sheetData: { ...state.sheetData, ocr: { busy: true, progress: 0, imageUrl, items: [] } } });
      const text = await ocrReceipt(f, (p) => {
        setState({ sheetData: { ...state.sheetData, ocr: { ...state.sheetData.ocr, busy: true, progress: p } } });
      });
      const items = parseReceiptText(text || '');
      setState({ sheetData: { ...state.sheetData, ocr: { busy: false, progress: 100, imageUrl, items } } });
    }
    if (t?.dataset?.input === 'item-photo') {
      const f = t.files?.[0]; if (!f) return;
      const id = t.dataset.id;
      const dataUrl = await compressImage(f);
      await updateItem(id, { photo: dataUrl });
      toast('Foto adicionada');
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset?.input === 'search' || t.dataset?.input === 'quickadd') onSearchInput(t.value);
    if (t.matches('input[type="range"][name="stock"]')) {
      const out = t.parentElement.querySelector('[data-bind="stock-out"]');
      if (out) out.textContent = `${t.value}%`;
    }
  });

  // Focus/blur na addbar para autocomplete
  document.addEventListener('focusin', (e) => {
    if (e.target?.dataset?.input === 'quickadd' && !state.acFocus) setState({ acFocus: true });
  });
  document.addEventListener('focusout', (e) => {
    if (e.target?.dataset?.input === 'quickadd') {
      // delay para permitir clique nos itens do autocomplete
      setTimeout(() => { if (!document.activeElement?.closest?.('.ac, .addbar')) setState({ acFocus: false }); }, 200);
    }
  });

  // ESC fecha sheets
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.sheet) {
      if (state.sheet === 'add' && state.sheetData?.tab === 'camera') stopCamera();
      if (state.voice.listening) stopVoice();
      setState({ sheet: null, sheetData: null });
    }
  });

  // Online/offline
  window.addEventListener('online',  () => {
    setState({ online: true });
    toast('Voltou a ficar online');
    if (state.sync.spaceId) { schedulePush(200); pullChanges(); }
  });
  window.addEventListener('offline', () => { setState({ online: false }); toast('Modo offline — tudo continua salvando'); });

  // Quando reabre a aba após estar oculta, sync imediato
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.sync.spaceId && state.online) {
      pullChanges();
      schedulePush(200);
    }
  });

  // PWA install prompt
  let _installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPrompt = e;
    setState({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    _installPrompt = null;
    setState({ canInstall: false });
    toast('App instalado! 🎉');
  });
  async function promptInstall() {
    if (!_installPrompt) {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIOS) {
        toast('iOS: toque em Compartilhar → Adicionar à Tela de Início');
      } else {
        toast('Use o menu do navegador para instalar o app');
      }
      return;
    }
    try {
      _installPrompt.prompt();
      const { outcome } = await _installPrompt.userChoice;
      _installPrompt = null;
      setState({ canInstall: false });
      if (outcome === 'accepted') toast('App instalado! 🎉');
    } catch (e) { /* user cancelled */ }
  }

  // ────────────────────────────────────────────────────────────
  // 16. Init
  // ────────────────────────────────────────────────────────────
  async function init() {
    // Service Worker (apenas em http(s)://)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW falhou', e));
    }

    await loadAll();
    await loadTheme();
    await loadSyncMeta();
    if (state.sync.spaceId) {
      // Sync inicial: pull recente + arranca loop
      pullChanges().then(() => schedulePull());
      schedulePush(800); // tenta flushar fila offline residual
    }

    // Query string actions (do shortcut PWA)
    const qs = new URLSearchParams(location.search);
    const v = qs.get('vista');
    if (v && ['lista','estoque','recorrentes','sugestoes','familia','shopping'].includes(v)) state.view = v;
    if (qs.get('acao') === 'adicionar') state.sheet = 'add', state.sheetData = { tab: 'voz' };

    // Modo demo (?demo=1): popula dados de exemplo se banco vazio
    if (qs.get('demo') === '1' && state.family.length === 0) {
      await seedDemo();
      await loadAll();
    }

    // Se não tem usuário atual mas tem família, usa o primeiro
    if (!state.currentUser && state.family.length) state.currentUser = state.family[0].id;

    render();

    // notifica sugestões urgentes (se já houver permissão)
    setTimeout(() => checkAndNotify(), 1500);
  }

  document.addEventListener('DOMContentLoaded', init);

  // expose para debug
  window.LecoLista = { state, setState, addItem, addItems, parseInput, predict, classifyAisle, dbAll, exportJSON };
})();

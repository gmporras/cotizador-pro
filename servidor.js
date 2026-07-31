/**
 * ╔══════════════════════════════════════════════════════╗
 * ║        COTIZADOR PRO V9 — Servidor Proxy             ║
 * ║  Serper + MercadoLibre + OpenRouter + Caché local    ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * USO:
 *   node servidor.js
 *   Abre Cotizador_Pro_V9.html en el navegador
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT           = 3099;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS = [
  'google/gemini-2.0-flash-lite:free',
  'google/gemma-3-12b-it:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'qwen/qwen-2.5-7b-instruct:free',
  'openrouter/auto',
];

// ── Colores consola ──────────────────────────────────────
const C = {
  reset : '\x1b[0m', green : '\x1b[32m', cyan  : '\x1b[36m',
  yellow: '\x1b[33m', red  : '\x1b[31m', dim   : '\x1b[2m', bold: '\x1b[1m',
};
function log(color, ...args) {
  const ts = new Date().toLocaleTimeString('es-CL');
  console.log(`${C.dim}[${ts}]${C.reset} ${color}${args.join(' ')}${C.reset}`);
}

// ── Caché local ──────────────────────────────────────────
const CACHE_FILE    = path.join(__dirname, 'cotizador_cache.json');
const CACHE_TTL_DIAS = 7;

function cargarCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch(e) {}
  return {};
}
function guardarCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  catch(e) {}
}
function claveCache(q) {
  return q.toLowerCase().trim().replace(/\s+/g,' ').replace(/[^a-z0-9áéíóúñü ]/g,'');
}
function buscarEnCache(query) {
  const cache = cargarCache();
  const clave = claveCache(query);
  if (cache[clave]) {
    const dias = (Date.now() - cache[clave].fechaMs) / 86400000;
    if (dias <= CACHE_TTL_DIAS) {
      log(C.green, `✓ Cache HIT: "${query}" (hace ${Math.round(dias)}d)`);
      return cache[clave];
    }
  }
  return null;
}
function guardarEnCache(query, resultados, mejor) {
  const cache = cargarCache();
  cache[claveCache(query)] = {
    query, mejor,
    resultados: resultados.slice(0, 10),
    fechaMs: Date.now(),
    fecha: new Date().toLocaleDateString('es-CL'),
  };
  guardarCache(cache);
}

// ── Parser de precio CLP ─────────────────────────────────
function normalizarCLP(str) {
  let s = String(str).replace(/\s/g,'').replace(/\$/g,'');
  s = s.replace(/,[0-9]{1,2}$/, '');
  if (/^[0-9]{1,3}(\.[0-9]{3})+$/.test(s)) return parseInt(s.replace(/\./g,''), 10);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9]{1,3}(,[0-9]{3})+$/.test(s)) return parseInt(s.replace(/,/g,''), 10);
  return 0;
}
function parsearPrecioCLP(texto) {
  if (typeof texto === 'number') {
    if (texto > 0 && texto < 5000) return Math.round(texto * 950);
    if (texto >= 1000 && texto <= 99999999) return Math.round(texto);
    return 0;
  }
  const s = String(texto);
  const candidatos = [];
  let m;
  const r1 = /\$\s*([0-9]{1,3}(?:\.[0-9]{3})+)/g;
  while ((m = r1.exec(s)) !== null) {
    const n = normalizarCLP(m[1]);
    if (n >= 1000 && n <= 99999999) candidatos.push(n);
  }
  if (candidatos.length) return Math.min(...candidatos);
  const r2 = /CLP\s*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})+)/gi;
  while ((m = r2.exec(s)) !== null) {
    const n = normalizarCLP(m[1]);
    if (n >= 1000 && n <= 99999999) candidatos.push(n);
  }
  if (candidatos.length) return Math.min(...candidatos);
  const r3 = /\$\s*([0-9]{4,8})(?![0-9.,])/g;
  while ((m = r3.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1000 && n <= 99999999) candidatos.push(n);
  }
  if (candidatos.length) return Math.min(...candidatos);
  return 0;
}

// ── Detectar URL de listado vs producto ─────────────────
function esUrlListado(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return [
    /\/search[?/]/, /\/busqueda[?/]/, /\/buscar[?/]/,
    /[?&](q|query|s|search|keyword)=/,
    /\/categorias?\//, /\/category\//, /\/collections?\//,
    /\/productos\/?$/, /\/listado\//,
    /utm_source=chatgpt/, /[?&]order=/, /[?&]sort=/,
  ].some(p => p.test(u));
}

// ── Serper.dev búsqueda ──────────────────────────────────


// ─────────────────────────────────────────────────────────
// FIREBASE FIRESTORE — Base de datos propia de productos
// Consulta la colección "producto" de jyg-inversiones
// ─────────────────────────────────────────────────────────
const FIRESTORE_PROJECT = 'jyg-inversiones';
const FIRESTORE_COLLECTION = 'producto';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${FIRESTORE_COLLECTION}`;
const FIRESTORE_APIKEY = 'AIzaSyCmb0o93hyPjK5zAVX1hqxSxMJXH3oBHaE';

function fetchFirestore(query) {
  return new Promise((resolve) => {
    const url  = new URL(FIRESTORE_URL + '?key=' + FIRESTORE_APIKEY + '&pageSize=500');
    const opts = {
      hostname: url.hostname,
      path    : url.pathname + url.search,
      method  : 'GET',
      headers : { 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(data.documents || []);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// Normaliza texto para comparación fuzzy
function normalizarParaBusqueda(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Score de coincidencia entre query y nombre del producto en Firebase
function scoreFirestore(query, nombre) {
  const qNorm = normalizarParaBusqueda(query);
  const nNorm = normalizarParaBusqueda(nombre);
  const qWords = qNorm.split(' ').filter(w => w.length > 2);
  if (!qWords.length) return 0;
  const hits = qWords.filter(w => nNorm.includes(w)).length;
  return Math.round((hits / qWords.length) * 100);
}

// Busca en Firebase y devuelve los mejores matches
async function buscarEnFirebase(query) {
  try {
    const docs = await fetchFirestore(query);
    if (!docs.length) return [];

    const resultados = [];
    for (const doc of docs) {
      const f      = doc.fields || {};
      const nombre = f.nombre?.stringValue || '';
      const precio = parseInt(f.precio?.integerValue || f.precio?.doubleValue || 0, 10);
      const link   = f.proveedorContacto?.stringValue || '';
      const score  = scoreFirestore(query, nombre);
      if (score >= 40 && nombre && precio > 0) {
        resultados.push({
          titulo  : nombre,
          tienda  : link ? new URL(link).hostname.replace('www.','') : 'Firebase',
          precio,
          link,
          enStock : true,
          fuente  : 'firebase',
          score,
        });
      }
    }
    // Ordenar por score descendente
    return resultados.sort((a, b) => b.score - a.score).slice(0, 5);
  } catch(e) {
    log(C.yellow, `  ⚠ Firebase error: ${e.message}`);
    return [];
  }
}

// ── Limpiador de query — corrige typos y acorta ──────────
function limpiarQuery(query) {
  let q = query
    .replace(/^\([^)]+\)\s*/, '')         // quitar (aclaración) al inicio
    .replace(/\bwinwows\b/gi, 'windows')
    .replace(/\b(ama|amq|adn)\b/gi, 'amd')
    .replace(/\bryzer\b/gi, 'ryzen')
    .replace(/\brizem\b/gi, 'ryzen')
    .replace(/\blaptop\b/gi, 'notebook')
    .replace(/\b(\d+)\s*tb\b/gi, (m, n) => parseInt(n) > 10 ? n+'GB' : n+'TB')
    .replace(/\s{2,}/g, ' ').trim();
  // Si supera 80 chars, tomar las palabras más relevantes
  if (q.length > 80) {
    const palabras = q.split(' ');
    const importantes = palabras.filter(p => /^[A-Z]/.test(p) || /\d/.test(p) || p.length > 5);
    q = importantes.slice(0, 10).join(' ');
  }
  return q || query.trim();
}

function fetchSerper(apiKey, query) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      q  : 'buscar en chile precio mas economico ' + limpiarQuery(query) + ' -filetype:pdf -site:amazon.com -site:ebay.com -site:aliexpress.com -site:facebook.com -site:instagram.com -site:youtube.com -site:pinterest.com -site:reddit.com',
      gl : 'cl', hl : 'es', num: 10,
    });
    const opts = {
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: {
        'X-API-KEY': apiKey, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch(e) { resolve({ status: 500, body: {} }); }
      });
    });
    req.on('error', () => resolve({ status: 500, body: {} }));
    req.write(payload); req.end();
  });
}

// ── Parsear resultados Serper ────────────────────────────
function parsearResultados(body) {
  const resultados = [];
  const vistos = new Set();

  const organic = body.organic_results || body.organic || [];
  // Dominios extranjeros y redes sociales — excluir completamente
  const DOMINIOS_EXCLUIDOS = new Set([
    'amazon.com','amazon.com.mx','amazon.co.uk','amazon.de','amazon.es',
    'ebay.com','ebay.es','aliexpress.com','alibaba.com','wish.com',
    'homedepot.com','walmart.com','costco.com','lowes.com','sears.com',
    'facebook.com','instagram.com','twitter.com','x.com','tiktok.com',
    'youtube.com','pinterest.com','reddit.com','linkedin.com',
    'mercadolibre.com.ar','mercadolibre.com.mx','mercadolibre.com.co',
    'scribd.com','academia.edu','slideshare.net','issuu.com',
    'wikipedia.org','wikimedia.org','google.com','google.cl',
  ]);

  for (const r of organic) {
    const link = r.link || '';
    if (!link || vistos.has(link)) continue;
    // Excluir PDFs y docs técnicos
    if (/\.pdf($|\?)/i.test(link)) continue;
    if (/(ficha.tecnica|datasheet|normativa|catalogo)/i.test(link)) continue;
    const tituloLower = (r.title || '').toLowerCase();
    if (/(norma|reglamento|decreto|\[pdf\]|ficha tecnica|datasheet)/i.test(tituloLower)) continue;
    // Extraer hostname y excluir dominios extranjeros
    let hostname = '';
    try { hostname = new URL(link).hostname.replace('www.','').toLowerCase(); }
    catch(e) { continue; }
    if (DOMINIOS_EXCLUIDOS.has(hostname)) continue;
    // Excluir cualquier subdominio de dominios excluidos
    const esDominioExcluido = [...DOMINIOS_EXCLUIDOS].some(d => hostname.endsWith('.'+d));
    if (esDominioExcluido) continue;
    vistos.add(link);
    resultados.push({
      titulo  : r.title || '',
      tienda  : hostname,
      precio  : parsearPrecioCLP(r.snippet || r.title || ''),
      link,
      snippet : r.snippet || '',
      enStock : !/(agotado|sin stock|no disponible)/i.test((r.snippet||'') + (r.title||'')),
      fuente  : 'serper',
      esChile : hostname.endsWith('.cl'),
    });
  }

  const shopping = body.shopping_results || body.shopping || [];
  for (const r of shopping) {
    const precio = parsearPrecioCLP(r.price || r.extracted_price || '');
    if (!precio) continue;
    const link = r.product_link || r.link || '';
    if (!link || vistos.has(link) || /google\.(cl|com)/i.test(link)) continue;
    vistos.add(link);
    resultados.push({
      titulo   : r.title || '',
      tienda   : r.source || r.merchant?.name || 'Tienda',
      precio, link,
      enStock  : !/(agotado|sin stock)/i.test((r.title||'')),
      thumbnail: r.thumbnail || '',
      fuente   : 'shopping',
    });
  }
  return resultados;
}

// ── MercadoLibre Chile API ───────────────────────────────
function buscarEnMercadoLibre(query) {
  return new Promise((resolve) => {
    // ML: usar query limpia sin prefijos de texto
    const queryML = query.replace(/^(MT\.?\s*|SUMINISTRO\s*)/i,'').trim();
    const params = new URLSearchParams({ q: queryML, limit: '5', site_id: 'MLC' });
    const opts = {
      hostname: 'api.mercadolibre.com',
      path: '/sites/MLC/search?' + params.toString(),
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const resultados = (data.results || [])
            .filter(r => r.available_quantity > 0)
            .slice(0, 5)
            .map(r => ({
              titulo   : r.title || '',
              tienda   : 'MercadoLibre',
              precio   : r.price || 0,
              link     : r.permalink || '',
              enStock  : true,
              fuente   : 'mercadolibre',
            }));
          resolve(resultados);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ── OpenRouter IA ────────────────────────────────────────
function fetchOpenRouterModel(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model, messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, max_tokens: 200,
    });
    const opts = {
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost:3099', 'X-Title': 'Cotizador PRO V9',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch(e) { reject(new Error('Respuesta inválida')); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

async function fetchOpenRouter(apiKey, prompt) {
  let lastError = 'Sin respuesta';
  for (const model of OPENROUTER_MODELS) {
    try {
      log(C.dim, `  Probando modelo: ${model}`);
      const result = await fetchOpenRouterModel(apiKey, model, prompt);
      if ([402, 404].includes(result.status)) {
        lastError = result.body?.error?.message || `HTTP ${result.status}`;
        log(C.yellow, `  ✗ ${model}: ${lastError.substring(0,60)} — siguiente...`);
        continue;
      }
      return result;
    } catch(e) {
      lastError = e.message;
      log(C.yellow, `  ✗ ${model}: ${e.message} — siguiente...`);
    }
  }
  return { status: 503, body: { error: { message: `Todos los modelos fallaron: ${lastError}` } } };
}

// ── Elegir mejor resultado con IA ────────────────────────
async function elegirMejorConIA(apiKey, query, resultados) {
  if (!apiKey || !resultados.length) return { resultado: resultados[0], razon: 'Sin IA' };
  const lista = resultados.slice(0, 6).map((r, i) =>
    `${i+1}. "${r.titulo}" | ${r.tienda} | $${r.precio} | Stock: ${r.enStock ? 'Sí' : 'No'}`
  ).join('\n');
  const prompt = `Producto buscado: "${query}"
Resultados:
${lista}

Elige el resultado que MEJOR coincide con el nombre y especificaciones del producto buscado.
Prioridad: 1) Nombre del producto correcto 2) Especificaciones técnicas 3) Stock 4) Precio bajo
Responde SOLO con JSON: { "indice": número_1_al_6, "razon": "explicación breve" }`;
  try {
    const { body } = await fetchOpenRouter(apiKey, prompt);
    const text  = (body.choices?.[0]?.message?.content || '').replace(/```json?/g,'').replace(/```/g,'').trim();
    const data  = JSON.parse(text);
    const idx   = Math.max(0, (data.indice || 1) - 1);
    return { resultado: resultados[idx] || resultados[0], razon: data.razon || '' };
  } catch(e) {
    return { resultado: resultados[0], razon: 'Selección automática' };
  }
}

// ── Visitar página y extraer precio ─────────────────────

// ── MercadoLibre: obtener precio exacto por ID de item ────
function fetchMLItem(itemId) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.mercadolibre.com',
      path    : `/items/${itemId}`,
      method  : 'GET',
      headers : { 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Extrae el ID de item de una URL de MercadoLibre
// Ej: /MLC1610303412 o ?wid=MLC1610303412
function extraerMLId(url) {
  if (!url) return null;
  // Formato wid= en query string
  const widMatch = url.match(/[?&]wid=(MLC[0-9]+)/i);
  if (widMatch) return widMatch[1];
  // Formato /MLC1234567 en path
  const pathMatch = url.match(/\/(MLC[0-9]+)/i);
  if (pathMatch) return pathMatch[1];
  return null;
}

// Obtener precio real de ML usando su API oficial
async function obtenerPrecioML(url) {
  const itemId = extraerMLId(url);
  if (!itemId) return { precio: 0, enStock: false };
  log(C.dim, `  → ML API item: ${itemId}`);
  const item = await fetchMLItem(itemId);
  if (!item || item.error) return { precio: 0, enStock: false };
  const precio  = item.price || 0;
  const enStock = item.available_quantity > 0 && item.status === 'active';
  log(C.green, `  ✓ ML API: $${precio} stock=${enStock} (${item.title?.substring(0,40)})`);
  return { precio: Math.round(precio), enStock };
}

function fetchPage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const u    = new URL(url);
      const mod  = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'GET', timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept-Language': 'es-CL,es;q=0.9', 'Accept': 'text/html',
        },
      };
      const req = mod.request(opts, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          return fetchPage(res.headers.location, timeoutMs).then(resolve);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ ok: true, html: Buffer.concat(chunks).toString('utf8', 0, 120000), status: res.statusCode }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, html: '', status: 0 }); });
      req.on('error',   () => resolve({ ok: false, html: '', status: 0 }));
      req.end();
    } catch(e) { resolve({ ok: false, html: '', status: 0 }); }
  });
}

function extraerDePagina(html, urlStr) {
  let precio = 0;
  const esMercadoLibre = /mercadolibre\.cl/i.test(urlStr || '');

  // ── MercadoLibre: extracción específica ──────────────────
  if (esMercadoLibre) {
    // ML guarda el precio real en window.__PRELOADED_STATE__ o en JSON-LD
    // Buscar "price" en JSON de estado de la app
    const preloaded = html.match(/__PRELOADED_STATE__\s*=\s*(\{[\s\S]{0,50000}?\})</);
    if (preloaded) {
      // Buscar el precio del BUY BOX (precio real de compra)
      const buyPrice = preloaded[1].match(/"price"\s*:\s*(\d+(?:\.\d+)?)/);
      if (buyPrice) {
        const n = Math.round(parseFloat(buyPrice[1]));
        if (n >= 1000 && n <= 99999999) precio = n;
      }
    }
    // Fallback ML: buscar en meta og:price
    if (!precio) {
      const ogPrice = html.match(/property="og:price:amount"[^>]*content="([0-9.,]+)"/i)
                   || html.match(/"price"\s*:\s*"([0-9.,]+)"/);
      if (ogPrice) { const n = normalizarCLP(ogPrice[1]); if (n >= 1000) precio = n; }
    }
    // Fallback ML: buscar precio con clase andes-money-amount en contexto de compra
    // Eliminar primero las cuotas del HTML
    if (!precio) {
      let h = html
        // Eliminar sección de cuotas completa (entre tags que contienen "cuota")
        .replace(/<[^>]*class="[^"]*installment[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
        .replace(/<[^>]*class="[^"]*cuota[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
        // Eliminar frases de cuotas
        .replace(/[0-9]+\s*cuotas?\s*(sin\s*interés\s*)?de\s*\$[\s0-9.,]+/gi, '')
        .replace(/en\s*[0-9]+\s*cuotas?[^<]{0,60}/gi, '')
        // Eliminar precios tachados
        .replace(/<del[^>]*>[\s\S]*?<\/del>/gi, '')
        .replace(/<s[^>]*>[\s\S]*?<\/s>/gi, '')
        .replace(/antes\s*:?\s*\$[0-9.,]+/gi, '')
        // En ML el precio real generalmente está en aria-label="$16.990"
        ;
      // Buscar aria-label con precio (muy confiable en ML)
      const ariaPrice = h.match(/aria-label="\$\s*([0-9]{1,3}(?:\.[0-9]{3})+)"/);
      if (ariaPrice) { const n = normalizarCLP(ariaPrice[1]); if (n >= 1000) precio = n; }
      // Si no, tomar el menor precio con $ en el HTML limpio
      if (!precio) {
        const candidatos = [];
        let m;
        const r1 = /\$\s*([0-9]{1,3}(?:\.[0-9]{3})+)/g;
        while ((m = r1.exec(h)) !== null) {
          const n = normalizarCLP(m[1]);
          if (n >= 1000 && n <= 99999999) candidatos.push(n);
        }
        if (candidatos.length) {
          candidatos.sort((a,b) => a-b);
          // En ML, el precio real es el más bajo que sea mayor a 5000
          // (los de cuotas individuales quedan en rango 1000-5000 si se filtraron mal)
          const validos = candidatos.filter(p => p >= 5000);
          if (validos.length) precio = validos[0];
          else precio = candidatos[0];
        }
      }
    }
    const enStock = /(agregar al carro|comprar ahora|agregar al carrito)/i.test(html)
      && !/(sin stock|agotado|no disponible)/i.test(html);
    log(C.dim, `    ML precio=${precio} stock=${enStock}`);
    return { precio, enStock };
  }

  // ── Otras tiendas ─────────────────────────────────────────
  // 1. JSON-LD
  const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of jsonLd) {
    const m = b.match(/"price"\s*:\s*"?([0-9.,]+)"?/);
    if (m) { const n = normalizarCLP(m[1]); if (n >= 500 && n <= 100000000) { precio = n; break; } }
  }
  // 2. Meta tags
  if (!precio) {
    for (const pat of [
      /property="product:price:amount"[^>]*content="([0-9.,]+)"/i,
      /itemprop="price"[^>]*content="([0-9.,]+)"/i,
      /data-price="([0-9.,]+)"/i,
      /data-product-price="([0-9.,]+)"/i,
    ]) {
      const m = html.match(pat);
      if (m) { const n = normalizarCLP(m[1]); if (n >= 500 && n <= 100000000) { precio = n; break; } }
    }
  }
  // 3. HTML visible — limpiar cuotas y precios tachados
  if (!precio) {
    let h = html
      .replace(/[0-9]+\s*cuotas?\s*(sin interés\s*)?de\s*\$[\s0-9.,]+/gi, '')
      .replace(/<del[^>]*>[\s\S]*?<\/del>/gi, '')
      .replace(/<s[^>]*>[\s\S]*?<\/s>/gi, '')
      .replace(/antes\s*:?\s*\$[0-9.,]+/gi, '')
      .replace(/precio\s*(normal|lista|referencial)[^<]{0,80}/gi, '');
    const candidatos = [];
    let m;
    const r1 = /\$\s*([0-9]{1,3}(?:\.[0-9]{3})+)/g;
    while ((m = r1.exec(h)) !== null) {
      const n = normalizarCLP(m[1]);
      if (n >= 1000 && n <= 99999999) candidatos.push(n);
    }
    if (candidatos.length) { candidatos.sort((a,b)=>a-b); precio = candidatos[0]; }
  }
  const enStock = /(añadir\s*al\s*carro|agregar\s*al\s*carro|comprar\s*ahora|add\s*to\s*cart|en\s*stock|agregar\s*al\s*carrito)/i.test(html)
    && !/(sin\s*stock|agotado|no\s*disponible)/i.test(html);
  log(C.dim, `    precio=${precio} stock=${enStock}`);
  return { precio, enStock };
}

// ── Helpers HTTP ─────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}


// ── Extractor de ítems desde PDF usando pdf-parse ──────────
async function extraerItemsPDF(buffer) {
  const items = [];
  let texto = '';

  // Intentar usar pdf-parse si está instalado
  try {
    const pdfParsePath = require.resolve('pdf-parse/dist/pdf-parse/cjs/index.cjs');
    const { PDFParse } = require(pdfParsePath);
    const parser = new PDFParse();
    const data   = await parser.parse(buffer);
    // Construir texto desde páginas
    for (const page of data.pages) {
      for (const line of page.lines) {
        texto += line.words.map(w => w.text).join(' ') + '\n';
      }
    }
    log(C.dim, `  PDF texto extraído: ${texto.length} chars`);
  } catch(e) {
    log(C.yellow, `  ⚠ pdf-parse no disponible: ${e.message}`);
    // Fallback: extraer texto de streams PDF básicos
    const raw = buffer.toString('latin1');
    const btRe = /BT([\s\S]*?)ET/g;
    let bm;
    while ((bm = btRe.exec(raw)) !== null) {
      const block = bm[1];
      const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let sm;
      while ((sm = strRe.exec(block)) !== null) {
        const t = sm[1].replace(/\\n/g,' ').replace(/\\r/g,' ');
        if (t.trim()) texto += t + ' ';
      }
    }
  }

  // Limpiar y dividir en líneas
  const lineas = texto
    .replace(/\s{3,}/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2);

  // Patrones para detectar cantidad + descripción
  // Formato: "30 UN Plancha zinc..." o "30 Plancha zinc..." o "30UN Plancha..."
  const patronCantDesc = /^(\d+)\s*(?:UN|UND?|UNI|UNID|PZA?|MT|ML|MTS?|KG|GR|LT|M2|M3|GL|PAR|JGO|SET|ROL|BOL|BLD|CJA?|PKG?)?\s+(.{5,})/i;

  // Patrones alternativos: cantidad al inicio de línea sola, descripción en siguiente
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i];

    // Intentar patrón directo: cantidad + descripción en misma línea
    const match = linea.match(patronCantDesc);
    if (match) {
      const qty  = parseInt(match[1], 10);
      const desc = match[2].trim();
      // Validar que qty sea razonable y desc tenga sentido
      if (qty >= 1 && qty <= 99999 && desc.length > 4 &&
          !/^(CANTIDAD|CANT|QTY|ITEM|N°|NRO|#)/i.test(desc)) {
        // Acumular descripción si la siguiente línea es continuación (no empieza con número)
        let descCompleta = desc;
        let j = i + 1;
        while (j < lineas.length && !/^\d+\s/.test(lineas[j]) && lineas[j].length > 3 && j < i + 4) {
          // Solo agregar si parece continuación de texto (no es header/footer)
          if (!/^(PÁGINA|PAGE|TOTAL|SUBTOTAL|IVA|$)/i.test(lineas[j])) {
            descCompleta += ' ' + lineas[j];
          }
          j++;
        }
        items.push({ qty, desc: descCompleta.substring(0, 300).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }

  // Si no encontró ítems con el método anterior, intentar buscar tabla CANTIDAD/DESCRIPCIÓN
  if (!items.length) {
    log(C.yellow, '  ⚠ PDF: método 1 sin resultados, probando método 2...');
    let enTabla = false;
    for (let k = 0; k < lineas.length; k++) {
      if (/CANTIDAD|DESCRIPCI[OÓ]N/i.test(lineas[k])) { enTabla = true; continue; }
      if (!enTabla) continue;
      // Número solo en una línea = cantidad
      const soloNum = lineas[k].match(/^(\d+)\s*$/);
      if (soloNum && k + 1 < lineas.length) {
        const qty  = parseInt(soloNum[1], 10);
        const desc = lineas[k + 1].trim();
        if (qty >= 1 && qty <= 99999 && desc.length > 4) {
          items.push({ qty, desc });
          k++;
        }
      }
    }
  }

  return items;
}

// ── Servidor ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  // POST /pdf — extraer ítems de PDF usando IA ──────────────
  if (req.method === 'POST' && url === '/pdf') {
    let b2;
    try { b2 = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: 'Body inválido' }); return; }
    const { pdf, apiKey: iaKey } = b2;
    if (!pdf) { sendJSON(res, 400, { error: 'Falta el PDF' }); return; }

    log(C.cyan, '→ /pdf — extrayendo ítems con IA...');
    try {
      // Enviar el PDF a la IA como texto base64 para que extraiga los ítems
      // Decodificar base64 a texto para mandarlo a la IA más eficientemente
      let pdfTexto = '';
      try {
        const pdfBuf = Buffer.from(pdf, 'base64');
        // Extraer texto legible del PDF (caracteres ASCII imprimibles)
        pdfTexto = pdfBuf.toString('utf8', 0, 200000)
          .replace(/[^\x20-\x7E\xA0-\xFF\n\r]/g, ' ')
          .replace(/\s{3,}/g, '\n')
          .substring(0, 8000);
      } catch(e) { pdfTexto = pdf.substring(0, 3000); }

      const prompt = `Eres un asistente experto en documentos de licitación chilenos (Mercado Público).
Analiza el siguiente texto extraído de un PDF y extrae TODOS los productos/ítems con su cantidad.

Formatos comunes de tabla:
- ITEM | DESCRIPCION | Unidad | MARCA | CANT.  → usar CANT como qty
- CANTIDAD | DESCRIPCION/PRODUCTO              → usar CANTIDAD como qty  
- "30 UN Plancha zinc liso..."                 → 30 es qty, resto es desc
- Números al inicio de línea seguidos de texto → pueden ser qty

REGLAS:
- Extrae TODOS los ítems numerados o en tabla
- Si hay columna CANT o CANTIDAD, úsala como qty
- La descripción debe ser completa incluyendo especificaciones técnicas
- Ignora encabezados, totales, notas al pie y texto legal
- Si hay SKU o código de ítem, inclúyelo en el campo sku

Responde SOLO con JSON válido sin texto extra ni backticks:
{
  "items": [
    { "qty": número, "desc": "descripción completa", "sku": "código o vacío" }
  ]
}

TEXTO DEL PDF:
${pdfTexto}`;

      const { body: orBody } = await fetchOpenRouter(iaKey || '', prompt);
      if (orBody.error) throw new Error(orBody.error.message || 'Error IA');
      
      const text  = (orBody.choices?.[0]?.message?.content || '').replace(/\`\`\`json?/g,'').replace(/\`\`\`/g,'').trim();
      const data  = JSON.parse(text);
      const items = (data.items || []).filter(it => it.qty > 0 && it.desc?.length > 3);
      
      log(C.green, `✓ PDF IA: ${items.length} ítems extraídos`);
      sendJSON(res, 200, { items });
    } catch(e) {
      log(C.red, `✗ PDF error: ${e.message}`);
      // Fallback: intentar extracción básica
      try {
        const buffer = Buffer.from(pdf, 'base64');
        const items  = await extraerItemsPDF(buffer);
        sendJSON(res, 200, { items });
      } catch(e2) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    return;
  }

  // POST /cache-save — guardar resultado manual en caché
  if (req.method === 'POST' && url === '/cache-save') {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { sendJSON(res, 400, { error: 'Body inválido' }); return; }
    const { query, mejor } = b;
    if (!query || !mejor) { sendJSON(res, 400, { error: 'Faltan datos' }); return; }
    guardarEnCache(query, [mejor], mejor);
    log(C.green, `✓ Cache manual guardado: "${query}" $${mejor.precio}`);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /cache
  if (req.method === 'GET' && url === '/cache') {
    const cache = cargarCache();
    const entradas = Object.values(cache).map(v => ({
      producto : v.query,
      precio   : v.mejor?.precioVerificado || v.mejor?.precio || 0,
      tienda   : v.mejor?.tienda || '',
      link     : v.mejor?.link || '',
      fecha    : v.fecha,
      diasAtras: Math.round((Date.now() - (v.fechaMs||0)) / 86400000),
    })).sort((a,b) => a.diasAtras - b.diasAtras);
    sendJSON(res, 200, { total: entradas.length, entradas });
    return;
  }
  // DELETE /cache
  if (req.method === 'DELETE' && url === '/cache') {
    try { fs.writeFileSync(CACHE_FILE, '{}', 'utf8'); } catch(e) {}
    log(C.yellow, 'Cache limpiado');
    sendJSON(res, 200, { ok: true });
    return;
  }


  // ── GET /pdf — extraer ítems de PDF ──────────────────
  if (req.method === 'POST' && url === '/pdf') {
    let body2;
    try { const raw = await readBody(req); body2 = JSON.parse(raw); }
    catch { sendJSON(res, 400, { error: 'Body inválido' }); return; }

    const { pdf } = body2;
    if (!pdf) { sendJSON(res, 400, { error: 'Falta el PDF en base64' }); return; }

    try {
      const buffer = Buffer.from(pdf, 'base64');
      const items  = await extraerItemsPDF(buffer);
      log(C.green, `✓ PDF: ${items.length} ítems extraídos`);
      sendJSON(res, 200, { items });
    } catch(e) {
      log(C.red, `✗ PDF error: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (!['GET','POST','DELETE'].includes(req.method) || (req.method === 'POST' && !['/ia', '/buscar', '/pdf', '/cache-save'].includes(url))) {
    sendJSON(res, 404, { error: 'Ruta no encontrada' });
    return;
  }

  let body;
  try { const raw = await readBody(req); body = JSON.parse(raw); }
  catch { sendJSON(res, 400, { error: 'Body JSON inválido' }); return; }

  // ── POST /ia ─────────────────────────────────────────
  if (url === '/ia') {
    const { apiKey, prompt } = body;
    if (!apiKey) { sendJSON(res, 400, { error: 'API Key faltante' }); return; }
    log(C.cyan, `→ /ia (${(prompt||'').length} chars)`);
    try {
      const { body: orBody } = await fetchOpenRouter(apiKey, prompt);
      if (orBody.error) { sendJSON(res, 503, { error: orBody.error.message }); return; }
      const text = orBody.choices?.[0]?.message?.content || '';
      log(C.green, `✓ IA OK (${text.length} chars)`);
      sendJSON(res, 200, { text });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /buscar ──────────────────────────────────────
  if (url === '/buscar') {
    const { serpKey, apiKey, query } = body;
    if (!query) { sendJSON(res, 400, { error: 'Falta query' }); return; }
    log(C.cyan, `→ /buscar: "${query}"`);

    // Caché
    const hit = buscarEnCache(query);
    if (hit) {
      sendJSON(res, 200, { resultados: hit.resultados || [], mejor: hit.mejor, razon: '📦 Desde caché local', desdeCache: true });
      return;
    }
    if (!serpKey) { sendJSON(res, 400, { error: 'Serper API Key no configurada' }); return; }

    try {
      // PASO 0: Firebase — base de datos propia (gratis, instantáneo)
      log(C.dim, '  [0/3] Firebase (base propia)...');
      const fbRes = await buscarEnFirebase(query);
      log(C.dim, `  → Firebase: ${fbRes.length} resultados`);

      // Si Firebase encontró match con score alto (≥70), usarlo directamente
      if (fbRes.length > 0 && fbRes[0].score >= 70) {
        const mejor = { ...fbRes[0], verificado: true, stockConfirmado: true, precioVerificado: fbRes[0].precio };
        guardarEnCache(query, fbRes, mejor);
        log(C.green, `✓ Firebase match: "${mejor.titulo}" $${mejor.precio} (score ${fbRes[0].score})`);
        sendJSON(res, 200, { resultados: fbRes, mejor, razon: `📦 Base de datos propia (${fbRes[0].score}% coincidencia)`, desdeCache: false, desdeFirebase: true });
        return;
      }

      // PASO 1: Serper + MercadoLibre en paralelo
      log(C.dim, '  [1/3] Buscando en web...');
      const [serpRes, mlRes] = await Promise.all([
        fetchSerper(serpKey, query),
        buscarEnMercadoLibre(query),
      ]);

      const serpResultados = serpRes.body?.error ? [] : parsearResultados(serpRes.body);
      log(C.dim, `  → Serper: ${serpResultados.length} | ML: ${mlRes.length}`);

      // Ordenar: dominios .cl primero, luego el resto
      const serpOrdenados = [
        ...serpResultados.filter(r => r.esChile),
        ...serpResultados.filter(r => !r.esChile),
      ];
      // ML + Firebase como respaldo al final
      const candidatos = [
        ...serpOrdenados,
        ...mlRes.filter(ml => !serpOrdenados.some(s => s.link === ml.link)),
        ...fbRes.filter(fb => !serpOrdenados.some(s => s.link === fb.link)),
      ];

      if (!candidatos.length) {
        // Fallback: reintentar con query más corta (solo marca y modelo)
        log(C.yellow, '  ⚠ Sin resultados — reintentando con query reducida...');
        const queryCorta = limpiarQuery(query).split(' ').slice(0,5).join(' ');
        log(C.dim, `  → Query reducida: "${queryCorta}"`);
        const { body: serpBody2 } = await fetchSerper(serpKey, queryCorta);
        const candidatos2 = serpBody2.error ? [] : parsearResultados(serpBody2);
        if (!candidatos2.length) {
          sendJSON(res, 200, { resultados: [], mejor: null, razon: 'Sin resultados. Intenta simplificar la descripción.' });
          return;
        }
        // Usar candidatos del reintento
        candidatos.push(...candidatos2);
        log(C.dim, `  → Reintento: ${candidatos2.length} resultados`);
      }

      // PASO 2: IA elige el mejor
      log(C.dim, '  [2/3] IA eligiendo...');
      const eleccion = await elegirMejorConIA(apiKey, query, candidatos);
      log(C.dim, `  → Elegido: "${eleccion.resultado?.titulo?.substring(0,50)}" (${eleccion.razon})`);

      // PASO 3: Verificar precio en la página
      let mejor = { ...eleccion.resultado, verificado: false, stockConfirmado: eleccion.resultado.enStock };

      // ML: precio ya es exacto, no visitar página
      if (/mercadolibre\.cl/i.test(mejor.link || '')) {
        // ML: usar API oficial para precio exacto
        const mlData = await obtenerPrecioML(mejor.link);
        mejor.verificado      = true;
        mejor.stockConfirmado = mlData.enStock;
        if (mlData.precio > 0) {
          mejor.precioVerificado = mlData.precio;
          log(C.green, `  ✓ ML API precio: $${mlData.precio}`);
        } else {
          // Fallback: precio de la búsqueda
          mejor.precioVerificado = mejor.precio;
          log(C.yellow, `  ⚠ ML API sin precio, usando búsqueda: $${mejor.precio}`);
        }
      } else if (mejor.fuente === 'mercadolibre') {
        mejor.verificado = true;
        mejor.precioVerificado = mejor.precio;
        log(C.green, `  ✓ ML precio directo: $${mejor.precio}`);
      } else if (mejor.link && !esUrlListado(mejor.link)) {
        log(C.dim, `  [3/3] Verificando: ${mejor.link}`);
        const { ok, html } = await fetchPage(mejor.link);
        if (ok && html.length > 500) {
          const { precio, enStock } = extraerDePagina(html, mejor.link);
          mejor.verificado = true;
          mejor.stockConfirmado = enStock;
          if (precio > 1000) {
            mejor.precioVerificado = precio;
            log(C.green, `  ✓ Precio verificado: $${precio}`);
          } else if (mejor.precio > 1000) {
            mejor.precioVerificado = mejor.precio;
            log(C.yellow, `  ⚠ Sin precio en página, usando Serper: $${mejor.precio}`);
          }
        } else if (mejor.precio > 1000) {
          mejor.precioVerificado = mejor.precio;
          log(C.yellow, `  ⚠ Página no accesible, usando Serper: $${mejor.precio}`);
        }
      } else if (mejor.precio > 1000) {
        mejor.precioVerificado = mejor.precio;
      }

      guardarEnCache(query, candidatos, mejor);
      log(C.green, `✓ "${mejor.titulo?.substring(0,50)}" $${mejor.precioVerificado||mejor.precio}`);
      sendJSON(res, 200, { resultados: candidatos, mejor, razon: eleccion.razon, desdeCache: false });

    } catch(e) {
      log(C.red, `✗ Error: ${e.message}`);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`${C.bold}${C.green}  ✅  Cotizador PRO V9 — Servidor activo${C.reset}`);
  console.log(`${C.dim}  Escuchando en${C.reset} ${C.cyan}http://localhost:${PORT}${C.reset}`);
  console.log('');
  console.log(`${C.dim}  1. Abre ${C.yellow}Cotizador_Pro_V9.html${C.reset}${C.dim} en tu navegador`);
  console.log(`  2. Presiona ⚙️ e ingresa tus API Keys`);
  console.log(`  3. Para detener: Ctrl + C${C.reset}`);
  console.log('');
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n${C.red}  ✗ Puerto ${PORT} en uso. Cierra otra instancia.${C.reset}\n`);
  else console.error(`\n${C.red}  ✗ Error: ${err.message}${C.reset}\n`);
  process.exit(1);
});

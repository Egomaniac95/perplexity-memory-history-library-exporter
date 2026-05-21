#!/usr/bin/env node
/*
  Optimized Perplexity export cleaner.

  Goals:
  - Extract only useful AI-memory material: date, title, query, answer, compact sources.
  - Avoid huge pretty JSON and repeated raw metadata.
  - Preserve failed/empty threads separately.
  - Produce clean AI-memory chunks and, by default, one consolidated Markdown file.

  Usage:
    node tools/clean-perplexity-export.cjs <perplexity-threads.json>
    node tools/clean-perplexity-export.cjs <file> --sources 0 --no-md
    node tools/clean-perplexity-export.cjs <file> --sources 3 --pretty --chunk-size 1200000
*/

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SOURCES = 0;
const DEFAULT_CHUNK_SIZE = 850_000;

function parseArgs(argv) {
  const opts = {
    inputFile: '',
    outDir: '',
    maxSources: Number(process.env.MAX_SOURCES || DEFAULT_MAX_SOURCES),
    keepSources: process.env.KEEP_SOURCES === '1',
    pretty: process.env.CLEAN_PRETTY === '1',

    // New default for this project: only AI-importable memory chunks.
    writeMd: process.env.WRITE_MD === '1',
    writeMemoryMd: process.env.WRITE_MEMORY_MD === '0' ? false : true,
    writeMemorySingle: process.env.WRITE_SINGLE_MEMORY === '0' ? false : true,
    writeCleanJson: process.env.WRITE_CLEAN_JSON === '1',
    writeIndex: process.env.WRITE_INDEX === '1',
    writeSummary: process.env.WRITE_SUMMARY === '1',
    writeState: process.env.WRITE_STATE === '0' ? false : true,
    chunksOnly: process.env.CHUNKS_ONLY === '0' ? false : true,

    chunkSize: Number(process.env.MEMORY_CHUNK_SIZE || DEFAULT_CHUNK_SIZE),
    filterNoise: process.env.FILTER_NOISE === '1',
    minChars: Number(process.env.MIN_CHARS || 80),
    maxAnswerChars: Number(process.env.MAX_ANSWER_CHARS || 0),
    includeDates: process.env.INCLUDE_DATES === '0' ? false : true,
    deleteOutDirFirst: process.env.DELETE_OUT_DIR_FIRST === '1',
  };

  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (!arg) continue;

    if (!opts.inputFile && !arg.startsWith('--')) {
      opts.inputFile = arg;
      continue;
    }

    if (arg === '--out') {
      opts.outDir = args.shift() || '';
      continue;
    }

    if (arg === '--sources') {
      const raw = args.shift();
      const n = Number(raw);
      opts.maxSources = Number.isFinite(n) ? Math.max(0, n) : DEFAULT_MAX_SOURCES;
      opts.keepSources = opts.maxSources > 0;
      continue;
    }

    if (arg === '--no-sources') {
      opts.keepSources = false;
      opts.maxSources = 0;
      continue;
    }

    if (arg === '--pretty') {
      opts.pretty = true;
      continue;
    }

    if (arg === '--no-pretty') {
      opts.pretty = false;
      continue;
    }

    if (arg === '--chunks-only') {
      opts.chunksOnly = true;
      opts.writeMd = false;
      opts.writeCleanJson = false;
      opts.writeIndex = false;
      opts.writeSummary = false;
      opts.writeMemoryMd = true;
      opts.writeMemorySingle = true;
      continue;
    }

    if (arg === '--full-output') {
      opts.chunksOnly = false;
      opts.writeMd = true;
      opts.writeCleanJson = true;
      opts.writeIndex = true;
      opts.writeSummary = true;
      opts.writeMemoryMd = true;
      opts.writeMemorySingle = true;
      continue;
    }

    if (arg === '--clean-json') {
      opts.writeCleanJson = true;
      opts.chunksOnly = false;
      continue;
    }

    if (arg === '--index') {
      opts.writeIndex = true;
      opts.chunksOnly = false;
      continue;
    }

    if (arg === '--summary') {
      opts.writeSummary = true;
      opts.chunksOnly = false;
      continue;
    }

    if (arg === '--no-state') {
      opts.writeState = false;
      continue;
    }

    if (arg === '--state') {
      opts.writeState = true;
      continue;
    }

    if (arg === '--no-md') {
      opts.writeMd = false;
      continue;
    }

    if (arg === '--md') {
      opts.writeMd = true;
      opts.chunksOnly = false;
      continue;
    }

    if (arg === '--single-memory') {
      opts.writeMemorySingle = true;
      opts.chunksOnly = false;
      continue;
    }

    if (arg === '--no-single-memory') {
      opts.writeMemorySingle = false;
      continue;
    }

    if (arg === '--no-memory-md') {
      opts.writeMemoryMd = false;
      continue;
    }

    if (arg === '--filter-noise') {
      opts.filterNoise = true;
      continue;
    }

    if (arg === '--no-filter-noise') {
      opts.filterNoise = false;
      continue;
    }

    if (arg === '--min-chars') {
      const raw = args.shift();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) opts.minChars = Math.floor(n);
      continue;
    }

    if (arg === '--max-answer-chars') {
      const raw = args.shift();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) opts.maxAnswerChars = Math.floor(n);
      continue;
    }

    if (arg === '--chunk-size') {
      const raw = args.shift();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 100_000) opts.chunkSize = n;
      continue;
    }

    if (arg === '--no-dates') {
      opts.includeDates = false;
      continue;
    }

    if (arg === '--delete-out-dir-first') {
      opts.deleteOutDirFirst = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  opts.maxSources = Math.max(0, Math.floor(opts.maxSources || 0));
  opts.keepSources = opts.keepSources && opts.maxSources > 0;
  opts.chunkSize = Math.max(100_000, Math.floor(opts.chunkSize || DEFAULT_CHUNK_SIZE));
  opts.minChars = Math.max(0, Math.floor(opts.minChars || 0));
  opts.maxAnswerChars = Math.max(0, Math.floor(opts.maxAnswerChars || 0));

  // In chunks-only mode, enforce exactly the requested final product.
  if (opts.chunksOnly) {
    opts.writeMd = false;
    opts.writeCleanJson = false;
    opts.writeIndex = false;
    opts.writeSummary = false;
    opts.writeMemoryMd = true;
  }

  return opts;
}

function printHelp() {
  console.log(`Uso:
  node tools\\clean-perplexity-export.cjs <perplexity-threads.json> [opciones]

Modo recomendado para memoria limpia:
  node tools\\clean-perplexity-export.cjs <perplexity-threads.json> --chunks-only --no-sources

Opciones principales:
  --out <dir>              Carpeta de salida. Default: <carpeta input>\\clean_export
  --chunks-only            Solo genera memory_chunks\\. No JSON, no JSONL, no md individuales, no perplexity-memory.md
  --single-memory          Genera perplexity-memory.md Ãºnico junto con memory_chunks\
  --no-sources             Omite fuentes, URLs externas y snippets de bÃºsqueda. Recomendado
  --sources <n>            Conserva mÃ¡ximo n fuentes por turno. Default: 0
  --filter-noise           Excluye hilos cortos/efÃ­meros con heurÃ­stica conservadora
  --min-chars <n>          Umbral usado por --filter-noise. Default: 80
  --max-answer-chars <n>   Trunca respuestas largas. Default: 0 = no truncar
  --chunk-size <n>         TamaÃ±o aprox. por chunk Markdown. Default: ${DEFAULT_CHUNK_SIZE}
  --no-dates               No incluye fecha resumida en cada hilo
  --delete-out-dir-first   Borra la carpeta de salida antes de generar

Opciones de salida adicional:
  --full-output            Genera JSON, JSONL, index, summary, md individuales y memoria completa
  --clean-json             TambiÃ©n genera perplexity-clean.json/jsonl
  --index                  TambiÃ©n genera index.tsv
  --summary                TambiÃ©n genera summary.json
  --md                     TambiÃ©n genera md\\ con un Markdown por hilo

Variables de entorno equivalentes:
  CHUNKS_ONLY=1 MAX_SOURCES=0 KEEP_SOURCES=0 WRITE_MD=0 WRITE_SINGLE_MEMORY=1 FILTER_NOISE=0 MEMORY_CHUNK_SIZE=${DEFAULT_CHUNK_SIZE}
`);
}

function safeParse(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function microsToIso(us) {
  const n = Number(us);
  if (!Number.isFinite(n) || n <= 0) return '';

  try {
    return new Date(Math.floor(n / 1000)).toISOString();
  } catch {
    return '';
  }
}

function minIso(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a <= b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a >= b ? a : b;
}

function normalizeText(value) {
  if (value == null) return '';

  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function compactInlineText(value, maxLen = 240) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)).trimEnd() + 'â€¦';
}

function stripMarkdownNoise(text) {
  return normalizeText(text)
    // Remove Perplexity/Web-style numeric citation marks left in answers.
    .replace(/\[(?:\d+|\d+(?:,\s*\d+)*)\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function truncateMultiline(text, maxLen) {
  const clean = stripMarkdownNoise(text);
  if (!maxLen || clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 40)).trimEnd() + '\n\n[Response truncated by cleaning limit]';
}

function isoDateOnly(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function likelyPersonalOrProjectSignal(text) {
  return /\b(mi|mis|me|nosotros|nuestra|nuestro|esposa|wendy|madre|mam[aÃ¡]|hermano|jefa|supervisora|trabajo|laboratorio|maestr[iÃ­]a|tesis|tsp|unmsm|serums|perplexity-exporter|proyecto|c[oÃ³]digo|script|python|node|powershell|windows|laptop|asus|ollama|gemini|chatgpt)\b/i.test(text);
}

function isLikelyNoiseThread(thread, opts) {
  if (!opts.filterNoise) return false;

  const text = normalizeText([
    thread.title || '',
    ...(thread.turns || []).flatMap((turn) => [turn.user || '', turn.assistant || '']),
  ].join('\n'));

  const userText = normalizeText((thread.turns || []).map((turn) => turn.user || '').join('\n'));
  const chars = Number(thread.chars || 0);

  if (chars < opts.minChars && !likelyPersonalOrProjectSignal(userText)) return true;

  // Ephemeral lookup/product/news/price queries are usually bad long-term memory.
  const ephemeral = /\b(precio|precios|oferta|stock|vuelos?|pasajes?|ida y vuelta|d[oÃ³]nde ver|netflix|estrena|estreno|cap[iÃ­]tulos?|manga|manhwa|manwha|drama|receta|comprar|tienda|farmacia|inkafarma|mifarma|tottus|falabella|kayak|sky airline|jet ?smart)\b/i;

  if (ephemeral.test(userText) && !likelyPersonalOrProjectSignal(userText)) return true;

  // Very short definitional lookups with no personal/project signal.
  if (userText.length < 60 && /^(qu[eÃ©]|cu[aÃ¡]l|como|c[oÃ³]mo|busca|dame|es cierto|significa)\b/i.test(userText) && !likelyPersonalOrProjectSignal(userText)) {
    return true;
  }

  return false;
}

function sanitizeFilename(name) {
  const clean = String(name || 'untitled')
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return clean || 'untitled';
}

function stableTurnKey(turn) {
  return `${normalizeText(turn.user).slice(0, 400)}\u241F${normalizeText(turn.assistant).slice(0, 800)}`;
}

function normalizeUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';

  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function getEntries(thread) {
  if (Array.isArray(thread?.entries)) return thread.entries;
  if (Array.isArray(thread?.data?.entries)) return thread.data.entries;
  if (Array.isArray(thread?.thread?.entries)) return thread.thread.entries;
  return [];
}

function getStepsFromEntry(entry) {
  const candidates = [];

  if (Array.isArray(entry?.steps)) candidates.push(entry.steps);
  if (Array.isArray(entry?.data?.steps)) candidates.push(entry.data.steps);

  if (typeof entry?.text === 'string') {
    const parsed = safeParse(entry.text);
    if (Array.isArray(parsed)) candidates.push(parsed);
    if (parsed && Array.isArray(parsed.steps)) candidates.push(parsed.steps);
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  return [];
}

function sourceFromResult(result) {
  if (!result || typeof result !== 'object') return null;

  const url = normalizeUrl(result.url || result.link || result.href || '');
  const name = compactInlineText(result.name || result.title || result.domain_name || result?.meta_data?.domain_name || '', 140);
  const snippet = compactInlineText(result.snippet || result.description || result?.meta_data?.description || '', 260);
  const publishedDate = firstNonEmpty(
    result?.published_date,
    result?.timestamp,
    result?.date,
    result?.meta_data?.published_date,
    result?.meta_data?.date
  );

  if (!url && !name && !snippet) return null;

  const source = {};
  if (name) source.name = name;
  if (url) source.url = url;
  if (publishedDate) source.published_date = publishedDate;
  if (snippet) source.snippet = snippet;
  return source;
}

function dedupeSources(sources, maxSources) {
  if (!maxSources) return [];

  const seen = new Set();
  const clean = [];

  for (const source of sources || []) {
    const normalized = sourceFromResult(source);
    if (!normalized) continue;

    const key = normalized.url || normalized.name || normalized.snippet;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push(normalized);

    if (clean.length >= maxSources) break;
  }

  return clean;
}

function extractSourcesFromSteps(steps, maxSources) {
  if (!maxSources) return [];

  const sources = [];

  for (const step of steps || []) {
    const stepType = step?.step_type || step?.type;
    const content = step?.content || step?.data || {};

    if (stepType === 'SEARCH_RESULTS' && Array.isArray(content.web_results)) {
      for (const result of content.web_results) sources.push(result);
    }

    if (Array.isArray(content.sources)) {
      for (const result of content.sources) sources.push(result);
    }

    if (Array.isArray(content.web_results)) {
      for (const result of content.web_results) sources.push(result);
    }
  }

  return dedupeSources(sources, maxSources);
}

function extractStructuredMarkdown(parsed) {
  if (!isPlainObject(parsed)) return '';

  if (Array.isArray(parsed.structured_answer)) {
    const markdown = parsed.structured_answer.find(
      (x) => x && x.type === 'markdown' && typeof x.text === 'string' && x.text.trim()
    );
    if (markdown?.text) return normalizeText(markdown.text);
  }

  return firstNonEmpty(parsed.answer, parsed.text, parsed.markdown, parsed.content);
}

function extractAnswerFromFinal(finalStep, maxSources) {
  const content = finalStep?.content || finalStep?.data || {};
  const answerField = content.answer ?? content.text ?? content.markdown ?? finalStep?.text ?? '';
  const parsed = safeParse(answerField);

  if (parsed && isPlainObject(parsed)) {
    const answer = normalizeText(extractStructuredMarkdown(parsed));
    const sources = Array.isArray(parsed.web_results) ? dedupeSources(parsed.web_results, maxSources) : [];
    return { answer, sources };
  }

  if (typeof answerField === 'string') {
    return { answer: normalizeText(answerField), sources: [] };
  }

  if (isPlainObject(answerField)) {
    return { answer: normalizeText(extractStructuredMarkdown(answerField)), sources: [] };
  }

  return { answer: '', sources: [] };
}

function extractConversationFromEntry(entry, opts) {
  const steps = getStepsFromEntry(entry);

  const initialStep = steps.find((s) => {
    const type = s?.step_type || s?.type;
    return type === 'INITIAL_QUERY';
  });

  const query = normalizeText(firstNonEmpty(
    entry?.query_str,
    entry?.prompt,
    entry?.question,
    entry?.query,
    initialStep?.content?.query,
    initialStep?.query
  ));

  const finalSteps = steps.filter((s) => {
    const type = s?.step_type || s?.type;
    return type === 'FINAL';
  });

  const lastFinal = finalSteps[finalSteps.length - 1];
  const extractedFinal = lastFinal
    ? extractAnswerFromFinal(lastFinal, opts.keepSources ? opts.maxSources : 0)
    : { answer: '', sources: [] };

  const stepSources = opts.keepSources ? extractSourcesFromSteps(steps, opts.maxSources) : [];
  const sources = opts.keepSources
    ? dedupeSources([...(extractedFinal.sources || []), ...(stepSources || [])], opts.maxSources)
    : [];

  const createdAt = firstNonEmpty(entry?.created_datetime, microsToIso(entry?.created_us));
  const updatedAt = firstNonEmpty(entry?.updated_datetime, microsToIso(entry?.updated_us));

  const turn = {
    n: 0,
    user: query,
    assistant: normalizeText(extractedFinal.answer),
  };

  if (createdAt) turn.created_at = createdAt;
  if (updatedAt) turn.updated_at = updatedAt;
  if (sources.length > 0) turn.sources = sources;

  turn.chars = String(turn.user || '').length + String(turn.assistant || '').length;
  turn.step_count = steps.length;

  return turn;
}

function cleanThread(thread, index, opts) {
  const entries = getEntries(thread);
  const firstEntry = entries[0] || {};

  const id = firstNonEmpty(
    thread?.__export?.id,
    firstEntry?.thread_url_slug,
    firstEntry?.backend_uuid,
    thread?.thread_url_slug,
    thread?.id,
    thread?.uuid
  );

  const titleCandidate = firstNonEmpty(
    thread?.thread_metadata?.title,
    firstEntry?.thread_title,
    thread?.title,
    firstEntry?.query_str,
    id,
    `thread_${index + 1}`
  );

  const title = normalizeText(titleCandidate).replace(/\s+/g, ' ').slice(0, 300) || `thread_${index + 1}`;

  const createdAt = firstNonEmpty(
    thread?.thread_metadata?.created_at,
    firstEntry?.created_datetime,
    microsToIso(firstEntry?.created_us)
  );

  const updatedAt = firstNonEmpty(
    thread?.thread_metadata?.updated_at,
    firstEntry?.updated_datetime,
    microsToIso(firstEntry?.updated_us)
  );

  const url = firstNonEmpty(
    thread?.__export?.url,
    thread?.url,
    id ? `https://www.perplexity.ai/search/${id}` : ''
  );

  const model = firstNonEmpty(
    firstEntry?.display_model,
    firstEntry?.user_selected_model,
    firstEntry?.mode
  );

  const rawTurns = entries.map((entry) => extractConversationFromEntry(entry, opts));
  const seenTurns = new Set();
  const turns = [];

  for (const rawTurn of rawTurns) {
    if (!rawTurn.user && !rawTurn.assistant) continue;
    const key = stableTurnKey(rawTurn);
    if (seenTurns.has(key)) continue;
    seenTurns.add(key);

    rawTurn.n = turns.length + 1;
    turns.push(rawTurn);
  }

  const chars = turns.reduce((sum, turn) => sum + Number(turn.chars || 0), 0);
  const sourceCount = turns.reduce((sum, turn) => sum + (Array.isArray(turn.sources) ? turn.sources.length : 0), 0);

  const cleaned = {
    id,
    title,
    created_at: createdAt || '',
    updated_at: updatedAt || '',
    turn_count: turns.length,
    chars,
    turns,
  };

  if (url) cleaned.url = url;
  if (model) cleaned.model = model;
  if (sourceCount > 0) cleaned.source_count = sourceCount;

  return cleaned;
}

function mergeDuplicateThreads(cleaned) {
  const out = [];
  const byKey = new Map();
  let duplicateThreadIds = 0;

  for (const thread of cleaned) {
    const key = isUuid(thread.id) ? thread.id : `__index_${out.length}`;

    if (!byKey.has(key)) {
      byKey.set(key, thread);
      out.push(thread);
      continue;
    }

    duplicateThreadIds++;
    const existing = byKey.get(key);

    if ((!existing.title || isUuid(existing.title)) && thread.title) existing.title = thread.title;
    existing.created_at = minIso(existing.created_at, thread.created_at);
    existing.updated_at = maxIso(existing.updated_at, thread.updated_at);
    if (!existing.url && thread.url) existing.url = thread.url;
    if (!existing.model && thread.model) existing.model = thread.model;

    const seenTurns = new Set((existing.turns || []).map(stableTurnKey));
    for (const turn of thread.turns || []) {
      const turnKey = stableTurnKey(turn);
      if (seenTurns.has(turnKey)) continue;
      seenTurns.add(turnKey);
      const copy = { ...turn, n: existing.turns.length + 1 };
      existing.turns.push(copy);
    }

    existing.turn_count = existing.turns.length;
    existing.chars = existing.turns.reduce((sum, turn) => sum + Number(turn.chars || 0), 0);
    existing.source_count = existing.turns.reduce(
      (sum, turn) => sum + (Array.isArray(turn.sources) ? turn.sources.length : 0),
      0
    );
    if (!existing.source_count) delete existing.source_count;
  }

  return { threads: out, duplicateThreadIds };
}

function toThreadMarkdown(thread, includeSources) {
  const lines = [];

  lines.push(`# ${thread.title || 'Untitled'}`);
  lines.push('');
  if (thread.created_at) lines.push(`- Creado: ${thread.created_at}`);
  if (thread.updated_at) lines.push(`- Actualizado: ${thread.updated_at}`);
  if (thread.id) lines.push(`- ID: ${thread.id}`);
  if (thread.url) lines.push(`- URL: ${thread.url}`);
  if (thread.model) lines.push(`- Modelo: ${thread.model}`);
  lines.push('');

  for (const turn of thread.turns || []) {
    lines.push(`## Turno ${turn.n || ''}`.trim());
    lines.push('');

    if (turn.created_at || turn.updated_at) {
      const dates = [];
      if (turn.created_at) dates.push(`creado: ${turn.created_at}`);
      if (turn.updated_at) dates.push(`actualizado: ${turn.updated_at}`);
      lines.push(`_${dates.join(' Â· ')}_`);
      lines.push('');
    }

    if (turn.user) {
      lines.push('### Usuario');
      lines.push('');
      lines.push(turn.user);
      lines.push('');
    }

    if (turn.assistant) {
      lines.push('### Asistente');
      lines.push('');
      lines.push(turn.assistant);
      lines.push('');
    }

    if (includeSources && Array.isArray(turn.sources) && turn.sources.length > 0) {
      lines.push('### Fuentes principales');
      lines.push('');
      turn.sources.forEach((source, i) => {
        const label = source.name || source.url || `Fuente ${i + 1}`;
        const url = source.url ? ` â€” ${source.url}` : '';
        const date = source.published_date ? ` (${source.published_date})` : '';
        const snippet = source.snippet ? ` â€” ${source.snippet}` : '';
        lines.push(`${i + 1}. ${label}${date}${url}${snippet}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

function toMemoryMarkdownHeader(stats) {
  return [
    '# Memoria limpia exportada de Perplexity',
    '',
    `- Hilos incluidos: ${stats.final_threads}`,
    `- Turnos incluidos: ${stats.final_turns}`,
    `- Fuentes incluidas: ${stats.max_sources}`,
    `- Generado: ${new Date().toISOString()}`,
    '',
    'Nota: se omitieron metadatos tÃ©cnicos como ID, URL del hilo, modelo, fuentes web y archivos Markdown individuales.',
    '',
    '---',
    '',
  ].join('\n');
}

function toMemoryThreadMarkdown(thread, opts) {
  const lines = [];
  const date = opts.includeDates ? isoDateOnly(thread.created_at || thread.updated_at) : '';
  const title = stripMarkdownNoise(thread.title || 'Sin tÃ­tulo').replace(/\n+/g, ' ').slice(0, 220);

  lines.push(`## ${date ? `${date} â€” ` : ''}${title}`);
  lines.push('');

  for (const turn of thread.turns || []) {
    const user = stripMarkdownNoise(turn.user || '');
    const assistant = truncateMultiline(turn.assistant || '', opts.maxAnswerChars);
    if (!user && !assistant) continue;

    lines.push(`### Turno ${turn.n || ''}`.trim());
    lines.push('');

    if (user) {
      lines.push('**Usuario**');
      lines.push('');
      lines.push(user);
      lines.push('');
    }

    if (assistant) {
      lines.push('**Asistente**');
      lines.push('');
      lines.push(assistant);
      lines.push('');
    }

    if (opts.keepSources && Array.isArray(turn.sources) && turn.sources.length > 0) {
      lines.push('**Fuentes conservadas**');
      lines.push('');
      turn.sources.forEach((source, i) => {
        const label = source.name || source.url || `Fuente ${i + 1}`;
        const url = source.url ? ` â€” ${source.url}` : '';
        const date = source.published_date ? ` (${source.published_date})` : '';
        lines.push(`${i + 1}. ${label}${date}${url}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

function writeMemoryChunks(outDir, threads, stats, opts) {
  if (!opts.writeMemoryMd) return [];

  const chunksDir = path.join(outDir, 'memory_chunks');
  fs.mkdirSync(chunksDir, { recursive: true });

  const chunkPaths = [];
  let chunkIndex = 1;
  let current = '';

  function chunkHeader(index) {
    return [
      `# Perplexity memory chunk ${String(index).padStart(3, '0')}`,
      '',
      'Contenido limpio para importar como contexto a otra IA.',
      '',
      '---',
      '',
    ].join('\n');
  }

  function flush() {
    if (!current.trim()) return;
    const filename = `memory_${String(chunkIndex).padStart(3, '0')}.md`;
    const filePath = path.join(chunksDir, filename);
    const body = `${chunkHeader(chunkIndex)}${current.trim()}\n`;
    fs.writeFileSync(filePath, body, 'utf8');
    chunkPaths.push(filePath);
    chunkIndex++;
    current = '';
  }

  for (const thread of threads) {
    const md = `${toMemoryThreadMarkdown(thread, opts)}\n---\n\n`;
    if (current.length > 0 && current.length + md.length > opts.chunkSize) flush();
    current += md;
  }

  flush();

  if (opts.writeMemorySingle) {
    const singlePath = path.join(outDir, 'perplexity-memory.md');
    const single = [toMemoryMarkdownHeader(stats), ...threads.map((t) => `${toMemoryThreadMarkdown(t, opts)}\n---\n\n`)].join('');
    fs.writeFileSync(singlePath, single.trim() + '\n', 'utf8');
    return [singlePath, ...chunkPaths];
  }

  return chunkPaths;
}

function loadInput(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];

  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.threads)) return parsed.threads;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.items)) return parsed.items;

    return [parsed];
  }

  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, value, pretty) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.inputFile) {
    console.error('Uso: node tools\\clean-perplexity-export.cjs <archivo_exportado.json>');
    process.exit(1);
  }

  if (!fs.existsSync(opts.inputFile)) {
    console.error('No existe el archivo:', opts.inputFile);
    process.exit(1);
  }

  const inputFile = path.resolve(opts.inputFile);
  const outDir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.join(path.dirname(inputFile), 'clean_export');
  const mdDir = path.join(outDir, 'md');

  if (opts.deleteOutDirFirst && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  fs.mkdirSync(outDir, { recursive: true });
  if (opts.writeMd) fs.mkdirSync(mdDir, { recursive: true });

  console.log('ðŸ§¹ Cleaning Perplexity export...');
  console.log('Input:', inputFile);
  console.log('Output:', outDir);
  console.log(`Mode: ${opts.chunksOnly ? 'chunks-only' : 'custom'}`);
  console.log(`Sources per turn: ${opts.keepSources ? opts.maxSources : 0}`);
  console.log(`Individual chat MD: ${opts.writeMd ? 'yes' : 'no'}`);
  console.log(`Single perplexity-memory.md: ${opts.writeMemorySingle ? 'yes' : 'no'}`);
  console.log(`Clean JSON/JSONL: ${opts.writeCleanJson ? 'yes' : 'no'}`);
  console.log(`Export state: ${opts.writeState ? 'yes' : 'no'}`);
  console.log(`Noise filter: ${opts.filterNoise ? 'yes' : 'no'}`);

  const input = loadInput(inputFile);
  const rawCleaned = input.map((thread, index) => cleanThread(thread, index, opts));
  const merged = mergeDuplicateThreads(rawCleaned);
  const cleaned = merged.threads;

  const withContent = cleaned.filter((x) => x.chars > 0).length;
  const emptyThreads = cleaned.filter((x) => x.chars <= 0);
  const includedThreads = cleaned.filter((x) => x.chars > 0 && !isLikelyNoiseThread(x, opts));
  const excludedByNoise = cleaned.filter((x) => x.chars > 0 && isLikelyNoiseThread(x, opts));

  const totalChars = cleaned.reduce((sum, x) => sum + Number(x.chars || 0), 0);
  const finalChars = includedThreads.reduce((sum, x) => sum + Number(x.chars || 0), 0);
  const totalTurns = cleaned.reduce((sum, x) => sum + Number(x.turn_count || 0), 0);
  const finalTurns = includedThreads.reduce((sum, x) => sum + Number(x.turn_count || 0), 0);
  const totalSources = cleaned.reduce((sum, x) => sum + Number(x.source_count || 0), 0);

  const stats = {
    generated_at: new Date().toISOString(),
    input_file: inputFile,
    total_input_items: input.length,
    total_threads: cleaned.length,
    duplicate_thread_ids_merged: merged.duplicateThreadIds,
    with_content: withContent,
    empty_threads: emptyThreads.length,
    excluded_by_noise_filter: excludedByNoise.length,
    final_threads: includedThreads.length,
    total_turns: totalTurns,
    final_turns: finalTurns,
    total_chars: totalChars,
    final_chars: finalChars,
    total_sources_found_before_omission: totalSources,
    max_sources: opts.keepSources ? opts.maxSources : 0,
    chunks_only: opts.chunksOnly,
    wrote_individual_md: opts.writeMd,
    wrote_memory_single: opts.writeMemorySingle,
    wrote_clean_json: opts.writeCleanJson,
    wrote_state: opts.writeState,
  };

  const generatedPaths = [];

  const jsonPath = path.join(outDir, 'perplexity-clean.json');
  const jsonlPath = path.join(outDir, 'perplexity-clean.jsonl');
  const indexPath = path.join(outDir, 'index.tsv');
  const summaryPath = path.join(outDir, 'summary.json');
  const emptyPath = path.join(outDir, 'empty-or-failed-threads.jsonl');
  const excludedPath = path.join(outDir, 'excluded-by-noise-filter.jsonl');
  const statePath = path.join(outDir, 'perplexity-export-state.json');

  if (opts.writeCleanJson) {
    writeJson(jsonPath, includedThreads, opts.pretty);
    fs.writeFileSync(jsonlPath, includedThreads.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    generatedPaths.push(jsonPath, jsonlPath);
  }

  if (opts.writeSummary) {
    writeJson(summaryPath, stats, true);
    generatedPaths.push(summaryPath);
  }

  if (!opts.chunksOnly && emptyThreads.length > 0) {
    fs.writeFileSync(emptyPath, emptyThreads.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    generatedPaths.push(emptyPath);
  } else if (fs.existsSync(emptyPath)) {
    fs.rmSync(emptyPath, { force: true });
  }

  if (!opts.chunksOnly && opts.filterNoise && excludedByNoise.length > 0) {
    fs.writeFileSync(excludedPath, excludedByNoise.map((x) => JSON.stringify({ id: x.id, title: x.title, chars: x.chars })).join('\n') + '\n', 'utf8');
    generatedPaths.push(excludedPath);
  } else if (fs.existsSync(excludedPath)) {
    fs.rmSync(excludedPath, { force: true });
  }

  if (opts.writeIndex) {
    const indexLines = [
      ['n', 'title', 'created_at', 'turn_count', 'chars'].join('\t'),
    ];

    includedThreads.forEach((thread, i) => {
      indexLines.push([
        i + 1,
        String(thread.title || '').replace(/\t/g, ' '),
        isoDateOnly(thread.created_at || thread.updated_at),
        thread.turn_count || 0,
        thread.chars || 0,
      ].join('\t'));
    });

    fs.writeFileSync(indexPath, indexLines.join('\n') + '\n', 'utf8');
    generatedPaths.push(indexPath);
  }

  if (opts.writeMd) {
    includedThreads.forEach((thread, i) => {
      const filename = `${String(i + 1).padStart(5, '0')}_${sanitizeFilename(thread.title)}.md`;
      fs.writeFileSync(path.join(mdDir, filename), toThreadMarkdown(thread, opts.keepSources), 'utf8');
    });
    generatedPaths.push(mdDir);
  }


  if (opts.writeState) {
    const threadIds = includedThreads.map((thread) => thread.id).filter(isUuid);
    const state = {
      version: 1,
      generated_at: new Date().toISOString(),
      source: 'clean-perplexity-export.cjs',
      input_file: inputFile,
      latest_thread_id: threadIds[0] || '',
      latest_thread_title: includedThreads[0]?.title || '',
      latest_thread_created_at: includedThreads[0]?.created_at || '',
      total_known_thread_ids: threadIds.length,
      thread_ids: threadIds,
    };
    writeJson(statePath, state, true);
    generatedPaths.push(statePath);
  }

  const memoryPaths = writeMemoryChunks(outDir, includedThreads, stats, opts);
  generatedPaths.push(...memoryPaths);

  const sizeOf = (filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  };

  console.log('');
  console.log('âœ… Cleanup completed');
  console.log('Total input items:', input.length);
  console.log('Threads finales leÃ­dos:', cleaned.length);
  console.log('IDs duplicados fusionados:', merged.duplicateThreadIds);
  console.log('Con contenido:', withContent);
  console.log('Sin contenido / fallidos:', emptyThreads.length);
  if (opts.filterNoise) console.log('Excluidos por filtro de ruido:', excludedByNoise.length);
  console.log('Incluidos en chunks:', includedThreads.length);
  console.log('Turnos incluidos:', finalTurns);
  console.log('Caracteres incluidos:', finalChars);
  console.log('Fuentes omitidas/conservadas:', opts.keepSources ? totalSources : 0);
  console.log('');
  console.log('Archivos generados:');
  if (memoryPaths.length === 0) console.log('(ninguno)');
  for (const p of generatedPaths.slice(0, 12)) {
    const stat = fs.existsSync(p) ? fs.statSync(p) : null;
    if (stat?.isFile()) console.log(`${p} (${(sizeOf(p) / 1024 / 1024).toFixed(2)} MB)`);
    else console.log(p);
  }
  if (generatedPaths.length > 12) console.log(`... and  more paths`);
}

main();



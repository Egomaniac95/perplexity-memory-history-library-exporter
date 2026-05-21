#!/usr/bin/env node
/*
  Runs the built Perplexity exporter and then leaves memory_chunks/ plus perplexity-memory.md by default.

  Usage from project root:
    pnpm build
    node tools\\run-export-and-clean.cjs

  Optional env:
    PEX_KEEP_RAW=1       Keep raw JSON/JSONL files after cleaning.
    PEX_FILTER_NOISE=1   Apply conservative noise filtering.
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findLatestExportJson(root) {
  const candidates = [];

  function addIfFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
      candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // ignore
    }
  }

  addIfFile(path.join(root, 'perplexity-threads.json'));

  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;
    if (!/^perplexity-export-/i.test(name)) continue;

    addIfFile(path.join(full, 'perplexity-threads.json'));
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return candidates[0]?.filePath || '';
}


function findLatestMemoryChunksDir(root) {
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory() || !/^perplexity-export-/i.test(name)) continue;
      const chunks = path.join(full, 'memory_chunks');
      if (!fs.existsSync(chunks) || !fs.statSync(chunks).isDirectory()) continue;
      candidates.push({ dir: chunks, mtimeMs: fs.statSync(chunks).mtimeMs });
    } catch {
      // ignore
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.dir || '';
}

function rmIfExists(filePath) {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function cleanOldOutputs(exportDir) {
  for (const name of [
    'memory_chunks',
    'clean_export',
    'md',
    'perplexity-clean.json',
    'perplexity-clean.jsonl',
    'perplexity-memory.md',
    'index.tsv',
    'empty-or-failed-threads.jsonl',
    'excluded-by-noise-filter.jsonl',
  ]) {
    rmIfExists(path.join(exportDir, name));
  }
}

function removeRawArtifacts(exportDir) {
  for (const name of [
    'perplexity-threads.json',
    'perplexity-threads.jsonl',
    'perplexity-threads.raw.jsonl',
    'threads-index.json',
    'failed-or-empty-threads.jsonl',
    'summary.json',
  ]) {
    rmIfExists(path.join(exportDir, name));
  }
}

function main() {
  const root = process.cwd();
  const distIndex = path.join(root, 'dist', 'index.js');
  const cleaner = path.join(root, 'tools', 'clean-perplexity-export.cjs');

  if (!fs.existsSync(distIndex)) {
    console.error('No existe dist\\index.js. Ejecuta primero: pnpm build');
    process.exit(1);
  }

  if (!fs.existsSync(cleaner)) {
    console.error('No existe tools\\clean-perplexity-export.cjs. Copia primero el cleaner optimizado en tools.');
    process.exit(1);
  }

  console.log('🚀 Running exporter...');
  const exportResult = spawnSync(process.execPath, [distIndex], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  if (exportResult.status !== 0) {
    console.error(`⚠️ Exporter terminó con código ${exportResult.status}. Intentaré limpiar el último export si existe.`);
  }

  const latestJson = findLatestExportJson(root);
  if (!latestJson) {
    const latestChunks = findLatestMemoryChunksDir(root);
    if (latestChunks) {
      console.log('');
      console.log('✅ La app principal ya dejó el resultado limpio.');
      console.log(`📁 Resultado final: ${latestChunks}`);
      process.exit(exportResult.status || 0);
    }
    console.error('No encontré ningún perplexity-threads.json ni memory_chunks para limpiar.');
    process.exit(exportResult.status || 1);
  }

  const exportDir = path.dirname(latestJson);
  cleanOldOutputs(exportDir);

  const cleanerArgs = [
    cleaner,
    latestJson,
    '--out',
    exportDir,
    '--chunks-only',
    '--no-sources',
  ];

  if (process.env.PEX_FILTER_NOISE === '1') {
    cleanerArgs.push('--filter-noise');
  }

  console.log('');
  console.log('🧹 Running automatic chunks-only clean...');
  console.log('Input:', latestJson);
  console.log('Output:', path.join(exportDir, 'memory_chunks'));

  const cleanResult = spawnSync(process.execPath, cleanerArgs, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CHUNKS_ONLY: '1',
      MAX_SOURCES: '0',
      KEEP_SOURCES: '0',
      WRITE_MD: '0',
      WRITE_SINGLE_MEMORY: '1',
      WRITE_CLEAN_JSON: '0',
    },
  });

  if (cleanResult.status !== 0) {
    console.error(`❌ Cleaner terminó con código ${cleanResult.status}.`);
    process.exit(cleanResult.status || 1);
  }

  if (process.env.PEX_KEEP_RAW !== '1') {
    removeRawArtifacts(exportDir);
  }

  console.log('');
  console.log('✅ Export + clean completed.');
  console.log(`📁 Resultado final: ${exportDir}`);
  console.log(`   - ${path.join(exportDir, 'memory_chunks')}`);
  console.log(`   - ${path.join(exportDir, 'perplexity-memory.md')}`);
  if (process.env.PEX_KEEP_RAW === '1') {
    console.log('ℹ️ Raw export conservado porque PEX_KEEP_RAW=1.');
  }
}

main();

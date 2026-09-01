#!/usr/bin/env node
'use strict';

// Brings HPA_DATA_LOCAL_DIR in line with the active HPA release: every hpa_datasets row whose
// version equals platform_config.active_hpa_version is downloaded with curl from its direct URL,
// checked against the server's size, hashed, and extracted, one file at a time. Rows of other
// versions are left alone. Run by the deployment before a release switches, and by hand.
//
//   node scripts/sync-hpa-data.js            sync what is missing or changed
//   node scripts/sync-hpa-data.js --check    report only, download nothing (exit 1 if not ready)

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { loadRuntimeConfig } = require('../src/config/runtime');
const { createDatabaseClient } = require('../src/database/client');
const { HpaDatasetRepository } = require('../src/database/repositories/hpaDatasets');
const { PlatformConfig } = require('../src/policy/config');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 AtlasAI-sync';
const CHECK_ONLY = process.argv.includes('--check');

function log(message) {
  console.log(`[HPA-SYNC ${new Date().toISOString()}] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', options.stdout || 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

// Asks for the identity encoding so the reported length matches what curl stores on disk.
async function remoteSize(url) {
  const response = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`HEAD ${url} -> HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest()));
  });
}

async function sizeOf(targetPath) {
  const stat = await fsp.stat(targetPath);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fsp.readdir(targetPath, { withFileTypes: true })) {
    total += await sizeOf(path.join(targetPath, entry.name));
  }
  return total;
}

function stripCompression(fileName, compression) {
  if (compression === 'ZIP' && fileName.endsWith('.zip')) return fileName.slice(0, -4);
  if (compression === 'GZIP' && fileName.endsWith('.gz')) return fileName.slice(0, -3);
  return fileName;
}

async function extract(dataset, archivePath, root, scratch) {
  const target = stripCompression(dataset.fileName, dataset.compression);
  if (dataset.compression === 'None') {
    await fsp.rename(archivePath, path.join(root, dataset.fileName));
    return dataset.fileName;
  }
  if (dataset.compression === 'GZIP') {
    const unpackedPath = path.join(scratch, target);
    const fd = fs.openSync(unpackedPath, 'w');
    try {
      await run('gzip', ['-dc', archivePath], { stdout: fd });
    } finally {
      fs.closeSync(fd);
    }
    await fsp.rename(unpackedPath, path.join(root, target));
    return target;
  }
  // ZIP: a single-file archive lands as that file, anything else keeps a directory named after it.
  const unzipDir = path.join(scratch, 'unzip');
  await fsp.rm(unzipDir, { recursive: true, force: true });
  await fsp.mkdir(unzipDir, { recursive: true });
  await run('unzip', ['-o', '-q', archivePath, '-d', unzipDir]);
  const entries = await fsp.readdir(unzipDir, { withFileTypes: true });
  if (dataset.format !== 'Archive' && entries.length === 1 && entries[0].isFile()) {
    const finalName = entries[0].name === target ? target : entries[0].name;
    await fsp.rm(path.join(root, finalName), { recursive: true, force: true });
    await fsp.rename(path.join(unzipDir, entries[0].name), path.join(root, finalName));
    return finalName;
  }
  const dirName = target.replace(/\.(tsv|json|xml)$/i, '');
  await fsp.rm(path.join(root, dirName), { recursive: true, force: true });
  await fsp.rename(unzipDir, path.join(root, dirName));
  return dirName;
}

async function localCopyIsIntact(dataset, root) {
  if (dataset.localStatus !== 'ready' || !dataset.localPath) return false;
  try {
    const size = await sizeOf(path.join(root, dataset.localPath));
    return size === dataset.unpackedBytes;
  } catch {
    return false;
  }
}

async function syncOne(dataset, root, scratch, datasets) {
  const archivePath = path.join(scratch, dataset.fileName);
  await datasets.markDownloading(dataset.id);
  log(`downloading ${dataset.fileName} (${dataset.resource}: ${dataset.datasetName})`);
  await fsp.rm(archivePath, { force: true });
  await run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--retry-delay', '5',
    '--user-agent', USER_AGENT, '--output', archivePath, dataset.downloadUrl]);
  const downloadBytes = (await fsp.stat(archivePath)).size;
  const expected = await remoteSize(dataset.downloadUrl);
  if (expected !== null && expected !== downloadBytes) {
    throw new Error(`size mismatch: server reports ${expected} bytes, downloaded ${downloadBytes}`);
  }
  const downloadSha256 = await sha256File(archivePath);
  const downloadedUnixMs = Date.now();
  log(`extracting ${dataset.fileName} (${(downloadBytes / 1e6).toFixed(1)} MB)`);
  const localPath = await extract(dataset, archivePath, root, scratch);
  await fsp.rm(archivePath, { force: true });
  const unpackedBytes = await sizeOf(path.join(root, localPath));
  await datasets.markReady(dataset.id, { localPath, downloadBytes, downloadSha256, unpackedBytes, downloadedUnixMs });
  log(`ready ${localPath} (${(unpackedBytes / 1e6).toFixed(1)} MB unpacked)`);
}

async function main() {
  const runtime = loadRuntimeConfig(path.join(__dirname, '..'));
  const root = runtime.dataLocalRoot;
  const scratch = path.join(root, '.sync');
  await fsp.mkdir(scratch, { recursive: true });

  const db = await createDatabaseClient();
  try {
    const config = await new PlatformConfig(db).reload();
    const datasets = new HpaDatasetRepository(db);
    const rows = await datasets.listForVersion(config.activeHpaVersion);
    log(`active HPA version ${config.activeHpaVersion}: ${rows.length} catalog rows, root ${root}`);

    const pending = [];
    for (const dataset of rows) {
      if (await localCopyIsIntact(dataset, root)) {
        await datasets.markVerified(dataset.id);
        continue;
      }
      pending.push(dataset);
    }
    log(`${rows.length - pending.length} present, ${pending.length} to fetch`);

    if (CHECK_ONLY) {
      for (const dataset of pending) log(`missing ${dataset.fileName}`);
      process.exitCode = pending.length === 0 ? 0 : 1;
      return;
    }

    // Small files first so the datasets the agents need most are available soonest.
    const sized = [];
    for (const dataset of pending) {
      let bytes = null;
      try {
        bytes = await remoteSize(dataset.downloadUrl);
      } catch (error) {
        await datasets.markFailed(dataset.id, error.message);
        log(`failed ${dataset.fileName}: ${error.message}`);
        continue;
      }
      sized.push({ dataset, bytes: bytes ?? Number.MAX_SAFE_INTEGER });
    }
    sized.sort((a, b) => a.bytes - b.bytes);

    let failures = pending.length - sized.length;
    for (const { dataset } of sized) {
      try {
        await syncOne(dataset, root, scratch, datasets);
      } catch (error) {
        failures += 1;
        await datasets.markFailed(dataset.id, error.message);
        log(`failed ${dataset.fileName}: ${error.message}`);
      }
    }
    const ready = await datasets.listReady(config.activeHpaVersion);
    log(`done: ${ready.length}/${rows.length} ready, ${failures} failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error('[HPA-SYNC] fatal:', error?.message || error);
  process.exitCode = 2;
});

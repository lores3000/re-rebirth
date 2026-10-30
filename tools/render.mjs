#!/usr/bin/env node
// Offline render of a song to WAV with the real engine, in headless Chrome.
//
//   node tools/render.mjs <song.rbs|session.json> [out.wav] [--start 1] [--bars 16] [--rate 48000] [--solo bass1] [--set fx.dist.on=0 ...] [--no-trim] [--tail 1]
//   node tools/render.mjs <song> --stems DIR [...]   mix.wav and one WAV per channel plus the delay's echoes,
//                                                    all --linear, so the stems add up to the mix
//   --linear: no master limiter or soft clip (for a game engine that mixes and limits itself)
//   --trim-lead: cut the clock's 0.05 s lead-in so bar 1 starts on the first sample (--stems does)
//
// --tail adds seconds after the last bar for releases and echoes.
//
// Uses the locally installed Chrome (override with CHROME=/path/to/chrome).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const STEMS = ['bass1', 'bass2', 'r808', 'r909', 'delay'];
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const opts = { start: 1, bars: 16, rate: 48000, solo: null, set: {}, noTrim: false, tail: 1, stems: null, linear: false, trimLead: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') opts.start = Number(argv[++i]);
    else if (a === '--bars') opts.bars = Number(argv[++i]);
    else if (a === '--rate') opts.rate = Number(argv[++i]);
    else if (a === '--no-trim') opts.noTrim = true;
    else if (a === '--tail') opts.tail = Number(argv[++i]);
    else if (a === '--stems') opts.stems = argv[++i];
    else if (a === '--linear') opts.linear = true;
    else if (a === '--trim-lead') opts.trimLead = true;
    else if (a === '--solo') opts.solo = argv[++i];
    else if (a === '--set') {
      const [key, value] = argv[++i].split('=');
      opts.set[key] = Number(value);
    }
    else opts.files.push(a);
  }
  return opts;
}

// 16-bit PCM, or 32-bit float (format 3) when `float`.
function wav(pcm, sampleRate, channels, float = false) {
  const bytes = float ? 4 : 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(8 * bytes, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const opts = parseArgs(process.argv.slice(2));
const [song, out = 'render.wav'] = opts.files;
if (!song || (opts.files.length > 1 && opts.stems)) {
  console.error('usage: node tools/render.mjs <song.rbs|session.json> [out.wav | --stems DIR] [--start N] [--bars N] [--rate HZ] [--tail S] [--solo deviceId] [--set key=value] [--no-trim] [--linear] [--trim-lead]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
// Songs can live anywhere: Vite serves them through /@fs/ with the file-system guard off.
const server = await createServer({ root, logLevel: 'error', server: { port: 0, fs: { strict: false } } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${base}tools/render.html`);
  await page.waitForFunction(() => window.renderReady);
  const url = `/@fs${resolve(song).split('/').map(encodeURIComponent).join('/')}`;
  const t0 = performance.now();
  const args = { url, startBar: opts.start, bars: opts.bars, sampleRate: opts.rate, solo: opts.solo, set: opts.set, noTrim: opts.noTrim, tail: opts.tail, linear: opts.linear || !!opts.stems, trimLead: opts.trimLead || !!opts.stems };
  const targets = opts.stems ? [[join(opts.stems, 'mix.wav'), null], ...STEMS.map((stem) => [join(opts.stems, `${stem}.wav`), stem])] : [[out, null]];
  if (opts.stems) mkdirSync(opts.stems, { recursive: true });
  for (const [file, stem] of targets) {
    const res = await page.evaluate((a) => window.renderSong(a), { ...args, stem });
    writeFileSync(file, wav(Buffer.from(res.data, 'base64'), res.sampleRate, res.channels, res.float));
    console.log(`${file}: bars ${opts.start}-${opts.start + opts.bars - 1} at ${res.tempo} BPM${opts.solo ? `, solo ${opts.solo}` : ''}${stem ? `, stem ${stem}` : ''}`);
  }
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)}s)`);
} finally {
  await browser.close();
  await server.close();
}

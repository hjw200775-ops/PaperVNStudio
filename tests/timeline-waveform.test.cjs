'use strict';
/* V0.8.2 · M2-A · 波形摘要数据层测试
 * 摘要来自「真实 WAV 音频字节」：测试里的 decode 替身直接读取工程内真实 PCM WAV 并计算峰值，
 * 与产品注入的 runtime().decodeWaveform 输出同构（peaks/duration/sampleRate/channels）。
 * 覆盖：真实摘要、重复素材复用、加载失败、超预算、素材替换、过期请求、不同缩放、容量上限、串行请求。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createWaveformCache = require('../dist/timeline-waveform.js');

const ROOT = path.resolve(__dirname, '..');
const WAV = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程',
  'assets', 'audio', '15d53f759eb7ac236deb62f976e4fd0f4d02a0078caf91ca9dc35f314a7c71f1.wav');

/* 从真实 PCM WAV 字节计算峰值摘要（不是随机数据） */
function decodeRealWav(bins) {
  const b = fs.readFileSync(WAV);
  assert.equal(b.slice(0, 4).toString('ascii'), 'RIFF');
  assert.equal(b.slice(8, 12).toString('ascii'), 'WAVE');
  const channels = b.readUInt16LE(22), sampleRate = b.readUInt32LE(24), byteRate = b.readUInt32LE(28);
  const bits = b.readUInt16LE(34), format = b.readUInt16LE(20);
  assert.equal(format, 1, '测试素材必须是 PCM WAV');
  let at = 36, dataAt = -1, dataSize = 0;
  while (at + 8 <= b.length) {
    const id = b.slice(at, at + 4).toString('ascii'), sz = b.readUInt32LE(at + 4);
    if (id === 'data') { dataAt = at + 8; dataSize = sz; break; }
    at += 8 + sz + (sz % 2);
  }
  assert.ok(dataAt > 0 && dataSize > 0, '找到真实 PCM data 块');
  const bytesPerSample = bits / 8;
  const samples = Math.floor(dataSize / bytesPerSample);
  const n = Math.max(16, Math.min(bins || 800, 4000));
  const step = Math.max(1, Math.floor(samples / n));
  const peaks = new Array(n);
  let peak = 0;
  for (let k = 0; k < n; k++) {
    let m = 0;
    const s = k * step;
    for (let i = 0; i < step && s + i < samples; i++) {
      const v = bits === 16
        ? Math.abs(b.readInt16LE(dataAt + (s + i) * 2) / 32768)
        : Math.abs((b[dataAt + (s + i)] - 128) / 128);
      if (v > m) m = v;
    }
    peaks[k] = m;
    if (m > peak) peak = m;
  }
  if (peak > 0) for (let k = 0; k < n; k++) peaks[k] = +(peaks[k] / peak).toFixed(4);
  return { ok: true, duration: +(dataSize / byteRate).toFixed(3), sampleRate, channels, peaks };
}

function harness(overrides) {
  const o = overrides || {};
  const st = { calls: 0, active: 0, maxActive: 0, lastBins: 0, release: null };
  const assets = o.assets || {
    a1: { id: 'a1', sha256: 'hash-real', bytes: 52964, duration: 1.2 },
    a2: { id: 'a2', sha256: 'hash-real', bytes: 52964, duration: 1.2 },  // 同一素材，不同动作 ID
    b1: { id: 'b1', sha256: 'hash-other', bytes: 102444, duration: 2.3 }
  };
  const decode = o.decode || ((audioId, bins) => {
    st.calls++; st.active++; st.maxActive = Math.max(st.maxActive, st.active);
    st.lastBins = bins;
    return new Promise((r) => setTimeout(() => { st.active--; r(decodeRealWav(bins)); }, 1));
  });
  const cache = createWaveformCache({
    decode,
    assetOf: (id) => assets[id] || null,
    maxEntries: o.maxEntries, maxBytes: o.maxBytes, maxBins: o.maxBins,
    maxAssetBytes: o.maxAssetBytes
  });
  return { cache, st, assets };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  assert.equal(fs.existsSync(WAV), true, '真实 WAV 素材存在');

  /* 1. 摘要来自实际音频数据 */
  {
    const { cache } = harness();
    const r = await cache.request('a1', 120, 400);
    assert.equal(r.ok, true);
    assert.equal(r.source, 'decodeWaveform');
    assert.equal(r.hash, 'hash-real', '缓存键使用 SHA-256 内容标识');
    assert.equal(r.sampleRate, 22050);
    assert.equal(r.channels, 1);
    assert.ok(Math.abs(r.duration - 1.2) < 0.02, '时长来自真实音频');
    assert.ok(r.bins >= 64 && r.peaks.length === r.bins);
    assert.ok(r.peaks.some((v) => v > 0.01), '波形有真实非零振幅');
    assert.deepEqual(r.min, r.peaks.map((v) => -v), 'min 由真实峰值派生');
    assert.deepEqual(r.max, r.peaks);
    const again = await cache.request('a1', 120, 400);
    assert.deepEqual(again.peaks, r.peaks, '重复解码同一真实音频结果一致（非随机）');
  }

  /* 2. 重复素材（同 sha，不同 audioId）只解码一次并复用缓存 */
  {
    const { cache, st } = harness();
    const [r1, r2] = await Promise.all([cache.request('a1', 100, 300), cache.request('a2', 100, 300)]);
    assert.equal(r1.ok && r2.ok, true);
    assert.equal(r1.key, r2.key);
    assert.equal(st.calls, 1, '同一素材不重复解码');
    const r3 = await cache.request('a2', 100, 300);
    assert.equal(r3.ok, true);
    assert.equal(cache.snapshot().cacheHits >= 1, true);
  }

  /* 3. 加载失败明确标记，不写入缓存、不抛异常 */
  {
    const { cache, st } = harness({ decode: () => Promise.resolve({ ok: false, reason: 'no-graph' }) });
    const r = await cache.request('a1', 100, 300);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-graph');
    assert.equal(cache.peek('a1'), null, '失败结果不进缓存');
    assert.equal(cache.snapshot().failures, 1);
    assert.equal(st.calls, 0);
    /* decode 抛异常也必须收敛为失败 */
    const c2 = createWaveformCache({ decode: () => { throw new Error('boom'); }, assetOf: () => ({ sha256: 'x' }) });
    const r2 = await c2.request('x', 100, 300);
    assert.equal(r2.ok, false);
  }

  /* 4. 超预算素材拒绝解码；大文件按预算降 bins */
  {
    const { cache, st } = harness({
      maxAssetBytes: 60000,
      assets: { big: { id: 'big', sha256: 'hash-big', bytes: 10 * 1024 * 1024, duration: 60 } }
    });
    const r = await cache.request('big', 100, 400);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'budget');
    assert.equal(st.calls, 0, '超预算不触发解码');
    assert.equal(cache.snapshot().budgetRejected, 1);
    const c2 = createWaveformCache({ decode: () => Promise.resolve({ ok: true }), assetOf: () => ({}) });
    assert.ok(c2.binsFor(200, 1200, 5) > c2.binsFor(20, 120, 5), '放大后需要更多 bins');
    assert.ok(c2.binsFor(200, 4000, 300) < c2.binsFor(200, 4000, 5), '长素材按预算降采样');
  }

  /* 5. 素材替换（同 audioId，内容标识变化）必须重新解码 */
  {
    const assets = { a1: { id: 'a1', sha256: 'hash-v1', bytes: 100, duration: 1 } };
    const { cache, st } = harness({ assets });
    await cache.request('a1', 100, 300);
    assert.equal(st.calls, 1);
    assets.a1 = { id: 'a1', sha256: 'hash-v2', bytes: 120, duration: 1.5 };
    const r2 = await cache.request('a1', 100, 300);
    assert.equal(r2.ok, true);
    assert.equal(r2.hash, 'hash-v2');
    assert.equal(st.calls, 2, '内容变化后重新解码');
  }

  /* 6. 过期请求：切换节点后旧解码结果被丢弃 */
  {
    let release, first = true;
    const { cache } = harness({
      decode: () => new Promise((r) => {
        if (first) { first = false; release = () => r(decodeRealWav(200)); }
        else setTimeout(() => r(decodeRealWav(200)), 1);   /* 新 scope 的请求正常完成 */
      })
    });
    const p = cache.request('a1', 100, 400);
    await tick();                       // 让串行队列进入 decode
    cache.setScope('node-2');
    assert.equal(typeof release, 'function', '解码已开始');
    release();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stale');
    assert.equal(cache.snapshot().staleDiscarded, 1);
    assert.equal(cache.snapshot().scopeChanges, 1);
    /* 新 scope 下的请求正常成功 */
    const r2 = await cache.request('a1', 100, 400);
    assert.equal(r2.ok, true);
  }

  /* 7. 不同缩放级别：bins 随像素密度变化，但都来自真实音频 */
  {
    const { cache, st } = harness({ maxBins: 1000 });
    const small = await cache.request('a1', 20, 120);
    cache.clear();
    const large = await cache.request('a1', 400, 1400);
    assert.ok(large.bins > small.bins, '放大后摘要分辨率更高');
    assert.ok(st.calls >= 2);
  }

  /* 8. 缓存容量上限与淘汰 */
  {
    const assets = {};
    for (let i = 0; i < 12; i++) assets['x' + i] = { id: 'x' + i, sha256: 'k' + i, bytes: 100, duration: 1 };
    const { cache } = harness({ assets, maxEntries: 3, maxBytes: 64 * 1024 });
    for (let i = 0; i < 12; i++) await cache.request('x' + i, 100, 400);
    const s = cache.snapshot();
    assert.equal(s.entries <= 3, true, '条目数不超过上限');
    assert.equal(s.bytes <= s.maxBytes, true, '缓存字节不超过上限');
    assert.ok(s.evictions > 0, '发生淘汰');
  }

  /* 9. 串行解码：decodeWaveform 共用 loadSeq，并发不能互相判 stale */
  {
    const { cache, st } = harness();
    await Promise.all([cache.request('a1', 100, 300), cache.request('b1', 100, 300), cache.request('a1', 100, 300)]);
    assert.equal(st.maxActive, 1, '任意时刻只有一个解码在飞');
    assert.equal(st.calls, 2, '两个不同素材各解码一次');
  }

  /* 10. clear / snapshot 不残留 */
  {
    const { cache } = harness();
    await cache.request('a1', 100, 300);
    assert.equal(cache.snapshot().entries, 1);
    cache.clear();
    assert.equal(cache.snapshot().entries, 0);
    assert.equal(cache.snapshot().bytes, 0);
  }

  console.log('PASS: 波形摘要（真实 WAV/重复素材复用/失败标记/超预算/素材替换/过期请求/缩放 bins/容量上限/串行解码）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });

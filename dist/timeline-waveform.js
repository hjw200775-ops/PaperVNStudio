/* V0.8.2 · M2-A · 时间轴波形数据层
 *
 * 只做「按需生成真实音频峰值摘要 + 缓存」，不自己解码音频：
 * 通过注入的 decode(audioId, bins) 复用 V0.8.1 的 runtime().decodeWaveform，
 * 因此走的是同一套 AudioBuffer 解码与 64 MiB 缓存，不重复开发解码器。
 *
 * 关键点：
 *  - 摘要来自真实解码结果（peaks 是归一化后的真实最大振幅，min/max 由它派生），绝无随机或装饰波形。
 *  - 只缓存降采样摘要（不保存 PCM）；缓存键优先用素材 SHA-256 内容标识。
 *  - 同一素材被多个动作引用时只解码一次（pending 复用 + 命中缓存）。
 *  - decodeWaveform 内部共用一个 loadSeq，并发调用会互相判 stale，因此这里严格串行请求。
 *  - scope（剧情节点）切换后，旧请求结果一律丢弃；容量有明确条目数与字节上限。
 */
function createWaveformCache(opts) {
  const o = opts || {};
  const decode = o.decode;
  const assetOf = o.assetOf || (() => null);
  const now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const MAX_ENTRIES = Math.max(1, Number(o.maxEntries) || 24);
  const MAX_BYTES = Math.max(4096, Number(o.maxBytes) || 2 * 1024 * 1024);       /* 摘要缓存 2 MiB */
  const MAX_BINS = Math.max(64, Number(o.maxBins) || 2000);
  const MAX_ASSET_BYTES = Math.max(1024, Number(o.maxAssetBytes) || 64 * 1024 * 1024); /* 与音频引擎预算一致 */

  const cache = new Map();       /* key -> summary（Map 顺序即 LRU 近似） */
  const pending = new Map();     /* key -> {promise, epoch, bins} */
  let chain = Promise.resolve(); /* 串行解码队列 */
  let epoch = 0, cacheBytes = 0;

  const stats = {
    requests: 0, decodeCalls: 0, cacheHits: 0, cacheMisses: 0,
    failures: 0, staleDiscarded: 0, budgetRejected: 0,
    scopeChanges: 0, lastMs: 0, peakBytes: 0, evictions: 0
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function keyOf(audioId) {
    const a = assetOf(audioId) || {};
    return String(a.sha256 || a.hash || a.file || audioId || '');
  }
  /* bins 按显示像素密度决定：约每 2px 一个 bin；长素材进一步降采样。
     不同缩放（pps）/片段宽度会得到不同 bins，但摘要仍来自同一真实音频。 */
  function binsFor(pps, widthPx, duration) {
    let n = Math.round(clamp(Number(widthPx) / 2, 64, MAX_BINS));
    if (Number(duration) > 120) n = Math.min(n, 512);
    if (Number(duration) > 600) n = Math.min(n, 256);
    return n;
  }
  function summaryFrom(audioId, key, r) {
    const peaks = Array.prototype.slice.call(r.peaks || []).map((v) => Number(v) || 0);
    const min = peaks.map((v) => -v);                 /* 对称包络：真实峰值派生，非随机 */
    const max = peaks.slice();
    const size = peaks.length * 8 + 192;             /* min/max 两路 float 近似 + 元信息 */
    return {
      ok: true, key, audioId, hash: key,
      bins: peaks.length, peaks, min, max,
      duration: Number(r.duration) || 0,
      sampleRate: Number(r.sampleRate) || 0,
      channels: Number(r.channels) || 0,
      bytes: size, generatedAt: now(),
      source: 'decodeWaveform'
    };
  }
  function put(key, s) {
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    cache.set(key, s);
    cacheBytes += s.bytes;
    stats.peakBytes = Math.max(stats.peakBytes, cacheBytes);
    while (cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
      stats.evictions++;
    }
  }
  function failure(key, audioId, reason) {
    return { ok: false, key, audioId, reason: String(reason || 'decode-failed') };
  }

  /* 请求一个素材的波形摘要。返回 Promise<summary|failure>，永不抛异常。 */
  function request(audioId, pps, widthPx) {
    stats.requests++;
    const key = keyOf(audioId);
    if (cache.has(key)) {
      stats.cacheHits++;
      const hit = cache.get(key);
      cache.delete(key); cache.set(key, hit);          /* 触及顺序 */
      return Promise.resolve(hit);
    }
    const a = assetOf(audioId) || {};
    if (Number(a.bytes) > MAX_ASSET_BYTES) {
      stats.budgetRejected++;
      return Promise.resolve(failure(key, audioId, 'budget'));
    }
    /* 只复用同一 scope 内尚未完成的请求；切节点后的旧请求不复用（否则会拿到 stale 结果） */
    const existing = pending.get(key);
    if (existing) {
      if (existing.epoch === epoch) return existing.promise;
      pending.delete(key);
    }
    stats.cacheMisses++;
    const bins = binsFor(pps, widthPx, a.duration);
    const myEpoch = epoch;

    const promise = chain.then(() => {
      if (myEpoch !== epoch) { stats.staleDiscarded++; return failure(key, audioId, 'stale'); }
      if (typeof decode !== 'function') { stats.failures++; return failure(key, audioId, 'no-decoder'); }
      stats.decodeCalls++;
      const t0 = now();
      let out;
      try { out = decode(audioId, bins); } catch (e) { out = Promise.reject(e); }
      return Promise.resolve(out).then((r) => {
        stats.lastMs = +Math.max(0, now() - t0).toFixed(2);
        if (myEpoch !== epoch) { stats.staleDiscarded++; return failure(key, audioId, 'stale'); }
        if (!r || !r.ok || !r.peaks || !r.peaks.length) {
          stats.failures++;
          return failure(key, audioId, (r && r.reason) || 'no-peaks');
        }
        const s = summaryFrom(audioId, key, r);
        put(key, s);
        return s;
      }).catch((e) => {
        stats.lastMs = +Math.max(0, now() - t0).toFixed(2);
        if (myEpoch !== epoch) { stats.staleDiscarded++; return failure(key, audioId, 'stale'); }
        stats.failures++;
        return failure(key, audioId, (e && e.message) || String(e));
      });
    });
    pending.set(key, { promise, epoch: myEpoch, bins });
    /* 串行：无论成功失败都放行下一个请求，避免 decodeWaveform 的 loadSeq 互判 stale。
       只清理自己那一项，避免误删新的同 key 请求（切节点后重新请求同一素材） */
    chain = promise.then(() => {}, () => {}).then(() => {
      const cur = pending.get(key);
      if (cur && cur.promise === promise) pending.delete(key);
    });
    return promise;
  }

  /* 切换剧情节点：旧请求在返回时因 epoch 不符被丢弃；缓存保留以便跨节点复用。 */
  function setScope(nodeKey) {
    epoch++;
    stats.scopeChanges++;
    return { epoch, nodeKey: nodeKey == null ? '' : String(nodeKey) };
  }
  function peek(audioId) { return cache.get(keyOf(audioId)) || null; }
  function clear() {
    epoch++;
    cache.clear(); pending.clear();
    cacheBytes = 0;
    chain = Promise.resolve();
  }
  function snapshot() {
    return Object.assign({}, stats, {
      entries: cache.size, bytes: cacheBytes, pending: pending.size,
      maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES, maxBins: MAX_BINS,
      maxAssetBytes: MAX_ASSET_BYTES, epoch,
      keys: Array.from(cache.keys())
    });
  }
  return { request, peek, setScope, clear, snapshot, binsFor, keyOf, MAX_ASSET_BYTES };
}
if (typeof module !== 'undefined') module.exports = createWaveformCache;

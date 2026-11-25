/* 纸间 PaperVNStudio V0.8.0 · 舞台演出运行时（Performance Engine）
 *
 * 设计要点（与 V0.7.6 的「逐图层效果」并列，不互相替换）：
 *  - effects.js：一句之内，对某个图层的 scale / move / opacity / filter 做插值；
 *  - performance.js：一句之内（及跨句）的**动作序列**——角色出现/离场/移动/表情、
 *    背景转场、镜头、全屏淡入淡出与闪白、等待，带顺序/并行、阻塞/非阻塞。
 *
 * 三个不可让步的性质：
 *  1. 纯函数求解：给定 before 状态 + 动作表 + 时间 t，状态唯一确定；
 *     跳过动画 = t→∞ 求值，因此「跳过」与「正常播完」必然同一个终态。
 *  2. 单一时间源：一个 requestAnimationFrame 循环驱动全部动作，不为每个动作开定时器。
 *  3. 状态外置：运行状态不写进工程、不写进 DOM 属性，只在内存里按 layerId 记账，
 *     读档 / 换章 / 重开都靠重放 trail 得到同一份状态。
 */
function createPaperPerformance() {
  const VERSION = 1;

  /* ---------- 动作类型表 ---------- */
  const TYPES = {
    'character.show': { name: '角色出现', target: 'char', params: { side: 'fade' }, defDur: 0.6 },
    'character.hide': { name: '角色离场', target: 'char', params: { mode: 'fade' }, defDur: 0.6 },
    'character.move': { name: '角色移动', target: 'char', params: { x: 50, y: 70 }, defDur: 0.8 },
    'character.scale': { name: '角色缩放', target: 'char', params: { scale: 120 }, defDur: 0.6 },
    'character.opacity': { name: '角色透明度', target: 'char', params: { opacity: 100 }, defDur: 0.5 },
    'character.expression': { name: '切换表情', target: 'char', params: { expressionId: '' }, defDur: 0.3 },
    'character.bob': { name: '轻微跳动', target: 'char', params: { amplitude: 3, times: 2 }, defDur: 0.8 },
    'background.change': { name: '背景切换', target: 'bg', params: { assetId: '', transition: 'crossfade' }, defDur: 0.8 },
    'camera.move': { name: '镜头平移', target: 'stage', params: { x: 0, y: 0 }, defDur: 0.8 },
    'camera.zoom': { name: '镜头缩放', target: 'stage', params: { scale: 110 }, defDur: 0.8 },
    'screen.fade': { name: '全屏渐暗 / 渐亮', target: 'stage', params: { to: 100, color: 'black' }, defDur: 0.8 },
    'screen.flash': { name: '屏幕闪白', target: 'stage', params: { color: 'white' }, defDur: 0.5 },
    'screen.shake': { name: '屏幕震动', target: 'stage', params: { strength: 2 }, defDur: 0.5 },
    wait: { name: '等待', target: 'stage', params: {}, defDur: 1 },
    /* ---------- V0.8.1 音频动作 ----------
       音频是「有外部副作用」的动作，因此这里只声明参数与时间关系；
       真正的播放/停止由播放器在动作起点调用音频引擎完成，
       终态由 stateAt() 计算后一次性落地（跳过 / 快进 / 读档）。 */
    'audio.bgm.play': { name: '播放背景音乐', target: 'stage', audio: true, params: { audioId: '', volume: 100, fadeIn: 0.8, loopMode: 'all', loopStart: 0, loopEnd: 0 }, defDur: 0.8 },
    'audio.bgm.stop': { name: '停止背景音乐', target: 'stage', audio: true, params: { fadeOut: 1 }, defDur: 1 },
    'audio.bgm.crossfade': { name: '切换背景音乐', target: 'stage', audio: true, params: { audioId: '', volume: 100, duration: 2, curve: 'equalPower', loopMode: 'all', loopStart: 0, loopEnd: 0 }, defDur: 2 },
    'audio.bgm.volume': { name: '背景音乐音量', target: 'stage', audio: true, params: { volume: 60, duration: 0.8 }, defDur: 0.8 },
    'audio.bgm.loop': { name: '背景音乐循环', target: 'stage', audio: true, params: { loopMode: 'region', loopStart: 10, loopEnd: 40 }, defDur: 0.3 },
    'audio.sfx.play': { name: '播放音效', target: 'stage', audio: true, params: { audioId: '', volume: 100, key: '' }, defDur: 0.3 },
    'audio.sfx.stop': { name: '停止音效', target: 'stage', audio: true, params: { key: '' }, defDur: 0.1 },
    'audio.voice.play': { name: '播放配音', target: 'stage', audio: true, params: { audioId: '', volume: 100, duck: true }, defDur: 0.5 },
    'audio.voice.stop': { name: '停止配音', target: 'stage', audio: true, params: {}, defDur: 0.1 },
    'audio.bus.volume': { name: '调整总线音量', target: 'stage', audio: true, params: { bus: 'bgm', volume: 70, duration: 0.6 }, defDur: 0.6 },
    'audio.ducking': { name: '自动压低音乐', target: 'stage', audio: true, params: { enabled: true, level: 35, attack: 0.25, release: 0.6 }, defDur: 0.3 }
  };
  const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
  const MAX_ACTIONS = 200;
  const AUDIO_BUSES = ['bgm', 'sfx', 'voice'];

  /* 循环区间归一化：region 必须 end > start，否则退化为整曲循环。 */
  function loopOf(p) {
    const mode = p.loopMode === 'off' ? 'off' : p.loopMode === 'region' ? 'region' : 'all';
    const start = num(p.loopStart) ? p.loopStart : 0;
    const end = num(p.loopEnd) ? p.loopEnd : 0;
    if (mode === 'region' && end > start) return { mode: 'region', start, end };
    return { mode: mode === 'off' ? 'off' : 'all', start: 0, end: 0 };
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  function ease(t, kind) {
    if (kind === 'linear') return t;
    if (kind === 'easeIn') return t * t;
    if (kind === 'easeOut') return 1 - (1 - t) * (1 - t);
    return t * t * (3 - 2 * t);
  }

  /* ---------- 构造与校验 ---------- */
  function make(id, type, target, patch) {
    const meta = TYPES[type];
    if (!meta) throw Error('未知的演出动作：' + type);
    const params = {};
    for (const [k, v] of Object.entries(meta.params)) params[k] = v;
    return Object.assign({
      id, type, target: target || '', params,
      duration: meta.defDur, delay: 0, easing: 'easeOut',
      blocking: false, mode: 'after', enabled: true
    }, patch || {});
  }

  /* 空演出：字段齐全，便于序列化与迁移 */
  function empty() { return { version: VERSION, actions: [] }; }

  function normalize(perf) {
    if (perf == null) return null;
    const out = { version: VERSION, actions: [] };
    const list = Array.isArray(perf.actions) ? perf.actions : [];
    for (const a of list) {
      if (!a || !TYPES[a.type]) continue;
      const meta = TYPES[a.type];
      const params = {};
      for (const [k, v] of Object.entries(meta.params)) params[k] = (a.params && k in a.params) ? a.params[k] : v;
      out.actions.push({
        id: String(a.id || ''),
        type: a.type,
        target: typeof a.target === 'string' ? a.target : '',
        params,
        duration: num(a.duration) ? a.duration : meta.defDur,
        delay: num(a.delay) ? a.delay : 0,
        easing: EASINGS.includes(a.easing) ? a.easing : 'easeOut',
        blocking: a.blocking === true,
        mode: a.mode === 'parallel' ? 'parallel' : 'after',
        enabled: a.enabled !== false,
        /* V0.8.2-M0：显式绝对开始时间（时间轴视图）。可选，旧工程没有。 */
        start: num(a.start) && a.start >= 0 ? a.start : undefined
      });
    }
    return out;
  }

  function validate(perf) {
    if (perf == null) return true;
    if (typeof perf !== 'object' || !Array.isArray(perf.actions)) throw Error('演出数据格式错误');
    if (perf.actions.length > MAX_ACTIONS) throw Error('演出动作过多（上限 ' + MAX_ACTIONS + '）');
    const ids = new Set();
    for (const a of perf.actions) {
      if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw Error('演出动作 ID 无效或重复');
      ids.add(a.id);
      const meta = TYPES[a.type];
      if (!meta) throw Error('未知的演出动作类型：' + a.type);
      if (typeof a.target !== 'string') throw Error('演出目标格式错误');
      if (!num(a.duration) || a.duration < 0 || a.duration > 30) throw Error('演出时长需在 0–30 秒之间');
      if (!num(a.delay) || a.delay < 0 || a.delay > 30) throw Error('演出延迟需在 0–30 秒之间');
      if (!EASINGS.includes(a.easing)) throw Error('未知的缓动方式');
      if (typeof a.blocking !== 'boolean') throw Error('阻塞标记格式错误');
      if (!['after', 'parallel'].includes(a.mode)) throw Error('执行关系只能是顺序或并行');
      if (a.start !== undefined && (!num(a.start) || a.start < 0 || a.start > 86400)) throw Error('演出开始时间格式错误');
      if (typeof a.enabled !== 'boolean') throw Error('启用标记格式错误');
      if (!a.params || typeof a.params !== 'object') throw Error('演出参数缺失');
      checkParams(a);
    }
    return true;
  }

  function checkParams(a) {
    const p = a.params;
    const need = (ok, msg) => { if (!ok) throw Error(msg); };
    switch (a.type) {
      case 'character.show':
        need(['left', 'right', 'fade', 'none'].includes(p.side), '角色出现方式无效'); break;
      case 'character.hide':
        need(['fade', 'out'].includes(p.mode), '角色离场方式无效'); break;
      case 'character.move':
        need(num(p.x) && p.x >= -200 && p.x <= 200, '角色目标 X 需在 -200–200 之间');
        need(num(p.y) && p.y >= -200 && p.y <= 200, '角色目标 Y 需在 -200–200 之间'); break;
      case 'character.scale':
        need(num(p.scale) && p.scale >= 10 && p.scale <= 400, '角色缩放需在 10–400%'); break;
      case 'character.opacity':
        need(num(p.opacity) && p.opacity >= 0 && p.opacity <= 100, '角色透明度需在 0–100%'); break;
      case 'character.expression':
        need(typeof p.expressionId === 'string', '表情 ID 格式错误'); break;
      case 'character.bob':
        need(num(p.amplitude) && p.amplitude >= 0.5 && p.amplitude <= 20, '跳动幅度需在 0.5–20');
        need(num(p.times) && p.times >= 1 && p.times <= 6, '跳动次数需在 1–6'); break;
      case 'background.change':
        need(typeof p.assetId === 'string', '背景素材 ID 格式错误');
        need(['cut', 'crossfade', 'fadeBlack', 'fadeWhite', 'slideLeft', 'slideRight'].includes(p.transition), '未知的转场方式'); break;
      case 'camera.move':
        need(num(p.x) && p.x >= -50 && p.x <= 50, '镜头平移 X 需在 -50–50');
        need(num(p.y) && p.y >= -50 && p.y <= 50, '镜头平移 Y 需在 -50–50'); break;
      case 'camera.zoom':
        need(num(p.scale) && p.scale >= 50 && p.scale <= 300, '镜头缩放需在 50–300%'); break;
      case 'screen.fade':
        need(num(p.to) && p.to >= 0 && p.to <= 100, '渐暗程度需在 0–100');
        need(['black', 'white'].includes(p.color), '渐暗颜色无效'); break;
      case 'screen.flash':
        need(['white', 'black'].includes(p.color), '闪光颜色无效'); break;
      case 'screen.shake':
        need(num(p.strength) && p.strength >= 0.5 && p.strength <= 6, '震动强度需在 0.5–6'); break;
      /* ---------- 音频动作 ---------- */
      case 'audio.bgm.play':
      case 'audio.bgm.crossfade':
        need(typeof p.audioId === 'string', '音频素材 ID 格式错误');
        need(num(p.volume) && p.volume >= 0 && p.volume <= 100, '音量需在 0–100');
        need(['off', 'all', 'region'].includes(p.loopMode), '循环模式无效');
        if (p.loopMode === 'region') need(num(p.loopStart) && num(p.loopEnd) && p.loopEnd > p.loopStart, '循环区间需结束晚于开始');
        if (a.type === 'audio.bgm.crossfade') {
          need(num(p.duration) && p.duration >= 0 && p.duration <= 10, '交叉淡化时长需在 0–10 秒');
          need(['linear', 'equalPower'].includes(p.curve), '淡入淡出曲线无效');
        } else need(num(p.fadeIn) && p.fadeIn >= 0 && p.fadeIn <= 10, '淡入时长需在 0–10 秒');
        break;
      case 'audio.bgm.stop':
        need(num(p.fadeOut) && p.fadeOut >= 0 && p.fadeOut <= 10, '淡出时长需在 0–10 秒'); break;
      case 'audio.bgm.volume':
        need(num(p.volume) && p.volume >= 0 && p.volume <= 100, '音量需在 0–100');
        need(num(p.duration) && p.duration >= 0 && p.duration <= 10, '过渡时长需在 0–10 秒'); break;
      case 'audio.bgm.loop':
        need(['off', 'all', 'region'].includes(p.loopMode), '循环模式无效');
        if (p.loopMode === 'region') need(num(p.loopStart) && num(p.loopEnd) && p.loopEnd > p.loopStart, '循环区间需结束晚于开始');
        break;
      case 'audio.sfx.play':
      case 'audio.voice.play':
        need(typeof p.audioId === 'string', '音频素材 ID 格式错误');
        need(num(p.volume) && p.volume >= 0 && p.volume <= 100, '音量需在 0–100'); break;
      case 'audio.sfx.stop':
        need(typeof p.key === 'string', '音效标识格式错误'); break;
      case 'audio.bus.volume':
        need(AUDIO_BUSES.includes(p.bus), '目标总线无效');
        need(num(p.volume) && p.volume >= 0 && p.volume <= 100, '音量需在 0–100'); break;
      case 'audio.ducking':
        need(typeof p.enabled === 'boolean', '压低开关格式错误');
        need(num(p.level) && p.level >= 0 && p.level <= 100, '压低程度需在 0–100');
        need(num(p.attack) && p.attack >= 0 && p.attack <= 10, 'Attack 需在 0–10 秒');
        need(num(p.release) && p.release >= 0 && p.release <= 10, 'Release 需在 0–10 秒'); break;
      default: break;
    }
  }

  /* ---------- 目标解析 ---------- */
  /* 目标可以是图层 ID，也可以是 `char:<角色ID>` / `bg` / `stage` 这类语义目标。
     语义目标按当前舞台图层表解析，保证换章节、换角色立绘后依然指向正确对象。 */
  function resolveTarget(layers, actionType, target) {
    if (actionType.startsWith('camera.') || actionType === 'screen.fade' || actionType === 'screen.flash' || actionType === 'screen.shake' || actionType === 'wait') return '';
    if (target === 'bg') {
      const bg = layers.find((l) => l.kind === 'bg');
      return bg ? bg.id : '';
    }
    if (target.startsWith('char:')) {
      const cid = target.slice(5);
      const l = layers.find((l) => l.characterId === cid);
      return l ? l.id : '';
    }
    return target;
  }

  function layerOf(layers, id) { return layers.find((l) => l.id === id) || null; }

  /* ---------- 状态 ---------- */
  function emptyState() {
    return { layers: {}, camera: { x: 0, y: 0, scale: 1 }, screen: { dim: 0, color: 'black' },
      /* audio 是「目标状态」而不是播放对象：只有数值与素材 ID，可直接比较与序列化 */
      audio: { bgm: null, buses: { bgm: 1, sfx: 1, voice: 1 }, ducking: null } };
  }
  function cloneState(s) {
    const out = { layers: {}, camera: { ...s.camera }, screen: { ...s.screen },
      audio: s.audio ? { bgm: s.audio.bgm ? { ...s.audio.bgm, loop: { ...s.audio.bgm.loop } } : null,
        buses: { ...s.audio.buses }, ducking: s.audio.ducking ? { ...s.audio.ducking } : null }
        : { bgm: null, buses: { bgm: 1, sfx: 1, voice: 1 }, ducking: null } };
    for (const [k, v] of Object.entries(s.layers)) out.layers[k] = { ...v };
    return out;
  }
  function layerState(st, id) {
    if (!st.layers[id]) st.layers[id] = { dx: 0, dy: 0, scale: 1, opacity: 1, visible: true, assetId: '' };
    return st.layers[id];
  }

  const neutral = { dx: 0, dy: 0, scale: 1, opacity: 1, visible: true, assetId: '' };

  function expressionAsset(P, characterId, expressionId) {
    const c = (P.characters || []).find((x) => x.id === characterId);
    if (!c) return '';
    const e = (c.expressions || []).find((x) => x.id === expressionId);
    return e ? e.assetId : '';
  }

  /* ---------- 时间轴 ---------- */
  /* 顺序 / 并行关系由「与上一动作」的语义决定，而不是绝对时间轴：
     - after    ：排在上一动作结束之后；
     - parallel ：与上一动作同时开始。
     这样拖动列表顺序就能改变语义，作者不需要手算绝对时间。
     V0.8.2-M0：动作可带显式 `start`（绝对秒）。有 `start` 就按绝对时间排（时间轴视图），
     没有就退回 after/parallel + delay（动作列表视图）。两者共用同一份数据源。 */
  function schedule(actions) {
    const list = (actions || []).filter((a) => a && a.enabled !== false && TYPES[a.type]);
    const out = [];
    let cursor = 0;
    let lastStart = 0;
    for (const a of list) {
      const explicit = num(a.start) && a.start >= 0;
      const start = explicit
        ? a.start
        : (a.mode === 'parallel' ? lastStart : cursor) + (a.delay || 0);
      const end = start + (a.duration || 0);
      out.push({ action: a, start, end, blocking: a.blocking === true });
      lastStart = start;
      cursor = Math.max(cursor, end);
    }
    return out;
  }

  function totalDuration(actions) {
    let t = 0;
    for (const s of schedule(actions)) t = Math.max(t, s.end);
    return t;
  }
  /* 剧情推进的等待点：最后一个「阻塞」动作的结束时间；没有阻塞动作则为 0。 */
  function blockUntil(actions) {
    let t = 0;
    for (const s of schedule(actions)) if (s.blocking) t = Math.max(t, s.end);
    return t;
  }

  /* ---------- 单步求值 ---------- */
  function applyStep(st, a, ctx, ratio) {
    if (ratio <= 0) return;
    const layers = ctx.layers;
    const layerId = resolveTarget(layers, a.type, a.target);
    const p = a.params || {};
    const lerp = (from, to, t) => from + (to - from) * t;
    const t = ratio;

    switch (a.type) {
      case 'character.show': {
        const s = layerState(st, layerId);
        const side = p.side;
        const off = side === 'left' ? -60 : side === 'right' ? 60 : 0;
        const anchor = s.dxEntry == null ? 0 : s.dxEntry;
        s.visible = true;
        /* 出现一律从「不可见」开始收敛到「完全可见」，与工程里图层默认可见无关。 */
        s.opacity = lerp(0, 1, t);
        s.dx = off ? lerp(anchor + off, anchor, t) : anchor;
        break;
      }
      case 'character.hide': {
        const s = layerState(st, layerId);
        s.opacity = s.opacity * (1 - t);
        if (t >= 1) { s.visible = false; s.opacity = 1; }
        break;
      }
      case 'character.move': {
        const s = layerState(st, layerId);
        const l = layerOf(layers, layerId);
        const bx = l ? l.x : 50, by = l ? l.y : 70;
        const tx = (num(p.x) ? p.x : bx) - bx;
        const ty = (num(p.y) ? p.y : by) - by;
        s.dx = lerp(s.dx, tx, t);
        s.dy = lerp(s.dy, ty, t);
        break;
      }
      case 'character.scale': {
        const s = layerState(st, layerId);
        s.scale = lerp(s.scale, (p.scale || 100) / 100, t);
        break;
      }
      case 'character.opacity': {
        const s = layerState(st, layerId);
        s.opacity = lerp(s.opacity, (p.opacity == null ? 100 : p.opacity) / 100, t);
        break;
      }
      case 'character.expression': {
        const s = layerState(st, layerId);
        const l = layerOf(layers, layerId);
        const asset = l && l.characterId ? expressionAsset(ctx.P, l.characterId, p.expressionId) : '';
        if (t > 0) s.assetId = asset || (l ? l.asset : '');
        break;
      }
      case 'character.bob': {
        const s = layerState(st, layerId);
        const amp = p.amplitude == null ? 3 : p.amplitude;
        const times = p.times == null ? 2 : p.times;
        const base = s.dyEntry == null ? 0 : s.dyEntry;
        s.dy = base + Math.sin(t * Math.PI * 2 * times) * amp * (1 - t);
        break;
      }
      case 'background.change': {
        const s = layerState(st, layerId);
        if (p.assetId) s.assetId = p.assetId;
        break;
      }
      case 'camera.move': {
        st.camera.x = lerp(st.camera.x, p.x || 0, t);
        st.camera.y = lerp(st.camera.y, p.y || 0, t);
        break;
      }
      case 'camera.zoom': {
        st.camera.scale = lerp(st.camera.scale, (p.scale || 100) / 100, t);
        break;
      }
      case 'screen.fade': {
        st.screen.dim = lerp(st.screen.dim, (p.to == null ? 100 : p.to) / 100, t);
        st.screen.color = p.color || 'black';
        break;
      }
      case 'screen.flash': {
        st.screen.flash = Math.sin(Math.PI * Math.min(1, t)) * (1 - t * 0.35);
        st.screen.flashColor = p.color || 'white';
        break;
      }
      case 'screen.shake': {
        const amp = (p.strength == null ? 2 : p.strength);
        st.screen.shakeX = Math.sin(t * Math.PI * 8) * amp * (1 - t) * 10;
        st.screen.shakeY = Math.cos(t * Math.PI * 6) * amp * (1 - t) * 16;
        break;
      }
      /* ---------- 音频：只写「目标状态」，不碰播放器 ---------- */
      case 'audio.bgm.play':
      case 'audio.bgm.crossfade': {
        st.audio.bgm = { audioId: p.audioId, volume: (p.volume == null ? 100 : p.volume) / 100, loop: loopOf(p), playing: true };
        break;
      }
      case 'audio.bgm.stop': { st.audio.bgm = null; break; }
      case 'audio.bgm.volume': {
        if (st.audio.bgm) st.audio.bgm.volume = lerp(st.audio.bgm.volume, (p.volume == null ? 100 : p.volume) / 100, t);
        break;
      }
      case 'audio.bgm.loop': {
        if (st.audio.bgm) st.audio.bgm.loop = loopOf(p);
        break;
      }
      case 'audio.bus.volume': {
        const bus = AUDIO_BUSES.includes(p.bus) ? p.bus : 'bgm';
        const from = st.audio.buses[bus] == null ? 1 : st.audio.buses[bus];
        st.audio.buses[bus] = lerp(from, (p.volume == null ? 100 : p.volume) / 100, t);
        break;
      }
      case 'audio.ducking': {
        st.audio.ducking = { enabled: p.enabled !== false, level: (p.level == null ? 35 : p.level) / 100,
          attack: p.attack, release: p.release };
        break;
      }
      /* 一次性动作（音效 / 配音）没有「终态」可记：跳过与快进时不应重放历史声音。 */
      case 'audio.sfx.play':
      case 'audio.sfx.stop':
      case 'audio.voice.play':
      case 'audio.voice.stop': break;
      default: break;
    }
  }

  /* 求 t 时刻的状态。t=Infinity 即终态，与「跳过」完全一致。 */
  function stateAt(before, actions, t, ctx) {
    const st = cloneState(before);
    /* 记下每个图层进入本句时的基线，出现的侧向偏移与跳动都以它为锚点 */
    for (const l of ctx.layers) {
      const s = layerState(st, l.id);
      if (s.dxEntry == null) { s.dxEntry = s.dx; s.dyEntry = s.dy; }
    }
    for (const slot of schedule(actions)) {
      if (t <= slot.start) continue;
      const dur = slot.action.duration || 0;
      const raw = dur <= 0 ? 1 : Math.min(1, (t - slot.start) / dur);
      applyStep(st, slot.action, ctx, ease(raw, slot.action.easing));
    }
    /* 终态清理：瞬态量归零、隐藏角色不再保留透明度残值 */
    if (!Number.isFinite(t)) {
      for (const s of Object.values(st.layers)) {
        s.dxEntry = undefined; s.dyEntry = undefined;
        if (s.visible === false) { s.opacity = 1; s.dx = 0; s.dy = 0; }
      }
      st.screen.flash = 0; st.screen.shakeX = 0; st.screen.shakeY = 0;
    }
    return st;
  }

  /* ---------- DOM 渲染 ---------- */
  function ensureFrame(wrap) {
    let inner = wrap.querySelector(':scope > .pf-frame');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'pf-frame';
      const img = wrap.querySelector(':scope > img');
      if (img) wrap.insertBefore(inner, img), inner.appendChild(img);
      else wrap.appendChild(inner);
    }
    return inner;
  }

  function ensureOverlay(container, cls) {
    const host = container.parentElement || container;
    let el = host.querySelector(':scope > .' + cls);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pf-overlay ' + cls;
      host.appendChild(el);
    }
    return el;
  }

  function applyDOM(container, layers, st, opts) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const W = rect.width || 1, H = rect.height || 1;
    const findAsset = (id) => {
      const P = (opts && opts.P) || null;
      const a = P ? (P.assets || []).find((x) => x.id === id) : null;
      return a ? a.data : '';
    };
    for (const wrap of Array.from(container.children)) {
      if (!wrap.dataset || !wrap.dataset.layer) continue;
      const l = layerOf(layers, wrap.dataset.layer);
      if (!l) continue;
      const s = st.layers[l.id] || neutral;
      const inner = ensureFrame(wrap);
      const hidden = s.visible === false || s.opacity <= 0.001;
      wrap.style.display = hidden ? 'none' : '';
      if (hidden) continue;
      const dx = (s.dx || 0) / 100 * W;
      const dy = (s.dy || 0) / 100 * H;
      inner.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) scale(' + (s.scale || 1).toFixed(4) + ')';
      inner.style.opacity = String(clamp(s.opacity == null ? 1 : s.opacity, 0, 1));
      const img = inner.querySelector('img');
      if (img && s.assetId) {
        const url = findAsset(s.assetId);
        if (url && img.getAttribute('src') !== url) img.src = url;
      }
    }
    const cam = st.camera || { x: 0, y: 0, scale: 1 };
    const shakeX = st.screen.shakeX || 0, shakeY = st.screen.shakeY || 0;
    container.style.transformOrigin = '50% 50%';
    container.style.transform = 'translate(' + (cam.x + shakeX / 10).toFixed(3) + '%,' + (cam.y + shakeY / 10).toFixed(3) + '%) scale(' + (cam.scale || 1).toFixed(4) + ')';
    const dim = ensureOverlay(container, 'pf-dim');
    dim.style.background = st.screen.color === 'white' ? '#fff' : '#000';
    dim.style.opacity = String(clamp(st.screen.dim || 0, 0, 1));
    const flash = ensureOverlay(container, 'pf-flash');
    flash.style.background = st.screen.flashColor === 'black' ? '#000' : '#fff';
    flash.style.opacity = String(clamp(st.screen.flash || 0, 0, 1));
  }

  function clearOverlays(container) {
    if (!container) return;
    const host = container.parentElement || container;
    host.querySelectorAll(':scope > .pf-overlay, :scope > .pf-bg-ghost').forEach((el) => el.remove());
  }

  /* ---------- 背景转场 ---------- */
  function transitionState(action, t, progress) {
    return { transition: action.params.transition, progress, started: t > 0 };
  }

  function runBackgroundTransition(container, layers, action, progress, P) {
    const layerId = resolveTarget(layers, action.type, action.target);
    const l = layerOf(layers, layerId);
    if (!l) return;
    const wrap = Array.from(container.children).find((w) => w.dataset && w.dataset.layer === l.id);
    if (!wrap) return;
    const host = container.parentElement || container;
    let ghost = host.querySelector(':scope > .pf-bg-ghost');
    const asset = (P.assets || []).find((a) => a.id === action.params.assetId);
    if (!asset) return;
    const mode = action.params.transition;
    if (mode === 'cut' || progress >= 1) {
      const img = wrap.querySelector('img');
      if (img) img.src = asset.data;
      if (ghost) ghost.remove();
      return;
    }
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'pf-bg-ghost';
      const r = wrap.getBoundingClientRect(), c = container.getBoundingClientRect();
      Object.assign(ghost.style, {
        position: 'absolute',
        left: (r.left - c.left) + 'px', top: (r.top - c.top) + 'px',
        width: r.width + 'px', height: r.height + 'px',
        backgroundImage: 'url("' + asset.data + '")',
        backgroundSize: l.fit === 'cover' ? 'cover' : l.fit === 'fill' ? '100% 100%' : 'contain',
        backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
        pointerEvents: 'none', zIndex: '2'
      });
      host.appendChild(ghost);
    } else {
      ghost.style.backgroundImage = 'url("' + asset.data + '")';
    }
    if (mode === 'crossfade') ghost.style.opacity = String(progress);
    else if (mode === 'slideLeft') { ghost.style.opacity = '1'; ghost.style.transform = 'translateX(' + (100 - progress * 100) + '%)'; }
    else if (mode === 'slideRight') { ghost.style.opacity = '1'; ghost.style.transform = 'translateX(-' + (100 - progress * 100) + '%)'; }
    else if (mode === 'fadeBlack' || mode === 'fadeWhite') {
      const dim = ensureOverlay(container, 'pf-transition');
      dim.style.background = mode === 'fadeBlack' ? '#000' : '#fff';
      dim.style.opacity = String(progress < 0.5 ? progress * 2 : (1 - progress) * 2);
      if (progress >= 0.5) {
        const img = wrap.querySelector('img');
        if (img && img.getAttribute('src') !== asset.data) img.src = asset.data;
        ghost.style.opacity = '0';
      }
      if (progress >= 1) dim.style.opacity = '0';
    }
  }

  /* ---------- 播放控制 ---------- */
  /* 一个 rAF 驱动全部动作。返回控制器：
     - finish()：立即到终态（点击跳过 / 快进 / 关闭预览）
     - cancel()：停止但保留当前终态（换句、销毁）
     - busy      ：是否还有未完成的阻塞动作 */
  function play(opts) {
    const { container, layers, actions, before, P, reduced, onTick, onDone } = opts;
    const ctx = { P, layers };
    const slots = schedule(actions);
    const total = totalDuration(actions);
    const blockAt = blockUntil(actions);
    const bgActions = slots.filter((s) => s.action.type === 'background.change');
    let raf = 0, start = 0, finished = false, cancelled = false;
    const still = reduced === true;
    let lastBg = new Map();

    function renderAt(t) {
      const st = stateAt(before, actions, still ? Infinity : t, ctx);
      applyDOM(container, layers, st, { P });
      for (const s of bgActions) {
        if (t <= s.start) continue;
        const dur = s.action.duration || 0;
        const prog = dur <= 0 ? 1 : Math.min(1, (t - s.start) / dur);
        const prev = lastBg.get(s.action.id) || 0;
        if (prog > prev || prog >= 1) {
          runBackgroundTransition(container, layers, s.action, prog, P);
          lastBg.set(s.action.id, prog);
        }
      }
      if (onTick) onTick(Math.min(t, total), total);
      return t >= total;
    }

    function finishNow() {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      renderAt(Infinity);
      schedule(actions).filter((s) => s.action.type === 'background.change').forEach((s) => {
        runBackgroundTransition(container, layers, s.action, 1, P);
      });
      if (onDone) onDone({ cancelled: false, instant: true });
    }

    function tick(now) {
      if (cancelled || finished) return;
      const t = (now - start) / 1000;
      const done = renderAt(t);
      if (done) { finished = true; if (onDone) onDone({ cancelled: false, instant: false }); return; }
      raf = requestAnimationFrame(tick);
    }

    if (total <= 0) {
      renderAt(Infinity);
      finished = true;
      if (onDone) onDone({ cancelled: false, instant: true });
    } else if (still) {
      renderAt(Infinity);
      finished = true;
      if (onDone) onDone({ cancelled: false, instant: true });
    } else {
      start = performance.now();
      raf = requestAnimationFrame(tick);
    }

    return {
      get busy() { return !finished && blockAt > 0; },
      get running() { return !finished; },
      blockAt, total,
      finish: finishNow,
      cancel() {
        cancelled = true;
        cancelAnimationFrame(raf);
        clearOverlays(container);
        const host = container.parentElement || container;
        host.querySelectorAll(':scope > .pf-transition').forEach((el) => el.remove());
      }
    };
  }

  /* ---------- 跨句重放 ---------- */
  /* steps: [{actions, layers, P}]，按剧情顺序。读档 / 跳章 / 重开都走这里，
     所以「跳过去」和「一句句播过来」得到的是同一份舞台状态。 */
  function replay(steps, from) {
    let st = from ? cloneState(from) : emptyState();
    for (const step of steps) {
      if (!step || !step.actions || !step.actions.length) continue;
      st = stateAt(st, step.actions, Infinity, { P: step.P, layers: step.layers });
    }
    return st;
  }
  function commit(state, actions, ctx) {
    if (!actions || !actions.length) return state;
    return stateAt(state, actions, Infinity, ctx);
  }

  /* ---------- 语义摘要（编辑器列表用） ---------- */
  function describe(action, layers, P) {
    const meta = TYPES[action.type];
    const l = layers ? layerOf(layers, resolveTarget(layers, action.type, action.target)) : null;
    const who = l ? l.name : (action.target === 'bg' ? '背景' : action.target || '舞台');
    const p = action.params || {};
    const bits = [];
    /* 音频动作没有图层，摘要里用总线名 + 素材名 + 关键参数 */
    if (action.type.indexOf('audio.') === 0) {
      const assets = (P && P.audioAssets) || [];
      const nameOf = (id) => {
        const a = assets.find((x) => x.id === id);
        return a ? a.name : (id ? '素材已失效' : '未选择素材');
      };
      const loopText = () => (p.loopMode === 'region' ? '循环 ' + p.loopStart + '–' + p.loopEnd + 's' : p.loopMode === 'off' ? '不循环' : '整曲循环');
      const bus = action.type.startsWith('audio.bgm') ? '背景音乐' : action.type.startsWith('audio.sfx') ? '音效' : action.type.startsWith('audio.voice') ? '配音' : action.type === 'audio.bus.volume' ? '总线' : '混音';
      if (action.type === 'audio.bgm.play') bits.push(nameOf(p.audioId) + ' · 音量 ' + p.volume + '% · 淡入 ' + p.fadeIn + 's · ' + loopText());
      else if (action.type === 'audio.bgm.stop') bits.push('淡出 ' + p.fadeOut + 's');
      else if (action.type === 'audio.bgm.crossfade') bits.push(nameOf(p.audioId) + ' · ' + p.duration + 's · ' + (p.curve === 'equalPower' ? '等功率' : '线性') + ' · ' + loopText());
      else if (action.type === 'audio.bgm.volume') bits.push(p.volume + '% · ' + p.duration + 's');
      else if (action.type === 'audio.bgm.loop') bits.push(loopText());
      else if (action.type === 'audio.sfx.play') bits.push(nameOf(p.audioId) + ' · ' + p.volume + '%' + (p.key ? ' · ' + p.key : ''));
      else if (action.type === 'audio.sfx.stop') bits.push(p.key ? '停止 ' + p.key : '停止全部同名音效');
      else if (action.type === 'audio.voice.play') bits.push(nameOf(p.audioId) + ' · ' + (p.duck !== false ? '压低音乐' : '不压低'));
      else if (action.type === 'audio.voice.stop') bits.push('停止当前配音');
      else if (action.type === 'audio.bus.volume') bits.push(p.bus + ' → ' + p.volume + '%');
      else if (action.type === 'audio.ducking') bits.push((p.enabled === false ? '关闭' : '压低到 ' + p.level + '%') + ' · ' + p.attack + 's / ' + p.release + 's');
      return { type: meta.name, who: bus, detail: bits.join(' · ') };
    }
    if (action.type === 'character.show') bits.push({ left: '从左侧进入', right: '从右侧进入', fade: '淡入', none: '直接出现' }[p.side] || '淡入');
    if (action.type === 'character.hide') bits.push(p.mode === 'out' ? '移出舞台' : '淡出');
    if (action.type === 'character.move') bits.push('到 ' + Math.round(p.x) + '% / ' + Math.round(p.y) + '%');
    if (action.type === 'character.scale') bits.push(p.scale + '%');
    if (action.type === 'character.opacity') bits.push(p.opacity + '%');
    if (action.type === 'character.expression') {
      const c = l && l.characterId ? (P.characters || []).find((x) => x.id === l.characterId) : null;
      const e = c ? (c.expressions || []).find((x) => x.id === p.expressionId) : null;
      bits.push(e ? e.name : (p.expressionId ? '表情已失效' : '选择表情'));
    }
    if (action.type === 'character.bob') bits.push('幅度 ' + p.amplitude + ' × ' + p.times);
    if (action.type === 'background.change') {
      const a = (P.assets || []).find((x) => x.id === p.assetId);
      bits.push((a ? a.name : '未选背景') + ' · ' + ({ cut: '直接切换', crossfade: '交叉淡化', fadeBlack: '黑屏过渡', fadeWhite: '白屏过渡', slideLeft: '左滑', slideRight: '右滑' }[p.transition] || p.transition));
    }
    if (action.type === 'camera.move') bits.push(Math.round(p.x) + '% / ' + Math.round(p.y) + '%');
    if (action.type === 'camera.zoom') bits.push(p.scale + '%');
    if (action.type === 'screen.fade') bits.push((p.to === 0 ? '渐亮' : '渐暗 ' + p.to + '%') + ' · ' + (p.color === 'white' ? '白' : '黑'));
    if (action.type === 'screen.flash') bits.push(p.color === 'black' ? '闪黑' : '闪白');
    if (action.type === 'screen.shake') bits.push('强度 ' + p.strength);
    return { type: meta.name, who, detail: bits.join(' · ') };
  }

  /* ---------- 预设 ---------- */
  /* 预设只生成标准动作，不引入第二套运行机制。 */
  const PRESETS = [
    {
      id: 'charEnterFade', name: '角色淡入登场',
      build: (id, target) => [make(id(), 'character.show', target, { params: { side: 'fade' }, duration: 0.8, blocking: true })]
    },
    {
      id: 'charEnterSide', name: '角色侧面进入',
      build: (id, target) => [
        make(id(), 'character.show', target, { params: { side: 'left' }, duration: 1.0, blocking: true }),
        make(id(), 'character.bob', target, { params: { amplitude: 1.5, times: 1 }, duration: 0.8, blocking: false, mode: 'after' })
      ]
    },
    {
      id: 'charStepIn', name: '角色向前靠近',
      build: (id, target, ctx) => [make(id(), 'character.scale', target, { params: { scale: ctx && ctx.scale || 140 }, duration: 1.2, easing: 'easeInOut' })]
    },
    {
      id: 'charExit', name: '角色退场',
      build: (id, target) => [make(id(), 'character.hide', target, { params: { mode: 'fade' }, duration: 0.8 })]
    },
    {
      id: 'sceneFade', name: '场景淡入淡出',
      build: (id, target, ctx) => [
        make(id(), 'screen.fade', '', { params: { to: 100, color: 'black' }, duration: 0.6, blocking: true }),
        make(id(), 'background.change', 'bg', { params: { assetId: (ctx && ctx.assetId) || '', transition: 'cut' }, duration: 0.05, mode: 'after' }),
        make(id(), 'screen.fade', '', { params: { to: 0, color: 'black' }, duration: 0.6, mode: 'after' })
      ]
    },
    {
      id: 'memoryFlash', name: '回忆闪白',
      build: (id) => [
        make(id(), 'screen.flash', '', { params: { color: 'white' }, duration: 0.6, blocking: true }),
        make(id(), 'camera.zoom', '', { params: { scale: 108 }, duration: 1.4, mode: 'parallel' })
      ]
    },
    {
      id: 'softShake', name: '轻微屏幕震动',
      build: (id) => [make(id(), 'screen.shake', '', { params: { strength: 1.4 }, duration: 0.6 })]
    }
  ];

  /* ---------- 音频预设（V0.8.1） ----------
     与视觉预设一样，只生成标准动作；音频素材由 ctx.audioId 带入，
     没选素材时生成的动作仍然合法，只是播放时会被跳过。 */
  const AUDIO_PRESETS = [
    { id: 'bgmFadeIn', name: 'BGM 淡入', build: (id, ctx) => [
      make(id(), 'audio.bgm.play', '', { params: { audioId: (ctx && ctx.audioId) || '', volume: 80, fadeIn: 2, loopMode: 'all' }, duration: 2 })] },
    { id: 'bgmFadeOut', name: 'BGM 淡出', build: (id) => [
      make(id(), 'audio.bgm.stop', '', { params: { fadeOut: 2 }, duration: 2 })] },
    { id: 'bgmCrossfade', name: '平滑切换 BGM', build: (id, ctx) => [
      make(id(), 'audio.bgm.crossfade', '', { params: { audioId: (ctx && ctx.audioId) || '', volume: 85, duration: 2.5, curve: 'equalPower', loopMode: 'all' }, duration: 2.5 })] },
    { id: 'ambienceDown', name: '环境音乐渐弱', build: (id) => [
      make(id(), 'audio.bus.volume', '', { params: { bus: 'bgm', volume: 35, duration: 3 }, duration: 3 })] },
    { id: 'duckUnderVoice', name: '配音压低音乐', build: (id) => [
      make(id(), 'audio.ducking', '', { params: { enabled: true, level: 35, attack: 0.25, release: 0.6 }, duration: 0.3 })] },
    { id: 'sceneFadeOut', name: '场景结束音乐淡出', build: (id) => [
      make(id(), 'audio.bgm.stop', '', { params: { fadeOut: 3 }, duration: 3 })] },
    { id: 'musicSwell', name: '音乐渐强', build: (id) => [
      make(id(), 'audio.bus.volume', '', { params: { bus: 'bgm', volume: 100, duration: 2 }, duration: 2 }),
      make(id(), 'audio.bgm.volume', '', { params: { volume: 100, duration: 2 }, duration: 2, mode: 'parallel' })] }
  ];

  return {
    VERSION, TYPES, EASINGS, PRESETS, AUDIO_PRESETS, MAX_ACTIONS, AUDIO_BUSES,
    isAudioType: (t) => String(t || '').indexOf('audio.') === 0,
    make, empty, normalize, validate, schedule, totalDuration, blockUntil,
    emptyState, cloneState, stateAt, replay, commit, applyDOM, clearOverlays, play,
    resolveTarget, describe, expressionAsset, ease, loopOf
  };
}
if (typeof module !== 'undefined') module.exports = createPaperPerformance;

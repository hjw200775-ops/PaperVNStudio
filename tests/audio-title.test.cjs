'use strict';
/* V0.8.1-RC2：标题音乐的循环区间必须能保存/读回，否则「编辑器里设了 6–14，
   重新打开却整曲循环」。这里只测数据层与校验，播放层在 tests/audio-precise.test.cjs。 */
const assert = require('node:assert/strict');
const C = require('../dist/core.js')();
const A = require('../dist/audio.js')();

/* 1. 带区间的标题音乐：规范化后区间保留 */
{
  const p = { titleMusic: { audioId: 'a1', volume: 65, fadeIn: 1.5, loop: true, loopStart: 6, loopEnd: 14 } };
  const out = C.toTitleMusic(p).titleMusic;
  assert.equal(out.loopStart, 6);
  assert.equal(out.loopEnd, 14);
  assert.equal(out.loop, true);
  assert.equal(out.volume, 65);
  assert.equal(C.checkTitleMusic(p), undefined, '合法区间应通过校验');
}

/* 2. 不带区间的旧工程：不得凭空多出字段 */
{
  const p = { titleMusic: { audioId: 'a1', volume: 80, fadeIn: 1.2, loop: true } };
  const out = C.toTitleMusic(p).titleMusic;
  assert.deepEqual(Object.keys(out).sort(), ['audioId', 'fadeIn', 'loop', 'volume']);
  assert.equal('loopStart' in out, false, '旧工程不能被加上 loopStart');
}

/* 3. 区间非法：结束不晚于开始要报错；越界要报错 */
{
  assert.throws(() => C.checkTitleMusic({ titleMusic: { audioId: 'a', volume: 80, fadeIn: 1, loop: true, loopStart: 12, loopEnd: 12 } }),
    /循环区间需结束晚于开始/);
  assert.throws(() => C.checkTitleMusic({ titleMusic: { audioId: 'a', volume: 80, fadeIn: 1, loop: true, loopStart: -5, loopEnd: 12 } }),
    /循环区间格式错误/);
  assert.throws(() => C.checkTitleMusic({ titleMusic: { audioId: 'a', volume: 80, fadeIn: 1, loop: true, loopStart: 0, loopEnd: 999999 } }),
    /循环区间格式错误/);
}

/* 4. 播放入口对区间做同样的归一：越界退化整曲，不把坏值丢给 BufferSource */
{
  assert.deepEqual(A.pure.loopSpec({ mode: 'region', start: 6, end: 14 }), { mode: 'region', start: 6, end: 14 });
  assert.deepEqual(A.pure.loopSpec({ mode: 'region', start: 14, end: 6 }), { mode: 'all', start: 0, end: 0 });
  assert.deepEqual(A.pure.loopSpec({ mode: 'off', start: 6, end: 14 }), { mode: 'off', start: 0, end: 0 });
}

/* 5. 默认标题音乐不写区间，避免给新工程凭空造出 region */
{
  const d = C.defaultTitleMusic();
  assert.equal('loopStart' in d, false);
  assert.equal('loopEnd' in d, false);
}

console.log('PASS: 标题音乐循环区间（保存保留/旧工程不加字段/非法区间报错/播放归一/默认值）');

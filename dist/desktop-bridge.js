/* Renderer-side desktop adapter. In the web build window.paperDesktop does not
 * exist, so PaperHost stays undefined and app.js keeps the IndexedDB / Blob
 * behaviour untouched. No Node, fs or shell is reachable from this context. */
(function () {
  const api = window.paperDesktop;
  if (!api) return;
  document.body.classList.add('desktop');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = r => { if (r && r.ok) return r; throw new Error((r && r.message) || '桌面文件操作失败'); };
  /* Every IPC call is async: unwrap the resolved value before validating it.
   * Passing the pending Promise into ok() would read an undefined .ok and
   * report a bogus "desktop file operation failed" on save/open/new. */
  const call = run => Promise.resolve().then(run).then(ok);

  /* Turn a main-process file result into something the existing callbacks can
   * consume without changing their editor logic. */
  function fileLike(f) {
    if (!f) return null;
    /* 复制主进程返回的元数据（哈希 / 大小 / MIME / 时长 / 受控 URL）。
       桌面版没有 Base64：dataUrl 字段只是兼容旧回调的受控 paper:// 地址。 */
    return Object.assign({}, f, {
      text: () => Promise.resolve(f.text == null ? '' : f.text)
    });
  }

  function applyState(s) {
    const pathEl = document.getElementById('projectPath');
    if (pathEl) {
      pathEl.textContent = s.currentDir ? s.label : '未关联工程目录';
      pathEl.title = s.currentDir || '使用「保存」或「另存为」创建工程目录';
    }
    const select = document.getElementById('recentList');
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">最近工程…</option>' + (s.recent || [])
        .map((r, i) => '<option value="' + i + '">' + esc(r.title) + ' · ' + esc(r.folder) + '</option>').join('');
      if (current && select.querySelector('option[value="' + current + '"]')) select.value = current;
    }
    const note = document.getElementById('storageNote');
    if (note) note.textContent = '图片保存在工程目录内；自动保存、备份与启动恢复已启用';
  }

  window.PaperHost = {
    desktop: true,
    bootstrap: () => call(() => api.bootstrap()),
    applyState,
    autoSave: p => api.autoSave(p),
    save: p => call(() => api.save(p)),
    saveAs: p => call(() => api.saveAs(p)),
    newProject: () => call(() => api.newProject()),
    open: () => call(() => api.open()),
    openRecent: index => call(() => api.openRecent(index)),
    recent: () => call(() => api.recent()),
    /* 单文件入口复用旧回调；批量导入走 stageFiles，两者都由主进程流式暂存。 */
    pickImage: assetKind => api.stageAssets({ kind: 'image', assetKind, multiple: false })
      .then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.files && v.files[0]); }),
    pickAudio: () => api.stageAssets({ kind: 'audio', multiple: false })
      .then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.files && v.files[0]); }),
    stageFiles: payload => api.stageAssets(Object.assign({ multiple: true }, payload || {}))
      .then(r => { const v = ok(r); return { cancelled: !!v.cancelled, files: (v.files || []).map(fileLike), errors: v.errors || [] }; }),
    cancelStage: token => call(() => api.cancelStage(token)),
    gcStaging: payload => call(() => api.gcStaging(payload)),
    stagingStats: () => call(() => api.stagingStats()),
    metrics: () => call(() => api.metrics()),
    onStageProgress: handler => { try { api.onStageProgress(handler); } catch { /* 浏览器版没有 */ } },
    pickText: () => api.pickText().then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.file); }),
    previewGame: project => call(() => api.previewGame(project)),
    onPreviewProgress: handler => { try { api.onPreviewProgress(handler); } catch { /* 浏览器版没有 */ } },
    closePreview: () => call(() => api.closePreview()),
    sampleInfo: () => call(() => api.sampleInfo()),
    experienceSample: () => call(() => api.experienceSample()),
    copySample: () => call(() => api.copySample()),
    gameToolchain: () => call(() => api.gameToolchain()),
    pickGameIcon: () => api.pickGameIcon().then(r => { const v = ok(r); return v.cancelled ? null : { name: v.name, dataUrl: v.dataUrl }; }),
    /* 取消不是错误：主进程会返回 {cancelled:true}，这里原样交给界面显示「已取消」。 */
    exportGame: payload => api.exportGame(payload).then(r => (r && r.cancelled) ? r : ok(r)),
    cancelExport: () => call(() => api.cancelExport()),
    revealFile: target => call(() => api.revealFile(target)),
    onExportProgress: handler => api.onExportProgress(handler),
    saveFile: payload => api.saveFile(payload).then(r => { const v = ok(r); return v.cancelled ? null : v; }),
    onCommand: handler => api.onCommand(handler),
    onSaveBeforeClose: handler => api.onSaveBeforeClose(handler),
    finishSaveBeforeClose: result => api.finishSaveBeforeClose(result),
    pathLabel: p => p ? p : '未保存的工程',
    esc
  };
})();

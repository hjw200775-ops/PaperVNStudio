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
    return {
      name: f.name, size: f.size, type: f.type,
      dataUrl: f.dataUrl, id: f.id,
      text: () => Promise.resolve(f.text == null ? '' : f.text)
    };
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
    pickImage: assetKind => api.pickImage(assetKind).then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.file); }),
    pickAudio: () => api.pickAudio().then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.file); }),
    pickText: () => api.pickText().then(r => { const v = ok(r); return v.cancelled ? null : fileLike(v.file); }),
    previewGame: html => call(() => api.previewGame(html)),
    saveFile: payload => api.saveFile(payload).then(r => { const v = ok(r); return v.cancelled ? null : v; }),
    onCommand: handler => api.onCommand(handler),
    onSaveBeforeClose: handler => api.onSaveBeforeClose(handler),
    finishSaveBeforeClose: result => api.finishSaveBeforeClose(result),
    pathLabel: p => p ? p : '未保存的工程',
    esc
  };
})();

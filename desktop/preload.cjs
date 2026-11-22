'use strict';
/* Narrow, fixed-channel bridge. No fs/path/shell/ipcRenderer is exposed. */
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('paperDesktop', {
  bootstrap: () => call('project:bootstrap'),
  autoSave: p => call('project:autoSave', p),
  save: p => call('project:save', p),
  saveAs: p => call('project:saveAs', p),
  newProject: () => call('project:new'),
  open: () => call('project:open'),
  openRecent: index => call('project:openRecent', index),
  recent: () => call('project:recent'),
  pickImage: assetKind => call('file:pickImage', assetKind),
  pickAudio: () => call('file:pickAudio'),
  stageAssets: payload => call('asset:stage', payload),
  cancelStage: token => call('asset:cancelStage', token),
  gcStaging: payload => call('asset:gc', payload),
  stagingStats: () => call('asset:stagingStats'),
  metrics: () => call('app:metrics'),
  onStageProgress: handler => ipcRenderer.on('asset:stageProgress', (_event, progress) => handler(progress)),
  pickText: () => call('file:pickText'),
  previewGame: project => call('player:preview', project),
  onPreviewProgress: handler => ipcRenderer.on('preview:progress', (_event, progress) => handler(progress)),
  closePreview: () => call('player:closePreview'),
  sampleInfo: () => call('sample:info'),
  experienceSample: () => call('sample:experience'),
  copySample: () => call('sample:copy'),
  saveFile: payload => call('file:save', payload),
  gameToolchain: () => call('game:toolchain'),
  pickGameIcon: () => call('game:pickIcon'),
  exportGame: payload => call('game:export', payload),
  cancelExport: () => call('game:cancelExport'),
  revealFile: target => call('game:reveal', target),
  onExportProgress: handler => ipcRenderer.on('game:exportProgress', (_event, progress) => handler(progress)),
  onCommand: handler => ipcRenderer.on('app:command', (_event, command) => handler(command)),
  onSaveBeforeClose: handler => ipcRenderer.on('app:saveBeforeClose', (_event, token) => handler(token)),
  finishSaveBeforeClose: result => call('app:finishSaveBeforeClose', result)
});

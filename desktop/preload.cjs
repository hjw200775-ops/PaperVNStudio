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
  pickText: () => call('file:pickText'),
  previewGame: html => call('player:preview', html),
  sampleInfo: () => call('sample:info'),
  experienceSample: () => call('sample:experience'),
  copySample: () => call('sample:copy'),
  saveFile: payload => call('file:save', payload),
  onCommand: handler => ipcRenderer.on('app:command', (_event, command) => handler(command)),
  onSaveBeforeClose: handler => ipcRenderer.on('app:saveBeforeClose', (_event, token) => handler(token)),
  finishSaveBeforeClose: result => call('app:finishSaveBeforeClose', result)
});

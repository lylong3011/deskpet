'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // 通用
  getState: () => ipcRenderer.invoke('state:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:set-api-key', key),
  testProvider: () => ipcRenderer.invoke('settings:test-provider'),
  generateCharacter: (payload) => ipcRenderer.invoke('character:generate', payload),
  saveCharacter: (payload) => ipcRenderer.invoke('character:save', payload),
  setActiveCharacter: (id) => ipcRenderer.invoke('character:set-active', id),
  renameCharacter: (name) => ipcRenderer.invoke('character:rename', name),
  deleteCharacter: (id) => ipcRenderer.invoke('character:delete', id),
  testReminder: (kind) => ipcRenderer.invoke('reminder:test', kind),
  pokePet: () => ipcRenderer.invoke('pet:poke'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openSettings: () => ipcRenderer.send('app:open-settings'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),

  // 道具 / 贴图
  listProps: () => ipcRenderer.invoke('props:list'),
  toggleProp: (id, on) => ipcRenderer.invoke('props:toggle', { id, on }),
  addProp: (payload) => ipcRenderer.invoke('props:add', payload),
  deleteProp: (id) => ipcRenderer.invoke('props:delete', { id }),
  generateProp: (prompt) => ipcRenderer.invoke('props:generate', { prompt }),
  focusPet: () => ipcRenderer.send('pet:focus'),
  menuOpened: () => ipcRenderer.send('pet:menu-open'),
  menuClosed: () => ipcRenderer.send('pet:menu-closed'),

  // 桌宠窗口
  setClickThrough: (through) => ipcRenderer.send('pet:click-through', through),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  interact: (kind) => ipcRenderer.send('pet:interact', kind),
  chat: (text) => ipcRenderer.invoke('pet:chat', text),

  // 事件订阅
  onSay: (cb) => subscribe('pet:say', cb),
  onAct: (cb) => subscribe('pet:act', cb),
  onInit: (cb) => subscribe('pet:init', cb),
  onState: (cb) => subscribe('state:update', cb),
  onSound: (cb) => subscribe('pet:sound', cb),
  onProps: (cb) => subscribe('pet:props', cb),
  onMenuClose: (cb) => subscribe('pet:menu-close', cb),
});

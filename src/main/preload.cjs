// Единственная дверь из окна в главный процесс: вызов метода по имени и подписка на 3 события.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['progress', 'log', 'game'];

contextBridge.exposeInMainWorld('api', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, ...args),
  on: (channel, cb) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, data) => cb(data));
  },
});

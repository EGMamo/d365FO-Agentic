// Gives the side strip (rail.html) its few calls into the main process; nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rail', {
  go: (id) => ipcRenderer.send('rail:go', id),
  profileMenu: () => ipcRenderer.send('rail:profile-menu'),
  onState: (cb) => ipcRenderer.on('rail:state', (_e, state) => cb(state)),
});

// The Chat model bar above Open WebUI (chatbar.html).
contextBridge.exposeInMainWorld('bar', {
  setModel: (id) => ipcRenderer.send('bar:set-model', id),
  newChat: () => ipcRenderer.send('bar:new-chat'),
  onState: (cb) => ipcRenderer.on('bar:state', (_e, state) => cb(state)),
});

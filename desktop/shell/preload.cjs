// Gives the side strip (rail.html) its few calls into the main process; no Node APIs are exposed to the app page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rail', {
  go: (id) => ipcRenderer.send('rail:go', id),
  profileMenu: () => ipcRenderer.send('rail:profile-menu'),
  onState: (cb) => ipcRenderer.on('rail:state', (_e, state) => cb(state)),
});

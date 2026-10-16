const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    setIgnoreMouseEvents: (ignore) => {
        ipcRenderer.send('set-ignore-mouse-events', ignore, { forward: true });
    },
    updatePetInteractionState: (x, y, pointerActive) => {
        ipcRenderer.send('pet:interaction-state', { x, y, pointerActive });
    },
    onCommand: (callback) => {
        ipcRenderer.on('pet:command', (_event, command) => callback(command));
    },
    onResume: (callback) => {
        ipcRenderer.on('pet:resume', callback);
    }
});

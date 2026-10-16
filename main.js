const { app, BrowserWindow, screen, ipcMain, powerMonitor, globalShortcut, shell } = require('electron');
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./config');
app.setName(CONFIG.application.name);

let petWindow = null;
let server = null;
let petModel = null;
let taskbarMonitor = null;
let taskbarMonitorBuffer = '';
let isQuitting = false;
let mouseCaptureTimer = null;
let zOrderTimer = null;
let ignoreMouseEvents = true;
let petInteractionState = { x: 0, y: 0, pointerActive: false };
const PORT = CONFIG.server.port;
const DEBUG_DEVTOOLS = process.env.PET_DEVTOOLS === '1' || CONFIG.debug.devTools;
function debugLog(...args) {
    if (CONFIG.debug.logEnabled) console.log(...args);
}

function createWindowsShortcuts() {
    if (
        process.platform !== 'win32' ||
        !CONFIG.application.createWindowsShortcuts
    ) return;

    const shortcutOptions = {
        target: process.execPath,
        cwd: __dirname,
        args: '.',
        description: CONFIG.application.name,
        icon: process.execPath,
        iconIndex: 0
    };
    const shortcutFolders = [];

    if (CONFIG.application.desktopShortcut) {
        shortcutFolders.push(app.getPath('desktop'));
    }
    if (CONFIG.application.startMenuShortcut) {
        shortcutFolders.push(path.join(
            app.getPath('appData'),
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs'
        ));
    }

    for (const folder of shortcutFolders) {
        const shortcutPath = path.join(folder, CONFIG.application.name + '.lnk');
        if (!shell.writeShortcutLink(shortcutPath, 'create', shortcutOptions)) {
            console.error('[main] failed to create Windows shortcut:', shortcutPath);
        }
    }
}

const CHARACTER_CONFIGS = Object.entries(CONFIG.characters).map(([id, character]) => ({
    id,
    label: character.label,
    dir: path.join(__dirname, ...character.directory),
    urlPrefix: character.urlPrefix,
    prefer: character.buildingKeyword,
    startupKeyword: character.startupKeyword
}));

function sanitizeFilenames(dir) {
    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            const newName = file.replace(/#/g, '_');
            const newPath = path.join(dir, newName);
            if (file !== newName) {
                fs.renameSync(filePath, newPath);
                sanitizeFilenames(newPath);
            } else sanitizeFilenames(filePath);
        } else {
            const newName = file.replace(/#/g, '_');
            const newPath = path.join(dir, newName);
            if (file !== newName) {
                fs.renameSync(filePath, newPath);
                if (newName.endsWith('.atlas')) {
                    let c = fs.readFileSync(newPath, 'utf8');
                    const oldP = file.replace('.atlas', '.png');
                    const newP = newName.replace('.atlas', '.png');
                    c = c.replace(new RegExp(oldP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newP);
                    fs.writeFileSync(newPath, c);
                }
            }
        }
    });
}

function findSpineModels(dir, baseDir, urlPrefix) {
    let results = [];
    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(findSpineModels(filePath, baseDir, urlPrefix));
        } else if (file.endsWith('.skel')) {
            const baseName = file.replace('.skel', '');
            const relDir = path.relative(baseDir, dir);
            const urlDir = relDir ? relDir.split(path.sep).join('/') : '';
            const fullUrl = urlDir ? (urlPrefix + '/' + urlDir) : urlPrefix;
            results.push({
                skelUrl: fullUrl + '/' + baseName + '.skel',
                atlasUrl: fullUrl + '/' + baseName + '.atlas',
                label: relDir || 'root'
            });
        }
    });
    return results;
}

function pickBuilding(models, preferKeyword) {
    if (!models || models.length === 0) return null;
    const kw = (preferKeyword || 'building').toLowerCase();
    let p = models.find(m => m.label.toLowerCase().includes(kw));
    if (p) return p;
    p = models.find(m => m.label.toLowerCase().includes('build'));
    if (p) return p;
    return models[0];
}

function pickStartupModel(models, keyword) {
    const normalizedKeyword = (keyword || '').toLowerCase();
    return models.find(m => m.label.toLowerCase().includes(normalizedKeyword)) || null;
}

function startServer() {
    const characters = {};

    for (const cfg of CHARACTER_CONFIGS) {
        if (!fs.existsSync(cfg.dir)) {
            console.warn('[main] folder missing for', cfg.id, cfg.dir);
            characters[cfg.id] = null;
            continue;
        }
        sanitizeFilenames(cfg.dir);
        const models = findSpineModels(cfg.dir, cfg.dir, cfg.urlPrefix);
        debugLog('[main] ' + cfg.id + ': ' + models.length + ' models');
        const pick = pickBuilding(models, cfg.prefer);
        const startModel = pickStartupModel(models, cfg.startupKeyword);
        if (pick) {
            characters[cfg.id] = {
                id: cfg.id,
                label: cfg.label,
                skelUrl: pick.skelUrl,
                atlasUrl: pick.atlasUrl,
                start: startModel ? {
                    skelUrl: startModel.skelUrl,
                    atlasUrl: startModel.atlasUrl
                } : null
            };
            debugLog('[main] ' + cfg.id + ' -> ' + pick.label);
            if (startModel) {
                debugLog('[main] ' + cfg.id + ' startup -> ' + startModel.label);
            }
        } else {
            characters[cfg.id] = null;
        }
    }

    petModel = { characters };

    const expressApp = express();

    for (const cfg of CHARACTER_CONFIGS) {
        if (fs.existsSync(cfg.dir)) {
            expressApp.use(cfg.urlPrefix, express.static(cfg.dir));
        }
    }

    expressApp.use('/libs/pixi.js', express.static(path.join(__dirname, ...CONFIG.server.libraryPaths.pixi)));
    expressApp.use('/libs/pixi-spine', express.static(path.join(__dirname, ...CONFIG.server.libraryPaths.spine)));

    expressApp.get('/api/pet-model', (req, res) => res.json(petModel || { characters: {} }));

    expressApp.get('/', (req, res) => res.sendFile(path.join(__dirname, ...CONFIG.paths.html)));
    expressApp.get('/pet.html', (req, res) => res.sendFile(path.join(__dirname, ...CONFIG.paths.html)));
    expressApp.get('/pet.js', (req, res) => {
        res.set('Content-Type', 'application/javascript');
        res.sendFile(path.join(__dirname, ...CONFIG.paths.renderer));
    });
    expressApp.get('/config.js', (req, res) => {
        res.set('Content-Type', 'application/javascript');
        res.sendFile(path.join(__dirname, ...CONFIG.paths.config));
    });

    return new Promise((resolve) => {
        server = expressApp.listen(PORT, CONFIG.server.host, () => resolve());
    });
}

function getPetWindowBounds() {
    const { bounds, workArea } = screen.getPrimaryDisplay();
    return {
        x: bounds.x,
        y: workArea.y + workArea.height - CONFIG.window.height + CONFIG.window.baselineOffset,
        width: bounds.width,
        height: CONFIG.window.height
    };
}

function positionPetAtTaskbar(taskbarTop) {
    if (!petWindow || petWindow.isDestroyed()) return;

    const display = screen.getPrimaryDisplay();
    const physicalDisplayTop = Math.round(display.bounds.y * display.scaleFactor);
    const taskbarTopDip = display.bounds.y + (taskbarTop - physicalDisplayTop) / display.scaleFactor;
    const y = Math.round(taskbarTopDip - CONFIG.window.height + CONFIG.window.baselineOffset);
    if (petWindow.getBounds().y !== y) {
        petWindow.setPosition(petWindow.getBounds().x, y);
    }
    keepPetAboveTaskbar();
}

function keepPetAboveTaskbar() {
    if (!petWindow || petWindow.isDestroyed() || !CONFIG.window.alwaysOnTop) return;

    petWindow.setAlwaysOnTop(true, CONFIG.window.alwaysOnTopLevel);
    petWindow.moveTop();
}

function updatePetMouseCapture() {
    if (!CONFIG.taskbar.monitorEnabled || !petWindow || petWindow.isDestroyed()) return;

    const bounds = petWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const petX = bounds.x + petInteractionState.x;
    const petY = bounds.y + petInteractionState.y;
    const hitboxTop = CONFIG.renderer.hitboxTopOffset != null
        ? CONFIG.renderer.hitboxTopOffset : CONFIG.renderer.hitboxHalfHeight;
    const hitboxBottom = CONFIG.renderer.hitboxBottomOffset != null
        ? CONFIG.renderer.hitboxBottomOffset : CONFIG.renderer.hitboxHalfHeight;
    const dy = cursor.y - petY;
    const overPet =
        Math.abs(cursor.x - petX) < CONFIG.renderer.hitboxHalfWidth &&
        dy < hitboxBottom &&
        dy > -hitboxTop;
    const shouldIgnore = !overPet && !petInteractionState.pointerActive;

    if (shouldIgnore !== ignoreMouseEvents) {
        ignoreMouseEvents = shouldIgnore;
        petWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    }
}

function startTaskbarMonitor() {
    if (!CONFIG.taskbar.monitorEnabled || process.platform !== 'win32') return;

    taskbarMonitor = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, ...CONFIG.taskbar.mouseMonitorScript)
    ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    taskbarMonitor.stdout.setEncoding('utf8');
    taskbarMonitor.stdout.on('data', (chunk) => {
        taskbarMonitorBuffer += chunk;
        const lines = taskbarMonitorBuffer.split(/\r?\n/);
        taskbarMonitorBuffer = lines.pop();

        for (const line of lines) {
            if (line.startsWith('DISPLAY,')) {
                const displayState = Number(line.substring('DISPLAY,'.length));
                if (!Number.isInteger(displayState) || displayState < 0 || displayState > 2) {
                    console.warn('[taskbar] invalid display power state:', line);
                    continue;
                }
                if (displayState === 1) recoverPetWindow();
                continue;
            }

            const parts = line.split(',');
            if (parts.length !== 4) {
                console.warn('[taskbar] invalid monitor output:', line);
                continue;
            }
            const [left, top, right, bottom] = parts.map(Number);
            if (![left, top, right, bottom].every(Number.isFinite)) {
                console.warn('[taskbar] invalid taskbar bounds:', line);
                continue;
            }
            positionPetAtTaskbar(top);
        }
    });

    taskbarMonitor.stderr.setEncoding('utf8');
    taskbarMonitor.stderr.on('data', (chunk) => {
        console.error('[taskbar] monitor error:', chunk.trim());
    });
    taskbarMonitor.on('error', (error) => {
        console.error('[taskbar] could not start monitor:', error);
    });
    taskbarMonitor.on('exit', (code, signal) => {
        taskbarMonitor = null;
        if (!isQuitting && code !== 0) {
            console.error('[taskbar] monitor exited:', code, signal);
        }
    });
}

function createPetWindow() {
    const bounds = getPetWindowBounds();

    petWindow = new BrowserWindow({
        ...bounds,
        frame: CONFIG.window.frame,
        transparent: CONFIG.window.transparent,
        alwaysOnTop: CONFIG.window.alwaysOnTop,
        skipTaskbar: CONFIG.window.skipTaskbar,
        resizable: CONFIG.window.resizable,
        movable: CONFIG.window.movable,
        hasShadow: CONFIG.window.hasShadow,
        focusable: CONFIG.window.focusable,
        fullscreenable: CONFIG.window.fullscreenable,
        webPreferences: {
            preload: path.join(__dirname, ...CONFIG.paths.preload),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: CONFIG.window.backgroundThrottling
        }
    });

    petWindow.setAlwaysOnTop(CONFIG.window.alwaysOnTop, CONFIG.window.alwaysOnTopLevel);
    if (CONFIG.window.alwaysOnTop) petWindow.moveTop();
    petWindow.setVisibleOnAllWorkspaces(CONFIG.window.visibleOnAllWorkspaces, {
        visibleOnFullScreen: CONFIG.window.visibleOnFullScreen
    });
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    ignoreMouseEvents = true;

    petWindow.webContents.on('console-message', (event, level, message) => {
        if (CONFIG.debug.logEnabled) {
            console.log('[pet]', message);
        } else if (level === 3) {
            console.error('[pet]', message);
        }
    });

    petWindow.webContents.on('render-process-gone', (event, details) => {
        console.error('[pet] renderer crashed:', details.reason);
    });

    petWindow.loadURL(`http://${CONFIG.server.host}:${PORT}/${CONFIG.paths.html[0]}`);

    if (DEBUG_DEVTOOLS) {
        petWindow.webContents.openDevTools({ mode: 'detach' });
    }

    petWindow.on('closed', () => { petWindow = null; });
}

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    if (petWindow && event.sender === petWindow.webContents) {
        ignoreMouseEvents = Boolean(ignore);
        petWindow.setIgnoreMouseEvents(ignore, options || { forward: true });
    }
});

ipcMain.on('pet:interaction-state', (event, state) => {
    if (!petWindow || event.sender !== petWindow.webContents || !state) return;
    if (
        !Number.isFinite(state.x) ||
        !Number.isFinite(state.y) ||
        typeof state.pointerActive !== 'boolean'
    ) {
        console.warn('[pet] ignored invalid interaction state');
        return;
    }

    petInteractionState = state;
});

function recoverPetWindow() {
    if (!petWindow || petWindow.isDestroyed()) return;
    keepPetAboveTaskbar();
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    ignoreMouseEvents = true;
    petInteractionState.pointerActive = false;
    if (petWindow.webContents.isLoading()) return;
    petWindow.webContents.send('pet:resume');
}

app.whenReady().then(async () => {
    createWindowsShortcuts();
    await startServer();
    createPetWindow();
    startTaskbarMonitor();
    mouseCaptureTimer = setInterval(updatePetMouseCapture, CONFIG.taskbar.mouseCaptureCheckIntervalMs);
    zOrderTimer = setInterval(keepPetAboveTaskbar, CONFIG.taskbar.zOrderReassertIntervalMs);

    for (const { accelerator, command } of CONFIG.shortcuts) {
        const ok = globalShortcut.register(accelerator, () => {
            if (command === 'exit') {
                app.quit();
                return;
            }
            if (petWindow && !petWindow.isDestroyed()) {
                petWindow.webContents.send('pet:command', command);
            }
        });
        if (ok) debugLog('[main] hotkey', accelerator, '->', command, 'ok');
        else console.error('[main] hotkey', accelerator, '->', command, 'FAILED');
    }

    powerMonitor.on('unlock-screen', recoverPetWindow);
    powerMonitor.on('resume', recoverPetWindow);
    powerMonitor.on('lock-screen', () => {
        if (!petWindow || petWindow.isDestroyed()) return;
        petInteractionState.pointerActive = false;
        ignoreMouseEvents = true;
        petWindow.setIgnoreMouseEvents(true, { forward: true });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
    });
});

app.on('window-all-closed', () => {
    if (server) server.close();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (mouseCaptureTimer) clearInterval(mouseCaptureTimer);
    if (zOrderTimer) clearInterval(zOrderTimer);
    if (taskbarMonitor) taskbarMonitor.kill();
    if (server) server.close();
});
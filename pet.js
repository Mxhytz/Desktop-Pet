(async function () {
    'use strict';

    const CONFIG = window.CONFIG || window.PET_CONFIG || null;
    if (!CONFIG) {
        console.error('[pet] config.js did not load');
        return;
    }
    function debugLog(...args) {
        if (CONFIG.debug.logEnabled) console.log(...args);
    }

    window.addEventListener('error', (e) => {
        console.error('[pet error]', e.message, e.filename + ':' + e.lineno);
    });
    window.addEventListener('unhandledrejection', (e) => {
        console.error('[pet rejection]', e.reason);
    });

    const particleCanvas = document.getElementById('pet-canvas');
    const ctx = particleCanvas.getContext('2d');
    const DPR = Math.min(window.devicePixelRatio || 1, CONFIG.renderer.maxDevicePixelRatio);

    function resizeParticles() {
        particleCanvas.width = Math.floor(window.innerWidth * DPR);
        particleCanvas.height = Math.floor(window.innerHeight * DPR);
        particleCanvas.style.width = window.innerWidth + 'px';
        particleCanvas.style.height = window.innerHeight + 'px';
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resizeParticles();
    window.addEventListener('resize', resizeParticles);

    if (typeof PIXI === 'undefined' || typeof PIXI.spine === 'undefined') {
        console.error('[pet] PIXI not loaded');
        return;
    }

    let MODEL;
    try {
        const res = await fetch('/api/pet-model');
        MODEL = await res.json();
    } catch (e) {
        console.error('[pet] fetch failed', e);
        return;
    }

    const charsData = MODEL && MODEL.characters ? MODEL.characters : {};
    debugLog('[pet] models', charsData);

    const app = new PIXI.Application({
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: 0x000000,
        backgroundAlpha: 0,
        resolution: DPR,
        autoDensity: true,
        antialias: CONFIG.renderer.antialias,
        transparent: CONFIG.renderer.transparent
    });
    app.ticker.maxFPS = CONFIG.renderer.tickerMaxFps;
    document.body.appendChild(app.view);
    if (app.view && app.view.style) app.view.style.cursor = 'default';

    // ---- taskbar clip mask ----
    const TASKBAR_TOP_Y =
        (CONFIG.window && CONFIG.window.height ? CONFIG.window.height : 340) -
        (CONFIG.window && CONFIG.window.baselineOffset ? CONFIG.window.baselineOffset : 30);
    const capeMask = new PIXI.Graphics();
    capeMask.beginFill(0xffffff);
    capeMask.drawRect(0, 0, app.screen.width, TASKBAR_TOP_Y);
    capeMask.endFill();
    capeMask.renderable = false;
    app.stage.addChild(capeMask);
    function refreshCapeMask() {
        capeMask.clear();
        capeMask.beginFill(0xffffff);
        capeMask.drawRect(0, 0, app.screen.width, TASKBAR_TOP_Y);
        capeMask.endFill();
    }

    function loadOne(cfg) {
        return new Promise((resolve, reject) => {
            const loader = new PIXI.Loader();
            loader.add('skel', cfg.skelUrl);
            loader.add('atlas', cfg.atlasUrl);
            loader.load((l, r) => {
                if (r.skel && r.skel.spineData) resolve(r.skel.spineData);
                else reject(new Error('failed to load ' + cfg.skelUrl));
            });
        });
    }

    const loaded = {};
    const startLoaded = {};
    for (const id of Object.keys(CONFIG.characters)) {
        if (charsData[id] && charsData[id].skelUrl) {
            try {
                loaded[id] = await loadOne(charsData[id]);
                debugLog('[pet] loaded', id);
            } catch (e) {
                console.error('[pet] failed to load', id, e.message);
            }
        }
        if (charsData[id] && charsData[id].start) {
            try {
                startLoaded[id] = await loadOne(charsData[id].start);
                debugLog('[pet] loaded startup model', id);
            } catch (e) {
                console.error('[pet] failed to load startup model', id, e.message);
            }
        }
    }

    if (Object.keys(loaded).length === 0) {
        console.error('[pet] no models loaded');
        return;
    }

    const PARTICLES = CONFIG.particles;
    const RENDERER = CONFIG.renderer;
    const START_CONFIG = RENDERER.startAnimation;
    const RESET_CONFIG = CONFIG.reset;
    const PAPER_SIZE = PARTICLES.paperSize;
    const PAPER_R = PARTICLES.paperRadius;

    const PHASE_OUT = PARTICLES.phaseOutSeconds;
    const PHASE_GAP = PARTICLES.phaseGapSeconds;
    const PHASE_IN  = PARTICLES.phaseInSeconds;
    const TOTAL     = PHASE_OUT + PHASE_GAP + PHASE_IN;
    const CHAR_IN_DELAY = PARTICLES.characterInDelaySeconds;

    const DEBRIS_COUNT = PARTICLES.count;
    const PAPER_TEXTURE_POOL_SIZE = DEBRIS_COUNT * PARTICLES.texturePoolMultiplier;
    const START_ANIMATION_TIME_SCALE = START_CONFIG.timeScale;
    const START_INTRO_FADE_DURATION = START_CONFIG.introFadeSeconds;
    const START_WEAPON_FADE_DURATION = START_CONFIG.weaponFadeSeconds;
    const START_IDLE_CROSSFADE_DURATION = START_CONFIG.idleCrossfadeSeconds;
    const SIZE_MIN = PARTICLES.sizeMin;
    const SIZE_MAX = PARTICLES.sizeMax;

    const RISE_MIN = PARTICLES.riseMin;
    const RISE_MAX = PARTICLES.riseMax;

    const FLIP_DURATION = PARTICLES.flipDurationSeconds;
    const FLIP_CENTER_START = PHASE_OUT + PARTICLES.flipCenterLeadSeconds;
    const FLIP_CENTER_SPREAD = PHASE_GAP - PARTICLES.flipCenterEndPaddingSeconds;
    const BLOOM_INTENSITY = PARTICLES.bloomIntensity;

    const PET_SCALE = RENDERER.scale;
    const WALK_SPEED_IDLE = RENDERER.walkSpeedIdle;
    const WALK_SPEED_DRAG = RENDERER.walkSpeedDrag;

    const CHARACTERS = CONFIG.characters;

    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    function smootherstep(t) {
        t = Math.max(0, Math.min(1, t));
        return t * t * t * (t * (t * 6 - 15) + 10);
    }
    function shade(hex, amount) {
        const c = hex.replace('#', '');
        let r = parseInt(c.substring(0, 2), 16);
        let g = parseInt(c.substring(2, 4), 16);
        let b = parseInt(c.substring(4, 6), 16);
        const d = Math.round(255 * amount);
        r = Math.max(0, Math.min(255, r + d));
        g = Math.max(0, Math.min(255, g + d));
        b = Math.max(0, Math.min(255, b + d));
        return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    const paperTexturePools = {};
    const paperTextureCursors = {};
    let paperTexturesReady = false;
    let pendingSwapTarget = null;

    function makePaperTexture(cfg) {
        const c = document.createElement('canvas');
        c.width = c.height = PAPER_SIZE;
        const g = c.getContext('2d');
        const cx = PAPER_SIZE / 2;
        const cy = PAPER_SIZE / 2;

        const baseFill = pick(cfg.palette);
        const toneA = shade(baseFill, PARTICLES.paperToneALightMin + Math.random() * PARTICLES.paperToneALightRange);
        const toneB = shade(baseFill, -(PARTICLES.paperToneBDarkMin + Math.random() * PARTICLES.paperToneBDarkRange));
        const toneC = shade(baseFill, PARTICLES.paperToneCLightMin + Math.random() * PARTICLES.paperToneCLightRange);

        const n = PARTICLES.polygonPointMin + Math.floor(Math.random() * PARTICLES.polygonPointRandomCount);
        const pts = [];
        const biasX = PARTICLES.paperBiasMin + Math.random() * PARTICLES.paperBiasRange;
        const biasY = PARTICLES.paperBiasMin + Math.random() * PARTICLES.paperBiasRange;
        for (let i = 0; i < n; i++) {
            const angle = (i / n) * Math.PI * 2;
            const r = PAPER_R * (PARTICLES.paperRadiusScaleMin + Math.random() * PARTICLES.paperRadiusScaleRange);
            pts.push({
                x: cx + Math.cos(angle) * r * biasX,
                y: cy + Math.sin(angle) * r * biasY
            });
        }

        function tracePath() {
            g.beginPath();
            g.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
            g.closePath();
        }

        tracePath();
        g.fillStyle = baseFill;
        g.fill();

        g.save();
        tracePath();
        g.clip();

        const washCount = PARTICLES.textureWashMin + Math.floor(Math.random() * PARTICLES.textureWashRandomCount);
        for (let i = 0; i < washCount; i++) {
            const gx = cx + (Math.random() - 0.5) * PAPER_SIZE * PARTICLES.textureWashSpread;
            const gy = cy + (Math.random() - 0.5) * PAPER_SIZE * PARTICLES.textureWashSpread;
            const rad = PAPER_R * (PARTICLES.textureWashRadiusMin + Math.random() * PARTICLES.textureWashRadiusRange);
            const grad = g.createRadialGradient(gx, gy, 0, gx, gy, rad);
            const tone = pick([toneA, toneB, toneC]);
            grad.addColorStop(0, tone);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            g.globalAlpha = PARTICLES.textureWashAlphaMin + Math.random() * PARTICLES.textureWashAlphaRange;
            g.fillStyle = grad;
            g.fillRect(0, 0, PAPER_SIZE, PAPER_SIZE);
        }
        g.globalAlpha = 1;

        const angleBias = Math.random() * PARTICLES.fiberAngleBiasRange * Math.PI;
        const angleSpread = PARTICLES.fiberAngleSpreadMin + Math.random() * PARTICLES.fiberAngleSpreadRange;
        const fiberCount = PARTICLES.fiberMin + Math.floor(Math.random() * PARTICLES.fiberRandomCount);
        for (let i = 0; i < fiberCount; i++) {
            const x = Math.random() * PAPER_SIZE;
            const y = Math.random() * PAPER_SIZE;
            const len = PARTICLES.fiberLengthMin + Math.random() * PARTICLES.fiberLengthRange;
            const ang = angleBias + (Math.random() - 0.5) * angleSpread * Math.PI;
            const useLight = Math.random() < PARTICLES.lightFiberChance;
            g.strokeStyle = useLight ? cfg.lightTone : toneB;
            g.globalAlpha = PARTICLES.fiberAlphaMin + Math.random() * PARTICLES.fiberAlphaRange;
            g.lineWidth = PARTICLES.fiberWidthMin + Math.random() * PARTICLES.fiberWidthRange;
            g.beginPath();
            g.moveTo(x, y);
            g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
            g.stroke();
        }
        g.globalAlpha = 1;

        const clusterX = Math.random() * PAPER_SIZE;
        const clusterY = Math.random() * PAPER_SIZE;
        const hasCluster = Math.random() < PARTICLES.speckClusterChance;
        const clusterR = PARTICLES.speckClusterRadiusMin + Math.random() * PARTICLES.speckClusterRadiusRange;
        const speckCount = PARTICLES.speckMin + Math.floor(Math.random() * PARTICLES.speckRandomCount);
        for (let i = 0; i < speckCount; i++) {
            let x, y;
            if (hasCluster && Math.random() < PARTICLES.speckClusterPointChance) {
                const a = Math.random() * Math.PI * 2;
                const r = Math.random() * clusterR;
                x = clusterX + Math.cos(a) * r;
                y = clusterY + Math.sin(a) * r;
            } else {
                x = Math.random() * PAPER_SIZE;
                y = Math.random() * PAPER_SIZE;
            }
            const roll = Math.random();
            let col;
            if (roll < PARTICLES.rollBiasLight) col = cfg.lightTone;
            else if (roll < PARTICLES.rollBiasTone) col = toneC;
            else                  col = cfg.highlight;
            g.fillStyle = col;
            g.globalAlpha = PARTICLES.speckAlphaMin + Math.random() * PARTICLES.speckAlphaRange;
            const r = PARTICLES.speckRadiusMin + Math.random() * PARTICLES.speckRadiusRange;
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
        }
        g.globalAlpha = 1;

        const grainAngle = Math.random() < PARTICLES.grainAngleChance ? 0 : Math.PI / 2;
        const grainCount = PARTICLES.grainMin + Math.floor(Math.random() * PARTICLES.grainRandomCount);
        for (let i = 0; i < grainCount; i++) {
            const len = PAPER_SIZE * (PARTICLES.grainLengthMin + Math.random() * PARTICLES.grainLengthRange);
            const startX = Math.random() * PAPER_SIZE * PARTICLES.grainStartAreaScale;
            const startY = Math.random() * PAPER_SIZE * PARTICLES.grainStartAreaScale;
            g.strokeStyle = Math.random() < PARTICLES.grainLightChance ? cfg.lightTone : toneB;
            g.globalAlpha = PARTICLES.grainAlphaMin + Math.random() * PARTICLES.grainAlphaRange;
            g.lineWidth = PARTICLES.grainWidthMin + Math.random() * PARTICLES.grainWidthRange;
            g.beginPath();
            if (grainAngle === 0) {
                g.moveTo(startX, startY);
                g.lineTo(startX + len, startY + (Math.random() - 0.5) * PARTICLES.grainJitter);
            } else {
                g.moveTo(startX, startY);
                g.lineTo(startX + (Math.random() - 0.5) * PARTICLES.grainJitter, startY + len);
            }
            g.stroke();
        }
        g.globalAlpha = 1;
        g.restore();

        const edgeStyle = Math.random();
        if (edgeStyle < PARTICLES.edgeHighlightChance) {
            tracePath();
            g.strokeStyle = cfg.highlight;
            g.lineWidth = PARTICLES.edgeWidthMin + Math.random() * PARTICLES.edgeWidthRange;
            g.globalAlpha = PARTICLES.edgeAlphaMin + Math.random() * PARTICLES.edgeAlphaRange;
            g.stroke();
        } else {
            tracePath();
            g.strokeStyle = cfg.lightTone;
            g.lineWidth = PARTICLES.edgeFallbackWidth;
            g.globalAlpha = PARTICLES.edgeAlphaMin + Math.random() * PARTICLES.edgeAlphaRange;
            g.stroke();
        }
        g.globalAlpha = 1;

        return c;
    }

    function preparePaperTextures() {
        const jobs = [];
        for (const id of Object.keys(loaded)) {
            paperTexturePools[id] = [];
            paperTextureCursors[id] = 0;
            for (let i = 0; i < PAPER_TEXTURE_POOL_SIZE; i++) {
                jobs.push(id);
            }
        }

        let nextJob = 0;
        function prepareBatch() {
            const batchEnd = Math.min(nextJob + PARTICLES.prepareBatchSize, jobs.length);
            while (nextJob < batchEnd) {
                const id = jobs[nextJob++];
                paperTexturePools[id].push(makePaperTexture(CHARACTERS[id]));
            }

            if (nextJob < jobs.length) {
                requestAnimationFrame(prepareBatch);
                return;
            }

            for (const id of Object.keys(paperTexturePools)) {
                shuffle(paperTexturePools[id]);
            }
            paperTexturesReady = true;
            debugLog('[pet] paper textures ready');
            if (pendingSwapTarget) {
                const targetId = pendingSwapTarget;
                pendingSwapTarget = null;
                startSwap(targetId);
            }
        }

        requestAnimationFrame(prepareBatch);
    }

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }

    const characters = {};
    const ids = Object.keys(loaded);
    let currentChar = ids[0];
    const hasStartupAnimation = Boolean(
        startLoaded[currentChar] &&
        startLoaded[currentChar].animations.some(animation => animation.name === START_CONFIG.name)
    );
    let swap = null;
    let swarm = [];

    for (const id of ids) {
        const s = new PIXI.spine.Spine(loaded[id]);
        s.scale.set(PET_SCALE);
        s.x = app.screen.width / 2;
        s.y = app.screen.height - RENDERER.initialYOffset;
        const isActiveWithoutIntro = id === currentChar && !hasStartupAnimation;
        s.alpha = isActiveWithoutIntro ? 1 : 0;
        s.visible = isActiveWithoutIntro;
        app.stage.addChild(s);

        const hideKeywords = CONFIG.characters[id].hideSlotKeywords.map(keyword => keyword.toLowerCase());
        s.skeleton.slots.forEach(slot => {
            const nameLower = slot.data.name.toLowerCase();
            if (hideKeywords.some(keyword => nameLower.includes(keyword))) {
                slot.visible = false;
            }
        });

        const capeKeywords = (CONFIG.characters[id].capeSlotKeywords || [])
            .map(keyword => keyword.toLowerCase());
        if (capeKeywords.length) {
            s.skeleton.slots.forEach(slot => {
                const nameLower = slot.data.name.toLowerCase();
                if (capeKeywords.some(keyword => nameLower.includes(keyword))) {
                    const container = s.slotContainers[slot.data.index];
                    if (container) container.mask = capeMask;
                }
            });
        }

        s.stateData.defaultMix = RENDERER.animationMix.default;
        const anims = s.spineData.animations.map(a => a.name);
        const mix = (a, b, d) => {
            if (anims.indexOf(a) !== -1 && anims.indexOf(b) !== -1) {
                s.stateData.setMix(a, b, d);
            }
        };
        for (const [from, to, duration] of RENDERER.animationMix.pairs) {
            mix(from, to, duration);
        }

        characters[id] = {
            cfg: CHARACTERS[id],
            spine: s,
            x: s.x,
            y: s.y,
            alpha: s.alpha
        };
    }

    let spine = characters[currentChar].spine;

    let MIN_X = RENDERER.horizontalMargin;
    let MAX_X = app.screen.width - RENDERER.horizontalMargin;
    let PET_Y = app.screen.height - RENDERER.initialYOffset;

    function updateBounds() {
        MIN_X = RENDERER.horizontalMargin;
        MAX_X = app.screen.width - RENDERER.horizontalMargin;
        PET_Y = app.screen.height - RENDERER.initialYOffset;
        for (const id in characters) {
            const s = characters[id].spine;
            if (s.x < MIN_X) s.x = MIN_X;
            if (s.x > MAX_X) s.x = MAX_X;
            s.y = PET_Y;
        }
        if (targetX !== null) {
            if (targetX < MIN_X) targetX = MIN_X;
            if (targetX > MAX_X) targetX = MAX_X;
        }
    }

    const BLOCKED_ANIMS = new Set(RENDERER.blockedAnimations);
    const STATE_MAP = RENDERER.stateMap;

    function spineAnimNames(s) { return s.spineData.animations.map(a => a.name); }
    function spineHas(s, animName) { return spineAnimNames(s).indexOf(animName) !== -1; }

    function animForSpine(s, state) {
        const c = STATE_MAP[state] || [];
        const anims = spineAnimNames(s);
        for (let i = 0; i < c.length; i++) {
            if (anims.indexOf(c[i]) !== -1 && !BLOCKED_ANIMS.has(c[i])) return c[i];
        }
        return null;
    }

    function animFor(state) {
        return animForSpine(spine, state);
    }

    let startupIntro = null;
    function createStartupIntro() {
        const startData = startLoaded[currentChar];
        const startAnimation = startData &&
            startData.animations.find(animation => animation.name === START_CONFIG.name);
        if (!startAnimation) return false;

        const introSpine = new PIXI.spine.Spine(startLoaded[currentChar]);
        introSpine.scale.set(PET_SCALE);
        introSpine.x = spine.x;
        introSpine.y = PET_Y;
        introSpine.alpha = 0;
        spine.visible = true;
        spine.alpha = 0;
        introSpine.stateData.defaultMix = 0;
        introSpine.autoUpdate = false;

        const weaponSlots = introSpine.skeleton.slots
            .filter(slot => {
                const attachment = typeof slot.getAttachment === 'function'
                    ? slot.getAttachment()
                    : null;
                const names = [
                    slot.data.name,
                    slot.data.attachmentName,
                    attachment && attachment.name
                ].filter(Boolean).join(' ').toLowerCase();
                return names.includes(START_CONFIG.weaponNameKeyword.toLowerCase());
            })
            .map(slot => {
                const alpha = slot.color.a;
                const slotContainer = introSpine.slotContainers[slot.data.index];
                return { slot, slotContainer, alpha };
            });

        const startCapeKeywords = (CONFIG.characters[currentChar].capeSlotKeywords || [])
            .map(keyword => keyword.toLowerCase());
        if (startCapeKeywords.length) {
            introSpine.skeleton.slots.forEach(slot => {
                const nameLower = slot.data.name.toLowerCase();
                if (startCapeKeywords.some(keyword => nameLower.includes(keyword))) {
                    const container = introSpine.slotContainers[slot.data.index];
                    if (container) container.mask = capeMask;
                }
            });
        }

        const startTrack = introSpine.state.setAnimation(0, START_CONFIG.name, false);
        startTrack.timeScale = START_ANIMATION_TIME_SCALE;
        app.stage.addChild(introSpine);
        startupIntro = {
            spine: introSpine,
            elapsed: 0,
            duration: startAnimation.duration / START_ANIMATION_TIME_SCALE,
            fadeDuration: Math.min(START_WEAPON_FADE_DURATION, startAnimation.duration / START_ANIMATION_TIME_SCALE),
            weaponSlots,
            handoffElapsed: null,
            normalDefaultMix: spine.stateData.defaultMix
        };
        debugLog('[pet] playing Start animation for', currentChar, 'duration', startAnimation.duration, 's');

        if (weaponSlots.length === 0) {
            console.warn('[pet] startup model has no weapon slots to fade');
        } else {
            debugLog('[pet] fading out startup weapon slots:', weaponSlots.map(item => item.slot.data.name));
        }
        return true;
    }
    if (hasStartupAnimation) createStartupIntro();

    let logicalState = 'Idle';
    let lockedState = null;
    let stateTimer = randomWanderTime();
    let targetX = null;
    let isBeingDragged = false;

    function randomWanderTime() {
        return RENDERER.randomWanderMinMs +
            Math.random() * (RENDERER.randomWanderMaxMs - RENDERER.randomWanderMinMs);
    }

    function clearLock() {
        lockedState = null;
    }

    function transitionTo(newState, force) {
        if (logicalState === newState && !force) return;
        const animName = animFor(newState);
        if (!animName) return;
        if (newState === 'Interact') {
            spine.state.setAnimation(0, animName, false);
            const ret = animFor(lockedState || 'Idle');
            if (ret) spine.state.addAnimation(0, ret, true, 0);
        } else {
            spine.state.setAnimation(0, animName, true);
        }
        logicalState = newState;
    }

    function setClickThrough(enabled) {
        if (window.electronAPI && window.electronAPI.setIgnoreMouseEvents) {
            window.electronAPI.setIgnoreMouseEvents(enabled);
        }
    }
    setClickThrough(true);

    let isDown = false;
    let isDragging = false;
    let downX = 0;
    let hoveringPet = false;

    function getMouseX(e) {
        const rect = app.view.getBoundingClientRect();
        return e.clientX - rect.left;
    }
    function getMouseY(e) {
        const rect = app.view.getBoundingClientRect();
        return e.clientY - rect.top;
    }

    function isOverSpine(px, py) {
        if (!spine) return false;
        const dx = px - spine.x;
        const dy = py - spine.y;
        const hitboxTop = RENDERER.hitboxTopOffset != null
            ? RENDERER.hitboxTopOffset : RENDERER.hitboxHalfHeight;
        const hitboxBottom = RENDERER.hitboxBottomOffset != null
            ? RENDERER.hitboxBottomOffset : RENDERER.hitboxHalfHeight;
        return Math.abs(dx) < RENDERER.hitboxHalfWidth &&
               dy < hitboxBottom &&
               dy > -hitboxTop;
    }

    function spawnRecycledSwarm(x, y, fromId, toId) {
        const result = [];
        const texturesFrom = paperTexturePools[fromId];
        const texturesTo = paperTexturePools[toId];
        const cursorFrom = paperTextureCursors[fromId];
        const cursorTo = paperTextureCursors[toId];

        for (let i = 0; i < DEBRIS_COUNT; i++) {
            const offsetX = (Math.random() - 0.5) * PARTICLES.horizontalSpread;
            const offsetY = (Math.random() - 0.5) * PARTICLES.verticalSpread;
            const flipCenter = FLIP_CENTER_START + Math.random() * FLIP_CENTER_SPREAD;
            result.push({
                baseX: x + offsetX,
                baseY: y + offsetY,
                riseHeight: RISE_MIN + Math.random() * (RISE_MAX - RISE_MIN),
                swayAmount: PARTICLES.swayMin + Math.random() * (PARTICLES.swayMax - PARTICLES.swayMin),
                swayFreq:   PARTICLES.swayFrequencyMin + Math.random() * (PARTICLES.swayFrequencyMax - PARTICLES.swayFrequencyMin),
                swayPhase:  Math.random() * Math.PI * 2,
                size:       SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN),
                rot:        Math.random() * Math.PI * 2,
                rotSpeed:   (Math.random() - 0.5) * PARTICLES.rotationSpeedRange,
                flipCenter,
                flipSpinDir:    Math.random() < PARTICLES.flipSpinDirectionChance ? -1 : 1,
                flipSpinAmount: PARTICLES.flipSpinMin + Math.random() * (PARTICLES.flipSpinMax - PARTICLES.flipSpinMin),
                fadeInOffset:  (Math.random() - 0.5) * PARTICLES.fadeInOffsetRange,
                fadeOutOffset: (Math.random() - 0.5) * PARTICLES.fadeOutOffsetRange,
                textureFrom: texturesFrom[(cursorFrom + i) % texturesFrom.length],
                textureTo:   texturesTo[(cursorTo + i) % texturesTo.length]
            });
        }

        paperTextureCursors[fromId] = (cursorFrom + DEBRIS_COUNT) % texturesFrom.length;
        paperTextureCursors[toId] = (cursorTo + DEBRIS_COUNT) % texturesTo.length;
        return result;
    }

    function updateSwarm(t) {
        const OUT_END = PHASE_OUT;
        const GAP_END = PHASE_OUT + PHASE_GAP;

        let h;
        if (t < OUT_END) {
            h = easeOutQuad(t / OUT_END);
        } else if (t < GAP_END) {
            h = 1;
        } else {
            h = 1 - easeInOutCubic((t - GAP_END) / PHASE_IN);
        }

        const ratio = PAPER_SIZE / PAPER_R;
        const halfFlip = FLIP_DURATION / 2;

        for (const p of swarm) {
            let pAlpha = 1;
            if (t < OUT_END) {
                const lt = t / OUT_END;
                const start = PARTICLES.debrisFadeInStart + p.fadeInOffset;
                const dur = PARTICLES.debrisFadeInDuration;
                if (lt < start + dur) pAlpha = smootherstep((lt - start) / dur);
            } else if (t >= GAP_END) {
                const lt = (t - GAP_END) / PHASE_IN;
                const start = PARTICLES.debrisFadeOutStart + p.fadeOutOffset;
                if (lt > start) {
                    const ft = (lt - start) / Math.max(0.01, 1 - start);
                    pAlpha = 1 - smootherstep(ft);
                }
            }
            pAlpha = Math.max(0, Math.min(1, pAlpha));
            if (pAlpha <= 0.001) continue;

            const sway = Math.sin(t * p.swayFreq * Math.PI * 2 + p.swayPhase) * p.swayAmount;
            const bx = p.baseX + sway * h;
            const by = p.baseY - p.riseHeight * h;
            const rot = p.rot + t * p.rotSpeed;

            const dtFlip = t - p.flipCenter;
            let flipProgress = 0;
            let scaleX = 1;
            let fromAlpha = 1;
            let toAlpha = 0;
            let bloom = 0;

            if (dtFlip >= -halfFlip && dtFlip <= halfFlip) {
                const k = (dtFlip + halfFlip) / FLIP_DURATION;
                scaleX = Math.abs(Math.cos(Math.PI * k));
                fromAlpha = 1 - smootherstep(Math.min(1, k * 1.3));
                toAlpha   = smootherstep(Math.max(0, (k - 0.25) / 0.75));
                bloom = Math.sin(k * Math.PI);
                flipProgress = easeInOutCubic(k);
            } else if (dtFlip > halfFlip) {
                flipProgress = 1;
                fromAlpha = 0;
                toAlpha = 1;
                scaleX = 1;
            }

            const safeScaleX = Math.max(0.02, scaleX);
            const drawSize = p.size * ratio;
            const tilt = p.flipSpinDir * p.flipSpinAmount * Math.sin(Math.PI * flipProgress);

            if (fromAlpha > 0.001) {
                ctx.save();
                ctx.globalAlpha = pAlpha * fromAlpha;
                ctx.translate(bx, by);
                ctx.rotate(rot + tilt);
                ctx.scale(safeScaleX, 1);
                ctx.drawImage(p.textureFrom, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
                ctx.restore();
            }

            if (toAlpha > 0.001) {
                ctx.save();
                ctx.globalAlpha = pAlpha * toAlpha;
                ctx.translate(bx, by);
                ctx.rotate(rot + tilt);
                ctx.scale(safeScaleX, 1);
                ctx.drawImage(p.textureTo, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
                ctx.restore();
            }

            if (bloom > 0.01) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = pAlpha * bloom * BLOOM_INTENSITY;
                const rad = drawSize * 0.75;
                const grad = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
                for (const [stop, color] of PARTICLES.bloomStops) {
                    grad.addColorStop(stop, color);
                }
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(bx, by, rad, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
    }

    function startSwap(targetId) {
        if (swap) return;
        if (!characters[targetId]) return;
        if (currentChar === targetId) return;
        if (!paperTexturesReady) {
            pendingSwapTarget = targetId;
            debugLog('[pet] swap queued until paper textures are ready');
            return;
        }

        clearLock();
        isDown = false;
        isDragging = false;
        isBeingDragged = false;
        targetX = null;

        const fromSpine = characters[currentChar].spine;
        const toSpine = characters[targetId].spine;

        const fromX = fromSpine.x;
        const fromY = fromSpine.y;

        toSpine.x = fromX;
        toSpine.y = fromY;
        toSpine.scale.x = fromSpine.scale.x;
        toSpine.scale.y = fromSpine.scale.y;

        const idleName = animForSpine(toSpine, 'Idle');
        if (idleName) toSpine.state.setAnimation(0, idleName, true);
        toSpine.visible = true;
        toSpine.alpha = 0;

        swarm = spawnRecycledSwarm(fromX, fromY, currentChar, targetId);

        swap = { from: currentChar, to: targetId, t: 0 };

        hoveringPet = false;
        setClickThrough(true);

        debugLog('[pet] swap start', currentChar, '->', targetId);
    }

    // ---------------------------------------------------------------
    // resetPet() — full fresh-state reset
    // ---------------------------------------------------------------
    function resetPet() {
        // ---- 1. tear down transient display objects ----
        if (startupIntro) {
            spine.stateData.defaultMix = startupIntro.normalDefaultMix;
            app.stage.removeChild(startupIntro.spine);
            startupIntro.spine.destroy({ children: true });
            startupIntro = null;
        }

        // ---- 2. clear swap + particle swarm + 2D canvas ----
        swap = null;
        swarm = [];
        pendingSwapTarget = null;
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

        // ---- 3. reset all input / drag state unconditionally ----
        isDown = false;
        isDragging = false;
        isBeingDragged = false;
        hoveringPet = false;
        downX = 0;
        targetX = null;

        // ---- 4. reset the state machine ----
        clearLock();
        if (!RESET_CONFIG.preserveCurrentCharacter) currentChar = ids[0];
        spine = characters[currentChar].spine;

        for (const id in characters) {
            const active = id === currentChar;
            const characterSpine = characters[id].spine;
            characterSpine.visible = active;
            characterSpine.alpha = active ? 1 : 0;
            characterSpine.x = spine.x;
            characterSpine.y = PET_Y;
            characterSpine.scale.x = Math.abs(characterSpine.scale.x);
            characterSpine.scale.y = PET_SCALE;
        }

        logicalState = 'Idle';
        transitionTo('Idle', true);
        stateTimer = randomWanderTime();

        // ---- 5. reset cursors on every layer ----
        document.body.style.cursor = 'default';
        if (app.view && app.view.style) app.view.style.cursor = 'default';

        // ---- 6. reset interaction reporting cache so main.js gets fresh data ----
        lastReportedX = null;
        lastReportedY = null;
        lastReportedPointerActive = null;

        // ---- 7. force click-through on both renderer and OS side ----
        setClickThrough(true);
        if (window.electronAPI && window.electronAPI.updatePetInteractionState) {
            window.electronAPI.updatePetInteractionState(spine.x, spine.y, false);
        }
        reportPetInteractionState(true);

        // ---- 8. replay startup animation if configured ----
        if (RESET_CONFIG.replayStartAnimation) {
            const replayed = createStartupIntro();
            if (!replayed) {
                console.warn('[pet] no Start animation available for', currentChar);
            }
        }
    }

    function handleCommand(command) {
        if (command === 'reset') {
            resetPet();
            return;
        }

        if (swap || startupIntro) return;

        if (command === 'swap') {
            const swapIds = Object.keys(CONFIG.characters).filter(id => characters[id]);
            const currentIndex = swapIds.indexOf(currentChar);
            const target = swapIds.length > 1 ? swapIds[(currentIndex + 1) % swapIds.length] : null;
            if (characters[target]) startSwap(target);
            return;
        }

        if (command === 'Special') {
            if (!spineHas(spine, 'Special')) return;
            if (lockedState === 'Special') {
                clearLock();
                transitionTo('Idle', true);
                stateTimer = randomWanderTime();
            } else {
                lockedState = 'Special';
                transitionTo('Special', true);
            }
            return;
        }

        if (command !== 'Sleep' && command !== 'Idle' && command !== 'Sit') return;
        if (lockedState === command) {
            clearLock();
            transitionTo('Idle', true);
            stateTimer = randomWanderTime();
        } else {
            lockedState = command;
            transitionTo(command, true);
        }
    }

    function recoverRenderer() {
        isDown = false;
        isDragging = false;
        targetX = null;
        isBeingDragged = false;
        swap = null;
        swarm = [];
        if (!startupIntro) {
            for (const id in characters) {
                const active = id === currentChar;
                characters[id].spine.visible = active;
                characters[id].spine.alpha = active ? 1 : 0;
            }
        }
        clearLock();
        if (!startupIntro) transitionTo('Idle', true);
        stateTimer = randomWanderTime();
        hoveringPet = false;
        document.body.style.cursor = 'default';
        if (app.view && app.view.style) app.view.style.cursor = 'default';
        app.renderer.resize(window.innerWidth, window.innerHeight);
        updateBounds();
        refreshCapeMask();
        app.ticker.start();
        reportPetInteractionState();
        setClickThrough(true);
        if (!startupIntro && !paperTexturesReady) preparePaperTextures();
    }

    let lastReportedX = null;
    let lastReportedY = null;
    let lastReportedPointerActive = null;
    function reportPetInteractionState(force = false) {
        if (window.electronAPI && window.electronAPI.updatePetInteractionState) {
            if (
                !force &&
                lastReportedX !== null &&
                Math.abs(spine.x - lastReportedX) < RENDERER.interactionPositionEpsilon &&
                Math.abs(spine.y - lastReportedY) < RENDERER.interactionPositionEpsilon &&
                isDown === lastReportedPointerActive
            ) {
                return;
            }
            lastReportedX = spine.x;
            lastReportedY = spine.y;
            lastReportedPointerActive = isDown;
            window.electronAPI.updatePetInteractionState(spine.x, spine.y, isDown);
        }
    }

    app.view.addEventListener('mousemove', (e) => {
        if (swap || startupIntro) return;
        const px = getMouseX(e);
        const py = getMouseY(e);
        const over = isOverSpine(px, py);
        if (over !== hoveringPet) {
            hoveringPet = over;
            setClickThrough(!over && !isDown);
            document.body.style.cursor = over ? 'pointer' : 'default';
            if (app.view && app.view.style) {
                app.view.style.cursor = over ? 'pointer' : 'default';
            }
        }

        if (!isDown) return;
        const dx = px - downX;
        if (!isDragging && Math.abs(dx) > RENDERER.dragThreshold) {
            isDragging = true;
            isBeingDragged = true;
            document.body.style.cursor = 'grabbing';
            if (app.view && app.view.style) app.view.style.cursor = 'grabbing';
        }
        if (isDragging) {
            clearLock();
            targetX = Math.max(MIN_X, Math.min(MAX_X, px));
            if (logicalState !== 'Walk') transitionTo('Walk');
        }
    });

    app.view.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (swap || startupIntro) return;
        const px = getMouseX(e);
        const py = getMouseY(e);
        if (!isOverSpine(px, py)) return;
        isDown = true;
        isDragging = false;
        downX = px;
        reportPetInteractionState(true);
        setClickThrough(false);
        e.preventDefault();
    });

    window.addEventListener('mouseup', () => {
        if (!isDown) return;
        isDown = false;
        reportPetInteractionState();
        document.body.style.cursor = 'default';
        if (app.view && app.view.style) app.view.style.cursor = 'default';
        if (swap) return;
        if (isDragging) {
            targetX = null;
            isBeingDragged = false;
            if (logicalState === 'Walk') {
                transitionTo('Idle', true);
                stateTimer = RENDERER.shortIdleMinMs +
                    Math.random() * (RENDERER.shortIdleMaxMs - RENDERER.shortIdleMinMs);
            }
        } else {
            if (!lockedState) {
                transitionTo('Interact', true);
                stateTimer = RENDERER.interactDurationMs;
            }
        }
        isDragging = false;
        targetX = null;
    });

    app.view.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') handleCommand('reset');
    });

    if (window.electronAPI && window.electronAPI.onResume) {
        window.electronAPI.onResume(recoverRenderer);
    }
    if (window.electronAPI && window.electronAPI.onCommand) {
        window.electronAPI.onCommand(handleCommand);
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) recoverRenderer();
    });

    app.ticker.add(() => {
        try {
            const dt = Math.min(RENDERER.maxDeltaSeconds, app.ticker.deltaMS / 1000);

            ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            reportPetInteractionState();

            if (!swap) {
                for (const id in characters) {
                    characters[id].spine.y = PET_Y;
                }
            }

            if (startupIntro) {
                startupIntro.spine.update(dt);
                startupIntro.elapsed += dt;
                startupIntro.spine.x = spine.x;
                startupIntro.spine.y = PET_Y;
                startupIntro.spine.alpha = smootherstep(
                    startupIntro.elapsed / START_INTRO_FADE_DURATION
                );

                const fadeStart = startupIntro.duration - startupIntro.fadeDuration;
                const weaponProgress = startupIntro.elapsed <= fadeStart
                    ? 0
                    : smootherstep((startupIntro.elapsed - fadeStart) / startupIntro.fadeDuration);
                for (const item of startupIntro.weaponSlots) {
                    const alpha = item.alpha * (1 - weaponProgress);
                    item.slot.color.a = alpha;
                    item.slotContainer.alpha = alpha;
                }

                if (startupIntro.elapsed >= startupIntro.duration && startupIntro.handoffElapsed === null) {
                    startupIntro.handoffElapsed = 0;
                    spine.visible = true;
                    spine.alpha = 0;
                    spine.stateData.defaultMix = START_IDLE_CROSSFADE_DURATION;
                    logicalState = 'Idle';
                    transitionTo('Idle', true);
                }

                if (startupIntro.handoffElapsed !== null) {
                    startupIntro.handoffElapsed += dt;
                    const handoffProgress = smootherstep(
                        startupIntro.handoffElapsed / START_IDLE_CROSSFADE_DURATION
                    );
                    startupIntro.spine.alpha = 1 - handoffProgress;
                    spine.alpha = handoffProgress;
                }

                if (
                    startupIntro.handoffElapsed !== null &&
                    startupIntro.handoffElapsed >= START_IDLE_CROSSFADE_DURATION
                ) {
                    spine.stateData.defaultMix = startupIntro.normalDefaultMix;
                    app.stage.removeChild(startupIntro.spine);
                    startupIntro.spine.destroy({ children: true });
                    startupIntro = null;

                    spine.visible = true;
                    spine.alpha = 1;
                    stateTimer = randomWanderTime();
                    if (!paperTexturesReady) preparePaperTextures();
                    debugLog('[pet] startup animation crossfade complete');
                }
                return;
            }

            if (swap) {
                swap.t += dt;
                const t = swap.t;
                const inStart = PHASE_OUT + PHASE_GAP;

                const fromSpine = characters[swap.from].spine;
                const toSpine = characters[swap.to].spine;

                fromSpine.y = PET_Y;
                toSpine.y = PET_Y;
                toSpine.x = fromSpine.x;

                if (t < PHASE_OUT) {
                    fromSpine.alpha = 1 - easeOutCubic(t / PHASE_OUT);
                } else {
                    fromSpine.alpha = 0;
                }

                if (t >= inStart) {
                    const raw = (t - inStart) - CHAR_IN_DELAY;
                    if (raw <= 0) toSpine.alpha = 0;
                    else {
                        const lt = Math.min(1, raw / (PHASE_IN - CHAR_IN_DELAY));
                        toSpine.alpha = easeOutCubic(lt);
                    }
                } else {
                    toSpine.alpha = 0;
                }

                updateSwarm(t);

                if (t >= TOTAL) {
                    fromSpine.alpha = 0;
                    fromSpine.visible = false;
                    toSpine.alpha = 1;
                    toSpine.visible = true;
                    toSpine.x = fromSpine.x;
                    toSpine.y = PET_Y;

                    currentChar = swap.to;
                    spine = toSpine;
                    swap = null;
                    swarm = [];
                    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

                    clearLock();
                    logicalState = 'Idle';
                    const idleName = animForSpine(spine, 'Idle');
                    if (idleName) spine.state.setAnimation(0, idleName, true);
                    stateTimer = randomWanderTime();

                    hoveringPet = false;
                    setClickThrough(true);

                    debugLog('[pet] swap done, active =', currentChar);
                }
                return;
            }

            if (lockedState) {
                if (logicalState !== lockedState) transitionTo(lockedState);
                return;
            }

            if (logicalState === 'Walk' && targetX !== null) {
                const dx = targetX - spine.x;
                const dist = Math.abs(dx);

                if (dist < RENDERER.walkArrivalDistance) {
                    targetX = null;
                    isBeingDragged = false;
                    transitionTo('Idle', true);
                    stateTimer = RENDERER.shortIdleMinMs +
                        Math.random() * (RENDERER.shortIdleMaxMs - RENDERER.shortIdleMinMs);
                } else {
                    const speed = isBeingDragged ? WALK_SPEED_DRAG : WALK_SPEED_IDLE;
                    const step = speed * dt;
                    spine.x += Math.sign(dx) * Math.min(step, dist);
                    spine.x = Math.max(MIN_X, Math.min(MAX_X, spine.x));

                    const absScale = Math.abs(spine.scale.x);
                    if (dx < 0) spine.scale.x = -absScale;
                    else spine.scale.x = absScale;
                }
                return;
            }

            if (logicalState === 'Interact') {
                stateTimer -= dt * 1000;
                if (stateTimer <= 0) {
                    transitionTo('Idle', true);
                    stateTimer = randomWanderTime();
                }
                return;
            }

            stateTimer -= dt * 1000;
            if (stateTimer <= 0) {
                const pool = RENDERER.wanderPool.slice();

                if (spineHas(spine, 'Special')) {
                    for (let i = 0; i < RENDERER.specialWanderWeight; i++) {
                        pool.push('Special');
                    }
                }

                const p = pool[Math.floor(Math.random() * pool.length)];
                if (p === 'Walk') {
                    targetX = MIN_X + Math.random() * (MAX_X - MIN_X);
                    isBeingDragged = false;
                    transitionTo('Walk');
                    stateTimer = RENDERER.walkTimeoutMs;
                } else {
                    transitionTo(p);
                    stateTimer = randomWanderTime();
                }
            }
        } catch (err) {
            console.error('[pet ticker error]', err);
        }
    });

    let resizePending = false;
    window.addEventListener('resize', () => {
        const resize = () => {
            app.renderer.resize(window.innerWidth, window.innerHeight);
            updateBounds();
            refreshCapeMask();
            resizePending = false;
        };
        if (!RENDERER.windowResizeDebounceFrames) {
            resize();
            return;
        }
        if (resizePending) return;
        resizePending = true;
        requestAnimationFrame(resize);
    });

    if (!startupIntro) transitionTo('Idle', true);
    stateTimer = randomWanderTime();
    if (!startupIntro) preparePaperTextures();
    debugLog('[pet] ready');
})();
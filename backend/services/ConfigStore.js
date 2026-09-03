/**
 * ConfigStore - Persistent JSON configuration storage.
 *
 * Stores:
 *   - User preferences
 *   - Machine profiles
 *   - Macros
 *   - Event triggers
 *   - Work coordinate offsets
 *   - Tool library
 *
 * Data is saved to a JSON file on disk and loaded on startup.
 * Writes are debounced to avoid excessive disk I/O.
 *
 * Reference: gSender configstore concept
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SAVE_DEBOUNCE_MS = 1000;

/** Default machine profiles shown when none are saved. */
const DEFAULT_MACHINE_PROFILES = [
    {
        id: 'onefinity-journeyman',
        name: 'Onefinity Journeyman',
        voltage: '24 V',
        workArea: '406×305×102 mm (16×12×4 in)',
        maxFeed: '3000 mm/min',
        spindle: 'Router / 1.5 kW',
        controller: 'GRBL / grblHAL',
        notes: 'NEMA 23, ball screws',
    },
    {
        id: 'onefinity-elite',
        name: 'Onefinity Elite',
        voltage: '48 V',
        workArea: '609×406×102 mm (24×16×4 in)',
        maxFeed: '4000 mm/min',
        spindle: 'Router / 2.2 kW',
        controller: 'GRBL / grblHAL',
        notes: 'NEMA 23, ball screws',
    },
    {
        id: 'generic-3018',
        name: 'Generic 3018',
        voltage: '12–24 V',
        workArea: '300×180×45 mm',
        maxFeed: '1000 mm/min',
        spindle: 'Spindle / 200 W or Laser',
        controller: 'GRBL',
        notes: 'Common 3018 CNC',
    },
    {
        id: 'custom',
        name: 'Custom',
        voltage: '',
        workArea: '',
        maxFeed: '',
        spindle: '',
        controller: '',
        notes: 'User-defined machine',
    },
];

const DEFAULT_CONFIG = {
    macros: [],
    eventTriggers: {},
    toolLibrary: [],
    preferences: {
        units: 'mm',
        jogSpeed: 1000,
        jogDistance: 1,
        safeHeight: 10,
        probeThickness: 0,
        probeFeedrate: 100,
        spindleDelay: 0,
        reconnectAutomatically: false,
        firmwareFallback: 'grblHAL',
        baudRate: 115200,
        runCheckOnFileLoad: false,
        outlineStyle: 'Detailed',
    },
    ethernet: {
        connectToIP: '192.168.5.1',
    },
    probeSettings: {
        touchPlateType: 'Standard Block',
        blockThickness: 15,
        // Corner block X/Y retract/offset: 20mm
        xyThickness: 20,
        zProbeDistance: 30,
        fastFind: 150,
        slowFind: 75,
        retraction: 2,
        traverseFeed: 2500,
        finalizeZFeed: 1500,
        finalizeXYFeed: 2500,
        // xyz-corner probe geometry (ProbingService.js _runRSP) -- split out
        // from blockThickness/xyThickness formulas per msg11454's exact
        // spec, so future tuning is a config change, not a code ship.
        zRetract: 11.5,
        xyReposition: 67,
        zDrop: 19,
        zRetractX: 3.0,
        xyRepositionX: 70.0,
        zDropX: 20.0,
        zRetractY: 20.0,
        xyRepositionY: 64.0,
        zDropY: 18.0,
        parkZClearance: 10,
        connectionTest: true,
    },
    machineProfiles: [],
    activeMachineProfile: null,
    wcsOffsets: {},
};

class ConfigStore extends EventEmitter {
    /**
     * @param {string} configPath - Path to the config JSON file
     */
    constructor(configPath) {
        super();

        this.configPath = configPath;
        this.data = {};
        this._saveTimer = null;

        this._load();
    }

    /**
     * Load config from disk, merging with defaults.
     * @private
     */
    _load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf-8');
                const parsed = JSON.parse(raw);
                this.data = this._deepMerge(DEFAULT_CONFIG, parsed);
            } else {
                this.data = { ...DEFAULT_CONFIG };
                this._saveImmediate();
            }
            // Seed default machine profiles if none saved
            const profiles = this.data.machineProfiles || [];
            if (!Array.isArray(profiles) || profiles.length === 0) {
                this.data.machineProfiles = DEFAULT_MACHINE_PROFILES.map((p) => ({ ...p }));
                if (this.data.activeMachineProfile == null) {
                    this.data.activeMachineProfile = DEFAULT_MACHINE_PROFILES[0].id;
                }
                this._saveImmediate();
            }
        } catch (err) {
            this.data = { ...DEFAULT_CONFIG };
        }
    }

    /**
     * Get a value by dot-separated key path.
     * @param {string} key - e.g. 'preferences.units' or 'macros'
     * @param {*} [defaultValue]
     * @returns {*}
     */
    get(key, defaultValue) {
        const parts = key.split('.');
        let current = this.data;

        for (const part of parts) {
            if (current == null || typeof current !== 'object') {
                return defaultValue;
            }
            current = current[part];
        }

        return current !== undefined ? current : defaultValue;
    }

    /**
     * Set a value by dot-separated key path.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        const parts = key.split('.');
        let current = this.data;

        for (let i = 0; i < parts.length - 1; i++) {
            if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
                current[parts[i]] = {};
            }
            current = current[parts[i]];
        }

        current[parts[parts.length - 1]] = value;
        this._scheduleSave();
        this.emit('change', key, value);
    }

    /**
     * Delete a key.
     * @param {string} key
     */
    delete(key) {
        const parts = key.split('.');
        let current = this.data;

        for (let i = 0; i < parts.length - 1; i++) {
            if (current[parts[i]] == null) return;
            current = current[parts[i]];
        }

        delete current[parts[parts.length - 1]];
        this._scheduleSave();
        this.emit('change', key, undefined);
    }

    /**
     * Get the entire config object.
     * @returns {object}
     */
    getAll() {
        return { ...this.data };
    }

    // ─── Macro Helpers ───────────────────────────────────────────

    /**
     * Get all macros.
     * @returns {Array<{id: string, name: string, content: string}>}
     */
    getMacros() {
        return this.get('macros', []);
    }

    /**
     * Add or update a macro.
     * @param {{ id: string, name: string, content: string }} macro
     */
    saveMacro(macro) {
        const macros = this.getMacros();
        const idx = macros.findIndex((m) => m.id === macro.id);
        if (idx >= 0) {
            macros[idx] = { ...macros[idx], ...macro };
        } else {
            macros.push({
                id: macro.id || `macro-${Date.now()}`,
                name: macro.name || 'Untitled',
                content: macro.content || '',
                createdAt: Date.now(),
            });
        }
        this.set('macros', macros);
    }

    /**
     * Delete a macro by ID.
     * @param {string} id
     */
    deleteMacro(id) {
        const macros = this.getMacros().filter((m) => m.id !== id);
        this.set('macros', macros);
    }

    /**
     * Get a macro by ID.
     * @param {string} id
     * @returns {object|null}
     */
    getMacro(id) {
        return this.getMacros().find((m) => m.id === id) || null;
    }

    // ─── Tool Library Helpers ────────────────────────────────────

    /**
     * Get all tools.
     * @returns {Array<{id: string, name: string, number: number, diameter: number, length: number}>}
     */
    getTools() {
        return this.get('toolLibrary', []);
    }

    /**
     * Add or update a tool.
     * @param {object} tool
     */
    saveTool(tool) {
        const tools = this.getTools();
        const idx = tools.findIndex((t) => t.id === tool.id);
        if (idx >= 0) {
            tools[idx] = { ...tools[idx], ...tool };
        } else {
            tools.push({
                id: tool.id || `tool-${Date.now()}`,
                name: tool.name || 'Untitled',
                number: tool.number || 0,
                diameter: tool.diameter || 0,
                length: tool.length || 0,
            });
        }
        this.set('toolLibrary', tools);
    }

    /**
     * Delete a tool by ID.
     * @param {string} id
     */
    deleteTool(id) {
        const tools = this.getTools().filter((t) => t.id !== id);
        this.set('toolLibrary', tools);
    }

    // ─── Machine Profile Helpers ─────────────────────────────────

    /**
     * Get all machine profiles.
     * @returns {Array<{id: string, name: string, voltage?: string, workArea?: string, maxFeed?: string, spindle?: string, controller?: string, notes?: string}>}
     */
    getMachineProfiles() {
        const profiles = this.get('machineProfiles', []);
        return Array.isArray(profiles) ? [...profiles] : [];
    }

    /**
     * Get the active machine profile ID.
     * @returns {string|null}
     */
    getActiveMachineProfile() {
        return this.get('activeMachineProfile', null);
    }

    /**
     * Set the active machine profile by ID.
     * @param {string|null} id - Profile ID or null to clear
     */
    setActiveMachineProfile(id) {
        this.set('activeMachineProfile', id);
    }

    /**
     * Add or update a machine profile.
     * @param {{ id?: string, name: string, voltage?: string, workArea?: string, maxFeed?: string, spindle?: string, controller?: string, notes?: string }} profile
     */
    saveMachineProfile(profile) {
        const profiles = this.getMachineProfiles();
        const id = profile.id || `machine-${Date.now()}`;
        const entry = {
            id,
            name: profile.name || 'Untitled',
            voltage: profile.voltage ?? '',
            workArea: profile.workArea ?? '',
            maxFeed: profile.maxFeed ?? '',
            spindle: profile.spindle ?? '',
            controller: profile.controller ?? '',
            notes: profile.notes ?? '',
        };
        const idx = profiles.findIndex((p) => p.id === id);
        if (idx >= 0) {
            profiles[idx] = { ...profiles[idx], ...entry };
        } else {
            profiles.push(entry);
        }
        this.set('machineProfiles', profiles);
    }

    // ─── Persistence ─────────────────────────────────────────────

    /** @private */
    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveImmediate(), SAVE_DEBOUNCE_MS);
    }

    /** @private */
    _saveImmediate() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), 'utf-8');
        } catch (err) {
            this.emit('error', err);
        }
    }

    /** Force an immediate save. */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._saveImmediate();
    }

    // ─── Utilities ───────────────────────────────────────────────

    /** @private */
    _deepMerge(target, source) {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (
                source[key] &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                target[key] &&
                typeof target[key] === 'object' &&
                !Array.isArray(target[key])
            ) {
                result[key] = this._deepMerge(target[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }
}

module.exports = { ConfigStore, DEFAULT_CONFIG };

/**
 * ToolLibrary — human-readable tool definitions.
 *
 * Each tool:
 *   {
 *     number: 1,                      // T-number used in G-code (T1, T2, ...)
 *     name: '1/4" flat end mill',     // shown in UI + job preflight dialog
 *     diameter: 6.35,                 // mm
 *     flutes: 2,
 *     stickout: 22,                   // mm
 *     material: 'carbide',            // 'hss' | 'carbide' | 'diamond'
 *     coating: 'TiN' | 'TiAlN' | 'none',
 *     defaultFeed: 1500,              // mm/min
 *     defaultPlunge: 400,
 *     defaultRpm: 18000,
 *     defaultStepdown: 1.0,           // mm per pass
 *     defaultStepover: 3.2,           // mm (use ~50% of diameter for slotting)
 *     length: 50,                     // mm (overall)
 *     pictureUrl: '',                 // optional, can be data: URL
 *     notes: '',
 *   }
 *
 * Persisted via ConfigStore at key `toolLibrary`.
 *
 * REST:
 *   GET    /api/tools                → array
 *   POST   /api/tools                → upsert
 *   DELETE /api/tools/:number        → remove
 *   GET    /api/tools/:number        → single
 *
 * Job preflight integration:
 *   When CNCEngine starts a job, it scans the G-code for `T<n>`,
 *   asks ToolLibrary.preflight(gcode) → returns warnings for missing tools.
 *   Frontend shows the modal before run.
 */

const DEFAULT_TOOLS = [
    {
        number: 1, name: '1/4" flat endmill (6.35mm)',
        diameter: 6.35, flutes: 2, stickout: 22,
        material: 'carbide', coating: 'TiAlN',
        defaultFeed: 1800, defaultPlunge: 500, defaultRpm: 18000,
        defaultStepdown: 1.5, defaultStepover: 3.2,
        length: 50, notes: 'General purpose roughing/finishing in wood + soft metal.',
    },
    {
        number: 2, name: '1/8" flat endmill (3.18mm)',
        diameter: 3.18, flutes: 2, stickout: 16,
        material: 'carbide', coating: 'TiAlN',
        defaultFeed: 1200, defaultPlunge: 300, defaultRpm: 20000,
        defaultStepdown: 0.8, defaultStepover: 1.6,
        length: 38, notes: 'Detail work + small pockets.',
    },
    {
        number: 3, name: '60° V-bit',
        diameter: 6.35, flutes: 1, stickout: 18,
        material: 'carbide', coating: 'none',
        defaultFeed: 1500, defaultPlunge: 400, defaultRpm: 18000,
        defaultStepdown: 0.5, defaultStepover: 0,
        length: 45, notes: 'V-carving lettering + inlays.',
    },
    {
        number: 4, name: '90° V-bit',
        diameter: 6.35, flutes: 1, stickout: 18,
        material: 'carbide', coating: 'none',
        defaultFeed: 1500, defaultPlunge: 400, defaultRpm: 18000,
        defaultStepdown: 0.5, defaultStepover: 0,
        length: 45, notes: 'Wider chamfer + V-carving.',
    },
    {
        number: 5, name: '3mm ball-nose',
        diameter: 3.0, flutes: 2, stickout: 18,
        material: 'carbide', coating: 'TiAlN',
        defaultFeed: 1200, defaultPlunge: 300, defaultRpm: 22000,
        defaultStepdown: 0.5, defaultStepover: 0.6,
        length: 38, notes: '3D finishing passes.',
    },
];

class ToolLibrary {
    constructor({ configStore, io, logger }) {
        this.configStore = configStore;
        this.io = io;
        this.logger = logger || console;
        const stored = configStore.get('toolLibrary');
        if (!stored || !Array.isArray(stored) || stored.length === 0) {
            this.tools = DEFAULT_TOOLS.slice();
            configStore.set('toolLibrary', this.tools);
        } else {
            this.tools = stored;
        }
    }

    list() { return this.tools.slice().sort((a, b) => a.number - b.number); }

    get(number) { return this.tools.find(t => t.number === +number) || null; }

    upsert(tool) {
        if (typeof tool.number !== 'number') throw new Error('Tool number required');
        const idx = this.tools.findIndex(t => t.number === tool.number);
        if (idx >= 0) this.tools[idx] = { ...this.tools[idx], ...tool };
        else this.tools.push(tool);
        this._persist();
        return tool;
    }

    remove(number) {
        const before = this.tools.length;
        this.tools = this.tools.filter(t => t.number !== +number);
        if (this.tools.length !== before) this._persist();
    }

    _persist() {
        this.configStore.set('toolLibrary', this.tools);
        this.io.emit('tools:list', this.list());
    }

    /**
     * Scan gcode for T<n> calls. Returns:
     *   { used: [1, 3, 5], missing: [{ number: 7, line: 32 }], warnings: [] }
     */
    preflight(gcode) {
        const used = new Set();
        const missing = [];
        const warnings = [];
        const lines = (gcode || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/\bT(\d+)/);
            if (!m) continue;
            const num = +m[1];
            used.add(num);
            if (!this.get(num)) missing.push({ number: num, line: i + 1 });
        }
        const usedSorted = [...used].sort((a, b) => a - b);
        for (const num of usedSorted) {
            const t = this.get(num);
            if (!t) continue;
            if (!t.defaultFeed) warnings.push(`T${num} (${t.name}) has no default feed defined.`);
            if (t.diameter > 10 && t.defaultStepdown > t.diameter * 0.5) {
                warnings.push(`T${num} (${t.name}) stepdown ${t.defaultStepdown}mm > 50% of diameter.`);
            }
        }
        return { used: usedSorted, missing, warnings };
    }
}

module.exports = { ToolLibrary, DEFAULT_TOOLS };

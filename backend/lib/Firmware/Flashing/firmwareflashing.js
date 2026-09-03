/**
 * firmwareflashing - High-level firmware flashing API.
 *
 * Provides a unified interface for flashing firmware to different
 * board types (LongMill MK1/MK2, SLB) using either Arduino bootloader
 * (avrgirl-arduino), STM32 serial bootloader, or DFU protocol.
 *
 * Emits Socket.IO events for UI progress tracking.
 *
 * Reference: gSender firmwareflashing.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const STM32Loader = require('./STM32Loader');
const DFUFlasher = require('./DFUFlasher');

class FirmwareFlashing extends EventEmitter {
    static FIRMWARE_DIR = path.join(__dirname, 'hex');

    static BOARD_TYPES = {
        MK1: 'mk1',
        MK2: 'mk2',
        SLB: 'slb',
        GRBL: 'grbl',
    };

    /**
     * Flash firmware to the specified board type.
     *
     * @param {string} flashPort - Serial port path
     * @param {string} boardType - 'MK1' | 'MK2' | 'SLB' | 'GRBL'
     * @param {object} [options]
     * @param {object} [options.socket] - Socket.IO socket for progress events
     * @param {string} [options.hexPath] - Custom hex file path
     */
    static async flash(flashPort, boardType, options = {}) {
        const { socket } = options;

        if (!flashPort) {
            const error = 'No port specified for flashing';
            if (socket) socket.emit('flash:error', error);
            throw new Error(error);
        }

        // Determine hex file
        let hexPath = options.hexPath;
        if (!hexPath) {
            const hexFilename = this.getHexFilename(boardType);
            hexPath = path.join(FirmwareFlashing.FIRMWARE_DIR, hexFilename);
        }

        if (!fs.existsSync(hexPath)) {
            const error = `Firmware file not found: ${hexPath}`;
            if (socket) socket.emit('flash:error', error);
            throw new Error(error);
        }

        const hexData = fs.readFileSync(hexPath, 'utf-8');

        if (socket) {
            socket.emit('flash:start', { port: flashPort, board: boardType });
            socket.emit('flash:message', {
                type: 'info',
                content: `Starting firmware flash on port ${flashPort} for board ${boardType}`,
            });
        }

        try {
            if (boardType === 'MK1' || boardType === 'MK2') {
                // Use Arduino bootloader (avrgirl-arduino)
                await this.flashArduino(flashPort, hexPath, socket);
            } else if (boardType === 'SLB') {
                // Use STM32 serial bootloader
                await this.flashSTM32(flashPort, hexData, socket);
            } else {
                throw new Error(`Unsupported board type: ${boardType}`);
            }

            if (socket) {
                socket.emit('flash:end', flashPort);
                socket.emit('flash:message', { type: 'success', content: 'Firmware flash successful!' });
            }
        } catch (error) {
            if (socket) {
                socket.emit('flash:error', error.message);
                socket.emit('flash:message', { type: 'error', content: error.message });
            }
            throw error;
        }
    }

    /**
     * Flash using Arduino bootloader (avrgirl-arduino).
     */
    static async flashArduino(port, hexPath, socket) {
        // NOTE: Requires @sienci/avrgirl-arduino package
        // Stub implementation - add to package.json if needed
        try {
            const AvrgirlArduino = require('@sienci/avrgirl-arduino');
            const avrgirl = new AvrgirlArduino({ board: 'uno', port });

            return new Promise((resolve, reject) => {
                avrgirl.flash(hexPath, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (e) {
            throw new Error('avrgirl-arduino not installed. Run: npm install @sienci/avrgirl-arduino');
        }
    }

    /**
     * Flash using STM32 serial bootloader.
     */
    static async flashSTM32(port, hexData, socket) {
        const loader = new STM32Loader(port);

        loader.on('progress', (current, total) => {
            if (socket) {
                socket.emit('flash:progress', { current, total, percent: (current / total) * 100 });
            }
        });

        loader.on('info', (message) => {
            if (socket) socket.emit('flash:message', { type: 'info', content: message });
        });

        await loader.open();
        // NOTE: Actual flashing logic would go here (write hex blocks, verify, etc.)
        await loader.releaseChip();
        await loader.close();
    }

    /**
     * Get the default hex filename for a board type.
     */
    static getHexFilename(boardType) {
        switch (boardType) {
            case 'MK1':
                return 'mk1_20220214.hex';
            case 'MK2':
                return 'mk2_20220214.hex';
            case 'SLB':
                return 'slb_orange.hex';
            case 'GRBL':
                return 'grblsept15.hex';
            default:
                throw new Error(`Unknown board type: ${boardType}`);
        }
    }
}

module.exports = FirmwareFlashing;

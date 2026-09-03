/**
 * STM32Loader - Serial bootloader protocol for STM32 microcontrollers.
 *
 * Communicates with STM32 bootloader over UART to flash firmware
 * without requiring USB DFU mode. Uses DTR/RTS lines to reset the
 * board into bootloader mode.
 *
 * Reference: gSender STM32Loader.js (GPLv3, Sienci Labs Inc.)
 */

const { SerialPort } = require('serialport');
const { delay } = require('../../delay');

class STM32Loader {
    static BAUD_RATE = 115200;

    constructor(path) {
        this.path = path;
        this.buffer = [];
        this.size = 0;
        this._reading = null;
    }

    /**
     * Open the serial port and initialize the bootloader.
     */
    open() {
        return new Promise((resolve, reject) => {
            this.port = new SerialPort({
                path: this.path,
                baudRate: STM32Loader.BAUD_RATE,
                parity: 'even',
            }, async (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                this.port.on('data', this.onData.bind(this));
                await delay(100);
                await this.initChip();
                resolve();
            });
        });
    }

    /**
     * Handle incoming data.
     */
    onData(data) {
        if (data) {
            this.buffer.push(data);
            this.size += data.length;
        }

        if (this._reading && this._reading.size <= this.size) {
            const { resolve, size } = this._reading;
            this._reading = undefined;

            let result = this.buffer.length > 1 ? Buffer.concat(this.buffer) : this.buffer[0];

            if (result.length === size) {
                this.buffer = [];
                this.size = 0;
            } else {
                this.buffer = [result.slice(size)];
                this.size -= size;
                result = result.slice(0, size);
            }

            resolve(result);
        }
    }

    /**
     * Write data to the serial port.
     */
    write(data) {
        if (typeof data === 'number') {
            data = [data];
        }
        this.port.write(data);
    }

    /**
     * Wait for ACK (0x79) from bootloader.
     */
    async waitForAck(timeout = 1000) {
        const data = await this.read(1);
        if (data[0] !== 0x79) {
            throw new Error('NACK received from bootloader');
        }
    }

    /**
     * Read a specific number of bytes.
     */
    read(size) {
        return new Promise((resolve, reject) => {
            this._reading = { resolve, reject, size };
            if (this.buffer.length > 0) {
                this.onData();
            }
        });
    }

    /**
     * Initialize the STM32 bootloader (send 0x7F sync byte).
     */
    async initChip() {
        this.buffer = [];
        this.setRTS(false);
        await this.reset();
        this.write(0x7F);
        await this.waitForAck(5000);
    }

    /**
     * Release the chip from bootloader mode.
     */
    async releaseChip() {
        this.setRTS(true);
        await this.reset();
    }

    /**
     * Reset the STM32 using DTR line.
     */
    async reset() {
        this.setDTR(false);
        await delay(200);
        this.setDTR(true);
        await delay(200);
    }

    /**
     * Set DTR line state.
     */
    setDTR(value) {
        this.port.set({ dtr: value });
    }

    /**
     * Set RTS line state.
     */
    setRTS(value) {
        this.port.set({ rts: value });
    }

    /**
     * Close the serial port.
     */
    close() {
        return new Promise((resolve) => {
            if (this.port && this.port.isOpen) {
                this.port.close(resolve);
            } else {
                resolve();
            }
        });
    }
}

module.exports = STM32Loader;

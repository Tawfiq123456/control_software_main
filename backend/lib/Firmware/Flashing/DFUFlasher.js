/**
 * DFUFlasher - High-level DFU flashing workflow orchestrator.
 *
 * Handles the complete firmware flashing process:
 *   1. Parse hex file
 *   2. Erase flash memory
 *   3. Write firmware in chunks
 *   4. Verify and manifest
 *
 * Emits progress events for UI feedback.
 *
 * Reference: gSender DFUFlasher.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const DFU = require('./DFU');
const { delay } = require('../../delay');

class DFUFlasher extends EventEmitter {
    static SET_ADDRESS = 0x21;
    static ERASE_PAGE = 0x41;
    static XFER_SIZE = 2048;

    constructor({ hex, ...options }) {
        super();
        this.options = options;
        this.hex = hex;
        this.dfu = new DFU(options);
    }

    /**
     * Flash firmware to the device.
     */
    async flash() {
        try {
            await this.dfu.open();
        } catch (e) {
            this.emit('error', e.message);
            return;
        }

        this.map = this.parseHex(this.hex);

        let startAddress = null;
        let byteSize = 0;

        for (const [address, dataBlock] of this.map) {
            if (!startAddress) startAddress = address;
            byteSize += dataBlock.byteLength;
        }

        try {
            await this.dfu.abortToIdle();
            this.emit('info', 'Aborted to IDLE state');
        } catch (e) {
            this.emit('error', e.message);
            return;
        }

        // Erase chip
        await this.erase(startAddress, byteSize);

        // Write all blocks
        for (const [address, dataBlock] of this.map) {
            this.emit('info', `Writing block of size ${dataBlock.byteLength} at address 0x${address.toString(16)}`);
            await this.download(address, DFUFlasher.XFER_SIZE, dataBlock);
        }

        await this.dfu.abortToIdle();
        this.emit('info', `Jumping back to start address ${startAddress} to manifest`);
        await this.sendDFUCommand(DFUFlasher.SET_ADDRESS, startAddress, 4);

        const status = await this.dfu.getStatus();
        this.emit('info', `Status: ${JSON.stringify(status)}`);

        await this.dfu.download(new ArrayBuffer(0), 0);

        try {
            await this.dfu.pollUntil(state => state === DFU.DFU_MANIFEST);
        } catch (error) {
            this.emit('error', error.message);
        }

        await this.dfu.close();
        this.emit('end');
    }

    /**
     * Parse Intel HEX file.
     * Returns a Map of address -> data buffer.
     */
    parseHex(hexString) {
        // Stub: requires 'nrf-intel-hex' or similar
        // Real implementation would parse Intel HEX format:
        //   :10010000214601360121470136007EFE09D2190140
        //   ^^ byte count
        //     ^^^^ address
        //         ^^ record type
        //           .... data
        //                   ^^ checksum
        //
        // For now, return empty map to avoid crash
        this.emit('error', 'Hex parsing not implemented (requires nrf-intel-hex library)');
        return new Map();
    }

    /**
     * Download data to device.
     */
    async download(startAddress, xferSize, data) {
        this.emit('info', 'Starting download to board');

        let bytesSent = 0;
        const expectedSize = data.byteLength;
        let chunks = 1;
        let address = startAddress;

        while (bytesSent < expectedSize) {
            const bytesLeft = expectedSize - bytesSent;
            const chunkSize = Math.min(bytesLeft, xferSize);

            try {
                await this.sendDFUCommand(DFUFlasher.SET_ADDRESS, address, 4);
                await this.dfu.getStatus();

                const bytesWritten = await this.dfu.download(
                    data.slice(bytesSent, bytesSent + chunkSize),
                    2
                );

                this.emit('info', `Wrote chunk ${chunks} with size ${bytesWritten}b`);

                const dfuStatus = await this.dfu.pollUntilIdle(DFU.DFU_DNLOAD_IDLE);
                if (dfuStatus.status !== DFU.STATUS_OK) {
                    this.emit('error', `DFU DOWNLOAD failed state=${dfuStatus.state}, status=${dfuStatus.status}`);
                    return;
                }

                address += chunkSize;
                chunks += 1;
                bytesSent += bytesWritten;
                this.logProgress(bytesSent, expectedSize);
            } catch (e) {
                this.emit('error', `Error during download: ${e.message}`);
                return;
            }
        }

        this.emit('info', 'Finished download chunk');
    }

    /**
     * Erase flash memory.
     */
    async erase(startAddr, length) {
        this.emit('info', `Erasing chip starting at address ${startAddr.toString(16)} - size ${length}`);

        let segment = this.dfu.getSegment(startAddr);
        if (!segment) {
            this.emit('error', 'Invalid segment in memory map');
            return;
        }

        let addr = this.getSectorStart(startAddr, segment);
        const endAddr = this.getSectorEnd(startAddr + length - 1, segment);
        this.emit('info', `Starting erase at ${addr.toString(16)} and erasing until ${endAddr.toString(16)}`);

        let bytesErased = 0;
        const bytesToErase = endAddr - addr;

        while (addr < endAddr) {
            if (segment.end <= addr) {
                segment = this.dfu.getSegment(addr);
            }
            if (!segment.erasable) {
                bytesErased = Math.min(bytesErased + segment.end - addr, bytesToErase);
                addr = segment.end;
                this.logProgress(bytesErased, bytesToErase);
                continue;
            }

            const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
            const sectorAddr = segment.start + sectorIndex * segment.sectorSize;

            await this.sendDFUCommand(DFUFlasher.ERASE_PAGE, sectorAddr, 4);
            await this.dfu.getStatus();

            addr = sectorAddr + segment.sectorSize;
            bytesErased += segment.sectorSize;
            this.logProgress(bytesErased, bytesToErase);
            this.emit('info', `Erased ${bytesErased} of ${bytesToErase} bytes`);
        }

        this.emit('info', 'Erase finished');
    }

    /**
     * Send a DFU command with payload.
     */
    async sendDFUCommand(command, param = 0x00, len = 1) {
        const payload = new ArrayBuffer(len + 1);
        const dv = new DataView(payload);
        dv.setUint8(0, command);

        if (len === 1) {
            dv.setUint8(1, param);
        } else if (len === 4) {
            dv.setUint32(1, param, true);
        } else {
            this.emit('error', `Invalid length of ${len} specified - must be 1 or 4`);
            return;
        }

        try {
            await this.dfu.download(payload, 0);
        } catch (err) {
            this.emit('error', `Error during DFU command ${command}`);
            return;
        }

        const status = await this.dfu.pollUntil(state => state !== DFU.DFU_DNBUSY);
        if (status.status !== DFU.STATUS_OK) {
            this.emit('error', `Special DfuSe command ${command} failed`);
        }
    }

    getSectorStart(addr, segment) {
        const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
        return segment.start + sectorIndex * segment.sectorSize;
    }

    getSectorEnd(addr, segment) {
        const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
        return segment.start + (sectorIndex + 1) * segment.sectorSize;
    }

    logProgress(value, total) {
        this.emit('progress', value, total);
    }
}

module.exports = DFUFlasher;

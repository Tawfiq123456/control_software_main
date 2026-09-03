/**
 * GrblLineParser - Modular line parser for GRBL serial responses.
 *
 * Delegates to pluggable result parsers, each handling a specific
 * response type (status, ok, error, alarm, settings, etc.).
 * Returns { type, payload } where type identifies the parser class
 * and payload contains parsed data plus the raw line.
 *
 * Reference: gSender GrblLineParser.js (GPLv3, Sienci Labs Inc.)
 */

const GrblLineParserResultStatus = require('./parsers/GrblLineParserResultStatus');
const GrblLineParserResultOk = require('./parsers/GrblLineParserResultOk');
const GrblLineParserResultError = require('./parsers/GrblLineParserResultError');
const GrblLineParserResultAlarm = require('./parsers/GrblLineParserResultAlarm');
const GrblLineParserResultParserState = require('./parsers/GrblLineParserResultParserState');
const GrblLineParserResultParameters = require('./parsers/GrblLineParserResultParameters');
const GrblLineParserResultHelp = require('./parsers/GrblLineParserResultHelp');
const GrblLineParserResultVersion = require('./parsers/GrblLineParserResultVersion');
const GrblLineParserResultOption = require('./parsers/GrblLineParserResultOption');
const GrblLineParserResultEcho = require('./parsers/GrblLineParserResultEcho');
const GrblLineParserResultFeedback = require('./parsers/GrblLineParserResultFeedback');
const GrblLineParserResultSettings = require('./parsers/GrblLineParserResultSettings');
const GrblLineParserResultStartup = require('./parsers/GrblLineParserResultStartup');

class GrblLineParser {
    constructor() {
        this.parsers = [
            GrblLineParserResultStatus,
            GrblLineParserResultOk,
            GrblLineParserResultError,
            GrblLineParserResultAlarm,
            GrblLineParserResultParserState,
            GrblLineParserResultParameters,
            GrblLineParserResultHelp,
            GrblLineParserResultVersion,
            GrblLineParserResultOption,
            GrblLineParserResultEcho,
            GrblLineParserResultFeedback,
            GrblLineParserResultSettings,
            GrblLineParserResultStartup,
        ];
    }

    /**
     * Parse a single line from the GRBL serial port.
     * @param {string} line - Raw line from serial
     * @returns {{ type: string|null, payload: object }}
     */
    parse(line) {
        for (const parser of this.parsers) {
            const result = parser.parse(line);
            if (result) {
                result.payload.raw = line;
                return result;
            }
        }

        return {
            type: null,
            payload: { raw: line },
        };
    }
}

module.exports = GrblLineParser;

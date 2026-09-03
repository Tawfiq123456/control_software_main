/**
 * Demo server - Basic Express + Socket.IO server without CNC dependencies
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 4002;
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Basic routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Demo server running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

app.get('/api/ports', (req, res) => {
    res.json([
        { path: '/dev/ttyUSB0', manufacturer: 'Demo Port 1' },
        { path: '/dev/ttyUSB1', manufacturer: 'Demo Port 2' },
        { path: 'COM3', manufacturer: 'Demo Port 3' },
    ]);
});

app.get('/api/state', (req, res) => {
    res.json({
        connected: false,
        port: null,
        status: 'idle',
        position: { x: 0, y: 0, z: 0 },
        demo: true,
    });
});

// Create HTTP + Socket.IO server
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true },
    path: '/socket.io',
});

// Socket.IO handlers
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send demo data immediately on connection
    socket.emit('demo:welcome', {
        message: 'Connected to demo CNC server',
        features: ['REST API', 'Socket.IO', 'Health Check'],
    });

    // Send initial port list
    socket.emit('serialport:list', [
        { path: '/dev/ttyUSB0', manufacturer: 'Demo Port 1', vendorId: '0x1234', productId: '0x5678' },
        { path: '/dev/ttyUSB1', manufacturer: 'Demo Port 2', vendorId: '0x1234', productId: '0x5679' },
        { path: 'COM3', manufacturer: 'Demo Port 3', vendorId: '0x1234', productId: '0x567A' },
    ]);

    // Handle port listing requests
    socket.on('list', (callback) => {
        const ports = [
            { path: '/dev/ttyUSB0', manufacturer: 'Demo Port 1', vendorId: '0x1234', productId: '0x5678' },
            { path: '/dev/ttyUSB1', manufacturer: 'Demo Port 2', vendorId: '0x1234', productId: '0x5679' },
            { path: 'COM3', manufacturer: 'Demo Port 3', vendorId: '0x1234', productId: '0x567A' },
        ];
        if (callback) callback(null, ports);
        socket.emit('serialport:list', ports);
    });

    // Handle connection attempts
    socket.on('open', (portPath, options, callback) => {
        console.log(`Demo: Opening port ${portPath} with options:`, options);
        setTimeout(() => {
            socket.emit('serialport:open', { port: portPath, controllerType: 'Grbl' });
            socket.emit('controller:type', 'Grbl');
            socket.emit('controller:state', 'Grbl', {
                status: {
                    activeState: 'Idle',
                    mpos: { x: 0, y: 0, z: 0 },
                    wpos: { x: 0, y: 0, z: 0 },
                    wco: { x: 0, y: 0, z: 0 },
                    ov: { feed: 100, rapid: 100, spindle: 100 },
                    buf: { planner: 0, rx: 0 },
                    feedrate: 0,
                    spindle: 0,
                    spindleDirection: 'M5',
                    pinState: '',
                },
                parserstate: {
                    modal: { motion: 'G0', wcs: 'G54', plane: 'G17', units: 'G21', distance: 'G90' },
                    tool: 0,
                    feedrate: 0,
                    spindle: 0,
                }
            });
            if (callback) callback(null);
        }, 500);
    });

    // Handle disconnection attempts
    socket.on('close', (portPath, callback) => {
        console.log(`Demo: Closing port ${portPath}`);
        socket.emit('serialport:close', { port: portPath });
        if (callback) callback(null);
    });

    // Handle demo commands
    socket.on('demo:ping', (data, callback) => {
        console.log('Demo ping received:', data);
        if (callback) callback(null, { pong: true, timestamp: Date.now() });
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Demo CNC backend running on http://localhost:${PORT}`);
    console.log(`📡 Socket.IO endpoint: http://localhost:${PORT}/socket.io`);
    console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
});
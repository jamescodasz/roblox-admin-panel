// server.js
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cors());

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // HTTPS only
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Store connected game servers
const gameServers = new Map();
const playerData = new Map();

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === 'host' && password === 'password') {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/players', requireAuth, (req, res) => {
    const players = Array.from(playerData.values());
    res.json(players);
});

app.post('/api/kick/:userId', requireAuth, (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    
    // Send kick command to all connected game servers
    gameServers.forEach((ws, serverId) => {
        ws.send(JSON.stringify({
            type: 'kick',
            userId: userId,
            reason: reason || 'Kicked by administrator'
        }));
    });
    
    res.json({ success: true });
});

// Create HTTPS server
let server;
if (process.env.NODE_ENV === 'production') {
    // In production, use platform-provided HTTPS
    server = app.listen(PORT);
} else {
    // For local development, create self-signed certificate
    const privateKey = fs.readFileSync('key.pem', 'utf8');
    const certificate = fs.readFileSync('cert.pem', 'utf8');
    const credentials = { key: privateKey, cert: certificate };
    
    server = https.createServer(credentials, app);
    server.listen(PORT, () => {
        console.log(`HTTPS Server running on port ${PORT}`);
    });
}

// WebSocket server for game communication
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const serverId = Date.now().toString();
    gameServers.set(serverId, ws);
    
    console.log(`Game server connected: ${serverId}`);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'player_update':
                    // Update player data
                    data.players.forEach(player => {
                        playerData.set(player.userId, {
                            ...player,
                            serverId: serverId,
                            lastUpdate: Date.now()
                        });
                    });
                    break;
                    
                case 'player_join':
                    playerData.set(data.player.userId, {
                        ...data.player,
                        serverId: serverId,
                        lastUpdate: Date.now()
                    });
                    break;
                    
                case 'player_leave':
                    playerData.delete(data.userId);
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        gameServers.delete(serverId);
        // Remove players from this server
        playerData.forEach((player, userId) => {
            if (player.serverId === serverId) {
                playerData.delete(userId);
            }
        });
        console.log(`Game server disconnected: ${serverId}`);
    });
});

// Clean up stale player data periodically
setInterval(() => {
    const now = Date.now();
    playerData.forEach((player, userId) => {
        if (now - player.lastUpdate > 60000) { // 1 minute timeout
            playerData.delete(userId);
        }
    });
}, 30000);


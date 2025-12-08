const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const mkdirp = require("mkdirp");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "messages.json");
mkdirp.sync(DATA_DIR);

// Ensure simple JSON store
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ rooms: {}, dms: {} }, null, 2));
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch (e) {
        return { rooms: {}, dms: {} };
    }
}
function writeDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT_HTTP = 3000;
const PORT = 3000;

// In-memory presence + rooms
// clientMap: ws -> {id, username, room}
const clients = new Map();
// rooms: { roomName: Set(ws) }
const rooms = new Map();
// simple incremental user id
let nextUserId = 1;

/* --- Helper: broadcast function --- */
function safeSend(ws, obj) {
    try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    } catch (e) {}
}
function broadcastToRoom(roomName, obj) {
    const s = rooms.get(roomName);
    if (!s) return;
    for (const ws of s) safeSend(ws, obj);
}
function broadcastToAll(obj) {
    for (const ws of clients.keys()) safeSend(ws, obj);
}

/* --- WebSocket message protocol ---
client -> server messages (JSON):
{ type: 'login', username }
{ type: 'create_room', room }
{ type: 'join_room', room }
{ type: 'leave_room', room }
{ type: 'message', room, text }
{ type: 'dm', toUsername, text }
{ type: 'typing', room, isTyping }  // isTyping: true/false
{ type: 'history', room } // request history
...
server -> client messages:
{ type: 'login_success', username, users, rooms }
{ type: 'presence', users }
{ type: 'room_list', rooms }
{ type: 'room_message', room, username, text, ts }
{ type: 'dm_message', from, to, text, ts }
{ type: 'notification', text }
{ type: 'typing', room, username, isTyping }
{ type: 'history', room, messages: [...] }
*/

wss.on("connection", (ws, req) => {
    const userId = nextUserId++;
    clients.set(ws, { id: userId, username: null, room: null, typing: false });
    console.log("New connection", userId);

    // Send server welcome / ask to login
    safeSend(ws, { type: "welcome", message: "Welcome! Please send {type:'login', username}" });

    ws.on("message", (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch (e) { return; }

        const meta = clients.get(ws);
        if (!meta) return;

        if (data.type === "login") {
            const username = String(data.username || `User${meta.id}`).trim();
            meta.username = username;

            // Add to default lobby room
            const defaultRoom = "lobby";
            if (!rooms.has(defaultRoom)) rooms.set(defaultRoom, new Set());
            rooms.get(defaultRoom).add(ws);
            meta.room = defaultRoom;

            // Ensure DB has room
            const db = readDB();
            if (!db.rooms[defaultRoom]) db.rooms[defaultRoom] = [];
            writeDB(db);

            // Notify all with presence and rooms
            const usersList = Array.from(clients.values()).filter(u => u.username).map(u => ({ username: u.username, room: u.room }));
            const roomsList = Array.from(rooms.keys());

            // Send login success
            safeSend(ws, { type: "login_success", username, users: usersList, rooms: roomsList, room: defaultRoom });

            // Send last 50 messages for room
            const db2 = readDB();
            const roomMsgs = db2.rooms[meta.room] || [];
            safeSend(ws, { type: "history", room: meta.room, messages: roomMsgs.slice(-200) });

            // Broadcast presence & join notification
            broadcastToAll({ type: "presence", users: usersList });
            broadcastToRoom(meta.room, { type: "notification", text: `${username} joined ${meta.room}` });
            return;
        }

        // Require logged-in for other actions
        if (!meta.username) {
            safeSend(ws, { type: "error", message: "Please login first." });
            return;
        }

        if (data.type === "create_room") {
            const room = String(data.room).trim();
            if (!room) return;
            if (!rooms.has(room)) rooms.set(room, new Set());
            // persist empty room if not present
            const db = readDB();
            if (!db.rooms[room]) db.rooms[room] = [];
            writeDB(db);
            // notify all clients
            broadcastToAll({ type: "room_list", rooms: Array.from(rooms.keys()) });
            return;
        }

        if (data.type === "join_room") {
            const room = String(data.room).trim();
            if (!room) return;
            // leave previous room
            if (meta.room && rooms.has(meta.room)) {
                rooms.get(meta.room).delete(ws);
                broadcastToRoom(meta.room, { type: "notification", text: `${meta.username} left ${meta.room}` });
            }
            // join new
            if (!rooms.has(room)) rooms.set(room, new Set());
            rooms.get(room).add(ws);
            meta.room = room;
            // ensure persisted store
            const db = readDB();
            if (!db.rooms[room]) db.rooms[room] = [];
            writeDB(db);
            // send history for new room
            const db2 = readDB();
            safeSend(ws, { type: "history", room, messages: db2.rooms[room].slice(-200) });
            broadcastToRoom(room, { type: "notification", text: `${meta.username} joined ${room}` });
            broadcastToAll({ type: "room_list", rooms: Array.from(rooms.keys()) });
            return;
        }

        if (data.type === "leave_room") {
            const room = meta.room;
            if (room && rooms.has(room)) {
                rooms.get(room).delete(ws);
                broadcastToRoom(room, { type: "notification", text: `${meta.username} left ${room}` });
            }
            meta.room = null;
            broadcastToAll({ type: "presence", users: Array.from(clients.values()).filter(u=>u.username).map(u=>({ username: u.username, room: u.room })) });
            return;
        }

        if (data.type === "message") {
            const room = data.room || meta.room;
            const text = String(data.text || "");
            const ts = Date.now();
            if (!room) {
                safeSend(ws, { type: "error", message: "Not in a room" });
                return;
            }
            // persist
            const db = readDB();
            db.rooms[room] = db.rooms[room] || [];
            db.rooms[room].push({ username: meta.username, text, ts });
            // cap history length (keep last 1000 per room)
            if (db.rooms[room].length > 2000) db.rooms[room].shift();
            writeDB(db);
            // broadcast to the room
            broadcastToRoom(room, { type: "room_message", room, username: meta.username, text, ts });
            return;
        }

        if (data.type === "dm") {
            const to = String(data.to || "").trim();
            const text = String(data.text || "");
            const ts = Date.now();
            if (!to) return;
            // find recipient ws
            let targetWs = null;
            for (const [clientWs, m] of clients) {
                if (m.username === to) { targetWs = clientWs; break; }
            }
            // persist DM under sorted key (userA|userB)
            const db = readDB();
            const key = [meta.username, to].sort().join("|");
            db.dms[key] = db.dms[key] || [];
            db.dms[key].push({ from: meta.username, to, text, ts });
            if (db.dms[key].length > 2000) db.dms[key].shift();
            writeDB(db);
            // send to both participants (if online)
            if (targetWs) safeSend(targetWs, { type: "dm_message", from: meta.username, to, text, ts });
            safeSend(ws, { type: "dm_message", from: meta.username, to, text, ts });
            return;
        }

        if (data.type === "typing") {
            const isTyping = !!data.isTyping;
            meta.typing = isTyping;
            // notify other users in the same room
            broadcastToRoom(meta.room, { type: "typing", room: meta.room, username: meta.username, isTyping });
            return;
        }

        if (data.type === "history") {
            const room = data.room;
            const db = readDB();
            if (room) {
                safeSend(ws, { type: "history", room, messages: db.rooms[room] || [] });
            } else {
                safeSend(ws, { type: "error", message: "room required" });
            }
            return;
        }
    });

    ws.on("close", () => {
        const meta = clients.get(ws) || {};
        const name = meta.username || `User${meta.id}`;
        // remove from rooms
        if (meta.room && rooms.has(meta.room)) rooms.get(meta.room).delete(ws);
        clients.delete(ws);
        // broadcast presence + leave notification
        broadcastToAll({ type: "presence", users: Array.from(clients.values()).filter(u=>u.username).map(u=>({ username: u.username, room: u.room })) });
        if (meta.room) broadcastToRoom(meta.room, { type: "notification", text: `${name} disconnected` });
        console.log("Connection closed", name);
    });

    ws.on("error", (err) => {
        console.error("WS error:", err);
    });
});

/* --- Simple HTTP endpoints for convenience --- */
app.get("/rooms", (req, res) => {
    res.json({ rooms: Array.from(rooms.keys()) });
});
app.get("/users", (req, res) => {
    res.json({ users: Array.from(clients.values()).filter(u=>u.username).map(u=>({ username: u.username, room: u.room })) });
});
app.get("/history/:room", (req, res) => {
    const db = readDB();
    res.json({ room: req.params.room, messages: db.rooms[req.params.room] || [] });
});
app.get("/dm/:userA/:userB", (req, res) => {
    const db = readDB();
    const key = [req.params.userA, req.params.userB].sort().join("|");
    res.json({ key, messages: db.dms[key] || [] });
});

server.listen(PORT_HTTP, () => {
    console.log(`HTTP + WS server listening on http://localhost:${PORT_HTTP}`);
});

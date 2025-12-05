const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 }, () => {
    console.log("Server running on ws://localhost:8080");
});

// Assign a unique ID to each user
let userCount = 1;

wss.on("connection", (ws) => {
    ws.username = "User" + userCount++;
    console.log(ws.username + " connected");

    // Notify all users that a new user joined
    broadcast({
        type: "notification",
        message: `${ws.username} joined the chat`,
    });

    ws.on("message", (data) => {
        const message = data.toString();

        // Broadcast message to all connected users
        broadcast({
            type: "message",
            username: ws.username,
            message,
        });
    });

    ws.on("close", () => {
        broadcast({
            type: "notification",
            message: `${ws.username} left the chat`,
        });
    });
});

function broadcast(data) {
    const json = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    });
}

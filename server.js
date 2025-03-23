// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ 
  port: 8080,
  perMessageDeflate: false 
}, () => {
  console.log('WebSocket server started on ws://localhost:8080');
});

wss.on('connection', (ws) => {
  console.log('New client connected (compression disabled)');

  ws.on('message', (message) => {
    console.log(`Received audio chunk of size: ${message.length} bytes`);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});


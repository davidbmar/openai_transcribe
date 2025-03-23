// server.js - HTTP POST approach
const http = require('http');
const fs = require('fs');
const path = require('path');

// Create HTTP server
const server = http.createServer((req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle OPTIONS request (preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Handle audio POST request
  if (req.method === 'POST' && req.url === '/audio') {
    console.log('Receiving audio data...');
    
    let data = [];
    
    req.on('data', (chunk) => {
      data.push(chunk);
      console.log(`Received chunk of size: ${chunk.length} bytes`);
    });
    
    req.on('end', () => {
      const buffer = Buffer.concat(data);
      console.log(`Received complete audio data: ${buffer.length} bytes`);
      
      // Log the first few bytes for debugging
      if (buffer.length > 0) {
        console.log(`First few bytes: ${buffer.slice(0, 10).toString('hex')}`);
      }
      
      // Send a success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, size: buffer.length }));
    });
    
    return;
  }
  
  // Serve the HTML page
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'streaming.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading HTML file');
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  
  // Default response for other requests
  res.writeHead(404);
  res.end('Not found');
});

// Start server
const PORT = 8080;
server.listen(PORT, () => {
  console.log(`HTTP server running on http://localhost:${PORT}`);
});

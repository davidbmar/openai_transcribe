// server.js - HTTP server with OpenAI transcription using direct environment variables
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Get API key directly from environment variable
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Check if API key is available
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.');
  console.error('Please set your OpenAI API key as an environment variable before running the server:');
  console.error('  export OPENAI_API_KEY=your_api_key  # For Linux/Mac');
  console.error('  set OPENAI_API_KEY=your_api_key     # For Windows CMD');
  console.error('  $env:OPENAI_API_KEY="your_api_key"  # For Windows PowerShell');
  process.exit(1);
}

const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

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
    
    req.on('end', async () => {
      const buffer = Buffer.concat(data);
      console.log(`Received complete audio data: ${buffer.length} bytes`);
      
      // Log first few bytes for debugging
      if (buffer.length > 0) {
        console.log(`First few bytes: ${buffer.slice(0, 10).toString('hex')}`);
      }
      
      try {
        // Send the audio to OpenAI for transcription
        const transcript = await transcribeAudio(buffer);
        
        // Send back the transcription as the response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          size: buffer.length,
          transcript: transcript
        }));
      } catch (error) {
        console.error('Transcription error:', error);
        
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: error.message
        }));
      }
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

// Function to transcribe audio using OpenAI API
async function transcribeAudio(audioBuffer) {
  try {
    // Get the audio format from the buffer
    const format = detectAudioFormat(audioBuffer);
    const tmpFilename = `temp_audio_${Date.now()}.${format}`;
    
    // Write the buffer to a temporary file
    fs.writeFileSync(tmpFilename, audioBuffer);
    
    // Create a FormData object
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tmpFilename));
    formData.append('model', 'whisper-1');
    formData.append('language', 'en'); // Set to your preferred language or detect it
    
    // Send the request to OpenAI using axios
    const response = await axios.post(OPENAI_API_URL, formData, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders() // This is important for FormData to work correctly
      }
    });
    
    // Clean up the temporary file
    try {
      fs.unlinkSync(tmpFilename);
    } catch (err) {
      console.error('Error deleting temporary file:', err);
    }
    
    // Return the transcription
    return response.data.text || 'No transcription available';
    
  } catch (error) {
    console.error('Transcription error:', error.message);
    if (error.response) {
      console.error('OpenAI API response:', error.response.data);
    }
    throw error;
  }
}

// Simple function to detect audio format from buffer
function detectAudioFormat(buffer) {
  // WebM header usually starts with 0x1A 0x45 0xDF 0xA3
  if (buffer.length > 4 && 
      buffer[0] === 0x1A && 
      buffer[1] === 0x45 && 
      buffer[2] === 0xDF && 
      buffer[3] === 0xA3) {
    return 'webm';
  }
  
  // This is a fallback, as browsers typically use WebM with MediaRecorder
  return 'webm';
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`HTTP server running on http://localhost:${PORT}`);
  console.log(`OpenAI API key is configured`);
});

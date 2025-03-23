// server.js - Optimized for WAV audio handling
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

// Get API key from environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.');
  console.error('Please set your OpenAI API key as an environment variable before running the server:');
  console.error('  export OPENAI_API_KEY=your_api_key  # For Linux/Mac');
  console.error('  set OPENAI_API_KEY=your_api_key     # For Windows CMD');
  console.error('  $env:OPENAI_API_KEY="your_api_key"  # For Windows PowerShell');
  process.exit(1);
}

// Buffer to store previous audio chunks that had no transcription
let previousAudioBuffer = null;
let previousAudioBufferSize = 0;
const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB max buffer size
let consecutiveEmptyResponses = 0;
const MAX_EMPTY_RESPONSES = 3; // Auto-reset after this many consecutive empty responses

// Create HTTP server
const server = http.createServer((req, res) => {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Handle audio POST request
  if (req.method === 'POST' && req.url === '/audio') {
    let data = [];
    
    req.on('data', (chunk) => {
      data.push(chunk);
    });
    
    req.on('end', async () => {
      const currentBuffer = Buffer.concat(data);
      console.log(`Received audio chunk: ${currentBuffer.length} bytes`);
      
      // Skip processing very small chunks
      if (currentBuffer.length < 1000) {
        console.log('Audio chunk too small, skipping...');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          transcript: ''
        }));
        return;
      }
      
      try {
        // Generate unique filenames
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 8);
        const audioFile = `audio_${timestamp}_${randomString}`;
        const wavFile = `${audioFile}.wav`;
        const mp3File = `${audioFile}.mp3`;
        
        // Check audio format by reading first few bytes
        const headerBuffer = currentBuffer.slice(0, Math.min(12, currentBuffer.length));
        const isWav = headerBuffer.includes('RIFF') && headerBuffer.includes('WAVE');
        const isWebm = headerBuffer.includes('webm');
        const isMp3 = headerBuffer[0] === 0xFF && (headerBuffer[1] & 0xE0) === 0xE0;
        
        console.log(`Audio format detection: WAV=${isWav}, WebM=${isWebm}, MP3=${isMp3}`);
        
        // Save the received audio to file
        fs.writeFileSync(wavFile, currentBuffer);
        console.log(`Saved audio to temporary file: ${wavFile}`);
        
        // STEP 1: Try direct transcription with the file as-is
        console.log('Sending audio directly to OpenAI API...');
        let transcript = await transcribeWithCurl(wavFile);
        console.log(`Direct transcription result: "${transcript}"`);
        
        // If direct transcription worked, we're done
        if (transcript && transcript.trim() !== '') {
          // Send successful response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            transcript: transcript
          }));
          
          // Clean up and return early
          cleanupFiles([wavFile]);
          
          // Reset buffers
          previousAudioBuffer = null;
          previousAudioBufferSize = 0;
          consecutiveEmptyResponses = 0;
          
          return;
        }
        
        // STEP 2: If direct transcription failed and it's not a WAV file, try converting to MP3
        if (!isWav) {
          console.log('Direct transcription failed, trying conversion to MP3...');
          try {
            await convertToMp3(wavFile, mp3File);
            console.log('Conversion to MP3 successful');
            
            transcript = await transcribeWithCurl(mp3File);
            console.log(`MP3 transcription result: "${transcript}"`);
            
            if (transcript && transcript.trim() !== '') {
              // Send successful response
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                success: true, 
                transcript: transcript
              }));
              
              // Clean up and return early
              cleanupFiles([wavFile, mp3File]);
              
              // Reset buffers
              previousAudioBuffer = null;
              previousAudioBufferSize = 0;
              consecutiveEmptyResponses = 0;
              
              return;
            }
          } catch (conversionError) {
            console.error('MP3 conversion error:', conversionError);
          }
        }
        
        // If we reach here, all transcription attempts failed
        consecutiveEmptyResponses++;
        console.log(`All transcription attempts failed. Empty response count: ${consecutiveEmptyResponses}`);
        
        if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
          // Too many failures, reset buffer
          console.log(`Too many empty responses (${consecutiveEmptyResponses}), resetting buffer`);
          previousAudioBuffer = null;
          previousAudioBufferSize = 0;
          consecutiveEmptyResponses = 0;
        } else {
          // Keep current buffer for the next attempt
          previousAudioBuffer = currentBuffer;
          previousAudioBufferSize = currentBuffer.length;
          console.log(`Storing audio for next attempt (${previousAudioBufferSize} bytes)`);
        }
        
        // Clean up files
        cleanupFiles([wavFile, mp3File]);
        
        // Send empty response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          transcript: ''
        }));
        
      } catch (error) {
        console.error('Transcription error:', error.message);
        
        // Reset buffer on error
        previousAudioBuffer = null;
        previousAudioBufferSize = 0;
        
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: error.message 
        }));
      }
    });
    
    req.on('error', (err) => {
      console.error('Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    
    return;
  }
  
  // Handle reset buffer request
  if (req.method === 'POST' && req.url === '/reset') {
    previousAudioBuffer = null;
    previousAudioBufferSize = 0;
    consecutiveEmptyResponses = 0;
    console.log('Audio buffer reset');
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Buffer reset' }));
    return;
  }
  
  // Serve HTML page
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
  
  res.writeHead(404);
  res.end('Not found');
});

// Helper to clean up multiple files
function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Temporary file ${filePath} deleted`);
      }
    } catch (cleanupError) {
      console.error(`Error deleting file ${filePath}:`, cleanupError);
    }
  }
}

// Convert audio to MP3 using ffmpeg
async function convertToMp3(inputFile, mp3File) {
  const execAsync = promisify(exec);
  
  // Check if input file exists
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file ${inputFile} does not exist`);
  }
  
  // Create ffmpeg command with optimal settings for Whisper
  const ffmpegCommand = `ffmpeg -y -i "${inputFile}" -c:a libmp3lame -q:a 4 -ar 16000 -ac 1 "${mp3File}"`;
  
  try {
    console.log(`Running FFmpeg command: ${ffmpegCommand}`);
    const { stdout, stderr } = await execAsync(ffmpegCommand);
    
    if (stderr && !stderr.includes('time=')) {
      console.log('FFmpeg stderr output:', stderr);
    }
    
    // Check if output file exists and has content
    if (!fs.existsSync(mp3File)) {
      throw new Error('MP3 file was not created');
    }
    
    const stats = fs.statSync(mp3File);
    if (stats.size === 0) {
      throw new Error('MP3 file is empty');
    }
    
    return true;
  } catch (error) {
    // More specific error message
    if (error.stderr && error.stderr.includes('Invalid data found')) {
      throw new Error('Invalid audio format: corrupted header or incomplete file');
    }
    throw error;
  }
}

// Use curl to transcribe - more reliable than built-in HTTP clients for this case
async function transcribeWithCurl(filename) {
  const execAsync = promisify(exec);
  
  // Make sure input file exists
  if (!fs.existsSync(filename)) {
    throw new Error(`File ${filename} does not exist`);
  }
  
  // Get file size for logging
  const stats = fs.statSync(filename);
  console.log(`File size before transcription: ${stats.size} bytes`);
  
  // Escape quotes in the filename for shell safety
  const escapedFilename = filename.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  
  // Build curl command
  const curlCommand = `curl -s -X POST https://api.openai.com/v1/audio/transcriptions \\
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \\
    -H "Content-Type: multipart/form-data" \\
    -F file="@${escapedFilename}" \\
    -F model="whisper-1" \\
    -F response_format="json" \\
    -F language="en"`;
  
  try {
    console.log('Executing curl command...');
    const { stdout, stderr } = await execAsync(curlCommand);
    
    if (stderr) {
      console.error('Curl error:', stderr);
    }
    
    if (!stdout.trim()) {
      console.log('Empty response from OpenAI API');
      return '';
    }
    
    try {
      const response = JSON.parse(stdout);
      return response.text || '';
    } catch (parseError) {
      console.error('Error parsing JSON response:', parseError);
      console.log('Raw response:', stdout);
      throw new Error('Invalid JSON response from API');
    }
  } catch (error) {
    console.error('Curl execution error:', error);
    if (error.message.includes('413')) {
      throw new Error('File too large for API (413 Payload Too Large)');
    }
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Real-time transcription server running on http://localhost:${PORT}`);
  console.log(`OpenAI API key is configured`);
  console.log(`Note: This version is optimized for WAV audio format`);
  
  // Check if ffmpeg is available
  exec('ffmpeg -version', (error) => {
    if (error) {
      console.error('WARNING: ffmpeg is not installed or not in PATH');
      console.error('Audio conversion will not work, transcription may fail for non-WAV formats');
    } else {
      console.log('ffmpeg is available for audio conversion');
    }
  });
});

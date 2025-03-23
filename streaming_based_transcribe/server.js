// server.js - Using MP3 conversion for better Whisper API compatibility
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
        // Combine with previous audio if it exists
        let combinedBuffer;
        if (previousAudioBuffer) {
          console.log(`Combining with previous audio (${previousAudioBufferSize} bytes)`);
          combinedBuffer = Buffer.concat([previousAudioBuffer, currentBuffer]);
          console.log(`Combined audio size: ${combinedBuffer.length} bytes`);
        } else {
          combinedBuffer = currentBuffer;
        }
        
        // Save audio to file with timestamp to ensure uniqueness
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(2, 8);
        const webmFile = `audio_${timestamp}_${randomString}.webm`;
        const mp3File = `audio_${timestamp}_${randomString}.mp3`;
        
        console.log(`Saving audio to temporary file: ${webmFile}`);
        fs.writeFileSync(webmFile, combinedBuffer);
        
        // Check file exists and has content
        const stats = fs.statSync(webmFile);
        console.log(`Temporary WebM file size: ${stats.size} bytes`);
        
        // Convert WebM to MP3 using ffmpeg (this improves compatibility with Whisper)
        console.log('Converting WebM to MP3...');
        try {
          await convertToMp3(webmFile, mp3File);
          console.log('Conversion successful');
          
          // Check if MP3 file exists and has content
          if (fs.existsSync(mp3File)) {
            const mp3Stats = fs.statSync(mp3File);
            console.log(`MP3 file size: ${mp3Stats.size} bytes`);
            
            if (mp3Stats.size > 0) {
              // Transcribe using curl
              console.log('Sending MP3 to OpenAI API using curl...');
              const transcript = await transcribeWithCurl(mp3File);
              console.log(`Transcription result: "${transcript}"`);
              
              // Handle transcript results
              if (transcript && transcript.trim() !== '') {
                // If we got a valid transcript, clear the buffer
                previousAudioBuffer = null;
                previousAudioBufferSize = 0;
                consecutiveEmptyResponses = 0;
                
                // Send successful response
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  success: true, 
                  transcript: transcript
                }));
              } else {
                // No transcript received, store the current audio for next time
                consecutiveEmptyResponses++;
                console.log(`Empty response count: ${consecutiveEmptyResponses}`);
                
                if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
                  // Too many empty responses, reset the buffer
                  console.log(`Too many empty responses (${consecutiveEmptyResponses}), resetting buffer`);
                  previousAudioBuffer = null;
                  previousAudioBufferSize = 0;
                  consecutiveEmptyResponses = 0;
                } else if (combinedBuffer.length < MAX_BUFFER_SIZE) {
                  previousAudioBuffer = combinedBuffer;
                  previousAudioBufferSize = combinedBuffer.length;
                  console.log(`No transcript received, storing audio for next chunk (${previousAudioBufferSize} bytes)`);
                } else {
                  // Buffer too large, reset it
                  previousAudioBuffer = null;
                  previousAudioBufferSize = 0;
                  console.log('Buffer too large, resetting');
                }
                
                // Send empty response
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                  success: true, 
                  transcript: ''
                }));
              }
            } else {
              throw new Error('MP3 conversion resulted in empty file');
            }
          } else {
            throw new Error('MP3 file not created');
          }
        } catch (conversionError) {
          console.error('Conversion error:', conversionError);
          console.log('Trying WebM file directly...');
          
          // Transcribe WebM directly as fallback
          const transcript = await transcribeWithCurl(webmFile);
          console.log(`Transcription result from WebM: "${transcript}"`);
          
          if (transcript && transcript.trim() !== '') {
            // If we got a valid transcript, clear the buffer
            previousAudioBuffer = null;
            previousAudioBufferSize = 0;
            consecutiveEmptyResponses = 0;
            
            // Send successful response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              transcript: transcript
            }));
          } else {
            // Handle empty transcription like above
            consecutiveEmptyResponses++;
            console.log(`Empty response count: ${consecutiveEmptyResponses}`);
            
            if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
              previousAudioBuffer = null;
              previousAudioBufferSize = 0;
              consecutiveEmptyResponses = 0;
              console.log(`Too many empty responses (${consecutiveEmptyResponses}), resetting buffer`);
            } else if (combinedBuffer.length < MAX_BUFFER_SIZE) {
              previousAudioBuffer = combinedBuffer;
              previousAudioBufferSize = combinedBuffer.length;
              console.log(`No transcript received, storing audio for next chunk (${previousAudioBufferSize} bytes)`);
            } else {
              previousAudioBuffer = null;
              previousAudioBufferSize = 0;
              console.log('Buffer too large, resetting');
            }
            
            // Send empty response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              transcript: ''
            }));
          }
        }
        
        // Cleanup temporary files
        try {
          if (fs.existsSync(webmFile)) {
            fs.unlinkSync(webmFile);
            console.log(`Temporary file ${webmFile} deleted`);
          }
          if (fs.existsSync(mp3File)) {
            fs.unlinkSync(mp3File);
            console.log(`Temporary file ${mp3File} deleted`);
          }
        } catch (cleanupError) {
          console.error('Error deleting temporary files:', cleanupError);
        }
        
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

// Convert WebM to MP3 using ffmpeg
async function convertToMp3(webmFile, mp3File) {
  const execAsync = promisify(exec);
  
  // Make sure input file exists
  if (!fs.existsSync(webmFile)) {
    throw new Error(`WebM file ${webmFile} does not exist`);
  }
  
  // Create ffmpeg command with optimal settings for Whisper
  const ffmpegCommand = `ffmpeg -y -i "${webmFile}" -c:a libmp3lame -q:a 4 -ar 16000 -ac 1 "${mp3File}"`;
  
  // Execute command
  const { stdout, stderr } = await execAsync(ffmpegCommand);
  
  if (stderr && !stderr.includes('time=')) {
    console.error('FFmpeg error output:', stderr);
  }
  
  // Check if output file exists and has content
  if (!fs.existsSync(mp3File)) {
    throw new Error('MP3 file was not created');
  }
  
  return true;
}

// Use curl to transcribe - more reliable than built-in HTTP clients for this case
async function transcribeWithCurl(filename) {
  const execAsync = promisify(exec);
  
  // Make sure input file exists
  if (!fs.existsSync(filename)) {
    throw new Error(`File ${filename} does not exist`);
  }
  
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
      throw new Error('Empty response from API');
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
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Real-time transcription server running on http://localhost:${PORT}`);
  console.log(`OpenAI API key is configured`);
  console.log(`Note: This version requires ffmpeg to be installed for MP3 conversion`);
  // Check if ffmpeg is available
  exec('ffmpeg -version', (error) => {
    if (error) {
      console.error('WARNING: ffmpeg is not installed or not in PATH');
      console.error('MP3 conversion will not work, falling back to WebM (less reliable)');
    } else {
      console.log('ffmpeg is available for audio conversion');
    }
  });
});

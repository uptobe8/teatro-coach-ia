const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let currentScript = null;
let currentSession = {
  act: null,
  scene: null,
  characters: {},
  lines: [],
  currentLine: 0
};

// Subir y parsear PDF
app.post('/api/upload-script', upload.single('script'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó archivo' });
    }

    const pdfData = await pdfParse(req.file.buffer, {
      max: 0, // Process all pages
    });
    const text = pdfData.text

        
    // Log extracted text length for debugging
    console.log('PDF text length:', text.length, 'characters');
    // Parsear el guion
    const lines = text.split('\n').filter(line => line.trim());
    const characters = new Set();
    const parsedLines = [];

    lines.forEach(line => {
      const match = line.match(/^([A-ZÁÉÍÓÚÑ\s]+):\s*(.+)$/);
      if (match) {
        const character = match[1].trim();
        const dialogue = match[2].trim();
        characters.add(character);
        parsedLines.push({ character, dialogue, type: 'dialogue' });
      } else if (line.match(/^ACTO\s+\d+|^ESCENA\s+\d+/i)) {
        parsedLines.push({ type: 'header', text: line.trim() });
      } else if (line.trim()) {
        parsedLines.push({ type: 'stage_direction', text: line.trim() });
      }
    });

    currentScript = {
      title: req.file.originalname,
      characters: Array.from(characters),
      lines: parsedLines,
      totalLines: parsedLines.filter(l => l.type === 'dialogue').length
    };

    res.json({
      success: true,
      script: {
        title: currentScript.title,
        characters: currentScript.characters,
        totalLines: currentScript.totalLines
      }
    });
  } catch (error) {
    console.error('Error procesando PDF:', error);
    res.status(500).json({ error: 'Error procesando el archivo PDF' });
  }
});

// Obtener información del guion
app.get('/api/script-info', (req, res) => {
  if (!currentScript) {
    return res.status(404).json({ error: 'No hay guion cargado' });
  }
  
  res.json(currentScript);
});

// Configurar sesión de ensayo
app.post('/api/setup-rehearsal', (req, res) => {
  const { act, scene, characterVoices } = req.body;
  
  if (!currentScript) {
    return res.status(400).json({ error: 'No hay guion cargado' });
  }

  currentSession = {
    act,
    scene,
    characters: characterVoices || {},
    lines: currentScript.lines.filter(line => {
      // Filtrar por acto/escena si se especifica
      return line.type === 'dialogue';
    }),
    currentLine: 0
  };

  res.json({ success: true, session: currentSession });
});

// Generar audio de IA con OpenAI TTS
app.post('/api/generate-audio', async (req, res) => {
  try {
    const { text, character } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Texto requerido' });
    }

    // Seleccionar voz según personaje
    const voice = currentSession.characters[character] || 'alloy';

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice,
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length
    });
    res.send(buffer);
  } catch (error) {
    console.error('Error generando audio:', error);
    res.status(500).json({ error: 'Error generando audio' });
  }
});

// Transcribir audio del usuario con Whisper
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó audio' });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: req.file,
      model: 'whisper-1',
      language: 'es',
    });

    res.json({ text: transcription.text });
  } catch (error) {
    console.error('Error transcribiendo:', error);
    res.status(500).json({ error: 'Error transcribiendo audio' });
  }
});

// Analizar interpretación con GPT-4
app.post('/api/analyze-performance', async (req, res) => {
  try {
    const { userText, expectedText, character } = req.body;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{
        role: 'system',
        content: 'Eres un director de teatro experto. Analiza la interpretación del actor comparando lo que dijo con el texto original. Da feedback constructivo y específico sobre: exactitud del texto, entonación sugerida, y consejos de interpretación. Responde SOLO por voz, de forma conversacional y motivadora.'
      }, {
        role: 'user',
        content: `Texto esperado: "${expectedText}"\nTexto del actor: "${userText}"\nPersonaje: ${character}\n\nDa feedback conciso y útil.`
      }],
      temperature: 0.7,
      max_tokens: 200
    });

    const feedback = completion.choices[0].message.content;
    res.json({ feedback });
  } catch (error) {
    console.error('Error analizando:', error);
    res.status(500).json({ error: 'Error analizando interpretación' });
  }
});

// Obtener siguiente línea
app.get('/api/next-line', (req, res) => {
  if (!currentSession.lines || currentSession.currentLine >= currentSession.lines.length) {
    return res.json({ done: true });
  }

  const line = currentSession.lines[currentSession.currentLine];
  currentSession.currentLine++;

  res.json({ line, lineNumber: currentSession.currentLine });
});

// Export for Vercel serverless
module.exports = app;

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { GarminClient } from './client';
import { fetchGarminData, buildUserMessage, COACH_SYSTEM_PROMPT } from './coach/index';
import type { AthleteProfile, DailyCheckin } from './coach/index';

const PORT = parseInt(process.env.PORT ?? '3005');
const ANTHROPIC_API_KEY_ENV = process.env.ANTHROPIC_API_KEY ?? null;

const PROFILE_DIR = join(homedir(), '.garmin-mcp');
const PROFILE_PATH = join(PROFILE_DIR, 'athlete-profile.json');
const CREDS_PATH = join(PROFILE_DIR, 'credentials.json');
const __dir = dirname(fileURLToPath(import.meta.url));

type Credentials = { email: string; password: string; anthropicKey: string };

function ensureDir(): void {
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
}

function loadCredentials(): Credentials | null {
  try {
    if (process.env.GARMIN_EMAIL && process.env.GARMIN_PASSWORD) {
      return { email: process.env.GARMIN_EMAIL, password: process.env.GARMIN_PASSWORD };
    }
      if (existsSync(CREDS_PATH)) {
      const saved = JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as Credentials;
      if (ANTHROPIC_API_KEY_ENV) saved.anthropicKey = ANTHROPIC_API_KEY_ENV;
      return saved;
    }
  } catch {}
  return null;
}

function saveCredentials(creds: Credentials): void {
  ensureDir();
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
}

function loadProfile(): AthleteProfile | null {
  try {
    if (existsSync(PROFILE_PATH)) return JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as AthleteProfile;
  } catch {}
  return null;
}

function saveProfile(profile: AthleteProfile): void {
  ensureDir();
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

async function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const HTML = readFileSync(join(__dir, 'public/index.html'), 'utf-8');

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (method === 'GET' && url === '/api/credentials') {
    const creds = loadCredentials();
    const complete = creds !== null && !!creds.email && !!creds.password && !!creds.anthropicKey;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasCredentials: complete, email: creds?.email ?? null }));
    return;
  }

  if (method === 'POST' && url === '/api/credentials') {
    const { email, password, anthropicKey } = JSON.parse(await readBody(req)) as Credentials;
    saveCredentials({ email, password, anthropicKey });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'DELETE' && url === '/api/credentials') {
    try { writeFileSync(CREDS_PATH, JSON.stringify({})); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/api/profile') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadProfile()));
    return;
  }

  if (method === 'POST' && url === '/api/analyze') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (type: string, data: Record<string, unknown> = {}): void => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
      const creds = loadCredentials();
      if (!creds?.email || !creds?.password || !creds?.anthropicKey) {
        send('error', { message: 'Faltan credenciales. Ingresalas desde ⚙ Cuenta.' });
        res.end();
        return;
      }

      const body = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };
      const { profile, checkin } = body;
      saveProfile({ ...profile, savedAt: new Date().toISOString() });

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(creds.email, creds.password));
      send('status', { message: `✅ ${garminData.activities.length} actividades descargadas. Analizando con IA...` });

      const stream = new Anthropic({ apiKey: creds.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(profile, checkin, garminData) }],
      });

      stream.on('text', (text: string) => send('text', { content: text }));
      await stream.finalMessage();
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }

    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  🏃 Garmin Coach corriendo en http://localhost:${PORT}\n`);
});

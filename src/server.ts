import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { GarminClient } from './client';
import {
  fetchGarminData, buildUserMessage, buildReviewMessage, buildChatSystemPrompt,
  COACH_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT,
  generateHistoryContext, historyExists,
  loadPlan, savePlan, deletePlan, getPlanStatus,
} from './coach/index';
import type { AthleteProfile, DailyCheckin } from './coach/index';

const PORT = parseInt(process.env.PORT ?? '3005');
const ANTHROPIC_API_KEY_ENV = process.env.ANTHROPIC_API_KEY ?? null;

const PROFILE_DIR = process.env.PROFILE_DIR ?? join(homedir(), '.garmin-mcp');
const PROFILE_PATH = join(PROFILE_DIR, 'athlete-profile.json');
const CREDS_PATH = join(PROFILE_DIR, 'credentials.json');
const __dir = dirname(fileURLToPath(import.meta.url));

type Credentials = { email: string; password: string; anthropicKey: string };

function ensureDir(): void {
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
}

function loadCredentials(): Credentials | null {
  try {
    if (process.env.GARMIN_EMAIL && process.env.GARMIN_PASSWORD && ANTHROPIC_API_KEY_ENV) {
      return { email: process.env.GARMIN_EMAIL, password: process.env.GARMIN_PASSWORD, anthropicKey: ANTHROPIC_API_KEY_ENV };
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

  if (method === 'GET' && url === '/api/history-status') {
    const creds = loadCredentials();
    const exists = creds?.email ? historyExists(PROFILE_DIR, creds.email) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists }));
    return;
  }

  if (method === 'GET' && url === '/api/plan-status') {
    const creds = loadCredentials();
    const plan = creds?.email ? loadPlan(PROFILE_DIR, creds.email) : null;
    const today = new Date().toISOString().split('T')[0];
    const status = getPlanStatus(plan, today);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (method === 'DELETE' && url === '/api/plan') {
    const creds = loadCredentials();
    if (creds?.email) deletePlan(PROFILE_DIR, creds.email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/api/save-plan') {
    const creds = loadCredentials();
    if (!creds?.email) { res.writeHead(401); res.end(); return; }
    ensureDir();
    const planData = JSON.parse(await readBody(req)) as Record<string, unknown>;
    savePlan(PROFILE_DIR, creds.email, planData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/api/map-history') {
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
      if (!creds?.email || !creds?.password) { send('error', { message: 'Sin credenciales.' }); res.end(); return; }
      if (historyExists(PROFILE_DIR, creds.email)) { send('done', { existed: true }); res.end(); return; }

      await generateHistoryContext(
        new GarminClient(creds.email, creds.password),
        PROFILE_DIR,
        creds.email,
        (msg) => send('status', { message: msg }),
      );
      send('done', { existed: false });
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
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
        res.end(); return;
      }

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };
      saveProfile({ ...profile, savedAt: new Date().toISOString() });

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(creds.email, creds.password));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Generando plan...` });

      let historyContext: string | undefined;
      try {
        if (historyExists(PROFILE_DIR, creds.email)) {
          const { readFileSync: rfs } = await import('fs');
          const { historyFilePath } = await import('./coach/index');
          historyContext = rfs(historyFilePath(PROFILE_DIR, creds.email), 'utf-8');
        }
      } catch {}

      const systemPrompt = COACH_SYSTEM_PROMPT;
      const userMessage = buildUserMessage(profile, checkin, garminData, historyContext);

      const stream = new Anthropic({ apiKey: creds.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
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

  if (method === 'POST' && url === '/api/review') {
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
        send('error', { message: 'Faltan credenciales.' });
        res.end(); return;
      }

      const currentPlan = loadPlan(PROFILE_DIR, creds.email);
      if (!currentPlan) {
        send('error', { message: 'No hay plan activo. Generá uno con Analizar primero.' });
        res.end(); return;
      }

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(creds.email, creds.password));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Cruzando plan vs real...` });

      let historyContext: string | undefined;
      try {
        if (historyExists(PROFILE_DIR, creds.email)) {
          const { readFileSync: rfs } = await import('fs');
          const { historyFilePath } = await import('./coach/index');
          historyContext = rfs(historyFilePath(PROFILE_DIR, creds.email), 'utf-8');
        }
      } catch {}

      const stream = new Anthropic({ apiKey: creds.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildReviewMessage(profile, checkin, garminData, currentPlan, historyContext) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => {
        fullText += text;
        send('text', { content: text });
      });
      await stream.finalMessage();

      const re = /\[REVIEW_JSON\]([\s\S]*?)\[\/REVIEW_JSON\]/;
      const m = fullText.match(re);
      if (m) {
        let raw = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const start = raw.indexOf('{');
        if (start > 0) raw = raw.slice(start);
        try {
          const reviewJson = JSON.parse(raw) as Record<string, unknown>;
          savePlan(PROFILE_DIR, creds.email, reviewJson);
          send('plan_update', { plan: reviewJson });
        } catch {}
      }

      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'POST' && url === '/api/chat') {
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
        send('error', { message: 'Faltan credenciales.' });
        res.end(); return;
      }

      const { messages, profile, checkin } = JSON.parse(await readBody(req)) as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        profile: AthleteProfile;
        checkin: DailyCheckin;
      };

      const today = new Date().toISOString().split('T')[0];
      const currentPlan = loadPlan(PROFILE_DIR, creds.email);
      const systemPrompt = buildChatSystemPrompt(profile, checkin, currentPlan, today);

      const stream = new Anthropic({ apiKey: creds.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        messages,
      });

      let fullText = '';
      stream.on('text', (text: string) => {
        fullText += text;
        send('text', { content: text });
      });
      await stream.finalMessage();

      const re = /\[PLAN_JSON\]([\s\S]*?)\[\/PLAN_JSON\]/;
      const m = fullText.match(re);
      if (m) {
        let raw = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const start = raw.indexOf('{');
        if (start > 0) raw = raw.slice(start);
        try {
          const planJson = JSON.parse(raw) as Record<string, unknown>;
          savePlan(PROFILE_DIR, creds.email, planJson);
          send('plan_update', { plan: planJson });
        } catch {}
      }

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

import Anthropic from '@anthropic-ai/sdk';
import { GarminClient } from './client';
import { runQuestionnaire, fetchGarminData, buildUserMessage, COACH_SYSTEM_PROMPT } from './coach/index';

const GARMIN_EMAIL = process.env.GARMIN_EMAIL;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function main(): Promise<void> {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║            GARMIN COACH  —  IA Personal               ║');
  console.log('║   Running · Triatlón · Ciclismo · Natación · Fuerza   ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  if (!GARMIN_EMAIL || !GARMIN_PASSWORD) {
    console.error('\nError: GARMIN_EMAIL y GARMIN_PASSWORD son requeridos como variables de entorno.');
    console.error('Ejemplo: GARMIN_EMAIL=tu@email.com GARMIN_PASSWORD=tupass garmin-coach');
    process.exit(1);
  }

  if (!ANTHROPIC_API_KEY) {
    console.error('\nError: ANTHROPIC_API_KEY es requerida como variable de entorno.');
    process.exit(1);
  }

  const { profile, checkin } = await runQuestionnaire();

  console.log('\n  Conectando a Garmin Connect y descargando datos...');
  const garminClient = new GarminClient(GARMIN_EMAIL, GARMIN_PASSWORD);
  const garminData = await fetchGarminData(garminClient);

  if (garminData.errors.length > 0) {
    console.log(`\n  ⚠  ${garminData.errors.length} métricas no disponibles (detallado en el análisis)`);
  }

  const actCount = garminData.activities.length;
  const weekCount = garminData.weeklyVolumes.length;
  console.log(`  ✅ ${actCount} actividades / ${weekCount} semanas descargadas`);

  console.log('\n  Analizando con IA (Claude)...');
  console.log('\n' + '═'.repeat(60) + '\n');

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const userMessage = buildUserMessage(profile, checkin, garminData);

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: COACH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  stream.on('text', (text: string) => {
    process.stdout.write(text);
  });

  await stream.finalMessage();

  console.log('\n\n' + '═'.repeat(60));
  console.log('\n  ✅ Análisis completado.\n');
}

main().catch((error: unknown) => {
  console.error('\nError fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

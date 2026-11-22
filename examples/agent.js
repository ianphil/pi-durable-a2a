import { mkdir } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { A2AExtension, createA2AServer, openA2A } from 'pi-durable-a2a';

const { OPENAI_API_KEY, MODEL_ID, A2A_TOKEN } = process.env;
if (!OPENAI_API_KEY || !MODEL_ID || !A2A_TOKEN) {
  throw new Error('Set OPENAI_API_KEY, MODEL_ID and A2A_TOKEN before starting');
}

// The provider resolves its key from the environment, not the conversation.
const models = createModels();
models.setProvider(openaiProvider());
if (!models.getModel('openai', MODEL_ID)) throw new Error(`Unknown OpenAI model: ${MODEL_ID}`);

// Install the task definition before opening the persistent store.
process.umask(0o077);
await mkdir('./examples/.state', { recursive: true });
const registry = createRegistry();
registry.install(A2AExtension);
const harness = await Harness.open(
  await openNodeSqliteStorage('./examples/.state/agent.sqlite'),
  { models, registry },
  context,
);
const conversation = await harness.root(context);
await conversation.configure({
  model: { provider: 'openai', modelId: MODEL_ID },
  instructions: 'You are a friendly assistant. Reply briefly.',
}, context);

// A2A is the only input path into this conversation. There are no tools.
const a2a = await openA2A({ harness, conversation, card: {
  name: 'example-agent', description: 'A small persistent chat agent',
  url: 'http://127.0.0.1:8766/a2a', skills: [],
} });
harness.resume();
const server = createA2AServer(a2a, { token: A2A_TOKEN });
server.listen(8766, '127.0.0.1', () => console.log('A2A listening at http://127.0.0.1:8766/a2a'));

async function shutdown() {
  server.close();
  server.closeAllConnections();
  await a2a.close();
  await harness.close(context);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

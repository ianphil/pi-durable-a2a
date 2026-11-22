import { mkdir } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { A2AExtension, createA2AServer, openA2A } from 'pi-durable-a2a';

const { PI_PROVIDER, PI_MODEL, A2A_TOKEN } = process.env;
if (!PI_PROVIDER || !PI_MODEL || !A2A_TOKEN) {
  throw new Error('Set PI_PROVIDER, PI_MODEL and A2A_TOKEN before starting');
}
const port = Number(process.env.A2A_PORT ?? 8766);

// Use Pi's configured providers and credentials, not a separate model client.
const models = await ModelRuntime.create();
if (!models.getModel(PI_PROVIDER, PI_MODEL)) throw new Error(`Unknown Pi model: ${PI_PROVIDER}/${PI_MODEL}`);

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
  model: { provider: PI_PROVIDER, modelId: PI_MODEL },
  instructions: 'You are a friendly assistant. Reply briefly.',
}, context);

// A2A is the only input path into this conversation. There are no tools.
const a2a = await openA2A({ harness, conversation, card: {
  name: 'example-agent', description: 'A small persistent chat agent',
  url: `http://127.0.0.1:${port}/a2a`, skills: [],
} });
harness.resume();
const server = createA2AServer(a2a, { token: A2A_TOKEN });
server.listen(port, '127.0.0.1', () => console.log(`A2A listening at http://127.0.0.1:${port}/a2a`));

async function shutdown() {
  server.close();
  server.closeAllConnections();
  await a2a.close();
  await harness.close(context);
  await models.settleCredentialWrites();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

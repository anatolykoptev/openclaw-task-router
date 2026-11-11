// Preloaded into discover-cli.js: OpenRouter returns one model whose id is hostile.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: process.env.HOSTILE_MODEL_ID, pricing: { prompt: '0' }, context_length: 8000 }] }),
});

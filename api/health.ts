export default {
  async fetch() {
    try {
      await import('./_lib/auth');
      return new Response('loaded');
    } catch (error) {
      return new Response(error instanceof Error ? error.stack ?? error.message : String(error), { status: 500 });
    }
  },
};

export default {
  fetch() {
    return new Response('ok', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    });
  },
};

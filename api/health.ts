import { randomBytes } from 'node:crypto';

export default {
  fetch() {
    return new Response(String(randomBytes(1).length));
  },
};

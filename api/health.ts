import { jsonResponse } from '../src/server/auth';

export default {
  fetch() {
    return jsonResponse({ ok: true });
  },
};

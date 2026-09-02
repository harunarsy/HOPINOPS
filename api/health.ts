import { createClient } from '@supabase/supabase-js';

export default {
  fetch() {
    return new Response(typeof createClient);
  },
};

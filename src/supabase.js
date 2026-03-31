import { createClient } from '@supabase/supabase-js';

let supabase = null;

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getSupabaseClient() {
  if (supabase) {
    return supabase;
  }

  supabase = createClient(
    getRequiredEnv('SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  );

  return supabase;
}

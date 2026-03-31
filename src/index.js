// src/index.js
// Evolutionz HiKVision Bridge Service
// Runs on the gym laptop — listens for access control jobs from Supabase
// and executes them against the HiKVision device on the local network.

import 'dotenv/config';
import { processJob } from './jobs.js';
import { createSerialJobQueue } from './job-queue.js';
import { getSupabaseClient } from './supabase.js';

// ─── Supabase Setup ───────────────────────────────────────────────────────────

const supabase = getSupabaseClient();

// ─── Startup ─────────────────────────────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Evolutionz HiKVision Bridge — Starting up');
console.log(`  Device: http://${process.env.HIK_IP}:${process.env.HIK_PORT}`);
console.log(`  Supabase: ${process.env.SUPABASE_URL}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// ─── Process a single job ─────────────────────────────────────────────────────

async function handleJob(job) {
  // Mark job as processing
  await supabase
    .from('access_control_jobs')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', job.id);

  try {
    const { result } = await processJob(job);

    // Mark as done
    await supabase
      .from('access_control_jobs')
      .update({
        status: 'done',
        result,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(`[bridge] ✓ Job ${job.id} (${job.type}) completed`);
  } catch (err) {
    console.error(`[bridge] ✗ Job ${job.id} (${job.type}) failed:`, err.message);

    // Mark as failed with error message
    await supabase
      .from('access_control_jobs')
      .update({
        status: 'failed',
        error: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  }
}

const enqueueJob = createSerialJobQueue(handleJob);

// ─── Pick up any jobs that were pending before this service started ──────────

async function processPendingJobs() {
  const { data: pendingJobs, error } = await supabase
    .from('access_control_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[bridge] Error fetching pending jobs:', error.message);
    return;
  }

  if (pendingJobs.length > 0) {
    console.log(`[bridge] Found ${pendingJobs.length} pending job(s) to process on startup`);
    for (const job of pendingJobs) {
      await enqueueJob(job);
    }
  } else {
    console.log('[bridge] No pending jobs — ready and listening');
  }
}

// ─── Realtime Listener ────────────────────────────────────────────────────────

function startRealtimeListener() {
  supabase
    .channel('access_control_jobs')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'access_control_jobs',
        filter: 'status=eq.pending',
      },
      async (payload) => {
        const job = payload.new;
        console.log(`[bridge] New job received: type="${job.type}" id=${job.id}`);
        await enqueueJob(job);
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[bridge] Realtime subscription active — waiting for jobs...');
      } else {
        console.log(`[bridge] Realtime status: ${status}`);
      }
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

await processPendingJobs();
startRealtimeListener();

// Keep the process alive
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down gracefully...');
  process.exit(0);
});

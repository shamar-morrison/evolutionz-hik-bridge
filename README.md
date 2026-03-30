# Evolutionz HiKVision Bridge Service

Lightweight Node.js service that runs on the gym laptop and bridges the Evolutionz PWA (on Vercel) with the HiKVision access control device on the gym's local network.

## How it works

```
PWA (Vercel) ──writes job──→ Supabase (access_control_jobs table)
                                        │
                              Gym Laptop (this service)
                              listens via Supabase Realtime
                                        │
                              HiKVision DS-K1T804BMF
                              192.168.100.192 (local network)
```

1. The PWA inserts a job into `access_control_jobs` in Supabase
2. This service detects the new job via Supabase Realtime
3. It calls the appropriate ISAPI endpoint on the HiKVision device
4. It writes the result (or error) back to the job row in Supabase
5. The PWA can poll the job row to see if it completed

---

## Setup

### 1. Supabase — run the migration
In your Supabase project, open the SQL editor and run the contents of `supabase-migration.sql`.

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

```env
HIK_IP=192.168.100.192
HIK_PORT=80
HIK_USERNAME=Admin
HIK_PASSWORD=your_device_password
HIK_REMOTE_PASSWORD=123456
HIK_DEBUG_AVAILABLE_SLOTS=0
HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES=
HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS=
HIK_PLACEHOLDER_SLOT_PATTERN=^[A-Z]\d{1,2}$

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

`HIK_REMOTE_PASSWORD` must match the 6-digit remote door password configured on the device in iVMS-4200 / access control settings. The bridge needs that extra credential specifically for `unlock_door`.
Set `HIK_DEBUG_AVAILABLE_SLOTS=1` temporarily when you need extra `list_available_slots` diagnostics in the laptop logs. That debug mode keeps the job result shape unchanged, but logs bounded pretty-JSON reports for scanned users, scanned cards, and card-backed non-slots.
Use `HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES` and `HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS` when you need to force specific slot labels or card numbers into the debug output, for example `HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES=P55` and `HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS=0105451261`.
Reusable slots are exact labels only, such as `P4` or `P55`. Names like `P4 Ackeem Planter` or `P55 Jane Doe` are treated as occupied and stay unavailable even if their validity has expired.
If the gym laptop `.env` still pins `HIK_PLACEHOLDER_SLOT_PATTERN=^[A-Z]\d{2}$`, update it to `^[A-Z]\d{1,2}$` or remove the override so one-digit exact slot labels are not missed.
When both `HIK_DEBUG_AVAILABLE_SLOTS=1` and `HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS` are set, the bridge also logs focused bulk page traces, direct `CardNoList` card probes, direct `EmployeeNoList` user probes for any returned employee numbers, and a final bulk-vs-direct comparison report. For example, use `HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES=P55` and `HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS=0105451261` to compare what the laptop sees in bulk pagination against what the device returns for a direct probe of card `0105451261`.

### 4. Run the service
```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

The service must stay running on the gym laptop. Keep the terminal window open, or set it up as a Windows startup task (see below).

---

## Running automatically on Windows startup

So the bridge starts automatically whenever the gym laptop is turned on:

1. Press `Win + R`, type `shell:startup`, hit Enter
2. Create a new file called `hik-bridge.bat` in that folder with this content:
```bat
@echo off
cd /d C:\path\to\evolutionz-hik-bridge
node src/index.js
```
3. Replace `C:\path\to\evolutionz-hik-bridge` with the actual folder path
4. Save and restart the laptop to test

---

## From the PWA — how to trigger jobs

From your Next.js app, insert a row into `access_control_jobs`:

```ts
// Unlock the door (e.g. staff button in the PWA)
await supabase.from('access_control_jobs').insert({
  type: 'unlock_door',
  payload: { doorNo: 1 },
});

// Activate a member (add user + issue card)
await supabase.from('access_control_jobs').insert([
  {
    type: 'add_user',
    payload: {
      employeeNo: member.id,
      name: member.full_name,
      beginTime: subscription.start_date + 'T00:00:00',
      endTime: subscription.end_date + 'T23:59:59',
    },
  },
  {
    type: 'add_card',
    payload: {
      employeeNo: member.id,
      cardNo: member.card_number,
    },
  },
]);

// Suspend a member (revoke card access)
await supabase.from('access_control_jobs').insert({
  type: 'revoke_card',
  payload: {
    employeeNo: member.id,
    cardNo: member.card_number,
  },
});
```

---

## Job statuses

| Status       | Meaning                                      |
|-------------|----------------------------------------------|
| `pending`    | Waiting to be picked up by the bridge        |
| `processing` | Bridge is currently executing it             |
| `done`       | Completed successfully — see `result` column |
| `failed`     | Something went wrong — see `error` column    |

---

## Troubleshooting

**Bridge can't reach the device**
- Make sure the laptop is on the gym's network
- Try `http://192.168.100.192/ISAPI/AccessControl/capabilities` in a browser on the laptop

**Jobs stuck in `pending`**
- Check that the bridge service is running on the laptop
- Check that `SUPABASE_SERVICE_ROLE_KEY` is correct (not the anon key)

**Jobs failing with auth errors**
- Verify `HIK_USERNAME` and `HIK_PASSWORD` in `.env` match the device credentials

**`unlock_door` fails with 401**
- Verify `HIK_REMOTE_PASSWORD` is set in `.env`
- Verify the same 6-digit remote door password is configured on the device
- Test the unlock endpoint with `curl --digest` and a `RemoteControlDoor` XML body that includes `<remotePassword>`

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

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

`HIK_REMOTE_PASSWORD` must match the 6-digit remote door password configured on the device in iVMS-4200 / access control settings. The bridge needs that extra credential specifically for `unlock_door`.

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

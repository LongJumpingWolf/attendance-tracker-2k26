Scheduler script

How to run:

1. Generate VAPID keys (one-time):

```powershell
npx web-push generate-vapid-keys --json
```

2. Add the keys to your environment (in `.env.local` for Next.js):

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public>
VAPID_PRIVATE_KEY=<private>
VAPID_SUBJECT=mailto:you@example.com
```

3. Install dependencies (if not already):

```powershell
pnpm install
```

4. Run the scheduler (keeps running, checks every minute):

```powershell
node scripts/scheduler.js
```

Notes:
- For production, run `scripts/scheduler.js` as a cron job or background worker (PM2/systemd/container scheduler, or a serverless scheduled invocation).
- Subject reminders: create one-off entries with `type: 'subject'` and `notifyAt` (ISO string).
- Backup reminders: create entries with `type: 'backup'`.

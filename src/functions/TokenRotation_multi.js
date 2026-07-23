// ============================================================
// TokenRotation.js — Scheduled Plaid access-token rotation (MULTI-INSTITUTION)
// ============================================================
// WHAT IT DOES (each run):
//   1. Reads the institutions JSON list live from Key Vault (the SAME
//      "plaid-institutions" secret BankFeedSync uses).
//   2. For EACH institution, one at a time:
//        a. Calls Plaid /item/access_token/invalidate -> new token, old dies.
//        b. Updates that institution's entry in the array.
//        c. Writes the WHOLE updated array back to Key Vault immediately.
//   3. Emails a summary of every institution rotated.
//
//   BankFeedSync reads this same JSON live on every run, so it picks up
//   each rotated token automatically on its next execution.
//
// WHY WE PERSIST AFTER EVERY INSTITUTION (not once at the end):
//   All tokens live in ONE secret. The instant an invalidate call succeeds,
//   that institution's OLD token is dead. If we rotated several in memory and
//   only wrote once at the end, a failure partway through would leave the
//   already-invalidated institutions with dead tokens and no saved copy. By
//   writing the full array back after each successful rotation, every rotated
//   token is safely persisted before we invalidate the next one.
//
//   If a write ever fails, the old token for THAT institution is already dead,
//   so we log the full token and email it so it can be restored by hand.
//   Normal runs only log fingerprints (last 6 chars).
//
// PERMISSIONS: the Function App's managed identity needs BOTH Get and Set on
// Key Vault secrets.
// ============================================================

const { app } = require('@azure/functions');
const fetch = require('node-fetch');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { EmailClient } = require('@azure/communication-email');

// Plaid Client ID/Secret are read LIVE from Key Vault (secrets
// "plaid-test-clientid" / "plaid-test-secret"), matching what
// createLinkToken/savePlaidCredentials use -- NOT environment variables.
let _plaidClientId = null;
let _plaidSecret = null;
async function getPlaidCredentials() {
    if (_plaidClientId && _plaidSecret) {
        return { clientId: _plaidClientId, secret: _plaidSecret };
    }
    const secretClient = getSecretClient();
    const clientIdSecret = await secretClient.getSecret('plaid-test-clientid');
    const secretSecret = await secretClient.getSecret('plaid-test-secret');
    _plaidClientId = clientIdSecret.value;
    _plaidSecret = secretSecret.value;
    return { clientId: _plaidClientId, secret: _plaidSecret };
}
const PLAID_BASE_URL = process.env.PLAID_ENV === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';

const KEY_VAULT_URL       = process.env.KEY_VAULT_URL;
const INSTITUTIONS_SECRET = process.env.PLAID_INSTITUTIONS_SECRET || 'plaid-institutions';

// ---- Email settings (same ones BankFeedSync uses) ----
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const EMAIL_FROM            = process.env.ALERT_EMAIL_FROM;

// The alert recipient is read LIVE from Key Vault (secret "alert-email-to"),
// so it can be changed from the Plaid Setup page in Business Central without a
// redeployment. ALERT_EMAIL_TO (set by the deployment form) is the fallback for
// installs that have never synced an address.
//
// Cached for a few minutes rather than per-call: a changed address takes effect
// on the next run without hammering Key Vault, and without needing a restart.
const ALERT_EMAIL_SECRET = process.env.ALERT_EMAIL_SECRET_NAME || 'alert-email-to';
const EMAIL_TO_TTL_MS    = 5 * 60 * 1000;
let _emailTo        = null;
let _emailToChecked = 0;

async function getEmailTo(context) {
    if (_emailTo !== null && (Date.now() - _emailToChecked) < EMAIL_TO_TTL_MS) {
        return _emailTo;
    }
    let value = '';
    try {
        const secret = await getSecretClient().getSecret(ALERT_EMAIL_SECRET);
        value = (secret.value || '').trim();
    } catch (e) {
        context.log(`Could not read "${ALERT_EMAIL_SECRET}" from Key Vault (${e.message}). Falling back to the ALERT_EMAIL_TO app setting.`);
    }
    if (!value) {
        value = (process.env.ALERT_EMAIL_TO || '').trim();
    }
    _emailTo        = value;
    _emailToChecked = Date.now();
    return _emailTo;
}

const fp    = (t) => (t ? '...' + t.slice(-6) : 'none');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _secretClient = null;
function getSecretClient() {
    if (!_secretClient) {
        _secretClient = new SecretClient(KEY_VAULT_URL, new DefaultAzureCredential());
    }
    return _secretClient;
}

async function sendEmail(subject, message, context) {
    const emailTo = await getEmailTo(context);
    if (!ACS_CONNECTION_STRING || !EMAIL_FROM || !emailTo) {
        context.log('Email not configured — skipping notification.');
        return;
    }
    try {
        const client = new EmailClient(ACS_CONNECTION_STRING);
        const poller = await client.beginSend({
            senderAddress: EMAIL_FROM,
            recipients: { to: [{ address: emailTo }] },
            content: { subject, plainText: message }
        });
        await poller.pollUntilDone();
        context.log('Notification email sent.');
    } catch (e) {
        context.log('Could not send email: ' + e.message);
    }
}

async function plaidPost(path, extraBody, context) {
    const { clientId, secret } = await getPlaidCredentials();
    const body = { client_id: clientId, secret: secret, ...extraBody };
    const res  = await fetch(`${PLAID_BASE_URL}${path}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
        context.log(`Plaid ${path} failed: ${text}`);
        throw new Error(`Plaid ${path} error: ${text}`);
    }
    return JSON.parse(text);
}

// ============================================================
// THE DISASTER PATH, AND WHY NO TOKEN IS EVER LOGGED OR EMAILED
//
// /item/access_token/invalidate is irreversible. The instant it returns, the
// old token is dead and the new one exists only in this function's memory. If
// the Key Vault write then fails, that copy is lost when the function exits.
//
// The old code handled this by writing the full token to the logs AND emailing
// it. That put a live credential in two of the least protected places we have:
// App Insights (readable by anyone with resource-group Reader) and a mailbox
// (readable in transit, at rest, and in backups) -- both far weaker than the
// Key Vault we were using to protect it in the first place.
//
// We accept losing the token instead, because losing it is RECOVERABLE and
// leaking it is not. The Key Vault write is retried hard (5 attempts with
// backoff); if it still fails, the institution is simply reconnected through
// Plaid Link from Business Central ("Reconnect" on the Bank Connections page),
// which mints a fresh token. Cost: one re-authentication. No transactions are
// lost -- the cursor is untouched, so the next sync resumes exactly where it
// stopped.
//
// Logs and emails carry a FINGERPRINT (last 6 chars) only. Never the value.
// ============================================================

// Write the institutions array back to Key Vault, retrying a few times.
// Returns true on success, false if all attempts failed.
async function saveInstitutions(list, context) {
    const json = JSON.stringify(list, null, 2);
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await getSecretClient().setSecret(INSTITUTIONS_SECRET, json);
            context.log(`Institutions secret written on attempt ${attempt}.`);
            return true;
        } catch (e) {
            context.log(`Key Vault write attempt ${attempt} failed: ${e.message}`);
            await sleep(2000 * attempt);
        }
    }
    return false;
}

// ============================================================
// Rotate EVERY institution's token, persisting after each success.
// Returns a per-institution summary array for the email.
// ============================================================
async function rotateAllTokens(context) {
    const secretClient = getSecretClient();

    // Read the institutions list live.
    const secret = await secretClient.getSecret(INSTITUTIONS_SECRET);
    let list;
    try {
        list = JSON.parse(secret.value);
    } catch (e) {
        throw new Error(`The "${INSTITUTIONS_SECRET}" secret is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`The "${INSTITUTIONS_SECRET}" secret must be a non-empty JSON array.`);
    }

    const results = [];

    // Rotate one institution at a time, persisting the whole array after each.
    for (const inst of list) {
        if (!inst.name || !inst.accessToken) {
            results.push({ name: inst.name || '(unnamed)', status: 'SKIPPED', detail: 'missing name or accessToken' });
            continue;
        }

        context.log(`[${inst.name}] Current token fingerprint: ${fp(inst.accessToken)}`);

        // a. Rotate at Plaid. After this succeeds, the OLD token is DEAD.
        let newToken;
        try {
            const rotated = await plaidPost('/item/access_token/invalidate', { access_token: inst.accessToken }, context);
            newToken = rotated.new_access_token;
        } catch (e) {
            // Invalidate failed -> nothing changed for this institution. Record and continue.
            context.log(`[${inst.name}] Invalidate failed (token unchanged): ${e.message}`);
            results.push({ name: inst.name, status: 'FAILED', detail: 'invalidate failed: ' + e.message });
            continue;
        }

        context.log(`[${inst.name}] New token fingerprint: ${fp(newToken)} (old token now invalid)`);

        // b. Update this entry in the in-memory array.
        inst.accessToken = newToken;

        // c. Persist the WHOLE array now, before touching the next institution.
        const saved = await saveInstitutions(list, context);

        if (!saved) {
            // Disaster path: this institution's old token is dead and the new one
            // could not be written to Key Vault. The token is now unrecoverable --
            // deliberately. Reconnect through Plaid Link to mint a fresh one.
            context.log(`[${inst.name}] CRITICAL: could not save new token to Key Vault. Fingerprint: ${fp(newToken)}`);

            const err = new Error(`Rotation could not persist the new token for "${inst.name}".`);
            err.unsavedInstitution = inst.name;
            err.unsavedFingerprint = fp(newToken);
            // NOTE: deliberately NOT err.unsavedToken. No path exists to leak the
            // raw value into a log or an email.
            throw err;
        }

        results.push({ name: inst.name, status: 'ROTATED', newFp: fp(newToken) });
    }

    return results;
}

// ============================================================
// Runs the rotation AND sends exactly one summary email.
// ============================================================
async function runRotationWithNotifications(context) {
    try {
        const results = await rotateAllTokens(context);

        const lines = results.map(r => {
            if (r.status === 'ROTATED') return `  ${r.name}: rotated -> ${r.newFp}`;
            if (r.status === 'SKIPPED') return `  ${r.name}: skipped (${r.detail})`;
            return `  ${r.name}: FAILED (${r.detail})`;
        });

        const anyFailed  = results.some(r => r.status === 'FAILED');
        const anySkipped = results.some(r => r.status === 'SKIPPED');

        // A skipped bank is a malformed entry that will never rotate, so it needs
        // attention just like a failure. Only a fully clean run can be suppressed.
        if (!anyFailed && !anySkipped && !shouldEmailOnSuccess()) {
            context.log('Token rotation completed cleanly. Success email suppressed (NOTIFY_ON_TOKEN_ROTATION is off).');
            return results;
        }

        const subject = anyFailed
            ? 'Plaid token rotation completed WITH FAILURES'
            : anySkipped
                ? 'Plaid token rotation completed, some banks skipped'
                : 'Plaid token rotation OK';

        await sendEmail(subject, `Token rotation summary:\n\n${lines.join('\n')}`, context);
        return results;

    } catch (error) {
        if (error.unsavedFingerprint) {
            // Worst case: this institution's old token is dead and the new one was
            // not written to Key Vault. The token is gone. Recovery is a re-auth,
            // not a copy-paste -- which is exactly why it is safe not to keep it.
            await sendEmail(
                'CRITICAL: Plaid token rotation could not save a new token',
                `Institution "${error.unsavedInstitution}" was rotated, but its new token could NOT be ` +
                `written to Key Vault. Its bank feed is broken until it is reconnected.\n\n` +
                `New token fingerprint: ${error.unsavedFingerprint}\n\n` +
                `TO RECOVER:\n` +
                `  1. Open Business Central -> Plaid Setup -> View Bank Connections.\n` +
                `  2. Select "${error.unsavedInstitution}" and click Reconnect.\n` +
                `  3. Re-authenticate through Plaid Link. This mints a fresh token.\n` +
                `  4. Click "Save Institutions" to push it to Key Vault.\n\n` +
                `No transactions are lost -- the sync cursor was not advanced, so the next ` +
                `bank feed run resumes exactly where it stopped.\n\n` +
                `Error: ${error.message}`,
                context
            );
        } else {
            await sendEmail('Plaid token rotation FAILED', 'Rotation failed: ' + error.message, context);
        }
        throw error;
    }
}

// ============================================================
// SUCCESS-EMAIL SWITCH
// Driven by the NOTIFY_ON_TOKEN_ROTATION app setting, which the deployment sets
// from the "Email on every successful access token rotation?" toggle on the
// Alerts and retention tab.
//
// Defaults to OFF, matching the toggle and the other notify-on-success settings.
// Only an explicit true-like value turns it on, and the check is case-insensitive
// because ARM's string() on a boolean can emit "True" with a capital T.
//
// This suppresses ONLY the all-clear summary. Rotations that fail or skip a bank,
// and the critical could-not-save path, are ALWAYS emailed regardless.
// ============================================================
function shouldEmailOnSuccess() {
    const raw = (process.env.NOTIFY_ON_TOKEN_ROTATION ?? 'false').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

// ============================================================
// PRODUCTION TRIGGER: timer.
// Default: 3am on the 1st of each month (Eastern, per WEBSITE_TIME_ZONE).
// Override with TOKEN_ROTATION_SCHEDULE. 6-field CRON: {sec} {min} {hour} {day} {month} {dow}.
// ============================================================
app.timer('TokenRotationMulti', {
    schedule: process.env.TOKEN_ROTATION_SCHEDULE || '0 0 3 1 * *',
    handler: async (myTimer, context) => {
        context.log('Scheduled multi-institution token rotation started (timer: TokenRotationMulti).');
        await runRotationWithNotifications(context);
    }
});

// ============================================================
// DEVELOPER TEST-RUN: HTTP-triggered entry point, calls the exact same
// shared logic as the timer above.
//
// authLevel is 'function': this endpoint triggers a REAL, IRREVERSIBLE token
// rotation against live Plaid institutions. Anonymous, it let anyone with the
// URL break every bank feed in the tenant.
//
// BC already sends the key for this call (PlaidDeveloperTestRunPage reads
// 'TokenRotationRunKey' from Function App Config), so nothing on the BC side
// needs to change -- the key simply starts being enforced. Paste this
// function's key into Plaid Setup -> Function App Config.
// ============================================================
app.http('TokenRotationManualRun', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const results = await runRotationWithNotifications(context);
            return { status: 200, jsonBody: { success: true, results } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { success: false, error: err.message } };
        }
    }
});

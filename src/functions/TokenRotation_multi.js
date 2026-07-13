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

const PLAID_CLIENT_ID = process.env.PLAID_TEST_CLIENTID;
const PLAID_SECRET    = process.env.PLAID_TEST_SECRET;
const PLAID_BASE_URL = process.env.PLAID_ENV === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';

const KEY_VAULT_URL       = process.env.KEY_VAULT_URL;
const INSTITUTIONS_SECRET = process.env.PLAID_INSTITUTIONS_SECRET || 'plaid-institutions';

// ---- Email settings (same ones BankFeedSync uses) ----
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const EMAIL_FROM            = process.env.ALERT_EMAIL_FROM;
const EMAIL_TO              = process.env.ALERT_EMAIL_TO;

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
    if (!ACS_CONNECTION_STRING || !EMAIL_FROM || !EMAIL_TO) {
        context.log('Email not configured — skipping notification.');
        return;
    }
    try {
        const client = new EmailClient(ACS_CONNECTION_STRING);
        const poller = await client.beginSend({
            senderAddress: EMAIL_FROM,
            recipients: { to: [{ address: EMAIL_TO }] },
            content: { subject, plainText: message }
        });
        await poller.pollUntilDone();
        context.log('Notification email sent.');
    } catch (e) {
        context.log('Could not send email: ' + e.message);
    }
}

async function plaidPost(path, extraBody, context) {
    const body = { client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...extraBody };
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
            // is not saved. Surface the full token so it can be restored by hand.
            context.log(`[${inst.name}] CRITICAL: could not save new token.`);
            context.log(`CRITICAL_NEW_TOKEN[${inst.name}]=` + newToken);
            const err = new Error(`Rotation could not persist the new token for "${inst.name}".`);
            err.unsavedInstitution = inst.name;
            err.unsavedToken = newToken;
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

        const anyFailed = results.some(r => r.status === 'FAILED');
        const subject = anyFailed
            ? 'Plaid token rotation completed WITH FAILURES'
            : 'Plaid token rotation OK';

        await sendEmail(subject, `Token rotation summary:\n\n${lines.join('\n')}`, context);
        return results;

    } catch (error) {
        if (error.unsavedToken) {
            // Worst case: one institution's old token is dead and the new one wasn't saved.
            await sendEmail(
                'CRITICAL: Plaid token rotation could not save a new token',
                `Institution "${error.unsavedInstitution}" was rotated but its new token could NOT be ` +
                `written to Key Vault. Its bank feed is broken until you restore it.\n\n` +
                `Update the "${INSTITUTIONS_SECRET}" secret so this institution's accessToken is:\n\n` +
                `${error.unsavedToken}\n\nError: ${error.message}`,
                context
            );
        } else {
            await sendEmail('Plaid token rotation FAILED', 'Rotation failed: ' + error.message, context);
        }
        throw error;
    }
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
// shared logic as the timer above. Anonymous auth for now, per explicit
// request for simplicity -- this means ANYONE with the URL can trigger
// a real token rotation against your live Plaid institutions. Worth
// locking down (authLevel: 'function', or better, requiring the same
// BC-side auth as everything else) before this app is exposed beyond
// your own testing.
// ============================================================
app.http('TokenRotationManualRun', {
    methods: ['POST'],
    authLevel: 'anonymous',
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

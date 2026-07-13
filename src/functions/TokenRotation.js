// ============================================================
// TokenRotation.js — Scheduled Plaid access-token rotation
// ============================================================
// WHAT IT DOES (each run):
//   1. Reads the current access token live from Key Vault.
//   2. Calls Plaid /item/access_token/invalidate -> gets a NEW token, kills the old one.
//   3. Writes the new token back to Key Vault as a new version (with retries).
//   4. Reads it back to confirm the new version is live.
//   BankFeedSync already reads the token live from Key Vault on every run, so it
//   picks up the rotated token automatically on its next execution.
//
// THE ONE DANGER we design around: the instant step 2 succeeds, the OLD token is dead
// and the NEW token is the only working one. If we then failed to save it, the whole
// pipeline would be broken with no way back except manual Link re-auth. So the save is
// retried, and if it still fails we log the full token AND email it so it can be
// restored by hand. Normal runs only ever log fingerprints (last 6 chars).
//
// PERMISSIONS: the Function App's managed identity needs BOTH Get and Set on Key Vault
// secrets. BankFeedSync already gave you Get; this function adds the need for Set.
// ============================================================

const { app } = require('@azure/functions');
const fetch = require('node-fetch');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { EmailClient } = require('@azure/communication-email');

const PLAID_CLIENT_ID = process.env.PLAID_TEST_CLIENTID;
const PLAID_SECRET    = process.env.PLAID_TEST_SECRET;
const PLAID_BASE_URL  = 'https://sandbox.plaid.com'; // Change to production.plaid.com for live

const KEY_VAULT_URL = process.env.KEY_VAULT_URL;
const SECRET_NAME   = process.env.PLAID_ACCESS_TOKEN_SECRET_NAME || 'plaid-test-access-token';

// ---- Email settings (same ones BankFeedSync uses) ----
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const EMAIL_FROM            = process.env.ALERT_EMAIL_FROM;
const EMAIL_TO              = process.env.ALERT_EMAIL_TO;

const fp    = (t) => (t ? '...' + t.slice(-6) : 'none');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One reusable Key Vault client. The client is cheap; the get/set CALLS below go out
// to Key Vault live each time.
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

// ============================================================
// The rotation itself. Shared by the timer and the manual HTTP hook.
// ============================================================
async function rotateAccessToken(context) {
    const secretClient = getSecretClient();

    // 1) Read the current (live) token.
    const current  = await secretClient.getSecret(SECRET_NAME);
    const oldToken = current.value;
    context.log(`Current token fingerprint: ${fp(oldToken)}`);

    // 2) Rotate. After this line the OLD token is DEAD.
    const rotated  = await plaidPost('/item/access_token/invalidate', { access_token: oldToken }, context);
    const newToken = rotated.new_access_token;
    context.log(`New token fingerprint:     ${fp(newToken)}  (old token is now invalid)`);

    // 3) Save the new token — this is the must-not-fail step. Retry a few times.
    let written = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await secretClient.setSecret(SECRET_NAME, newToken);
            written = true;
            context.log(`New token written to Key Vault on attempt ${attempt}.`);
            break;
        } catch (e) {
            lastErr = e;
            context.log(`Key Vault write attempt ${attempt} failed: ${e.message}`);
            await sleep(2000 * attempt);
        }
    }

    // 3b) Disaster path: old token dead, new token not saved. Do NOT lose the new token.
    if (!written) {
        context.log('CRITICAL: new token could not be saved. FULL TOKEN follows so it can be restored by hand:');
        context.log('CRITICAL_NEW_TOKEN=' + newToken);
        // Attach the unsaved token to the error so the notifier can email it. This is the
        // one case where the email must carry the actual token (it's the only copy left).
        const err = new Error('Rotation could not persist the new token: ' + (lastErr && lastErr.message));
        err.unsavedToken = newToken;
        throw err;
    }

    // 4) Read back to confirm the new version is actually live in Key Vault.
    const verify   = await secretClient.getSecret(SECRET_NAME);
    const verified = verify.value === newToken;
    context.log(`Read-back verification: ${verified ? 'OK — new version is live' : 'MISMATCH — investigate'}`);

    return { oldFingerprint: fp(oldToken), newFingerprint: fp(newToken), verified };
}

// ============================================================
// Runs the rotation AND sends exactly one email describing the outcome.
// Both the timer and the manual HTTP hook call this, so they notify identically.
// ============================================================
async function runRotationWithNotifications(context) {
    try {
        const r = await rotateAccessToken(context);
        await sendEmail(
            'Plaid token rotated OK',
            `Access token rotated successfully.\nOld: ${r.oldFingerprint}\nNew: ${r.newFingerprint}\n` +
            `Verified in Key Vault: ${r.verified}`,
            context
        );
        return r;
    } catch (error) {
        if (error.unsavedToken) {
            // Worst case: old token dead, new one not saved. Email the token so it can be restored.
            await sendEmail(
                'CRITICAL: Plaid token rotation could not save the new token',
                `The old token was invalidated but the new token could NOT be written to Key Vault.\n` +
                `The bank feed is broken until you restore it. Set the secret "${SECRET_NAME}" to this value now:\n\n` +
                `${error.unsavedToken}\n\nError: ${error.message}`,
                context
            );
        } else {
            // Any other failure (e.g. the invalidate call failed, so nothing was changed).
            await sendEmail('Plaid token rotation FAILED', 'Rotation failed: ' + error.message, context);
        }
        throw error;
    }
}

// ============================================================
// PRODUCTION TRIGGER: timer.
// Default: 3am on the 1st of each month (Eastern, per WEBSITE_TIME_ZONE).
// Rotation frequency is a security-policy choice — override with TOKEN_ROTATION_SCHEDULE.
// Format is 6-field CRON: {sec} {min} {hour} {day} {month} {day-of-week}.
// ============================================================
app.timer('TokenRotation', {
    schedule: process.env.TOKEN_ROTATION_SCHEDULE || '0 0 3 1 * *',
    handler: async (myTimer, context) => {
        context.log('Scheduled token rotation started.');
        await runRotationWithNotifications(context); // emails the outcome; rethrows on failure
    }
});

// Public HTTP endpoint. Plaid calls this the INSTANT an item's status
// changes (e.g. ITEM_LOGIN_REQUIRED) -- this is what makes detection
// real-time instead of waiting for the next scheduled sync.
//
// IMPORTANT: this writes to its OWN secret ("plaid-institution-status"),
// NOT the "plaid-institutions" secret. BC treats plaid-institutions as
// fully overwritten on every sync -- if status lived there too, the next
// "Sync Institutions to Backend" click would silently wipe out whatever
// this webhook just wrote. Keeping status separate avoids that clobber
// entirely; BC never overwrites this secret, only reads it.
const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { EmailClient } = require('@azure/communication-email');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

const STATUS_SECRET = 'plaid-institution-status';

const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const EMAIL_FROM = process.env.ALERT_EMAIL_FROM;
const EMAIL_TO = process.env.ALERT_EMAIL_TO;

async function sendEmail(subject, message, context) {
    if (!ACS_CONNECTION_STRING || !EMAIL_FROM || !EMAIL_TO) {
        context.log('Email not configured -- skipping notification.');
        return;
    }
    try {
        const client = new EmailClient(ACS_CONNECTION_STRING);
        const poller = await client.beginSend({
            senderAddress: EMAIL_FROM,
            recipients: { to: [{ address: EMAIL_TO }] },
            content: { subject, plainText: message },
        });
        await poller.pollUntilDone();
    } catch (e) {
        context.log('Could not send email: ' + e.message);
    }
}

async function getStatusMap() {
    try {
        const secret = await secretClient.getSecret(STATUS_SECRET);
        return JSON.parse(secret.value);
    } catch (e) {
        // Secret doesn't exist yet on first-ever webhook call.
        return {};
    }
}

async function saveStatusMap(map) {
    await secretClient.setSecret(STATUS_SECRET, JSON.stringify(map));
}

app.http('itemErrorWebhook', {
    methods: ['POST'],
    authLevel: 'anonymous', // Plaid calls this directly -- it can't send a function key.
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { webhook_type, webhook_code, item_id, error } = body || {};

            context.log(`Webhook received: type=${webhook_type} code=${webhook_code} item=${item_id}`);

            // Only ITEM/ERROR webhooks matter for reconnection status.
            // Other webhook types (TRANSACTIONS, etc.) are ignored here.
            if (webhook_type !== 'ITEM' || webhook_code !== 'ERROR' || !item_id) {
                return { status: 200, jsonBody: { received: true, handled: false } };
            }

            const statusMap = await getStatusMap();
            statusMap[item_id] = {
                status: error && error.error_code === 'ITEM_LOGIN_REQUIRED' ? 'NEEDS_RECONNECT' : 'ERROR',
                errorCode: error ? error.error_code : 'UNKNOWN',
                errorMessage: error ? error.error_message : '',
                lastUpdated: new Date().toISOString(),
            };
            await saveStatusMap(statusMap);

            // Real-time alert -- this is the point of the webhook over a
            // pull-based check: the email goes out the moment Plaid
            // detects the break, not at the next scheduled sync.
            await sendEmail(
                `Bank connection needs attention: ${error ? error.error_code : 'unknown error'}`,
                `A bank connection reported an error and may need to be reconnected.\n\n` +
                `Item ID: ${item_id}\n` +
                `Error: ${error ? error.error_code : 'unknown'}\n\n` +
                `Open Business Central's Plaid Bank Connections page and use ` +
                `"Check Status" to see which institution this affects, then ` +
                `use "Reconnect" to repair it.`,
                context
            );

            return { status: 200, jsonBody: { received: true, handled: true } };
        } catch (err) {
            context.error(err);
            // Still return 200 -- Plaid retries on non-2xx, and a webhook
            // processing bug on our side shouldn't cause Plaid to hammer
            // this endpoint with retries.
            return { status: 200, jsonBody: { received: true, handled: false, error: err.message } };
        }
    },
});

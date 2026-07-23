const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

// Name of the alert-recipient secret. Must match what BankFeedSync and
// TokenRotation read, so both sides take it from the same app setting.
const ALERT_EMAIL_SECRET = process.env.ALERT_EMAIL_SECRET_NAME || 'alert-email-to';

// Renamed from savePlaidCredentials -> saveKeyVaultCredentials.
// Writes the Plaid Client ID / Secret to Key Vault, plus the alert email
// address when Business Central sends one.
//
// WHY THE EMAIL LIVES HERE AND NOT IN AN APP SETTING:
//   It used to be the ALERT_EMAIL_TO app setting, filled in on the deployment
//   form. That meant changing the address needed a redeployment, and a redeploy
//   of the template would overwrite whatever was set. As a Key Vault secret it
//   can be changed any time from the Plaid Setup page, the functions pick it up
//   on their next run, and no restart or redeployment is involved.
app.http('saveKeyVaultCredentials', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { clientId, secret, alertEmailTo } = body || {};

            if (!clientId || !secret) {
                return { status: 400, jsonBody: { error: 'clientId and secret are both required' } };
            }

            await secretClient.setSecret('plaid-test-clientid', clientId);
            await secretClient.setSecret('plaid-test-secret', secret);

            // Optional. Absent or blank leaves any address already in Key Vault
            // untouched, so clearing the field in Business Central cannot
            // silently switch every alert off.
            const email = typeof alertEmailTo === 'string' ? alertEmailTo.trim() : '';
            let alertEmailSaved = false;
            if (email) {
                await secretClient.setSecret(ALERT_EMAIL_SECRET, email);
                alertEmailSaved = true;
                // Deliberately not logged: the address identifies a person or
                // mailbox, and App Insights is readable by anyone with Reader.
                context.log('Alert email address updated in Key Vault.');
            }

            return { status: 200, jsonBody: { success: true, alertEmailSaved } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to save credentials to Key Vault' } };
        }
    },
});

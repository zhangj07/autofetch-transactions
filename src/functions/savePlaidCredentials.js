const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

app.http('savePlaidCredentials', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const { clientId, secret } = body || {};

            if (!clientId || !secret) {
                return { status: 400, jsonBody: { error: 'clientId and secret are both required' } };
            }

            await secretClient.setSecret('plaid-test-clientid', clientId);
            await secretClient.setSecret('plaid-test-secret', secret);

            return { status: 200, jsonBody: { success: true } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to save credentials to Key Vault' } };
        }
    },
});

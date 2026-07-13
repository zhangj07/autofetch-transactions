// Called by BC's "Check Status" action. Reads the status map the webhook
// writes to -- read-only from BC's perspective, never overwritten by BC.
const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

const STATUS_SECRET = 'plaid-institution-status';

app.http('getInstitutionStatus', {
    methods: ['GET'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            let statusMap = {};
            try {
                const secret = await secretClient.getSecret(STATUS_SECRET);
                statusMap = JSON.parse(secret.value);
            } catch (e) {
                // No status secret yet -- nothing has ever errored. Not a failure.
                statusMap = {};
            }

            return {
                status: 200,
                jsonBody: {
                    statuses: statusMap,
                    environment: process.env.PLAID_ENV || 'sandbox',
                },
            };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to read institution status' } };
        }
    },
});

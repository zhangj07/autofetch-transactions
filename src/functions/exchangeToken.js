const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { PlaidApi, PlaidEnvironments } = require('plaid');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

async function getPlaidClient() {
    const clientIdSecret = await secretClient.getSecret('plaid-test-clientid');
    const secretSecret = await secretClient.getSecret('plaid-test-secret');

    return new PlaidApi({
        basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
        baseOptions: {
            headers: {
                'PLAID-CLIENT-ID': clientIdSecret.value,
                'PLAID-SECRET': secretSecret.value,
            },
        },
    });
}

app.http('exchangeToken', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const public_token = body?.public_token;

            if (!public_token) {
                return { status: 400, jsonBody: { error: 'Missing public_token' } };
            }

            const plaidClient = await getPlaidClient();
            const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token });

            return {
                status: 200,
                jsonBody: {
                    access_token: exchangeResponse.data.access_token,
                    item_id: exchangeResponse.data.item_id,
                },
            };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to exchange public token' } };
        }
    },
});

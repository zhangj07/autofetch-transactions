const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

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

app.http('createLinkToken', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const client_user_id = body?.user?.client_user_id;
            // Optional: when reconnecting an existing institution, BC
            // passes the existing access_token so Plaid repairs THIS item
            // instead of creating a new one (Plaid Link "update mode").
            const access_token = body?.access_token;

            if (!client_user_id) {
                return { status: 400, jsonBody: { error: 'Missing user.client_user_id' } };
            }

            const plaidClient = await getPlaidClient();

            const requestBody = {
                user: { client_user_id },
                client_name: 'Alphavima Technologies',
                products: [Products.Transactions],
                country_codes: [CountryCode.Us, CountryCode.Ca],
                language: 'en',
                // Registers the webhook so Plaid calls itemErrorWebhook
                // whenever THIS item's status changes (e.g. breaks).
                webhook: process.env.PLAID_WEBHOOK_URL,
            };

            if (access_token) {
                // Update mode: repair the existing item, don't create a new one.
                requestBody.access_token = access_token;
            }

            const response = await plaidClient.linkTokenCreate(requestBody);

            return { status: 200, jsonBody: { link_token: response.data.link_token } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to create link token' } };
        }
    },
});

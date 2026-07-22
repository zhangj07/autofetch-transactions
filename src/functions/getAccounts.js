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

app.http('getAccounts', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const access_token = body?.access_token;

            if (!access_token) {
                return { status: 400, jsonBody: { error: 'Missing access_token' } };
            }

            const plaidClient = await getPlaidClient();

            // /accounts/get returns exactly the accounts currently shared on
            // the item, so this reflects adds/removes made via update mode.
            const response = await plaidClient.accountsGet({ access_token });

            const accounts = (response.data.accounts || []).map((a) => ({
                name: a.name,
                mask: a.mask,
                subtype: a.subtype,
                account_id: a.account_id,
            }));

            return { status: 200, jsonBody: { accounts } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to get accounts' } };
        }
    },
});

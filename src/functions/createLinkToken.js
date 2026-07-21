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
            // Optional: Add / Manage Accounts sets this so update mode
            // re-shows Plaid's account picker, letting the user add or
            // remove which accounts the item shares. Only meaningful
            // alongside an access_token (i.e. in update mode).
            const account_selection_enabled = body?.account_selection_enabled === true;
            // Optional: names a Plaid Dashboard Link customization. This is
            // how the Account Select "view behavior" (e.g. previously-shared
            // accounts pre-checked) is applied to the update-mode pane.
            const link_customization_name = body?.link_customization_name;

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
                // Update mode: repair/modify the existing item, don't create a new one.
                requestBody.access_token = access_token;
                if (account_selection_enabled) {
                    // Re-show the account selection pane so the user can add or
                    // remove which accounts this item shares. Only valid in
                    // update mode, so it lives inside the access_token branch.
                    requestBody.update = { account_selection_enabled: true };
                }
            }

            if (link_customization_name) {
                // Selects the Dashboard customization whose Account Select
                // view behavior governs pre-selection in the picker.
                requestBody.link_customization_name = link_customization_name;
            }

            const response = await plaidClient.linkTokenCreate(requestBody);

            return { status: 200, jsonBody: { link_token: response.data.link_token } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to create link token' } };
        }
    },
});

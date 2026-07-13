const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

app.http('updateInstitutions', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const institutions = body?.institutions;

            if (!Array.isArray(institutions)) {
                return { status: 400, jsonBody: { error: '"institutions" must be an array' } };
            }

            const isValid = institutions.every(
                (inst) => typeof inst.name === 'string' && inst.name.length > 0
                    && typeof inst.accessToken === 'string' && inst.accessToken.length > 0
            );

            if (!isValid) {
                return {
                    status: 400,
                    jsonBody: { error: 'Every institution needs a non-empty "name" and "accessToken"' },
                };
            }

            await secretClient.setSecret('plaid-institutions', JSON.stringify(institutions));

            return { status: 200, jsonBody: { success: true, count: institutions.length } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to update plaid-institutions in Key Vault' } };
        }
    },
});

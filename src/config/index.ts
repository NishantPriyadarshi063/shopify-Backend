import dotenv from 'dotenv';

dotenv.config();

const required = (key: string): string => {
  const v = process.env[key];
  if (v == null || v === '') throw new Error(`Missing env: ${key}`);
  return v;
};

const optional = (key: string, def: string): string => process.env[key] ?? def;

export const config = {
  port: parseInt(optional('PORT', '5300'), 10),

  db: {
    host: required('DB_HOST'),
    port: parseInt(required('DB_PORT'), 10),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    schema: required('DB_SCHEMA'),
    ssl: optional('DB_SSL', 'true').toLowerCase() === 'true' || optional('DB_SSL', 'true') === '1',
    rejectUnauthorized: optional('DB_SSL_REJECT_UNAUTHORIZED', 'false').toLowerCase() === 'true',
  },

  azure: {
    storageAccountName: required('AZURE_STORAGE_ACCOUNT_NAME'),
    storageAccountKey: required('AZURE_STORAGE_ACCOUNT_KEY'),
    containerName: required('AZURE_STORAGE_CONTAINER'),
    sasTtlMinutes: parseInt(optional('AZURE_SAS_TTL_MINUTES', '60'), 10),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '7d'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '30d'),
  },

  shopify: {
    // Example: "tiltingheads.myshopify.com"
    shopDomain: required('TH_SHOPIFY_SHOP_DOMAIN'),
    apiVersion: optional('TH_SHOPIFY_API_VERSION', '2023-01'),
    // Private app / custom app Admin API access token
    accessToken: required('TH_SHOPIFY_PASSWORD'),
  },
} as const;

export const DB_SCHEMA = config.db.schema;

/**
 * Seed first admin user. Run: npx ts-node scripts/seed-admin.ts
 * Or set env ADMIN_EMAIL and ADMIN_PASSWORD and run.
 */
import dotenv from 'dotenv';
dotenv.config();

import { createAdminUser } from '../src/repositories/auth';

const email = process.env.ADMIN_EMAIL || 'admin@tiltingheads.com';
const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const name = process.env.ADMIN_NAME || 'Admin';

async function main() {
  try {
    const user = await createAdminUser({ email, password, name });
    console.log('Admin user created:', user.id, user.email);
    console.log('Login with the email and password you set.');
  } catch (e: any) {
    if (e.code === '23505') {
      console.log('Admin with this email already exists.');
    } else {
      throw e;
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

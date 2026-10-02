// Operator commands, run inside the container. See add_user.sh, the friendly wrapper.
//
//   node server/cli.js add-user <email> [--reset]
//   node server/cli.js list-users

import { openDb } from './db.js';
import { isEmail } from './auth.js';

const usage = `Usage:
  add_user.sh <email>            register an email and print its invite link
  add_user.sh <email> --reset    issue a fresh link for an existing email (signs them out)
  add_user.sh --list             list the registered emails
`;

const args = process.argv.slice(2);
const cmd = args[0] === 'list-users' || args.includes('--list') ? 'list' : args[0];
const flags = new Set(args.filter((a) => a.startsWith('--')));
const rest = args.slice(1).filter((a) => !a.startsWith('--'));

const db = openDb();
const baseUrl = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const hours = Number(process.env.INVITE_HOURS) || 72;

if (cmd === 'list') {
  const rows = db.db.prepare('SELECT email, password_hash, created_at FROM users ORDER BY created_at').all();
  if (!rows.length) console.log('No users yet.');
  for (const r of rows) console.log(`${r.email}\t${r.password_hash ? 'active' : 'invited'}\t${r.created_at}`);
  process.exit(0);
}

if (cmd !== 'add-user' || !rest.length) {
  console.error(usage);
  process.exit(2);
}

const email = rest[0].trim();
if (!isEmail(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(2);
}

let user = db.userByEmail(email);
if (user && !flags.has('--reset')) {
  if (user.password_hash) {
    console.error(`${email} already has an account. Use --reset to send a new link.`);
    process.exit(1);
  }
  console.log(`${email} was already invited; here is a fresh link.`);
}
if (!user) user = db.createUser(email);
if (flags.has('--reset')) db.dropUserSessions(user.id);

const token = db.newInvite(user.id, hours);
console.log('');
console.log(`  ${email}`);
console.log(`  ${baseUrl}/invite/${token}`);
console.log('');
console.log(`This link sets their password and is valid for ${hours} hours. Send it to them yourself.`);

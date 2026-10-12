import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicSupabaseConfig, isSupabaseServiceRoleKey } from '../src/supabase-config.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('exposes only configured HTTPS Supabase project URLs and public API keys', () => {
  const config = getPublicSupabaseConfig({
    SUPABASE_URL: 'https://project-ref.supabase.co/',
    SUPABASE_ANON_KEY: jwt({ role: 'anon' }),
  });
  assert.equal(config.supabaseUrl, 'https://project-ref.supabase.co');
  assert.equal(config.authConfigured, true);
  assert.equal(config.accountDeletionConfigured, false);
});

test('never returns service-role or invalid-origin keys to the browser', () => {
  for (const environment of [
    { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_ANON_KEY: jwt({ role: 'service_role' }) },
    { SUPABASE_URL: 'http://project-ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public' },
    { SUPABASE_URL: 'https://attacker.example', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public' },
    { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' },
    { SUPABASE_URL: 'https://project-ref.supabase.co:8443', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public' },
    {
      SUPABASE_URL: 'https://project-ref.supabase.co/unexpected-path',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public',
    },
    { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public!' },
  ]) {
    assert.deepEqual(getPublicSupabaseConfig(environment), {
      supabaseUrl: '',
      supabaseKey: '',
      authConfigured: false,
      accountDeletionConfigured: false,
    });
  }
});

test('recognizes only JWT credentials with the service_role claim for server-side deletion', () => {
  assert.equal(isSupabaseServiceRoleKey(jwt({ role: 'service_role' })), true);
  assert.equal(isSupabaseServiceRoleKey(jwt({ role: 'anon' })), false);
  assert.equal(isSupabaseServiceRoleKey('sb_secret_private_key'), false);
  assert.equal(isSupabaseServiceRoleKey('invalid'), false);
  assert.equal(
    getPublicSupabaseConfig({
      SUPABASE_URL: 'https://project-ref.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public',
      SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }),
    }).accountDeletionConfigured,
    true,
  );
});
